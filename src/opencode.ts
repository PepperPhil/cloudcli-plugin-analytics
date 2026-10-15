import fs from 'node:fs';
import { createRequire } from 'node:module';
import { RequestRecord, SessionSource, MAX_LATENCY_MS } from './collector.js';
import { Tokens, estimateCost } from './pricing.js';

// OpenCode (sst/opencode) keeps sessions in ~/.local/share/opencode/opencode.db.
// Each assistant `message` row is one model response; `data` holds providerID/modelID,
// tokens and OpenCode's own cost estimate. Sessions spawned by the task tool have a parent_id.

const require = createRequire(import.meta.url);
/** Re-read rows updated this close to the watermark, in case they committed late. */
const OVERLAP_MS = 5_000;
const MAX_PARENT_DEPTH = 16;

interface OcSession {
  id: string;
  parentId: string | null;
  cwd: string;
  title: string | null;
  cost: number | null;
  updated: number;
}

interface OcMessage {
  id: string;
  sessionId: string;
  role: string;
  created: number;
  parentId: string | null;
  completed: number | null;
  record: RequestRecord | null;
}

/** Row shape returned by MESSAGE_SQL. Exported for tests. */
export interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  role: string | null;
  parent: string | null;
  provider: string | null;
  model: string | null;
  tokens: string | null;
  cost: number | null;
  completed: number | null;
  cwd: string | null;
  first_part: number | null;
}

const SESSION_SQL = `
  SELECT id, parent_id, directory, title, cost, time_updated
  FROM session WHERE time_updated >= ?`;

// first_part: first streamed content block (skip the step-start marker) → time to first token.
const MESSAGE_SQL = `
  SELECT m.id, m.session_id, m.time_created, m.time_updated,
    json_extract(m.data, '$.role') AS role,
    json_extract(m.data, '$.parentID') AS parent,
    json_extract(m.data, '$.providerID') AS provider,
    json_extract(m.data, '$.modelID') AS model,
    json_extract(m.data, '$.tokens') AS tokens,
    json_extract(m.data, '$.cost') AS cost,
    json_extract(m.data, '$.time.completed') AS completed,
    json_extract(m.data, '$.path.cwd') AS cwd,
    (SELECT p.time_created FROM part p
      WHERE p.message_id = m.id AND json_extract(p.data, '$.type') <> 'step-start'
      ORDER BY p.id LIMIT 1) AS first_part
  FROM message m WHERE m.time_updated >= ? AND m.time_created >= ?`;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Map OpenCode's token object onto the shared shape. Reasoning tokens are billed as output. */
export function tokensFromOpenCode(t: any): Tokens {
  return {
    input: num(t?.input),
    output: num(t?.output) + num(t?.reasoning),
    cacheWrite5m: num(t?.cache?.write),
    cacheWrite1h: 0,
    cacheRead: num(t?.cache?.read),
  };
}

/** Parse one message row. Exported for tests. */
export function parseMessage(row: MessageRow): OcMessage {
  const msg: OcMessage = {
    id: row.id,
    sessionId: row.session_id,
    role: row.role ?? '',
    created: row.time_created,
    parentId: row.parent,
    completed: typeof row.completed === 'number' ? row.completed : null,
    record: null,
  };
  if (msg.role !== 'assistant' || !row.model || !row.tokens) return msg;
  let raw: any;
  try {
    raw = JSON.parse(row.tokens);
  } catch {
    return msg;
  }
  const tokens = tokensFromOpenCode(raw);
  // Placeholder rows are written before the response streams in; skip until they carry usage.
  if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m === 0) return msg;
  const model = row.provider ? `${row.provider}/${row.model}` : row.model;
  const latency = typeof row.first_part === 'number' ? row.first_part - row.time_created : NaN;
  msg.record = {
    id: row.id,
    tool: 'opencode',
    ts: row.time_created,
    sessionId: row.session_id,
    cwd: row.cwd ?? '',
    model,
    tokens,
    cost: typeof row.cost === 'number' ? row.cost : estimateCost(row.model, tokens),
    latencyMs: latency > 0 && latency <= MAX_LATENCY_MS ? latency : null,
    sidechain: false,
  };
  return msg;
}

export class OpenCodeStore {
  private db: any = null;
  private sessions = new Map<string, OcSession>();
  private messages = new Map<string, OcMessage>();
  private sessionMark = 0;
  private messageMark = 0;
  /** Last read failure (missing node:sqlite, schema change, …); null when healthy. */
  error: string | null = null;

  constructor(readonly dbPath: string, private retentionMs: number) {}

  available(): boolean {
    return fs.existsSync(this.dbPath);
  }

  private open(): any {
    if (this.db) return this.db;
    if (!this.available()) return null;
    // node:sqlite ships with Node ≥ 22.5; loaded lazily so older runtimes still serve Claude data.
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    this.db.exec('PRAGMA busy_timeout = 2000');
    return this.db;
  }

  private close(): void {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }

  /** Pull rows changed since the last call; keeps everything inside the retention window in memory. */
  refresh(nowMs: number): SessionSource[] {
    const cutoff = nowMs - this.retentionMs;
    try {
      const db = this.open();
      if (!db) return [];
      for (const r of db.prepare(SESSION_SQL).all(Math.max(0, this.sessionMark - OVERLAP_MS))) {
        this.sessions.set(r.id, {
          id: r.id,
          parentId: r.parent_id ?? null,
          cwd: r.directory ?? '',
          title: r.title || null,
          cost: typeof r.cost === 'number' ? r.cost : null,
          updated: r.time_updated,
        });
        if (r.time_updated > this.sessionMark) this.sessionMark = r.time_updated;
      }
      for (const r of db.prepare(MESSAGE_SQL).all(Math.max(0, this.messageMark - OVERLAP_MS), cutoff) as MessageRow[]) {
        this.messages.set(r.id, parseMessage(r));
        if (r.time_updated > this.messageMark) this.messageMark = r.time_updated;
      }
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      this.close();
    }
    for (const [id, m] of this.messages) if (m.created < cutoff) this.messages.delete(id);
    return this.sources();
  }

  private rootOf(id: string): string {
    let cur = id;
    for (let i = 0; i < MAX_PARENT_DEPTH; i++) {
      const parent = this.sessions.get(cur)?.parentId;
      if (!parent) break;
      cur = parent;
    }
    return cur;
  }

  private sources(): SessionSource[] {
    const bySession = new Map<string, OcMessage[]>();
    for (const m of this.messages.values()) {
      const list = bySession.get(m.sessionId);
      if (list) list.push(m);
      else bySession.set(m.sessionId, [m]);
    }
    const out: SessionSource[] = [];
    for (const [sid, msgs] of bySession) {
      const s = this.sessions.get(sid);
      const root = this.rootOf(sid);
      // A turn runs from the user prompt until the last assistant reply to it completes.
      const done = new Map<string, number>();
      for (const m of msgs) {
        if (m.role === 'assistant' && m.parentId && m.completed !== null) {
          done.set(m.parentId, Math.max(done.get(m.parentId) ?? 0, m.completed));
        }
      }
      const turns: SessionSource['turns'] = [];
      const prompts: number[] = [];
      const requests: RequestRecord[] = [];
      for (const m of msgs) {
        // User messages in subagent sessions are task prompts written by the parent agent.
        if (m.role === 'user' && root === sid) prompts.push(m.created);
        const end = m.role === 'user' ? done.get(m.id) : undefined;
        if (end !== undefined && end > m.created) turns.push({ ts: m.created, durationMs: end - m.created });
        if (m.record) {
          m.record.sessionId = root;
          // Attribute to the session's directory, matching how CloudCLI groups sessions into projects.
          m.record.cwd = s?.cwd || m.record.cwd;
          requests.push(m.record);
        }
      }
      out.push({
        tool: 'opencode',
        sessionId: root,
        cwd: s?.cwd ?? requests[0]?.cwd ?? null,
        title: s?.title ?? null,
        reportedCost: s?.cost ?? null,
        lastWriteMs: s?.updated ?? Math.max(0, ...msgs.map((m) => m.completed ?? m.created)),
        subagent: root !== sid,
        requests,
        turns,
        prompts,
      });
    }
    return out;
  }
}
