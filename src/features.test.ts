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
    { accessToken: 't', expired: true, plan: 'pro' });
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
