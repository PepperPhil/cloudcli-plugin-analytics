import fs from 'node:fs';
import path from 'node:path';
import {
  Tokens,
  zeroTokens,
  addTokens,
  estimateCost,
  cacheHitRate,
  totalTokens,
} from './pricing.js';

// ── Parsed records ─────────────────────────────────────────────────────

export type Tool = 'claude' | 'opencode';
export const TOOLS: Tool[] = ['claude', 'opencode'];

export interface RequestRecord {
  id: string;
  tool: Tool;
  ts: number;
  sessionId: string;
  cwd: string;
  model: string;
  tokens: Tokens;
  cost: number | null;
  latencyMs: number | null;
  sidechain: boolean;
}

interface CostState {
  ts: number;
  totalCostUSD: number;
}

/** Incremental parse state for one append-only transcript file. */
interface FileState {
  size: number;
  mtimeMs: number;
  offset: number;
  carry: string;
  uuidTs: Map<string, number>;
  apiRequestTs: Map<string, number>;
  seenIds: Set<string>;
  requests: RequestRecord[];
  turns: { ts: number; durationMs: number }[];
  prompts: number[];
  costState: CostState | null;
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  lastPrompt: string | null;
  lastTs: number;
}

/** One session (or subagent) worth of requests from any tool, as consumed by aggregate(). */
export interface SessionSource {
  tool: Tool;
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  /** The tool's own cost counter for this session, if it keeps one. */
  reportedCost: number | null;
  lastWriteMs: number;
  /** Subagent sources count toward their parent session but don't supply its title or reported cost. */
  subagent: boolean;
  requests: RequestRecord[];
  turns: { ts: number; durationMs: number }[];
  /** Timestamps of prompts the user typed (not tool results or subagent tasks). */
  prompts: number[];
}

export const MAX_LATENCY_MS = 15 * 60_000;
const SKIP_TYPES = ['"api-request-blob"', '"api-request-shape"', '"file-history-snapshot"'];

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function newFileState(): FileState {
  return {
    size: 0,
    mtimeMs: 0,
    offset: 0,
    carry: '',
    uuidTs: new Map(),
    apiRequestTs: new Map(),
    seenIds: new Set(),
    requests: [],
    turns: [],
    prompts: [],
    costState: null,
    sessionId: null,
    cwd: null,
    title: null,
    lastPrompt: null,
    lastTs: 0,
  };
}

export function tokensFromUsage(usage: any): Tokens {
  const created = num(usage?.cache_creation_input_tokens);
  const split = usage?.cache_creation;
  let w1h = num(split?.ephemeral_1h_input_tokens);
  let w5m = num(split?.ephemeral_5m_input_tokens);
  if (w1h + w5m !== created) {
    w5m = created - w1h;
    if (w5m < 0) {
      w1h = created;
      w5m = 0;
    }
  }
  return {
    input: num(usage?.input_tokens),
    output: num(usage?.output_tokens),
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
    cacheRead: num(usage?.cache_read_input_tokens),
  };
}

/** A user entry is a typed prompt unless it only carries tool results. */
function isTypedPrompt(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0;
  return Array.isArray(content) && content.some((b) => b?.type === 'text' || b?.type === 'image');
}

/** Apply one transcript line to the file state. Exported for tests. */
export function applyLine(st: FileState, line: string): void {
  const head = line.slice(0, 48);
  if (SKIP_TYPES.some((t) => head.includes(t))) return;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (!obj || typeof obj !== 'object') return;
  const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
  if (typeof obj.sessionId === 'string' && !st.sessionId) st.sessionId = obj.sessionId;
  // A session belongs to the directory it started in, even if a shell `cd` later changes cwd.
  if (typeof obj.cwd === 'string' && !st.cwd) st.cwd = obj.cwd;
  if (Number.isFinite(ts) && ts > st.lastTs) st.lastTs = ts;
  if (typeof obj.uuid === 'string' && Number.isFinite(ts)) st.uuidTs.set(obj.uuid, ts);

  switch (obj.type) {
    case 'ai-title':
      if (typeof obj.aiTitle === 'string') st.title = obj.aiTitle;
      return;
    case 'last-prompt':
      if (typeof obj.lastPrompt === 'string') st.lastPrompt = obj.lastPrompt.slice(0, 120);
      return;
    case 'api-request':
      if (typeof obj.id === 'string' && Number.isFinite(ts)) st.apiRequestTs.set(obj.id, ts);
      return;
    case 'cost-state':
      if (typeof obj.totalCostUSD === 'number') {
        st.costState = { ts: Number.isFinite(ts) ? ts : st.lastTs, totalCostUSD: obj.totalCostUSD };
      }
      return;
    case 'system':
      if (obj.subtype === 'turn_duration' && Number.isFinite(ts) && typeof obj.durationMs === 'number') {
        st.turns.push({ ts, durationMs: obj.durationMs });
      }
      return;
    case 'user':
      // turn_duration is only written by the interactive CLI, so count prompts from user entries.
      if (!obj.isMeta && !obj.isSidechain && Number.isFinite(ts) && isTypedPrompt(obj.message?.content)) st.prompts.push(ts);
      return;
    case 'assistant':
      break;
    default:
      return;
  }

  const msg = obj.message;
  if (!msg?.id || !msg.usage || !msg.model || msg.model === '<synthetic>' || !Number.isFinite(ts)) return;
  // One API response is written as several lines (one per content block); count it once.
  if (st.seenIds.has(msg.id)) return;
  st.seenIds.add(msg.id);

  let startTs: number | undefined;
  if (typeof obj.requestRef === 'string') startTs = st.apiRequestTs.get(obj.requestRef);
  if (startTs === undefined && typeof obj.parentUuid === 'string') startTs = st.uuidTs.get(obj.parentUuid);
  const latency = startTs !== undefined ? ts - startTs : NaN;

  const tokens = tokensFromUsage(msg.usage);
  st.requests.push({
    id: msg.id,
    tool: 'claude',
    ts,
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : st.sessionId ?? '',
    cwd: st.cwd ?? '',
    model: msg.model,
    tokens,
    cost: estimateCost(msg.model, tokens, msg.usage.speed === 'fast'),
    latencyMs: latency > 0 && latency <= MAX_LATENCY_MS ? latency : null,
    sidechain: obj.isSidechain === true,
  });
}

// ── Transcript store ───────────────────────────────────────────────────

export class TranscriptStore {
  private files = new Map<string, FileState>();

  constructor(private root: string) {}

  /** Find .jsonl files under root (including subagent dirs) modified at/after sinceMs. */
  private listFiles(sinceMs: number): { file: string; size: number; mtimeMs: number }[] {
    const out: { file: string; size: number; mtimeMs: number }[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'memory') walk(full, depth + 1);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try {
            const s = fs.statSync(full);
            if (s.mtimeMs >= sinceMs) out.push({ file: full, size: s.size, mtimeMs: s.mtimeMs });
          } catch {
            /* vanished */
          }
        }
      }
    };
    walk(this.root, 0);
    return out;
  }

  /** Read only the bytes appended since the last refresh. */
  private refreshFile(file: string, size: number, mtimeMs: number): FileState {
    let st = this.files.get(file);
    if (!st || size < st.size) {
      st = newFileState(); // new or truncated/rewritten file
      this.files.set(file, st);
    }
    if (size === st.offset && mtimeMs === st.mtimeMs) return st;

    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'r');
      const CHUNK = 4 * 1024 * 1024;
      const buf = Buffer.alloc(CHUNK);
      while (st.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - st.offset), st.offset);
        if (n <= 0) break;
        st.offset += n;
        const text = st.carry + buf.toString('utf8', 0, n);
        const lines = text.split('\n');
        st.carry = lines.pop() ?? '';
        for (const line of lines) if (line) applyLine(st, line);
      }
    } catch {
      /* unreadable — keep what we have */
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    st.size = size;
    st.mtimeMs = mtimeMs;
    return st;
  }

  refresh(sinceMs: number): SessionSource[] {
    return this.listFiles(sinceMs).map(({ file, size, mtimeMs }) =>
      sourceFromTranscript(file, this.refreshFile(file, size, mtimeMs)));
  }
}

export function sourceFromTranscript(file: string, st: FileState): SessionSource {
  return {
    tool: 'claude',
    sessionId: st.sessionId,
    cwd: st.cwd,
    title: st.title ?? st.lastPrompt,
    reportedCost: st.costState?.totalCostUSD ?? null,
    lastWriteMs: st.mtimeMs,
    subagent: file.includes('/subagents/'),
    requests: st.requests,
    turns: st.turns,
    prompts: st.prompts,
  };
}

// ── Aggregation ────────────────────────────────────────────────────────

export const RANGES = {
  '1h': { spanMs: 3_600_000, bucketMs: 60_000 },
  '24h': { spanMs: 86_400_000, bucketMs: 1_800_000 },
  '7d': { spanMs: 7 * 86_400_000, bucketMs: 4 * 3_600_000 },
  '30d': { spanMs: 30 * 86_400_000, bucketMs: 86_400_000 },
} as const;
export type RangeKey = keyof typeof RANGES;

interface Group {
  tokens: Tokens;
  cost: number;
  unpriced: number;
  requests: number;
  latencies: number[];
}

function newGroup(): Group {
  return { tokens: zeroTokens(), cost: 0, unpriced: 0, requests: 0, latencies: [] };
}

function addToGroup(g: Group, r: RequestRecord): void {
  addTokens(g.tokens, r.tokens);
  g.requests += 1;
  if (r.cost === null) g.unpriced += 1;
  else g.cost += r.cost;
  if (r.latencyMs !== null) g.latencies.push(r.latencyMs);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function summarize(g: Group) {
  const lat = [...g.latencies].sort((a, b) => a - b);
  return {
    tokens: g.tokens,
    totalTokens: totalTokens(g.tokens),
    cost: g.cost,
    unpricedRequests: g.unpriced,
    requests: g.requests,
    cacheHitRate: cacheHitRate(g.tokens),
    latency: {
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      avg: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
      samples: lat.length,
    },
  };
}

export type Summary = ReturnType<typeof summarize>;

export interface AnalyticsStats {
  range: RangeKey;
  generatedAt: number;
  windowStart: number;
  bucketMs: number;
  totals: Summary & { sessions: number; activeSessions: number; avgTurnMs: number | null; turns: number; prompts: number };
  lastHour: { cost: number; requests: number };
  series: { t: number; cost: number; tokens: number; cacheHitRate: number | null; latencyP50: number | null; requests: number }[];
  byTool: (Summary & { tool: Tool; sessions: number; prompts: number })[];
  byModel: (Summary & { model: string; tool: Tool })[];
  byProject: (Summary & { project: string; cwd: string })[];
  sessions: (Summary & {
    tool: Tool;
    sessionId: string;
    title: string | null;
    project: string;
    cwd: string;
    lastActivity: number;
    active: boolean;
    reportedCost: number | null;
    subagentRequests: number;
  })[];
  recent: { ts: number; tool: Tool; model: string; project: string; cost: number | null; latencyMs: number | null; tokens: number; cacheHitRate: number | null; sidechain: boolean }[];
}

const ACTIVE_MS = 2 * 60_000;

export interface Scope {
  /** Exact working directory. Subdirectories are separate projects in CloudCLI, so they don't match. */
  project?: string | null;
  /** Root session id (Claude Code session or top-level OpenCode session). */
  session?: string | null;
}

function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export function aggregate(
  sources: SessionSource[],
  range: RangeKey,
  nowMs: number,
  scope: Scope = {},
): AnalyticsStats {
  const { spanMs, bucketMs } = RANGES[range];
  const windowStart = Math.floor((nowMs - spanMs) / bucketMs) * bucketMs + bucketMs;
  const nBuckets = Math.round((Math.floor(nowMs / bucketMs) * bucketMs - windowStart) / bucketMs) + 1;
  const buckets = Array.from({ length: nBuckets }, newGroup);
  const total = newGroup();
  const tools = new Map<Tool, Group & { sessions: Set<string>; prompts: number }>();
  const models = new Map<string, Group & { tool: Tool; model: string }>();
  const projects = new Map<string, Group>();
  const sessions = new Map<string, Group & { meta: AnalyticsStats['sessions'][number] }>();
  const seen = new Set<string>();
  const recent: RequestRecord[] = [];
  const lastHour = { cost: 0, requests: 0 };
  const turnDurations: number[] = [];
  let promptCount = 0;
  const project = scope.project ? trimSlash(scope.project) : null;
  const inScope = (cwd: string, sessionId: string | null) =>
    (!project || trimSlash(cwd) === project) && (!scope.session || sessionId === scope.session);
  const toolGroup = (tool: Tool) => {
    let g = tools.get(tool);
    if (!g) tools.set(tool, (g = Object.assign(newGroup(), { sessions: new Set<string>(), prompts: 0 })));
    return g;
  };

  // Main sessions first so session metadata (title, reported cost) comes from them.
  const ordered = [...sources].sort((a, b) => Number(a.subagent) - Number(b.subagent));

  for (const src of ordered) {
    const isSub = src.subagent;
    const srcInScope = inScope(src.cwd ?? '', src.sessionId);
    for (const t of src.turns) {
      if (t.ts >= windowStart && srcInScope) turnDurations.push(t.durationMs);
    }
    for (const ts of src.prompts) {
      if (ts >= windowStart && srcInScope) {
        promptCount += 1;
        toolGroup(src.tool).prompts += 1;
      }
    }
    for (const r of src.requests) {
      const key = `${r.tool}:${r.id}`;
      if (r.ts < windowStart || r.ts > nowMs + 60_000 || seen.has(key) || !inScope(r.cwd, r.sessionId)) continue;
      seen.add(key);
      addToGroup(total, r);
      const bi = Math.min(nBuckets - 1, Math.max(0, Math.floor((r.ts - windowStart) / bucketMs)));
      addToGroup(buckets[bi], r);
      if (r.ts >= nowMs - 3_600_000) {
        lastHour.requests += 1;
        lastHour.cost += r.cost ?? 0;
      }

      const tg = toolGroup(r.tool);
      addToGroup(tg, r);
      tg.sessions.add(r.sessionId);

      const mk = `${r.tool}:${r.model}`;
      const mg = models.get(mk) ?? Object.assign(newGroup(), { tool: r.tool, model: r.model });
      addToGroup(mg, r);
      models.set(mk, mg);

      const pg = projects.get(r.cwd) ?? newGroup();
      addToGroup(pg, r);
      projects.set(r.cwd, pg);

      const sk = `${r.tool}:${r.sessionId}`;
      let sg = sessions.get(sk);
      if (!sg) {
        sg = Object.assign(newGroup(), {
          meta: {
            tool: r.tool,
            sessionId: r.sessionId,
            title: null,
            project: path.basename(r.cwd) || r.cwd,
            cwd: r.cwd,
            lastActivity: 0,
            active: false,
            reportedCost: null,
            subagentRequests: 0,
          } as unknown as AnalyticsStats['sessions'][number],
        });
        sessions.set(sk, sg);
      }
      addToGroup(sg, r);
      if (isSub || r.sidechain) sg.meta.subagentRequests += 1;
      if (r.ts > sg.meta.lastActivity) sg.meta.lastActivity = r.ts;

      recent.push(r);
    }

    const sg = src.sessionId ? sessions.get(`${src.tool}:${src.sessionId}`) : undefined;
    if (sg) {
      if (!isSub) {
        if (src.title) sg.meta.title = src.title;
        if (src.reportedCost !== null) sg.meta.reportedCost = src.reportedCost;
      }
      if (nowMs - src.lastWriteMs < ACTIVE_MS) sg.meta.active = true;
    }
  }

  recent.sort((a, b) => b.ts - a.ts);
  const rankByCost = <T extends { cost: number; totalTokens: number }>(a: T, b: T) => b.cost - a.cost || b.totalTokens - a.totalTokens;

  const sessionList = [...sessions.values()]
    .map((g) => ({ ...summarize(g), ...g.meta }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.lastActivity - a.lastActivity)
    .slice(0, 50);

  return {
    range,
    generatedAt: nowMs,
    windowStart,
    bucketMs,
    totals: {
      ...summarize(total),
      sessions: sessions.size,
      activeSessions: sessionList.filter((s) => s.active).length,
      turns: turnDurations.length,
      prompts: promptCount,
      avgTurnMs: turnDurations.length ? turnDurations.reduce((a, b) => a + b, 0) / turnDurations.length : null,
    },
    lastHour,
    series: buckets.map((g, i) => {
      const s = summarize(g);
      return {
        t: windowStart + i * bucketMs,
        cost: s.cost,
        tokens: s.totalTokens,
        cacheHitRate: s.cacheHitRate,
        latencyP50: s.latency.p50,
        requests: s.requests,
      };
    }),
    byTool: TOOLS.filter((t) => tools.has(t)).map((tool) => {
      const g = tools.get(tool)!;
      return { tool, ...summarize(g), sessions: g.sessions.size, prompts: g.prompts };
    }),
    byModel: [...models.values()].map((g) => ({ model: g.model, tool: g.tool, ...summarize(g) })).sort(rankByCost),
    byProject: [...projects.entries()]
      .map(([cwd, g]) => ({ project: path.basename(cwd) || cwd || '(unknown)', cwd, ...summarize(g) }))
      .sort(rankByCost),
    sessions: sessionList,
    recent: recent.slice(0, 25).map((r) => ({
      ts: r.ts,
      tool: r.tool,
      model: r.model,
      project: path.basename(r.cwd) || r.cwd,
      cost: r.cost,
      latencyMs: r.latencyMs,
      tokens: totalTokens(r.tokens),
      cacheHitRate: cacheHitRate(r.tokens),
      sidechain: r.sidechain,
    })),
  };
}

export { newFileState };
