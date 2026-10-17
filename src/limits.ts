import fs from 'node:fs';
import { DetectedPlan, detectPlan } from './subscriptions.js';

// Claude plan limits (5h session window, weekly caps) from the endpoint the
// Claude apps use. It is unofficial and may change, so the response is mapped
// defensively and every failure becomes a message instead of an exception.
// Adapted from HandyS11/cloudcli-plugin-claude-usage (MIT).

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 60_000;
const ERROR_CACHE_MS = 30_000;

export interface LimitWindow {
  kind: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
}

export interface Limits {
  plan: string | null;
  limits: LimitWindow[];
}

export type LimitsResult = ({ ok: true } & Limits) | { ok: false; error: string };

interface Credentials {
  accessToken: string;
  expired: boolean;
  plan: string | null;
  tier: string | null;
}

/** Reads the OAuth access token Claude Code stores; never uses or touches the refresh token. */
export function parseCredentials(json: unknown, nowMs: number): Credentials | null {
  const oauth = (json as any)?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string') return null;
  return {
    accessToken: oauth.accessToken,
    expired: typeof oauth.expiresAt === 'number' && oauth.expiresAt < nowMs,
    plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    tier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
  };
}

const KIND_LABELS: Record<string, string> = {
  session: 'session (5h)',
  weekly_all: 'weekly · all models',
  weekly_scoped: 'weekly',
};

export function normalizeUsage(raw: unknown, plan: string | null): Limits {
  const limits: LimitWindow[] = [];
  const rawLimits = (raw as any)?.limits;
  if (Array.isArray(rawLimits)) {
    for (const l of rawLimits) {
      if (typeof l?.kind !== 'string' || typeof l?.percent !== 'number' || !Number.isFinite(l.percent)) continue;
      const model = l.scope?.model?.display_name;
      const base = KIND_LABELS[l.kind] ?? l.kind.replace(/_/g, ' ');
      limits.push({
        kind: l.kind,
        label: typeof model === 'string' && model ? `${base} · ${model}` : base,
        percent: Math.max(0, l.percent),
        severity: typeof l.severity === 'string' ? l.severity : 'normal',
        resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
      });
    }
  }
  return { plan, limits };
}

export class LimitsClient {
  private cache: { at: number; ttl: number; data: LimitsResult } | null = null;
  private inflight: Promise<LimitsResult> | null = null;

  constructor(private readonly credentialsPath: string, private readonly fetchImpl: typeof fetch = fetch) {}

  get(): Promise<LimitsResult> {
    if (this.cache && Date.now() - this.cache.at < this.cache.ttl) return Promise.resolve(this.cache.data);
    this.inflight ??= this.load().then((data) => {
      this.cache = { at: Date.now(), ttl: data.ok ? CACHE_MS : ERROR_CACHE_MS, data };
      this.inflight = null;
      return data;
    });
    return this.inflight;
  }

  private async load(): Promise<LimitsResult> {
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
    } catch {
      return { ok: false, error: 'No Claude login found. Plan limits need Claude Code signed in with a claude.ai account.' };
    }
    const creds = parseCredentials(json, Date.now());
    if (!creds) return { ok: false, error: 'Claude Code is not signed in with a claude.ai account (API keys have no plan limits).' };
    if (creds.expired) return { ok: false, error: 'Claude login expired. Run any claude command to refresh it.' };
    try {
      const res = await this.fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `Claude login was rejected (HTTP ${res.status}). Run any claude command to refresh it.` };
      }
      if (!res.ok) return { ok: false, error: `Usage endpoint returned HTTP ${res.status}.` };
      return { ok: true, ...normalizeUsage(await res.json(), creds.plan) };
    } catch (err) {
      return { ok: false, error: `Usage endpoint unreachable: ${(err as Error).message}` };
    }
  }
}

/** The Claude plan of the signed-in account, from the credentials file; null when unknown. */
export function readPlan(credentialsPath: string): DetectedPlan | null {
  try {
    const creds = parseCredentials(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')), Date.now());
    return creds ? detectPlan(creds.plan, creds.tier) : null;
  } catch {
    return null;
  }
}
