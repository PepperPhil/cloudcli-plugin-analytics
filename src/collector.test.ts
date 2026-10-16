import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLine, aggregate, newFileState, sourceFromTranscript } from './collector.js';
import { estimateCost, cacheHitRate, zeroTokens } from './pricing.js';
import { parseMessage, MessageRow } from './opencode.js';

const usage = {
  input_tokens: 2,
  output_tokens: 1000,
  cache_read_input_tokens: 90_000,
  cache_creation_input_tokens: 8_000,
  cache_creation: { ephemeral_1h_input_tokens: 8_000, ephemeral_5m_input_tokens: 0 },
};

function line(o: object): string {
  return JSON.stringify(o);
}

test('estimateCost prices opus-5-5 with 1h cache writes', () => {
  const t = { ...zeroTokens(), input: 1_000_000, output: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 1_000_000 };
  assert.equal(estimateCost('claude-opus-5-5', t), 4 + 20 + 8 + 0.2);
  assert.equal(estimateCost('claude-opus-5-5', t, true), 2 * (4 + 20 + 8 + 0.2));
  assert.equal(estimateCost('claude-opus-4-8', { ...zeroTokens(), input: 1_000_000 }), 5);
  assert.equal(estimateCost('some-other-model', t), null);
});

test('cacheHitRate is reads over all prompt tokens', () => {
  assert.equal(cacheHitRate({ ...zeroTokens(), input: 10, cacheWrite5m: 10, cacheRead: 80 }), 0.8);
  assert.equal(cacheHitRate(zeroTokens()), null);
});

test('applyLine dedupes split assistant messages and measures latency', () => {
  const st = newFileState();
  const base = { sessionId: 's1', cwd: '/proj/a' };
  applyLine(st, line({ ...base, type: 'user', uuid: 'u1', timestamp: '2026-10-15T10:00:00.000Z', message: { content: 'hi' } }));
  applyLine(st, line({ type: 'api-request', ...base, id: 'r1', timestamp: '2026-10-15T10:00:00.500Z' }));
  const msg = { id: 'm1', model: 'claude-opus-5-5', usage };
  applyLine(st, line({ ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', requestRef: 'r1', timestamp: '2026-10-15T10:00:03.000Z', message: msg }));
  applyLine(st, line({ ...base, type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: '2026-10-15T10:00:05.000Z', message: msg }));
  // No requestRef: falls back to the parent entry's timestamp.
  applyLine(st, line({ ...base, type: 'user', uuid: 'u2', timestamp: '2026-10-15T10:01:00.000Z', message: { content: [{ type: 'tool_result' }] } }));
  applyLine(st, line({ ...base, type: 'user', isMeta: true, uuid: 'u3', timestamp: '2026-10-15T10:01:00.100Z', message: { content: [{ type: 'text' }] } }));
  applyLine(st, line({ ...base, type: 'assistant', uuid: 'a3', parentUuid: 'u2', timestamp: '2026-10-15T10:01:01.200Z', message: { ...msg, id: 'm2' } }));
  applyLine(st, line({ ...base, type: 'cost-state', totalCostUSD: 1.23 }));
  applyLine(st, line({ type: 'ai-title', sessionId: 's1', aiTitle: 'Hello' }));

  assert.equal(st.requests.length, 2);
  assert.equal(st.requests[0].latencyMs, 2500);
  assert.equal(st.requests[1].latencyMs, 1200);
  assert.equal(st.requests[0].tokens.cacheWrite1h, 8000);
  assert.equal(st.costState?.totalCostUSD, 1.23);
  assert.equal(st.title, 'Hello');

  const now = Date.parse('2026-10-15T10:30:00.000Z');
  const stats = aggregate([sourceFromTranscript('/x/s1.jsonl', st)], '1h', now);
  assert.equal(stats.totals.requests, 2);
  // Only the typed prompt counts; tool results and meta entries don't.
  assert.equal(stats.totals.prompts, 1);
  assert.equal(stats.byTool[0].prompts, 1);
  assert.equal(stats.sessions[0].title, 'Hello');
  assert.equal(stats.sessions[0].reportedCost, 1.23);
  assert.equal(stats.totals.latency.p50, 1200);
  assert.equal(stats.series.reduce((a, p) => a + p.requests, 0), 2);

  const src = [sourceFromTranscript('/x/s1.jsonl', st)];
  assert.equal(aggregate(src, '1h', now, { project: '/proj/b' }).totals.requests, 0);
  assert.equal(aggregate(src, '1h', now, { project: '/proj/a/' }).totals.requests, 2);
  // A parent directory is a different CloudCLI project, so it must not include /proj/a.
  assert.equal(aggregate(src, '1h', now, { project: '/proj' }).totals.requests, 0);
  assert.equal(aggregate(src, '1h', now, { session: 's1' }).totals.requests, 2);
  assert.equal(aggregate(src, '1h', now, { session: 's2' }).totals.requests, 0);
  // Every id one session is known by, e.g. a Claude session across resumes.
  assert.equal(aggregate(src, '1h', now, { session: ['app-1', 's1'] }).totals.requests, 2);
  assert.equal(aggregate(src, '1h', now, { session: ['app-1', 's2'] }).totals.requests, 0);
});

function ocRow(over: Partial<MessageRow>): MessageRow {
  return {
    id: 'msg_a', session_id: 'ses_1', time_created: 1_000, time_updated: 5_000, role: 'assistant', parent: 'msg_u',
    provider: 'github-copilot', model: 'gpt-5.6-terra', cost: 0.02, completed: 5_000, cwd: '/proj/a', first_part: 1_800,
    tokens: JSON.stringify({ total: 1250, input: 100, output: 40, reasoning: 10, cache: { read: 1100, write: 0 } }),
    ...over,
  };
}

test('parseMessage maps OpenCode assistant rows', () => {
  const r = parseMessage(ocRow({})).record!;
  assert.equal(r.tool, 'opencode');
  assert.equal(r.model, 'github-copilot/gpt-5.6-terra');
  assert.deepEqual(r.tokens, { input: 100, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1100 });
  assert.equal(r.cost, 0.02);
  assert.equal(r.latencyMs, 800);
  // Streaming placeholder (all-zero tokens) and user rows carry no request.
  assert.equal(parseMessage(ocRow({ tokens: JSON.stringify({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }) })).record, null);
  assert.equal(parseMessage(ocRow({ role: 'user', model: null, tokens: null })).record, null);
});

test('OpenCodeStore reads the sqlite db and rolls subagents into the root session', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const { OpenCodeStore } = await import('./opencode.js');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-oc-'));
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL, title text NOT NULL, cost real DEFAULT 0 NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`);
  const now = Date.parse('2026-10-15T10:30:00.000Z');
  const t0 = now - 10 * 60_000;
  const tokens = { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 0 } };
  const addSession = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)');
  addSession.run('ses_root', null, '/proj/a', 'Fix bug', 0.5, now - 1_000);
  addSession.run('ses_child', 'ses_root', '/proj/a', 'subtask', 0.1, now - 2_000);
  const addMsg = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const addPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  addMsg.run('msg_u1', 'ses_root', t0, t0, JSON.stringify({ role: 'user', time: { created: t0 } }));
  addMsg.run('msg_a1', 'ses_root', t0 + 100, t0 + 9_000, JSON.stringify({
    role: 'assistant', parentID: 'msg_u1', providerID: 'github-copilot', modelID: 'claude-sonnet-5', cost: 0.03, tokens,
    path: { cwd: '/proj/a' }, time: { created: t0 + 100, completed: t0 + 9_000 },
  }));
  addPart.run('prt_1', 'msg_a1', 'ses_root', t0 + 1_500, t0 + 1_500, JSON.stringify({ type: 'step-start' }));
  addPart.run('prt_2', 'msg_a1', 'ses_root', t0 + 2_100, t0 + 3_000, JSON.stringify({ type: 'text' }));
  addMsg.run('msg_a2', 'ses_child', t0 + 200, t0 + 4_000, JSON.stringify({
    role: 'assistant', parentID: 'msg_x', providerID: 'github-copilot', modelID: 'gpt-5.6-terra', cost: 0.01, tokens,
    path: { cwd: '/proj/a' }, time: { created: t0 + 200, completed: t0 + 4_000 },
  }));
  db.close();

  const store = new OpenCodeStore(file, 30 * 86_400_000);
  const sources = store.refresh(now);
  assert.equal(store.error, null);
  assert.equal(sources.length, 2);
  assert.ok(sources.every((s) => s.sessionId === 'ses_root'));

  const stats = aggregate(sources, '1h', now);
  assert.equal(stats.totals.requests, 2);
  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.sessions[0].tool, 'opencode');
  assert.equal(stats.sessions[0].title, 'Fix bug');
  assert.equal(stats.sessions[0].reportedCost, 0.5);
  assert.equal(stats.sessions[0].subagentRequests, 1);
  assert.equal(stats.byTool[0].tool, 'opencode');
  assert.equal(stats.byTool[0].prompts, 1);
  // Session scope includes the subagent session's requests.
  assert.equal(aggregate(sources, '1h', now, { session: 'ses_root' }).totals.requests, 2);
  assert.equal(stats.totals.avgTurnMs, 9_000);
  assert.equal(stats.recent.find((r) => r.model === 'github-copilot/claude-sonnet-5')?.latencyMs, 2_000);
  assert.ok(Math.abs(stats.totals.cost - 0.04) < 1e-9);

  // Second refresh with no changes keeps the same data.
  assert.equal(aggregate(store.refresh(now), '1h', now).totals.requests, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('aggregate keeps Claude and OpenCode sessions apart', () => {
  const st = newFileState();
  applyLine(st, line({ sessionId: 'same', cwd: '/p', type: 'assistant', uuid: 'a', timestamp: '2026-10-15T10:00:00.000Z', message: { id: 'm', model: 'claude-opus-5-5', usage } }));
  const oc = parseMessage(ocRow({ session_id: 'same', time_created: Date.parse('2026-10-15T10:00:00.000Z') })).record!;
  const stats = aggregate([
    sourceFromTranscript('/x/same.jsonl', st),
    { tool: 'opencode', sessionId: 'same', cwd: '/p', title: null, reportedCost: null, lastWriteMs: 0, subagent: false, requests: [oc], turns: [], prompts: [] },
  ], '1h', Date.parse('2026-10-15T10:30:00.000Z'));
  assert.equal(stats.sessions.length, 2);
  assert.deepEqual(stats.byTool.map((t) => t.tool), ['claude', 'opencode']);
});

test('CloudCliSessions maps an app id to its provider ids, including superseded ones', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const { CloudCliSessions } = await import('./cloudcli.js');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-cc-'));
  const file = path.join(dir, 'auth.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (session_id TEXT NOT NULL, provider TEXT NOT NULL, provider_session_id TEXT);
    CREATE TABLE superseded_provider_sessions (provider_session_id TEXT NOT NULL, provider TEXT NOT NULL, session_id TEXT NOT NULL);
    INSERT INTO sessions VALUES ('app-1', 'claude', 'claude-new'), ('app-2', 'opencode', NULL);
    INSERT INTO superseded_provider_sessions VALUES ('claude-old', 'claude', 'app-1');`);
  db.close();

  const sessions = new CloudCliSessions(file);
  assert.deepEqual(sessions.resolve('app-1').sort(), ['app-1', 'claude-new', 'claude-old']);
  assert.deepEqual(sessions.resolve('claude-new').sort(), ['claude-new', 'claude-old']);
  assert.deepEqual(sessions.resolve('app-2'), ['app-2']);
  assert.deepEqual(sessions.resolve('unknown'), ['unknown']);
  assert.deepEqual(new CloudCliSessions(path.join(dir, 'missing.db')).resolve('app-1'), ['app-1']);
});

test('CloudCliSessions still resolves the current id without the superseded table', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const { CloudCliSessions } = await import('./cloudcli.js');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-cc-'));
  const file = path.join(dir, 'auth.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (session_id TEXT NOT NULL, provider TEXT NOT NULL, provider_session_id TEXT);
    INSERT INTO sessions VALUES ('app-1', 'claude', 'claude-new');`);
  db.close();

  assert.deepEqual(new CloudCliSessions(file).resolve('app-1').sort(), ['app-1', 'claude-new']);
});
