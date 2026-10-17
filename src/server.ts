import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TranscriptStore, aggregate, RANGES, RangeKey, AnalyticsStats, Scope, Tool, TOOLS } from './collector.js';
import { OpenCodeStore } from './opencode.js';
import { CloudCliSessions } from './cloudcli.js';
import { LimitsClient, readPlan } from './limits.js';
import { PrismClient } from './prism.js';
import { PRICES_AS_OF, parseOverrides, setPriceOverrides, setRemotePrices } from './pricing.js';
import { RemotePrices } from './remote-prices.js';
import { DEFAULT_SETTINGS, Settings, SubscriptionTool, compare, parseSettings } from './subscriptions.js';

// The host passes only PATH, HOME, NODE_ENV and PLUGIN_NAME, so paths derive from HOME.
const HOME = process.env.HOME || os.homedir();
const CLAUDE_ROOT = path.join(HOME, '.claude', 'projects');
const OPENCODE_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
const CLOUDCLI_DB = path.join(HOME, '.cloudcli', 'auth.db');
const CREDENTIALS = path.join(HOME, '.claude', '.credentials.json');
const CONFIG_DIR = path.join(HOME, '.config', 'cloudcli-analytics');
const PRICES_FILE = path.join(CONFIG_DIR, 'prices.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const PRICE_CACHE = path.join(HOME, '.cache', 'cloudcli-analytics', 'litellm-prices.json');
const CACHE_MS = 2_000;

type ToolFilter = Tool | 'all';
type Response = AnalyticsStats & { tools: Record<Tool, { available: boolean; error: string | null }> };

const transcripts = new TranscriptStore(CLAUDE_ROOT);
const opencode = new OpenCodeStore(OPENCODE_DB, RANGES['30d'].spanMs);
const cloudcli = new CloudCliSessions(CLOUDCLI_DB);
const limits = new LimitsClient(CREDENTIALS);
const prism = new PrismClient(HOME);
const cache = new Map<string, { at: number; data: Response }>();
const remotePrices = new RemotePrices(PRICE_CACHE, (list) => {
  setRemotePrices(list);
  cache.clear();
});

// ── Subscription settings ───────────────────────────────────────────────

function loadSettings(): { settings: Settings; error: string | null } {
  try {
    return parseSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { settings: { ...DEFAULT_SETTINGS }, error: missing ? null : `${SETTINGS_FILE}: ${(err as Error).message}` };
  }
}

function saveSettings(settings: Settings): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS_FILE);
}

/** API-equivalent cost per subscription: Claude Code requests, and OpenCode's GitHub Copilot models. */
function subscriptionCosts(s: AnalyticsStats): Record<SubscriptionTool, number> {
  return {
    claude: s.byTool.find((t) => t.tool === 'claude')?.cost ?? 0,
    copilot: s.byModel.filter((m) => m.tool === 'opencode' && m.model.startsWith('github-copilot/')).reduce((a, m) => a + m.cost, 0),
  };
}

function subscriptions(range: RangeKey) {
  const { settings } = loadSettings();
  const plan = readPlan(CREDENTIALS);
  // Subscriptions cover every project, so compare against unscoped usage.
  const inRange = subscriptionCosts(getStats(range, {}, 'all'));
  const month = range === '30d' ? inRange : subscriptionCosts(getStats('30d', {}, 'all'));
  return compare(settings, plan, RANGES[range].spanMs, inRange, month);
}

// ── User prices ─────────────────────────────────────────────────────────
// Re-read when the file changes, so a new model can be priced without a restart.

type PricesInfo = { asOf: string; file: string; loaded: boolean; overrides: number; errors: string[]; remote?: RemotePrices['status'] };
let prices: PricesInfo = { asOf: PRICES_AS_OF, file: PRICES_FILE, loaded: false, overrides: 0, errors: [] };
let pricesMtime: number | null = null;

function refreshPrices(): void {
  let mtime: number | null = null;
  try { mtime = fs.statSync(PRICES_FILE).mtimeMs; } catch { /* no user prices */ }
  if (mtime === pricesMtime) return;
  pricesMtime = mtime;
  cache.clear();
  if (mtime === null) {
    setPriceOverrides([]);
    prices = { ...prices, loaded: false, overrides: 0, errors: [] };
    return;
  }
  try {
    const { entries, errors } = parseOverrides(JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')));
    setPriceOverrides(entries);
    prices = { ...prices, loaded: true, overrides: entries.length, errors };
  } catch (err) {
    setPriceOverrides([]);
    prices = { ...prices, loaded: true, overrides: 0, errors: [(err as Error).message] };
  }
}

function getStats(range: RangeKey, scope: Scope, tool: ToolFilter): Response {
  const key = `${range}|${scope.project ?? ''}|${[scope.session ?? ''].flat().join(',')}|${tool}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.data;
  const sources = [
    ...(tool === 'all' || tool === 'claude' ? transcripts.refresh(now - RANGES[range].spanMs) : []),
    ...(tool === 'all' || tool === 'opencode' ? opencode.refresh(now) : []),
  ];
  const data: Response = {
    ...aggregate(sources, range, now, scope),
    tools: {
      claude: { available: true, error: null },
      opencode: { available: opencode.available(), error: opencode.error },
    },
  };
  cache.set(key, { at: now, data });
  return data;
}

const MAX_BODY = 64 * 1024;

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/stats') {
    const rangeParam = url.searchParams.get('range') ?? '24h';
    const project = url.searchParams.get('project') || null;
    const session = url.searchParams.get('session') || null;
    const current = url.searchParams.get('current') || null;
    const tool = (url.searchParams.get('tool') ?? 'all') as ToolFilter;
    if (!(rangeParam in RANGES)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `range must be one of ${Object.keys(RANGES).join(', ')}` }));
      return;
    }
    if (tool !== 'all' && !TOOLS.includes(tool)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `tool must be one of all, ${TOOLS.join(', ')}` }));
      return;
    }
    if (project !== null && !path.isAbsolute(project)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'project must be an absolute path' }));
      return;
    }
    if ([session, current].some((id) => id !== null && !/^[\w-]{1,128}$/.test(id))) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'session and current must be session ids' }));
      return;
    }
    try {
      // Resolved on every request: a new session only gets its provider id
      // once its first run starts.
      const sessionIds = session ? cloudcli.resolve(session) : null;
      // Lets the UI mark the open session in the list whatever the scope.
      const currentSessionIds = current ? (current === session ? sessionIds : cloudcli.resolve(current)) : null;
      refreshPrices();
      const stats = getStats(rangeParam as RangeKey, { project, session: sessionIds }, tool);
      res.end(JSON.stringify({ ...stats, currentSessionIds, prices: { ...prices, remote: remotePrices.status }, subscriptions: subscriptions(rangeParam as RangeKey) }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Both answer 200 with { ok: false, error } on failure: the host turns other
  // statuses into a generic RPC error and the message would be lost.
  if (req.method === 'GET' && url.pathname === '/limits') {
    limits.get().then((data) => res.end(JSON.stringify(data)));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/prism') {
    const project = url.searchParams.get('project') || null;
    if (project !== null && !path.isAbsolute(project)) {
      res.end(JSON.stringify({ ok: false, notInstalled: false, error: 'project must be an absolute path' }));
      return;
    }
    prism.get(project, url.searchParams.get('refresh') === '1').then((data) => res.end(JSON.stringify(data)));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/prices/refresh') {
    remotePrices.refresh().then(() => res.end(JSON.stringify({ ok: !remotePrices.status.error, status: remotePrices.status })));
    return;
  }

  if (url.pathname === '/settings') {
    if (req.method === 'GET') {
      const { settings, error } = loadSettings();
      res.end(JSON.stringify({ ok: true, settings, error, plan: readPlan(CREDENTIALS) }));
      return;
    }
    if (req.method === 'PUT') {
      readBody(req).then((body) => {
        const { settings, error } = parseSettings(body);
        if (error) {
          res.end(JSON.stringify({ ok: false, error }));
          return;
        }
        try {
          saveSettings(settings);
          res.end(JSON.stringify({ ok: true, settings }));
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: `Could not save settings: ${(err as Error).message}` }));
        }
      }, (err: Error) => res.end(JSON.stringify({ ok: false, error: err.message })));
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.end(JSON.stringify({ ok: true, claudeRoot: CLAUDE_ROOT, opencodeDb: OPENCODE_DB, opencodeError: opencode.error }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
  // Cached prices first, so the warm-up below already uses them; a download follows in the background.
  remotePrices.start();
  // Warm the parse cache after signalling readiness (host waits max 10s for the ready line).
  setTimeout(() => {
    try {
      getStats('30d', {}, 'all');
    } catch {
      /* first request will surface the error */
    }
  }, 0);
});
