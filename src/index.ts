/**
 * Analytics plugin — module entry point.
 * Real-time cost, cache hit rate, token usage and latency for Claude Code and OpenCode.
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
  generatedAt: number;
  bucketMs: number;
  totals: Summary & { sessions: number; activeSessions: number; avgTurnMs: number | null; turns: number };
  lastHour: { cost: number; requests: number };
  series: { t: number; cost: number; tokens: number; cacheHitRate: number | null; latencyP50: number | null; requests: number }[];
  byTool: (Summary & { tool: Tool; sessions: number; turns: number })[];
  byModel: (Summary & { model: string; tool: Tool })[];
  byProject: (Summary & { project: string; cwd: string })[];
  sessions: (Summary & {
    tool: Tool; sessionId: string; title: string | null; project: string; cwd: string;
    lastActivity: number; active: boolean; reportedCost: number | null; subagentRequests: number;
  })[];
  recent: { ts: number; tool: Tool; model: string; project: string; cost: number | null; latencyMs: number | null; tokens: number; cacheHitRate: number | null; sidechain: boolean }[];
  tools: Record<Tool, { available: boolean; error: string | null }>;
}

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
      `${toolTag(c, t.tool)}${TOOL_NAMES[t.tool]}`, String(t.sessions), String(t.turns), String(t.requests),
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
  const rows = s.sessions.slice(0, 20).map((x) => {
    const dot = x.active
      ? `<span title="active (written in the last 2 min)" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c.ok};margin-right:6px;box-shadow:0 0 6px ${c.ok}"></span>`
      : `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c.border};margin-right:6px"></span>`;
    const name = esc(x.title || x.sessionId.slice(0, 8));
    const mark = x.sessionId === currentSession ? ` <span style="color:${c.accent}">◂ current</span>` : '';
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

// ── Controls ────────────────────────────────────────────────────────────

interface ViewState {
  range: Range;
  scope: 'all' | 'project';
  tool: Tool | 'all';
  intervalMs: number;
}

function pill(c: ThemeColors, active: boolean, action: string, value: string, label: string, disabled = false): string {
  return `<button data-action="${action}" data-value="${value}" ${disabled ? 'disabled' : ''}
    style="font:inherit;font-size:0.68rem;padding:3px 9px;border-radius:3px;cursor:${disabled ? 'not-allowed' : 'pointer'};
    border:1px solid ${active ? c.accent : c.border};background:${active ? c.accent : 'transparent'};
    color:${active ? c.bg : disabled ? c.border : c.text}">${label}</button>`;
}

function renderHeader(c: ThemeColors, v: ViewState, ctx: PluginContext, s: Stats | null, loading: boolean): string {
  const live = v.intervalMs > 0;
  const status = s ? `updated ${new Date(s.generatedAt).toLocaleTimeString()}` : loading ? 'loading…' : '';
  return `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-right:auto">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${live ? c.ok : c.muted};${live ? `box-shadow:0 0 8px ${c.ok}` : ''}"></span>
        <span style="font-size:0.95rem;font-weight:600">Analytics</span>
        <span style="font-size:0.66rem;color:${c.muted}">${status}</span>
      </div>
      <div style="display:flex;gap:4px">${RANGES.map((r) => pill(c, v.range === r, 'range', r, r)).join('')}</div>
      <div style="display:flex;gap:4px">${TOOL_FILTERS.map(([t, l]) => pill(c, v.tool === t, 'tool', t, l)).join('')}</div>
      <div style="display:flex;gap:4px">
        ${pill(c, v.scope === 'all', 'scope', 'all', 'all projects')}
        ${pill(c, v.scope === 'project', 'scope', 'project', ctx.project ? esc(ctx.project.name) : 'project', !ctx.project)}
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        <span style="font-size:0.62rem;color:${c.muted}">refresh</span>
        ${INTERVALS.map(([ms, l]) => pill(c, v.intervalMs === ms, 'interval', String(ms), l)).join('')}
      </div>
    </div>`;
}

// ── Mount / unmount ─────────────────────────────────────────────────────

export function mount(container: HTMLElement, api: PluginAPI): void {
  const view: ViewState = { range: '24h', scope: 'all', tool: 'all', intervalMs: 5_000 };
  let stats: Stats | null = null;
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
    let body = '';
    if (error) body += card(c, 'error', `<div style="font-size:0.75rem;color:${c.warn}">⚠ ${esc(error)}</div>`);
    const oc = stats?.tools?.opencode;
    if (oc && view.tool !== 'claude') {
      if (oc.error) body += card(c, 'opencode', `<div style="font-size:0.75rem;color:${c.warn}">⚠ Could not read the OpenCode database: ${esc(oc.error)}</div>`);
      else if (!oc.available && view.tool === 'opencode') body += card(c, 'opencode', empty(c, 'No OpenCode database found (~/.local/share/opencode/opencode.db).'));
    }
    if (stats) {
      body += renderTiles(c, stats) + renderCharts(c, stats) + renderTools(c, stats) + renderSessions(c, stats, ctx.session?.id ?? null)
        + `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:0 12px">${renderModels(c, stats)}${renderProjects(c, stats)}</div>`
        + renderRecent(c, stats)
        + `<div style="font-size:0.6rem;color:${c.muted};margin-top:4px">Claude Code costs are estimates from public per-token prices. OpenCode costs are OpenCode's own per-message figures; for GitHub Copilot these are API-equivalent, since Copilot bills by subscription and premium requests ("prompts"). "reported" is each tool's own session counter (Claude Code's resets on resume). Latency = request sent → first response block written. Data stays local (~/.claude/projects, ~/.local/share/opencode).</div>`;
    }
    root.innerHTML = renderHeader(c, view, ctx, stats, loading) + body;
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (alive && view.intervalMs > 0) timer = setTimeout(load, view.intervalMs);
  }

  async function load(): Promise<void> {
    const my = ++seq;
    loading = true;
    const ctx = api.context;
    const project = view.scope === 'project' && ctx.project ? ctx.project.path : '';
    const qs = new URLSearchParams({ range: view.range, tool: view.tool });
    if (project) qs.set('project', project);
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
  }

  function onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    const value = btn.dataset.value ?? '';
    switch (btn.dataset.action) {
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
    } else if (view.intervalMs > 0) {
      void load();
    }
  }

  root.addEventListener('click', onClick);
  document.addEventListener('visibilitychange', onVisibility);
  const unsub = api.onContextChange(() => {
    if (view.scope === 'project' && !api.context.project) view.scope = 'all';
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
