import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Session health from PRISM (https://github.com/jakeefr/prism, `pipx install
// prism-cc`): grades Claude Code sessions per project across five dimensions
// and lists the top issues. The scoring lives in the Python CLI; this module
// runs `prism analyze --json` and caches the report.
// Adapted from jakeefr/cloudcli-plugin-prism (MIT).

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const CACHE_MS = 5 * 60_000;
/** A crash on a half-written transcript should clear up without a manual refresh. */
const ERROR_CACHE_MS = 20_000;

export interface PrismDimension {
  grade: string;
  score: number;
  [extra: string]: unknown;
}

export interface PrismIssue {
  severity: string;
  category: string;
  description: string;
}

export interface PrismReport {
  project: string;
  display_name: string;
  session_count: number;
  overall_grade: string;
  overall_score: number;
  dimensions: Record<string, PrismDimension>;
  top_issues: PrismIssue[];
}

export type HealthResult =
  | { ok: true; version: string | null; reports: PrismReport[]; generatedAt: number }
  | { ok: false; notInstalled: boolean; error: string };

export function buildAnalyzeArgs(projectPath: string | null): string[] {
  return projectPath ? ['analyze', '--json', '--project', projectPath] : ['analyze', '--json'];
}

export function parseVersion(stdout: string): string | null {
  return stdout.match(/prism\s+v(\S+)/)?.[1] ?? null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The CLI prints through a rich console, so take the outermost JSON array.
 * Reports are normalised field by field, so a PRISM schema change degrades
 * to missing values instead of breaking the tab.
 */
export function parseReports(stdout: string): PrismReport[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('prism returned no JSON report');
  const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('prism returned unexpected JSON');
  const reports: PrismReport[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== 'object' || typeof r.overall_score !== 'number' || typeof r.display_name !== 'string') continue;
    const dimensions: Record<string, PrismDimension> = {};
    if (r.dimensions && typeof r.dimensions === 'object') {
      for (const [key, d] of Object.entries(r.dimensions as Record<string, any>)) {
        if (typeof d?.score === 'number' && typeof d?.grade === 'string') dimensions[key] = { grade: d.grade, score: d.score };
      }
    }
    reports.push({
      project: str(r.project),
      display_name: r.display_name,
      session_count: num(r.session_count),
      overall_grade: str(r.overall_grade) || '?',
      overall_score: r.overall_score,
      dimensions,
      top_issues: (Array.isArray(r.top_issues) ? r.top_issues : [])
        .filter((i: any) => typeof i?.description === 'string')
        .map((i: any) => ({ severity: str(i.severity) || 'info', category: str(i.category), description: i.description })),
    });
  }
  return reports;
}

/** The host's PATH often lacks pipx/pip user bins, so check those too. */
function findPrism(home: string): string {
  const candidates = process.platform === 'win32'
    ? []
    : [path.join(home, '.local', 'bin', 'prism'), '/usr/local/bin/prism', '/opt/homebrew/bin/prism'];
  return candidates.find((p) => fs.existsSync(p)) ?? 'prism';
}

/** prism's rich console must print plain, unwrapped JSON; Windows Python needs its profile vars. */
function prismEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', TERM: 'dumb', COLUMNS: '4096' };
  if (process.platform === 'win32') {
    const profile = process.env.USERPROFILE || home;
    env.USERPROFILE ??= profile;
    env.APPDATA ??= path.join(profile, 'AppData', 'Roaming');
    env.LOCALAPPDATA ??= path.join(profile, 'AppData', 'Local');
    env.TEMP ??= path.join(profile, 'AppData', 'Local', 'Temp');
    env.TMP ??= env.TEMP;
    env.SystemRoot ??= process.env.windir || 'C:\\Windows';
  }
  return env;
}

type Runner = (args: string[]) => Promise<string>;

class NotInstalled extends Error {}

export class PrismClient {
  private readonly run: Runner;
  private cache = new Map<string, { at: number; data: HealthResult }>();
  private inflight = new Map<string, Promise<HealthResult>>();
  private version: string | null | undefined;

  constructor(home = process.env.HOME || os.homedir(), run?: Runner) {
    this.run = run ?? ((args) => new Promise((resolve, reject) => {
      // argv, never a shell string: the project path cannot inject anything.
      execFile(findPrism(home), args, { env: prismEnv(home), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
        (err, stdout, stderr) => {
          if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') reject(new NotInstalled());
          else if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
          else resolve(stdout);
        });
    }));
  }

  /** Report for one project directory, or every project when `projectPath` is null. */
  get(projectPath: string | null, refresh = false): Promise<HealthResult> {
    const key = projectPath ?? '';
    const hit = this.cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < (hit.data.ok ? CACHE_MS : ERROR_CACHE_MS)) return Promise.resolve(hit.data);
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.load(projectPath).then((data) => {
        // A missing CLI is re-checked on every request, so installing it needs no restart.
        if (data.ok || !data.notInstalled) this.cache.set(key, { at: Date.now(), data });
        this.inflight.delete(key);
        return data;
      });
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async load(projectPath: string | null): Promise<HealthResult> {
    try {
      if (this.version === undefined) {
        try {
          this.version = parseVersion(await this.run(['--version']));
        } catch (err) {
          // Only a missing CLI matters here; a build without --version can still analyze.
          if (err instanceof NotInstalled) throw err;
          this.version = null;
        }
      }
      const reports = parseReports(await this.run(buildAnalyzeArgs(projectPath)));
      return { ok: true, version: this.version, reports, generatedAt: Date.now() };
    } catch (err) {
      if (err instanceof NotInstalled) {
        this.version = undefined;
        return { ok: false, notInstalled: true, error: 'PRISM is not installed (pipx install prism-cc).' };
      }
      // A project without Claude Code transcripts is empty, not broken.
      if (/no claude code sessions found/i.test((err as Error).message)) {
        return { ok: true, version: this.version ?? null, reports: [], generatedAt: Date.now() };
      }
      return { ok: false, notInstalled: false, error: `prism failed: ${(err as Error).message}` };
    }
  }
}
