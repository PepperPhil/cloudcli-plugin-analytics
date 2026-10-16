/**
 * Analytics plugin — module entry point.
 * Real-time cost, cache hit rate, token usage and latency for Claude Code and OpenCode,
 * Claude plan limits, and PRISM session health.
 */

import type { PluginAPI, PluginContext } from './types.js';

// ── Response shapes (mirror collector.ts output; do not import server code) ─

interface Tokens { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }
interface Summary {
  tokens: Tokens;
  totalTokens: number;
  cost: number;
  unpricedRequests: number;
  requests: number;
  cacheHitRate: number | null;
  latency: { p50: number | null; p95: number | null; avg: number | null; samples: number };
}
interface Stats {
  range: Range;
  /** Every id the open session is known by in the tools' data; null on older plugin servers. */
  currentSessionIds?: string[] | null;
  generatedAt: number;
  bucketMs: number;
  totals: Summary & { sessions: number; activeSessions: number; avgTurnMs: number | null; turns: number; prompts: number };
  lastHour: { cost: number; requests: number };
  series: { t: number; cost: number; tokens: number; cacheHitRate: number | null; latencyP50: number | null; requests: number }[];
  byTool: (Summary & { tool: Tool; sessions: number; prompts: number })[];
  byModel: (Summary & { model: string; tool: Tool })[];
  byProject: (Summary & { project: string; cwd: string })[];
  sessions: (Summary & {
    tool: Tool; sessionId: string; title: string | null; project: string; cwd: string;
    lastActivity: number; active: boolean; reportedCost: number | null; subagentRequests: number;
  })[];
  recent: { ts: number; tool: Tool; model: string; project: string; cost: number | null; latencyMs: number | null; tokens: number; cacheHitRate: number | null; sidechain: boolean }[];
  tools: Record<Tool, { available: boolean; error: string | null }>;
  prices?: PricesInfo;
}
interface PricesInfo { asOf: string; file: string; loaded: boolean; overrides: number; errors: string[] }

interface LimitWindow { kind: string; label: string; percent: number; severity: string; resetsAt: string | null }
type LimitsResult = { ok: true; plan: string | null; limits: LimitWindow[] } | { ok: false; error: string };

interface PrismReport {
  project: string;
  display_name: string;
  session_count: number;
  overall_grade: string;
  overall_score: number;
  dimensions: Record<string, { grade: string; score: number }>;
  top_issues: { severity: string; category: string; description: string }[];
}
type HealthResult =
  | { ok: true; version: string | null; reports: PrismReport[]; generatedAt: number }
  | { ok: false; notInstalled: boolean; error: string };

type Range = '1h' | '24h' | '7d' | '30d';
const RANGES: Range[] = ['1h', '24h', '7d', '30d'];
type Tool = 'claude' | 'opencode';
const TOOL_FILTERS: [Tool | 'all', string][] = [['all', 'all tools'], ['claude', 'Claude Code'], ['opencode', 'OpenCode']];
const TOOL_NAMES: Record<Tool, string> = { claude: 'Claude Code', opencode: 'OpenCode' };
const TOOL_TAGS: Record<Tool, string> = { claude: 'CC', opencode: 'OC' };
const INTERVALS: [number, string][] = [[5_000, '5s'], [15_000, '15s'], [60_000, '1m'], [0, 'off']];

// ── Theme (matches starter conventions) ─────────────────────────────────

const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

interface ThemeColors { bg: string; surface: string; border: string; text: string; muted: string; accent: string; cache: string; latency: string; ok: string; warn: string; bad: string }

function themeColors(dark: boolean): ThemeColors {
  return dark
    ? { bg: '#08080f', surface: '#0e0e1a', border: '#1a1a2c', text: '#e2e0f0', muted: '#6b6894', accent: '#fbbf24', cache: '#34d399', latency: '#60a5fa', ok: '#10b981', warn: '#f59e0b', bad: '#f43f5e' }
    : { bg: '#fafaf9', surface: '#ffffff', border: '#e8e6f0', text: '#0f0e1a', muted: '#7d7998', accent: '#d97706', cache: '#059669', latency: '#2563eb', ok: '#059669', warn: '#d97706', bad: '#e11d48' };
}

// ── Formatting helpers ──────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function fmtCost(n: number | null): string {
  if (n === null) return '—';
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(r: number | null): string {
  return r === null ? '—' : `${(r * 100).toFixed(1)}%`;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function fmtBucket(t: number, bucketMs: number): string {
  const d = new Date(t);
  if (bucketMs >= 86_400_000) return d.toLocaleDateString();
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/^github-copilot\//, 'copilot/');
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

function cacheColor(c: ThemeColors, r: number | null): string {
  if (r === null) return c.muted;
  if (r >= 0.8) return c.ok;
  if (r >= 0.5) return c.warn;
  return c.bad;
}

function toolTag(c: ThemeColors, tool: Tool): string {
  const color = tool === 'claude' ? c.accent : c.latency;
  return `<span title="${TOOL_NAMES[tool]}" style="display:inline-block;font-size:0.56rem;padding:0 4px;margin-right:6px;border:1px solid ${color};border-radius:2px;color:${color}">${TOOL_TAGS[tool]}</span>`;
}

// ── Section renderers ───────────────────────────────────────────────────

function card(c: ThemeColors, title: string, body: string, extra = ''): string {
  return `
    <div style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:16px;margin-bottom:12px;${extra}">
      <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">${title}</div>
      ${body}
    </div>`;
}

function tile(c: ThemeColors, label: string, value: string, sub: string, color = c.text): string {
  return `
    <div style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:14px 16px;min-width:0">
      <div style="font-size:0.6rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase">${label}</div>
      <div style="font-size:1.45rem;font-weight:600;color:${color};margin:6px 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${value}</div>
      <div style="font-size:0.66rem;color:${c.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>
    </div>`;
}

function renderTiles(c: ThemeColors, s: Stats): string {
  const t = s.totals;
  const unpriced = t.unpricedRequests ? ` · ${t.unpricedRequests} unpriced` : '';
  const writes = t.tokens.cacheWrite5m + t.tokens.cacheWrite1h;
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:12px">
      ${tile(c, `cost · ${s.range}`, fmtCost(t.cost), `last hour ${fmtCost(s.lastHour.cost)}${unpriced}`, c.accent)}
      ${tile(c, 'tokens', fmtTokens(t.totalTokens), `in ${fmtTokens(t.tokens.input)} · out ${fmtTokens(t.tokens.output)}`)}
      ${tile(c, 'cache hit rate', fmtPct(t.cacheHitRate), `read ${fmtTokens(t.tokens.cacheRead)} · write ${fmtTokens(writes)}`, cacheColor(c, t.cacheHitRate))}
      ${tile(c, 'latency p50', fmtMs(t.latency.p50), `p95 ${fmtMs(t.latency.p95)} · turn avg ${fmtMs(t.avgTurnMs)}`, c.latency)}
      ${tile(c, 'requests', String(t.requests), `${t.sessions} sessions · ${t.activeSessions} active`)}
    </div>`;
}

function barChart(
  c: ThemeColors,
  s: Stats,
  value: (p: Stats['series'][number]) => number | null,
  color: (v: number | null) => string,
  label: (p: Stats['series'][number]) => string,
  fixedMax?: number,
): string {
  const vals = s.series.map(value);
  const max = fixedMax ?? Math.max(0, ...vals.map((v) => v ?? 0));
  const bars = s.series.map((p, i) => {
    const v = vals[i];
    const h = v === null || max <= 0 ? 0 : Math.max(v > 0 ? 3 : 0, Math.round((v / max) * 100));
    const title = esc(`${fmtBucket(p.t, s.bucketMs)} — ${label(p)}`);
    return `<div title="${title}" style="flex:1;display:flex;align-items:flex-end;height:70px;min-width:0">
      <div style="width:100%;height:${h}%;background:${color(v)};border-radius:1px"></div>
    </div>`;
  }).join('');
  const first = s.series[0];
  const last = s.series[s.series.length - 1];
  return `
    <div style="display:flex;gap:2px;align-items:flex-end">${bars}</div>
    <div style="display:flex;justify-content:space-between;font-size:0.6rem;color:${c.muted};margin-top:6px">
      <span>${first ? esc(fmtBucket(first.t, s.bucketMs)) : ''}</span><span>${last ? esc(fmtBucket(last.t, s.bucketMs)) : ''}</span>
    </div>`;
}

function renderCharts(c: ThemeColors, s: Stats): string {
  const maxCost = Math.max(0, ...s.series.map((p) => p.cost));
  const cost = card(c, `cost per bucket <span style="float:right;letter-spacing:0">peak ${fmtCost(maxCost)}</span>`,
    barChart(c, s, (p) => p.cost, () => c.accent, (p) => `${fmtCost(p.cost)} · ${p.requests} req · ${fmtTokens(p.tokens)} tok`));
  const cache = card(c, 'cache hit rate',
    barChart(c, s, (p) => p.cacheHitRate, (v) => cacheColor(c, v), (p) => `${fmtPct(p.cacheHitRate)} · ${p.requests} req`, 1));
  const maxLat = Math.max(0, ...s.series.map((p) => p.latencyP50 ?? 0));
  const latency = card(c, `latency p50 <span style="float:right;letter-spacing:0">peak ${fmtMs(maxLat || null)}</span>`,
    barChart(c, s, (p) => p.latencyP50, () => c.latency, (p) => `p50 ${fmtMs(p.latencyP50)} · ${p.requests} req`));
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:0 12px">${cost}${cache}${latency}</div>`;
}

function table(c: ThemeColors, head: string[], rows: string[][], alignRightFrom = 1): string {
  const th = head.map((h, i) => `<th style="text-align:${i >= alignRightFrom ? 'right' : 'left'};font-weight:400;color:${c.muted};padding:4px 6px;border-bottom:1px solid ${c.border};white-space:nowrap">${h}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((cell, i) => `<td style="text-align:${i >= alignRightFrom ? 'right' : 'left'};padding:5px 6px;border-bottom:1px solid ${c.border};white-space:nowrap;${i === 0 ? 'max-width:320px;overflow:hidden;text-overflow:ellipsis' : ''}">${cell}</td>`).join('')}</tr>`).join('');
  return `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.72rem">${th ? `<thead><tr>${th}</tr></thead>` : ''}<tbody>${tr}</tbody></table></div>`;
}

function empty(c: ThemeColors, msg: string): string {
  return `<div style="font-size:0.75rem;color:${c.muted}">${esc(msg)}</div>`;
}

function hit(c: ThemeColors, r: number | null): string {
  return `<span style="color:${cacheColor(c, r)}">${fmtPct(r)}</span>`;
}

function renderTools(c: ThemeColors, s: Stats): string {
  if (s.byTool.length < 2) return '';
  return card(c, 'by tool', table(c,
    ['tool', 'sessions', 'prompts', 'requests', 'tokens', 'cache hit', 'p50', 'cost'],
    s.byTool.map((t) => [
      `${toolTag(c, t.tool)}${TOOL_NAMES[t.tool]}`, String(t.sessions), String(t.prompts), String(t.requests),
      fmtTokens(t.totalTokens), hit(c, t.cacheHitRate), fmtMs(t.latency.p50), fmtCost(t.cost),
    ])));
}

function renderModels(c: ThemeColors, s: Stats): string {
  if (!s.byModel.length) return card(c, 'by model', empty(c, 'No requests in this range.'));
  return card(c, 'by model', table(c,
    ['model', 'requests', 'tokens', 'cache hit', 'p50', 'p95', 'cost'],
    s.byModel.map((m) => [
      `${toolTag(c, m.tool)}${esc(shortModel(m.model))}`, String(m.requests), fmtTokens(m.totalTokens), hit(c, m.cacheHitRate),
      fmtMs(m.latency.p50), fmtMs(m.latency.p95), m.unpricedRequests === m.requests ? '—' : fmtCost(m.cost),
    ])));
}

function renderProjects(c: ThemeColors, s: Stats): string {
  if (s.byProject.length < 2) return '';
  return card(c, 'by project', table(c,
    ['project', 'requests', 'tokens', 'cache hit', 'p50', 'cost'],
    s.byProject.slice(0, 12).map((p) => [
      `<span title="${esc(p.cwd)}">${esc(p.project)}</span>`, String(p.requests), fmtTokens(p.totalTokens),
      hit(c, p.cacheHitRate), fmtMs(p.latency.p50), fmtCost(p.cost),
    ])));
}

function renderSessions(c: ThemeColors, s: Stats, currentSession: string | null): string {
  if (!s.sessions.length) return card(c, 'sessions', empty(c, 'No sessions in this range.'));
  const current = new Set(s.currentSessionIds ?? (currentSession ? [currentSession] : []));
  const rows = s.sessions.slice(0, 20).map((x) => {
    const dot = x.active
      ? `<span title="active (written in the last 2 min)" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c.ok};margin-right:6px;box-shadow:0 0 6px ${c.ok}"></span>`
      : `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c.border};margin-right:6px"></span>`;
    const name = esc(x.title || x.sessionId.slice(0, 8));
    const mark = current.has(x.sessionId) ? ` <span style="color:${c.accent}">◂ current</span>` : '';
    const sub = x.subagentRequests ? ` <span style="color:${c.muted}">(+${x.subagentRequests} sub)</span>` : '';
    const reportedTitle = x.tool === 'claude'
      ? "Claude Code's own cost counter for the latest process of this session (resets on resume)"
      : "OpenCode's stored cost for this session, all time, excluding subagent sessions";
    return [
      `${dot}${toolTag(c, x.tool)}<span title="${esc(x.sessionId)}">${name}</span>${mark}`,
      `<span title="${esc(x.cwd)}">${esc(x.project)}</span>`,
      `${x.requests}${sub}`, fmtTokens(x.totalTokens), hit(c, x.cacheHitRate), fmtMs(x.latency.p50),
      fmtCost(x.cost),
      x.reportedCost === null ? '—' : `<span title="${reportedTitle}">${fmtCost(x.reportedCost)}</span>`,
      fmtAgo(x.lastActivity),
    ];
  });
  return card(c, 'sessions', table(c,
    ['session', 'project', 'requests', 'tokens', 'cache hit', 'p50', 'cost (range)', 'reported', 'last'],
    rows, 2));
}

function renderRecent(c: ThemeColors, s: Stats): string {
  if (!s.recent.length) return '';
  return card(c, 'latest requests', table(c,
    ['time', 'model', 'project', 'tokens', 'cache hit', 'latency', 'cost'],
    s.recent.map((r) => [
      `${new Date(r.ts).toLocaleTimeString()}${r.sidechain ? ` <span style="color:${c.muted}">sub</span>` : ''}`,
      `${toolTag(c, r.tool)}${esc(shortModel(r.model))}`, esc(r.project), fmtTokens(r.tokens), hit(c, r.cacheHitRate), fmtMs(r.latencyMs), fmtCost(r.cost),
    ]), 3));
}

// ── Plan limits ─────────────────────────────────────────────────────────

function fmtUntil(iso: string | null): string {
  const ms = iso ? Date.parse(iso) - Date.now() : NaN;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'resets now';
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  return `resets in ${d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`}`;
}

function limitColor(c: ThemeColors, pct: number): string {
  if (pct >= 90) return c.bad;
  if (pct >= 70) return c.warn;
  return c.ok;
}

function renderLimits(c: ThemeColors, l: LimitsResult | null): string {
  if (!l) return '';
  if (!l.ok) return card(c, 'claude plan limits', empty(c, l.error));
  const title = `claude plan limits${l.plan ? ` · ${esc(l.plan)}` : ''}`;
  if (!l.limits.length) return card(c, title, empty(c, 'The usage endpoint returned no limits.'));
  const rows = l.limits.map((w) => {
    const color = limitColor(c, w.percent);
    const reset = w.resetsAt ? new Date(w.resetsAt).toLocaleString() : '';
    return `
      <div style="display:grid;grid-template-columns:minmax(90px,170px) minmax(60px,1fr) 42px;gap:10px;align-items:center;font-size:0.72rem;margin-top:8px">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(w.label)}</span>
        <div style="height:8px;background:${c.border};border-radius:2px;overflow:hidden">
          <div style="width:${Math.min(100, w.percent)}%;height:100%;background:${color}"></div>
        </div>
        <span style="text-align:right;color:${color}">${Math.round(w.percent)}%</span>
      </div>
      <div title="${esc(reset)}" style="font-size:0.62rem;color:${c.muted};margin-top:2px">${esc(fmtUntil(w.resetsAt))}</div>`;
  }).join('');
  return card(c, title, `<div style="margin-top:-8px">${rows}</div>`);
}

// ── Prices ──────────────────────────────────────────────────────────────

function renderPriceWarnings(c: ThemeColors, s: Stats): string {
  const unpriced = s.byModel.filter((m) => m.unpricedRequests > 0);
  const errors = s.prices?.errors ?? [];
  if (!unpriced.length && !errors.length) return '';
  const file = esc(s.prices?.file ?? '~/.config/cloudcli-analytics/prices.json');
  const models = unpriced.map((m) => `${toolTag(c, m.tool)}${esc(m.model)} <span style="color:${c.muted}">(${m.unpricedRequests} req)</span>`).join('<br>');
  // OpenCode estimates are priced by the bare model id, without the provider prefix.
  const exampleKey = unpriced[0]?.model.split('/').pop() || 'model-name';
  const example = esc(JSON.stringify({ [exampleKey]: { input: 3, output: 15, cacheRead: 0.3 } }));
  return card(c, 'prices', `<div style="font-size:0.72rem;line-height:1.6">
    ${unpriced.length ? `<div>No price for these models, so their cost is left out:</div><div style="margin:6px 0">${models}</div>
      <div style="color:${c.muted}">Add them to <code>${file}</code> in $ per million tokens; cache writes derive from input, cacheRead defaults to 0.1× input:</div>
      <code style="display:block;margin-top:4px;color:${c.muted};white-space:pre-wrap;word-break:break-all">${example}</code>` : ''}
    ${errors.map((e) => `<div style="color:${c.warn}">⚠ ${file}: ${esc(e)}</div>`).join('')}
  </div>`);
}

// ── Session health (PRISM) ──────────────────────────────────────────────

const DIMENSIONS: Record<string, string> = {
  token_efficiency: 'token efficiency',
  tool_health: 'tool health',
  context_hygiene: 'context hygiene',
  claude_md_adherence: 'CLAUDE.md adherence',
  session_continuity: 'session continuity',
};

function dimensionLabel(key: string): string {
  return DIMENSIONS[key] ?? key.replace(/_/g, ' ');
}

function scoreColor(c: ThemeColors, score: number): string {
  if (score >= 85) return c.ok;
  if (score >= 70) return c.warn;
  return c.bad;
}

function severityColor(c: ThemeColors, severity: string): string {
  const s = severity.toLowerCase();
  if (s === 'high' || s === 'critical') return c.bad;
  if (s === 'medium') return c.warn;
  return c.muted;
}

function renderReport(c: ThemeColors, r: PrismReport): string {
  const color = scoreColor(c, r.overall_score);
  const dims = Object.entries(r.dimensions).map(([key, d]) => `
    <div style="display:grid;grid-template-columns:minmax(110px,170px) minmax(60px,1fr) 34px 26px;gap:10px;align-items:center;font-size:0.72rem;margin-top:8px">
      <span>${esc(dimensionLabel(key))}</span>
      <div style="height:8px;background:${c.border};border-radius:2px;overflow:hidden">
        <div style="width:${Math.max(0, Math.min(100, d.score))}%;height:100%;background:${scoreColor(c, d.score)}"></div>
      </div>
      <span style="text-align:right">${Math.round(d.score)}</span>
      <span style="color:${scoreColor(c, d.score)}">${esc(d.grade)}</span>
    </div>`).join('');
  const issues = r.top_issues.length
    ? r.top_issues.map((i) => `
      <div style="display:grid;grid-template-columns:60px minmax(90px,140px) 1fr;gap:10px;font-size:0.72rem;padding:5px 0;border-bottom:1px solid ${c.border}">
        <span style="color:${severityColor(c, i.severity)};text-transform:uppercase;font-size:0.62rem">${esc(i.severity)}</span>
        <span style="color:${c.muted}">${esc(dimensionLabel(i.category))}</span>
        <span style="word-break:break-word">${esc(i.description)}</span>
      </div>`).join('')
    : empty(c, 'No issues found.');
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:12px">
      ${tile(c, 'overall health', esc(r.overall_grade), `${r.overall_score.toFixed(1)} / 100 · ${r.session_count} sessions`, color)}
    </div>
    ${card(c, 'dimensions', dims)}
    ${card(c, 'top issues', issues)}`;
}

/** Directory name, or the last two segments where names repeat (e.g. two `homeassistant` checkouts). */
function uniqueLabels(paths: string[]): Map<string, string> {
  const base = (p: string) => projectLabel(p);
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(base(p), (counts.get(base(p)) ?? 0) + 1);
  return new Map(paths.map((p) => [p, (counts.get(base(p)) ?? 0) > 1 ? p.replace(/\/+$/, '').split('/').slice(-2).join('/') : base(p)]));
}

function renderOverview(c: ThemeColors, reports: PrismReport[]): string {
  const sorted = [...reports].sort((a, b) => a.overall_score - b.overall_score);
  const labels = uniqueLabels(sorted.map((r) => r.display_name));
  return card(c, 'all projects · worst first', table(c,
    ['project', 'weakest', 'top issue', 'grade', 'score', 'sessions'],
    sorted.map((r) => {
      const weakest = Object.entries(r.dimensions).sort(([, a], [, b]) => a.score - b.score)[0];
      const issue = r.top_issues[0];
      return [
        `<span title="${esc(r.display_name)}">${esc(labels.get(r.display_name) ?? r.display_name)}</span>`,
        weakest ? `${esc(dimensionLabel(weakest[0]))} <span style="color:${scoreColor(c, weakest[1].score)}">${Math.round(weakest[1].score)}</span>` : '—',
        issue ? `<span title="${esc(issue.description)}" style="color:${severityColor(c, issue.severity)}">${esc(issue.description.slice(0, 70))}${issue.description.length > 70 ? '…' : ''}</span>` : '—',
        `<span style="color:${scoreColor(c, r.overall_score)}">${esc(r.overall_grade)}</span>`,
        r.overall_score.toFixed(1), String(r.session_count),
      ];
    }), 3));
}

function renderHealth(c: ThemeColors, h: HealthResult | null, loading: boolean, single: boolean): string {
  if (!h) return card(c, 'session health', empty(c, loading ? 'Running PRISM…' : ''));
  if (!h.ok) {
    if (!h.notInstalled) return card(c, 'session health', `<div style="font-size:0.75rem;color:${c.warn}">⚠ ${esc(h.error)}</div>`);
    return card(c, 'session health', `<div style="font-size:0.75rem;line-height:1.6">
      Session health is scored by <a href="https://github.com/jakeefr/prism" target="_blank" rel="noopener noreferrer" style="color:${c.accent}">PRISM</a>,
      a local Python CLI (3.11+): token efficiency, tool health, context hygiene, CLAUDE.md adherence and session continuity.
      <div style="margin-top:8px">Install it, then press refresh:</div>
      <code style="display:block;margin-top:4px;color:${c.muted}">pipx install prism-cc</code>
    </div>`);
  }
  if (!h.reports.length) return card(c, 'session health', empty(c, 'PRISM found no Claude Code sessions here.'));
  return single && h.reports.length === 1 ? renderReport(c, h.reports[0]) : renderOverview(c, h.reports);
}

// ── Controls ────────────────────────────────────────────────────────────

interface ViewState {
  page: 'usage' | 'health';
  /** Health covers the selected project, or every project when none is selected or 'all' is picked. */
  healthScope: 'project' | 'all';
  range: Range;
  scope: 'all' | 'project' | 'session';
  tool: Tool | 'all';
  intervalMs: number;
}

/**
 * The id the open session has in the tools' own data. CloudCLI's `session.id`
 * is its app id, which differs from the Claude/OpenCode id on disk; older
 * hosts don't send `providerSessionId`, so fall back to `id` there.
 */
function sessionKey(ctx: PluginContext): string | null {
  return ctx.session ? ctx.session.providerSessionId || ctx.session.id : null;
}

/** CloudCLI passes an opaque project id as `name`, so label projects by their directory. */
function projectLabel(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p || 'project';
}

function pill(c: ThemeColors, active: boolean, action: string, value: string, label: string, disabled = false, title = ''): string {
  return `<button data-action="${action}" data-value="${value}" ${disabled ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}
    style="font:inherit;font-size:0.68rem;padding:3px 9px;border-radius:3px;cursor:${disabled ? 'not-allowed' : 'pointer'};
    border:1px solid ${active ? c.accent : c.border};background:${active ? c.accent : 'transparent'};
    color:${active ? c.bg : disabled ? c.border : c.text}">${label}</button>`;
}

function healthProject(v: ViewState, ctx: PluginContext): string | null {
  return v.healthScope === 'project' && ctx.project ? ctx.project.path : null;
}

function renderHeader(c: ThemeColors, v: ViewState, ctx: PluginContext, status: string, live: boolean): string {
  const pages = `<div style="display:flex;gap:4px">${pill(c, v.page === 'usage', 'page', 'usage', 'usage')}${pill(c, v.page === 'health', 'page', 'health', 'health', false, 'Session health scored by PRISM')}</div>`;
  const title = `
      <div style="display:flex;align-items:center;gap:8px;margin-right:auto">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${live ? c.ok : c.muted};${live ? `box-shadow:0 0 8px ${c.ok}` : ''}"></span>
        <span style="font-size:0.95rem;font-weight:600">Analytics</span>
        <span style="font-size:0.66rem;color:${c.muted}">${status}</span>
      </div>`;
  const projectPill = (active: boolean, action: string) => pill(c, active, action, 'project', ctx.project ? esc(projectLabel(ctx.project.path)) : 'project', !ctx.project,
    ctx.project ? `Only this project directory: ${ctx.project.path}` : 'No project selected');
  if (v.page === 'health') {
    return `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px">
      ${title}${pages}
      <div style="display:flex;gap:4px">
        ${pill(c, !healthProject(v, ctx), 'health-scope', 'all', 'all projects')}
        ${projectPill(!!healthProject(v, ctx), 'health-scope')}
      </div>
      ${pill(c, false, 'prism-refresh', '', 'refresh', false, 'Re-run the PRISM analysis')}
    </div>`;
  }
  return `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px">
      ${title}${pages}
      <div style="display:flex;gap:4px">${RANGES.map((r) => pill(c, v.range === r, 'range', r, r)).join('')}</div>
      <div style="display:flex;gap:4px">${TOOL_FILTERS.map(([t, l]) => pill(c, v.tool === t, 'tool', t, l)).join('')}</div>
      <div style="display:flex;gap:4px">
        ${pill(c, v.scope === 'all', 'scope', 'all', 'all projects')}
        ${projectPill(v.scope === 'project', 'scope')}
        ${pill(c, v.scope === 'session', 'scope', 'session', 'this session', !ctx.session, ctx.session ? `Only the open session: ${ctx.session.title}` : 'No session open')}
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        <span style="font-size:0.62rem;color:${c.muted}">refresh</span>
        ${INTERVALS.map(([ms, l]) => pill(c, v.intervalMs === ms, 'interval', String(ms), l)).join('')}
      </div>
    </div>`;
}

// ── Mount / unmount ─────────────────────────────────────────────────────

export function mount(container: HTMLElement, api: PluginAPI): void {
  const view: ViewState = { page: 'usage', healthScope: 'project', range: '24h', scope: 'all', tool: 'all', intervalMs: 5_000 };
  let stats: Stats | null = null;
  let limits: LimitsResult | null = null;
  let health: HealthResult | null = null;
  let healthLoading = false;
  let healthSeq = 0;
  /** Project the shown health report belongs to ('' = all projects). */
  let healthFor: string | null = null;
  let error: string | null = null;
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  let alive = true;

  const root = document.createElement('div');
  container.appendChild(root);

  function render(): void {
    const ctx = api.context;
    const c = themeColors(ctx.theme === 'dark');
    root.style.cssText = `font-family:${MONO};background:${c.bg};color:${c.text};padding:18px;min-height:100%;box-sizing:border-box;overflow:auto;height:100%`;
    if (view.page === 'health') {
      const status = healthLoading ? 'analyzing…'
        : health?.ok ? `PRISM ${health.version ? `v${esc(health.version)} ` : ''}· analyzed ${new Date(health.generatedAt).toLocaleTimeString()}` : '';
      root.innerHTML = renderHeader(c, view, ctx, status, false)
        + renderHealth(c, health, healthLoading, !!healthProject(view, ctx))
        + `<div style="font-size:0.6rem;color:${c.muted};margin-top:4px">Scored locally by PRISM from ~/.claude/projects (Claude Code only). Results are cached for 5 minutes; refresh re-runs the analysis.</div>`;
      return;
    }
    let body = '';
    if (error) body += card(c, 'error', `<div style="font-size:0.75rem;color:${c.warn}">⚠ ${esc(error)}</div>`);
    const oc = stats?.tools?.opencode;
    if (oc && view.tool !== 'claude') {
      if (oc.error) body += card(c, 'opencode', `<div style="font-size:0.75rem;color:${c.warn}">⚠ Could not read the OpenCode database: ${esc(oc.error)}</div>`);
      else if (!oc.available && view.tool === 'opencode') body += card(c, 'opencode', empty(c, 'No OpenCode database found (~/.local/share/opencode/opencode.db).'));
    }
    if (view.tool !== 'opencode') body += renderLimits(c, limits);
    if (stats) {
      const p = stats.prices;
      const priceNote = p
        ? ` Built-in prices as of ${esc(p.asOf)}${p.overrides ? `; ${p.overrides} own price${p.overrides === 1 ? '' : 's'} from ${esc(p.file)}` : ''}.`
        : '';
      body += renderTiles(c, stats) + renderPriceWarnings(c, stats) + renderCharts(c, stats) + renderTools(c, stats) + renderSessions(c, stats, sessionKey(ctx))
        + `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:0 12px">${renderModels(c, stats)}${renderProjects(c, stats)}</div>`
        + renderRecent(c, stats)
        + `<div style="font-size:0.6rem;color:${c.muted};margin-top:4px">Claude Code costs are estimates from public per-token prices.${priceNote} OpenCode costs are OpenCode's own per-message figures; for GitHub Copilot these are API-equivalent, since Copilot bills by subscription and premium requests ("prompts"). "reported" is each tool's own session counter (Claude Code's resets on resume). Latency = request sent → first response block written. Plan limits come from Anthropic's usage endpoint with your Claude login; everything else is read locally (~/.claude/projects, ~/.local/share/opencode).</div>`;
    }
    const status = stats ? `updated ${new Date(stats.generatedAt).toLocaleTimeString()}` : loading ? 'loading…' : '';
    root.innerHTML = renderHeader(c, view, ctx, status, view.intervalMs > 0) + body;
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (alive && view.page === 'usage' && view.intervalMs > 0) timer = setTimeout(load, view.intervalMs);
  }

  async function load(): Promise<void> {
    const my = ++seq;
    loading = true;
    const ctx = api.context;
    const qs = new URLSearchParams({ range: view.range, tool: view.tool });
    if (view.scope === 'project' && ctx.project?.path) qs.set('project', ctx.project.path);
    const session = sessionKey(ctx);
    if (view.scope === 'session' && session) qs.set('session', session);
    if (session) qs.set('current', session);
    // Cached for a minute by the server, so polling with the stats is cheap.
    const limitsRequest = view.tool === 'opencode' ? null : (api.rpc('GET', '/limits') as Promise<LimitsResult>)
      .catch((err: Error): LimitsResult => ({ ok: false, error: err.message || 'Plan limits unavailable' }));
    try {
      const data = (await api.rpc('GET', `/stats?${qs}`)) as Stats & { error?: string };
      if (my !== seq || !alive) return;
      if (data?.error) throw new Error(data.error);
      stats = data;
      error = null;
    } catch (err) {
      if (my !== seq || !alive) return;
      error = (err as Error).message || 'Failed to load stats';
    }
    loading = false;
    render();
    schedule();
    // Limits need a network round trip; neither the stats nor the next poll wait for them.
    if (limitsRequest) {
      const result = await limitsRequest;
      if (my !== seq || !alive) return;
      limits = result;
      render();
    }
  }

  async function loadHealth(refresh = false): Promise<void> {
    const my = ++healthSeq;
    const project = healthProject(view, api.context);
    // Never show another project's report while the new one loads.
    if (healthFor !== (project ?? '')) health = null;
    healthLoading = true;
    render();
    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    if (refresh) qs.set('refresh', '1');
    let result: HealthResult;
    try {
      result = (await api.rpc('GET', `/prism?${qs}`)) as HealthResult;
    } catch (err) {
      result = { ok: false, notInstalled: false, error: (err as Error).message || 'Failed to load session health' };
    }
    if (my !== healthSeq || !alive) return;
    health = result;
    healthFor = project ?? '';
    healthLoading = false;
    if (view.page === 'health') render();
  }

  function onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    const value = btn.dataset.value ?? '';
    switch (btn.dataset.action) {
      case 'page':
        view.page = value as ViewState['page'];
        if (timer) clearTimeout(timer);
        timer = null;
        if (view.page === 'health') void loadHealth();
        else {
          render();
          void load();
        }
        return;
      case 'health-scope':
        view.healthScope = value as ViewState['healthScope'];
        void loadHealth();
        return;
      case 'prism-refresh':
        void loadHealth(true);
        return;
      case 'range':
        view.range = value as Range;
        stats = null;
        break;
      case 'scope':
        view.scope = value as ViewState['scope'];
        break;
      case 'tool':
        view.tool = value as ViewState['tool'];
        stats = null;
        break;
      case 'interval':
        view.intervalMs = Number(value);
        render();
        schedule();
        return;
    }
    render();
    void load();
  }

  // Pause polling while the tab is hidden.
  function onVisibility(): void {
    if (document.hidden) {
      if (timer) clearTimeout(timer);
      timer = null;
    } else if (view.page === 'usage' && view.intervalMs > 0) {
      void load();
    }
  }

  root.addEventListener('click', onClick);
  document.addEventListener('visibilitychange', onVisibility);
  const unsub = api.onContextChange(() => {
    if (view.scope === 'project' && !api.context.project) view.scope = 'all';
    if (view.scope === 'session' && !api.context.session) view.scope = 'all';
    if (view.page === 'health') {
      // Theme and session changes don't affect the report; only a new project does.
      if (healthFor !== (healthProject(view, api.context) ?? '')) void loadHealth();
      else render();
      return;
    }
    render();
    void load();
  });

  render();
  void load();

  (container as any)._analyticsCleanup = () => {
    alive = false;
    if (timer) clearTimeout(timer);
    root.removeEventListener('click', onClick);
    document.removeEventListener('visibilitychange', onVisibility);
    unsub();
  };
}

export function unmount(container: HTMLElement): void {
  (container as any)._analyticsCleanup?.();
  container.innerHTML = '';
}
