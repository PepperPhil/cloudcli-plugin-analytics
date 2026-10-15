import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TranscriptStore, aggregate, RANGES, RangeKey, AnalyticsStats, Tool, TOOLS } from './collector.js';
import { OpenCodeStore } from './opencode.js';

// The host passes only PATH, HOME, NODE_ENV and PLUGIN_NAME, so paths derive from HOME.
const HOME = process.env.HOME || os.homedir();
const CLAUDE_ROOT = path.join(HOME, '.claude', 'projects');
const OPENCODE_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
const CACHE_MS = 2_000;

type ToolFilter = Tool | 'all';
type Response = AnalyticsStats & { tools: Record<Tool, { available: boolean; error: string | null }> };

const transcripts = new TranscriptStore(CLAUDE_ROOT);
const opencode = new OpenCodeStore(OPENCODE_DB, RANGES['30d'].spanMs);
const cache = new Map<string, { at: number; data: Response }>();

function getStats(range: RangeKey, project: string | null, tool: ToolFilter): Response {
  const key = `${range}|${project ?? ''}|${tool}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.data;
  const sources = [
    ...(tool === 'all' || tool === 'claude' ? transcripts.refresh(now - RANGES[range].spanMs) : []),
    ...(tool === 'all' || tool === 'opencode' ? opencode.refresh(now) : []),
  ];
  const data: Response = {
    ...aggregate(sources, range, now, project),
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
    try {
      res.end(JSON.stringify(getStats(rangeParam as RangeKey, project, tool)));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
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
      getStats('30d', null, 'all');
    } catch {
      /* first request will surface the error */
    }
  }, 0);
});
