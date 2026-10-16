import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TranscriptStore, aggregate, RANGES, RangeKey, AnalyticsStats, Scope, Tool, TOOLS } from './collector.js';
import { OpenCodeStore } from './opencode.js';
import { CloudCliSessions } from './cloudcli.js';
import { LimitsClient } from './limits.js';
import { PrismClient } from './prism.js';
import { PRICES_AS_OF, parseOverrides, setPriceOverrides } from './pricing.js';

// The host passes only PATH, HOME, NODE_ENV and PLUGIN_NAME, so paths derive from HOME.
const HOME = process.env.HOME || os.homedir();
const CLAUDE_ROOT = path.join(HOME, '.claude', 'projects');
const OPENCODE_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
const CLOUDCLI_DB = path.join(HOME, '.cloudcli', 'auth.db');
const CREDENTIALS = path.join(HOME, '.claude', '.credentials.json');
const PRICES_FILE = path.join(HOME, '.config', 'cloudcli-analytics', 'prices.json');
const CACHE_MS = 2_000;

type ToolFilter = Tool | 'all';
type Response = AnalyticsStats & { tools: Record<Tool, { available: boolean; error: string | null }> };

const transcripts = new TranscriptStore(CLAUDE_ROOT);
const opencode = new OpenCodeStore(OPENCODE_DB, RANGES['30d'].spanMs);
const cloudcli = new CloudCliSessions(CLOUDCLI_DB);
const limits = new LimitsClient(CREDENTIALS);
const prism = new PrismClient(HOME);
const cache = new Map<string, { at: number; data: Response }>();

// ── User prices ─────────────────────────────────────────────────────────
// Re-read when the file changes, so a new model can be priced without a restart.

type PricesInfo = { asOf: string; file: string; loaded: boolean; overrides: number; errors: string[] };
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
      res.end(JSON.stringify({ ...stats, currentSessionIds, prices }));
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
  // Warm the parse cache after signalling readiness (host waits max 10s for the ready line).
  setTimeout(() => {
    try {
      getStats('30d', {}, 'all');
    } catch {
      /* first request will surface the error */
    }
  }, 0);
});
