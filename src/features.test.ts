import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LimitsClient, normalizeUsage, parseCredentials } from './limits.js';
import { PrismClient, buildAnalyzeArgs, parseReports, parseVersion } from './prism.js';
import { estimateCost, parseOverrides, setPriceOverrides, zeroTokens } from './pricing.js';
import { RequestRecord, repriced } from './collector.js';
import { priceGeneration } from './pricing.js';

const M = 1_000_000;

test('parseOverrides keeps valid entries and reports the rest', () => {
  const { entries, errors } = parseOverrides({
    'claude-opus-6': { input: 6, output: 30 },
    'My-Model': { input: 1, output: 2, cacheRead: 0.5 },
    broken: { input: 'x', output: 1 },
    negative: { input: -1, output: 1 },
  });
  assert.deepEqual(entries.map((e) => e.match), ['claude-opus-6', 'my-model']);
  assert.equal(errors.length, 2);
  assert.deepEqual(parseOverrides([]).errors.length, 1);
});

test('user prices win over the built-in table and price unknown models', () => {
  const t = { ...zeroTokens(), input: M, output: M, cacheRead: M };
  assert.equal(estimateCost('claude-opus-6-0', t), 5 + 25 + 0.5, 'family fallback before overrides');
  assert.equal(estimateCost('acme-1', t), null);
  setPriceOverrides(parseOverrides({ 'opus-6': { input: 6, output: 30 }, acme: { input: 1, output: 2, cacheRead: 0.5 } }).entries);
  try {
    assert.equal(estimateCost('claude-opus-6-0', t), 6 + 30 + 0.6, 'cacheRead defaults to 0.1x input');
    assert.equal(estimateCost('ACME-1', t), 1 + 2 + 0.5);
  } finally {
    setPriceOverrides([]);
  }
});

test('estimated costs are redone when prices change, tool-reported costs are kept', () => {
  const tokens = { ...zeroTokens(), input: M };
  const estimated: RequestRecord = {
    id: 'a', tool: 'claude', ts: 0, sessionId: 's', cwd: '/p', model: 'acme-1', tokens, cost: null,
    estimate: { model: 'acme-1', fast: false, generation: priceGeneration() }, latencyMs: null, sidechain: false,
  };
  const reported: RequestRecord = { ...estimated, id: 'b', cost: 0.42, estimate: undefined };
  setPriceOverrides(parseOverrides({ acme: { input: 2, output: 2 } }).entries);
  try {
    assert.equal(repriced(estimated).cost, 2);
    assert.equal(repriced(reported).cost, 0.42);
  } finally {
    setPriceOverrides([]);
  }
  assert.equal(repriced(estimated).cost, null, 'removing the price removes the cost again');
});

test('parseCredentials reads the access token and expiry, nothing else', () => {
  const now = 1_000;
  assert.equal(parseCredentials({}, now), null);
  assert.deepEqual(parseCredentials({ claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: 500, subscriptionType: 'pro' } }, now),
    { accessToken: 't', expired: true, plan: 'pro', tier: null });
});

test('normalizeUsage maps known windows and skips malformed ones', () => {
  const data = normalizeUsage({
    limits: [
      { kind: 'session', percent: 13, severity: 'normal', resets_at: '2026-10-17T01:10:00Z' },
      { kind: 'weekly_scoped', percent: 40, scope: { model: { display_name: 'Opus' } } },
      { kind: 'weekly_all', percent: 'n/a' },
      null,
    ],
  }, 'pro');
  assert.equal(data.plan, 'pro');
  assert.deepEqual(data.limits.map((l) => [l.label, l.percent, l.resetsAt]), [
    ['session (5h)', 13, '2026-10-17T01:10:00Z'],
    ['weekly · Opus', 40, null],
  ]);
  assert.deepEqual(normalizeUsage({ unexpected: true }, null).limits, []);
});

function credentialsFile(oauth: object | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-limits-'));
  const file = path.join(dir, '.credentials.json');
  if (oauth) fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
  return file;
}

test('LimitsClient sends the bearer token, caches, and turns failures into messages', async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify({ limits: [{ kind: 'session', percent: 5 }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new LimitsClient(credentialsFile({ accessToken: 'tok', expiresAt: Date.now() + 60_000, subscriptionType: 'max' }), fakeFetch);
  const first = await client.get();
  assert.ok(first.ok && first.limits[0].percent === 5 && first.plan === 'max');
  await client.get();
  assert.equal(calls.length, 1, 'second call is served from cache');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\//);

  const missing = await new LimitsClient(credentialsFile(null), fakeFetch).get();
  assert.ok(!missing.ok && /No Claude login/.test(missing.error));
  const expired = await new LimitsClient(credentialsFile({ accessToken: 't', expiresAt: 1 }), fakeFetch).get();
  assert.ok(!expired.ok && /expired/.test(expired.error));
  const failing = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
  const http = await new LimitsClient(credentialsFile({ accessToken: 't' }), failing).get();
  assert.ok(!http.ok && /429/.test(http.error));
  const offline = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch;
  const net = await new LimitsClient(credentialsFile({ accessToken: 't' }), offline).get();
  assert.ok(!net.ok && /unreachable/.test(net.error));
});

const REPORT = {
  project: '-p', display_name: '/p', session_count: 3, overall_grade: 'B', overall_score: 80,
  dimensions: { tool_health: { grade: 'C', score: 65 } }, top_issues: [{ severity: 'high', category: 'tool_health', description: 'x' }],
};

test('prism helpers build argv and parse rich-console output', () => {
  assert.deepEqual(buildAnalyzeArgs(null), ['analyze', '--json']);
  assert.deepEqual(buildAnalyzeArgs('/a b'), ['analyze', '--json', '--project', '/a b']);
  assert.equal(parseVersion('prism v0.4.1\n'), '0.4.1');
  assert.deepEqual(parseReports(`noise\n${JSON.stringify([REPORT, { bogus: 1 }])}\n`), [REPORT]);
  // A schema change degrades to missing values instead of breaking the tab.
  assert.deepEqual(parseReports(JSON.stringify([{ display_name: '/q', overall_score: 50, session_count: '<b>', dimensions: { a: { score: 'x' } }, top_issues: null }])),
    [{ project: '', display_name: '/q', session_count: 0, overall_grade: '?', overall_score: 50, dimensions: {}, top_issues: [] }]);
  assert.throws(() => parseReports('nothing'), /no JSON/);
});

test('PrismClient caches per project, refreshes on demand, and reports a missing CLI', async () => {
  const runs: string[][] = [];
  const client = new PrismClient('/home/x', async (args) => {
    runs.push(args);
    return args[0] === '--version' ? 'prism v0.4.1' : JSON.stringify([REPORT]);
  });
  const first = await client.get('/p');
  assert.ok(first.ok && first.version === '0.4.1' && first.reports.length === 1);
  await client.get('/p');
  assert.equal(runs.filter((a) => a[0] === 'analyze').length, 1, 'cached');
  await client.get('/p', true);
  await client.get(null);
  assert.deepEqual(runs.filter((a) => a[0] === 'analyze'), [buildAnalyzeArgs('/p'), buildAnalyzeArgs('/p'), buildAnalyzeArgs(null)]);

  // A missing CLI comes from the real runner: empty PATH and a HOME without ~/.local/bin/prism.
  const savedPath = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-path-'));
  try {
    const absent = await new PrismClient(fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-home-'))).get(null);
    // Skipped where prism sits in a fixed system location the client always checks.
    if (!fs.existsSync('/usr/local/bin/prism') && !fs.existsSync('/opt/homebrew/bin/prism')) {
      assert.ok(!absent.ok && absent.notInstalled && /pipx install prism-cc/.test(absent.error));
    }
  } finally {
    process.env.PATH = savedPath;
  }

  const crashing = new PrismClient('/home/x', async (args) => {
    if (args[0] === '--version') return 'prism v0.4.1';
    throw new Error('Traceback: boom');
  });
  const crashed = await crashing.get('/p');
  const empty = await new PrismClient('/home/x', async (args) => {
    if (args[0] === '--version') return 'prism v0.4.1';
    throw new Error('No Claude Code sessions found. Have you used Claude Code yet?');
  }).get('/new');
  assert.ok(empty.ok && empty.reports.length === 0);
  assert.ok(!crashed.ok && !crashed.notInstalled && /boom/.test(crashed.error));

  const noVersion = await new PrismClient('/home/x', async (args) => {
    if (args[0] === '--version') throw new Error('unknown option --version');
    return JSON.stringify([REPORT]);
  }).get('/p');
  assert.ok(noVersion.ok && noVersion.version === null && noVersion.reports.length === 1);
});

test('long transcript lines take the fast path with the same result as a full parse', async () => {
  const { applyLine, newFileState } = await import('./collector.js');
  const pad = 'x'.repeat(3000);
  const ts = (s: number) => new Date(Date.UTC(2026, 9, 16, 10, 0, s)).toISOString();
  const head = { sessionId: 's1', cwd: '/p' };
  const lines = [
    JSON.stringify({ type: 'user', ...head, uuid: 'u0', timestamp: ts(0), message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'api-request', sessionId: 's1', id: 'r1', timestamp: ts(1), params: pad }),
    JSON.stringify({ parentUuid: 'u0', isSidechain: false, attachment: { type: 'hook', body: pad }, type: 'attachment', uuid: 'a1', timestamp: ts(2), ...head }),
    JSON.stringify({ parentUuid: 'a1', isSidechain: false, promptId: 'p', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: pad }] }, uuid: 't1', timestamp: ts(3), toolUseResult: { stdout: pad }, ...head }),
    // A long typed prompt has no tool result, so it must still be counted.
    JSON.stringify({ parentUuid: 't1', isSidechain: false, promptId: 'p', type: 'user', message: { role: 'user', content: pad }, uuid: 'u2', timestamp: ts(4), ...head }),
    // An assistant entry whose tool input happens to contain the key must not be skipped.
    JSON.stringify({ parentUuid: 'u2', isSidechain: false, type: 'assistant', requestRef: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', input: { toolUseResult: pad } }] }, uuid: 'm', timestamp: ts(5), ...head }),
  ];
  const st = newFileState();
  for (const l of lines) applyLine(st, l);
  assert.equal(st.apiRequestTs.get('r1'), Date.parse(ts(1)));
  assert.equal(st.uuidTs.get('a1'), Date.parse(ts(2)));
  assert.equal(st.uuidTs.get('t1'), Date.parse(ts(3)));
  assert.deepEqual(st.prompts, [Date.parse(ts(0)), Date.parse(ts(4))]);
  assert.equal(st.requests.length, 1);
  assert.equal(st.requests[0].latencyMs, 4000, 'latency measured from the fast-path api-request');
  assert.equal(st.lastTs, Date.parse(ts(5)));
});

test('LiteLLM list: exact ids, tiers, junk skipped, and it wins over the built-in table', async () => {
  const { parseLiteLlm } = await import('./remote-prices.js');
  const { setRemotePrices, priceBasis } = await import('./pricing.js');
  const list = parseLiteLlm({
    'claude-sonnet-5-5': { litellm_provider: 'anthropic', input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7 },
    'claude-haiku-5-5': {
      litellm_provider: 'anthropic', input_cost_per_token: 1e-7, output_cost_per_token: 5e-7,
      input_cost_per_token_above_100k_tokens: 5e-7, output_cost_per_token_above_100k_tokens: 2.5e-6,
    },
    'bedrock/claude-x': { litellm_provider: 'bedrock', input_cost_per_token: 1, output_cost_per_token: 1 },
    broken: { litellm_provider: 'anthropic', input_cost_per_token: 'free' },
    sample_spec: 'not an object',
  });
  assert.deepEqual([...list.keys()].sort(), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  const sonnet = list.get('claude-sonnet-5-5')!;
  assert.ok(Math.abs(sonnet.cacheRead - 0.1) < 1e-9 && Math.abs(sonnet.cacheWrite5m - 2.5) < 1e-9 && Math.abs(sonnet.cacheWrite1h - 4) < 1e-9);
  assert.equal(list.get('claude-haiku-5-5')!.tiers?.[0].above, 100_000);

  const t = { ...zeroTokens(), cacheRead: M };
  assert.equal(priceBasis('claude-opus-5'), 'builtin');
  assert.equal(priceBasis('claude-opus-7'), 'family');
  assert.equal(priceBasis('acme-1'), null);
  setRemotePrices(new Map([['claude-sonnet-5-5', { ...sonnet, cacheRead: 0.05 }]]));
  try {
    assert.equal(priceBasis('claude-sonnet-5-5-20261001'), 'litellm', 'date suffix stripped');
    assert.equal(estimateCost('claude-sonnet-5-5', t), 0.05);
    setPriceOverrides(parseOverrides({ 'sonnet-5-5': { input: 2, output: 10, cacheRead: 0.07 } }).entries);
    assert.equal(priceBasis('claude-sonnet-5-5'), 'own');
    assert.equal(estimateCost('claude-sonnet-5-5', t), 0.07);
  } finally {
    setPriceOverrides([]);
    setRemotePrices(new Map());
  }
  assert.equal(estimateCost('claude-sonnet-5-5', t), 0.1, 'built-in table corrected to 0.1');
  const long = { ...zeroTokens(), input: 200_000 };
  assert.ok(Math.abs(estimateCost('claude-haiku-5-5', long)! - 0.1) < 1e-9, 'long-prompt tier applies above 100k');
});

test('RemotePrices loads the disk cache, downloads, writes the cache, and keeps the list on failure', async () => {
  const { RemotePrices } = await import('./remote-prices.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-remote-'));
  const cacheFile = path.join(dir, 'sub', 'prices.json');
  const data = { 'claude-x-1': { litellm_provider: 'anthropic', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } };
  const got: number[] = [];
  const ok = (async () => new Response(JSON.stringify(data))) as unknown as typeof fetch;
  const a = new RemotePrices(cacheFile, (p) => got.push(p.size), ok, 'https://example.invalid/x.json');
  await a.refresh();
  assert.equal(a.status.models, 1);
  assert.ok(fs.existsSync(cacheFile));

  const failing = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
  const b = new RemotePrices(cacheFile, (p) => got.push(p.size), failing, 'https://example.invalid/x.json');
  b.start();
  b.stop();
  assert.equal(b.status.models, 1, 'served from the disk cache');
  await b.refresh();
  assert.equal(b.status.models, 1, 'a failed refresh keeps the cached list');
  assert.match(b.status.error ?? '', /503/);
  assert.deepEqual(got, [1, 1]);
});

test('subscriptions: plan detection, settings validation, and value against the fee', async () => {
  const { detectPlan, parseSettings, compare } = await import('./subscriptions.js');
  assert.equal(detectPlan('max', 'default_claude_max_20x')?.listPrice, 200);
  assert.equal(detectPlan('max', 'default_claude_max_5x')?.key, 'max5x');
  assert.equal(detectPlan('pro', 'default_claude_ai')?.listPrice, 20);
  assert.equal(detectPlan(null, null), null);

  assert.ok(parseSettings({ claude: { monthly: -1, currency: 'USD' } }).error);
  assert.ok(parseSettings({ copilot: { monthly: 10, currency: 'GBP' } }).error);
  assert.ok(parseSettings({ usdPerEur: 0 }).error);
  const { settings } = parseSettings({ claude: { monthly: 18, currency: 'EUR' }, copilot: { monthly: 10, currency: 'USD' }, usdPerEur: 1.1 });

  const week = 7 * 86_400_000;
  const [claude, copilot] = compare(settings, detectPlan('pro', null), week, { claude: 42, copilot: 0 }, { claude: 100, copilot: 5 });
  assert.equal(claude.label, 'Claude Pro');
  assert.ok(Math.abs(claude.monthlyUsd - 19.8) < 1e-9);
  assert.ok(Math.abs(claude.share - 19.8 * 7 / 30) < 1e-9);
  assert.ok(Math.abs(claude.ratio! - 42 / (19.8 * 7 / 30)) < 1e-9);
  assert.equal(copilot.ratio30d, 0.5);

  const listOnly = compare({ usdPerEur: 1.1 }, detectPlan('max', 'x_20x'), 30 * 86_400_000, { claude: 400, copilot: 0 }, { claude: 400, copilot: 0 });
  assert.deepEqual(listOnly.map((x) => [x.priceSource, x.ratio]), [['list', 2]]);
  assert.deepEqual(compare({ usdPerEur: 1.1, claude: null }, detectPlan('pro', null), week, { claude: 1, copilot: 1 }, { claude: 1, copilot: 1 }), []);
});

test('review fixes: dated ids stay exact, prefixed list keys match bare ids, feedback on a tool result is a prompt', async () => {
  const { priceBasis } = await import('./pricing.js');
  const { parseLiteLlm } = await import('./remote-prices.js');
  const { applyLine, newFileState } = await import('./collector.js');
  assert.equal(priceBasis('claude-sonnet-5-20261001'), 'builtin');
  assert.equal(priceBasis('claude-sonnet-5-7'), 'family');

  const list = parseLiteLlm({ 'gemini/gemini-9-pro': { litellm_provider: 'gemini', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } });
  assert.ok(list.has('gemini-9-pro') && list.has('gemini/gemini-9-pro'));

  const st = newFileState();
  const head = { sessionId: 's1', cwd: '/p' };
  applyLine(st, JSON.stringify({ type: 'user', ...head, uuid: 'u0', timestamp: '2026-10-16T10:00:00.000Z', message: { role: 'user', content: 'hi' } }));
  applyLine(st, JSON.stringify({ parentUuid: 'u0', isSidechain: false, promptId: 'p', type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(3000) }, { type: 'text', text: 'no, do it differently' }] },
    uuid: 'u1', timestamp: '2026-10-16T10:00:05.000Z', toolUseResult: 'rejected', ...head }));
  assert.equal(st.prompts.length, 2);
});
