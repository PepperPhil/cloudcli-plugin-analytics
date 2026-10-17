import fs from 'node:fs';
import path from 'node:path';
import { ModelPrice, Rates } from './pricing.js';

// Model prices from LiteLLM's community-maintained list, which uses the same
// model ids as Claude Code. Fetched in the background, cached on disk and
// refreshed daily; the built-in table covers the time before the first fetch
// and any period without network.

export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_MS = 24 * 3_600_000;
const RETRY_MS = 30 * 60_000;
const MAX_BYTES = 10 * 1024 * 1024;
/** Providers whose list ids match the model names Claude Code and OpenCode record. */
const PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'deepseek', 'xai', 'mistral']);

const PER_M = 1_000_000;

function perM(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v * PER_M : null;
}

/** Reads one rate set; `suffix` selects a tier such as `_above_100k_tokens`. */
function readRates(e: Record<string, unknown>, suffix = ''): Rates | null {
  const input = perM(e[`input_cost_per_token${suffix}`]);
  const output = perM(e[`output_cost_per_token${suffix}`]);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: perM(e[`cache_read_input_token_cost${suffix}`]) ?? input * 0.1,
    cacheWrite5m: perM(e[`cache_creation_input_token_cost${suffix}`]) ?? input * 1.25,
    cacheWrite1h: perM(e[suffix ? `cache_creation_input_token_cost_above_1hr${suffix}` : 'cache_creation_input_token_cost_above_1hr']) ?? input * 2,
  };
}

/** Maps LiteLLM's JSON to prices keyed by lower-case model id; malformed entries are skipped. */
export function parseLiteLlm(json: unknown): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const [id, raw] of Object.entries(json as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.litellm_provider !== 'string' || !PROVIDERS.has(e.litellm_provider)) continue;
    const base = readRates(e);
    if (!base) continue;
    const tiers: ModelPrice['tiers'] = [];
    for (const key of Object.keys(e)) {
      const m = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
      const tier = m ? readRates(e, `_above_${m[1]}k_tokens`) : null;
      if (tier) tiers.push({ above: Number(m![1]) * 1000, ...tier });
    }
    const price = tiers.length ? { ...base, tiers } : base;
    const key = id.toLowerCase();
    out.set(key, price);
    // Some providers are listed as `gemini/<model>`; lookups use the bare model id.
    const bare = key.slice(key.lastIndexOf('/') + 1);
    if (bare !== key && !out.has(bare) && !(json as Record<string, unknown>)[bare]) out.set(bare, price);
  }
  return out;
}

/** A cached `[id, price]` pair, re-checked because the cache file is outside our control. */
function validEntry(e: unknown): e is [string, ModelPrice] {
  if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') return false;
  const p = e[1] as Record<string, unknown> | null;
  return !!p && ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k] as number));
}

export interface RemoteStatus {
  source: 'litellm';
  /** When the list in use was downloaded; null while only the built-in table applies. */
  fetchedAt: number | null;
  models: number;
  error: string | null;
}

/** Downloads, caches and periodically refreshes the list; `onPrices` receives every new list. */
export class RemotePrices {
  status: RemoteStatus = { source: 'litellm', fetchedAt: null, models: 0, error: null };
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cacheFile: string,
    private readonly onPrices: (prices: Map<string, ModelPrice>) => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly url = LITELLM_URL,
  ) {}

  /** Loads the disk cache, then refreshes when it is missing or older than a day. */
  start(): void {
    try {
      const cached = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as { fetchedAt?: unknown; prices?: unknown };
      const prices = new Map(Array.isArray(cached.prices) ? cached.prices.filter(validEntry) : []);
      if (typeof cached.fetchedAt === 'number' && prices.size) this.apply(prices, cached.fetchedAt);
    } catch {
      /* no cache yet */
    }
    const age = this.status.fetchedAt === null ? Infinity : Date.now() - this.status.fetchedAt;
    this.schedule(age >= REFRESH_MS ? 0 : REFRESH_MS - age);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Fetches now; concurrent calls share one download. Never rejects. */
  refresh(): Promise<void> {
    this.inflight ??= this.download().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private schedule(ms: number): void {
    this.stop();
    this.timer = setTimeout(() => {
      void this.refresh().then(() => this.schedule(this.status.error ? RETRY_MS : REFRESH_MS));
    }, ms);
    this.timer.unref();
  }

  private apply(prices: Map<string, ModelPrice>, fetchedAt: number): void {
    this.status = { source: 'litellm', fetchedAt, models: prices.size, error: null };
    this.onPrices(prices);
  }

  private async download(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('price list too large');
      const data: unknown = JSON.parse(text);
      const prices = parseLiteLlm(data);
      if (!prices.size) throw new Error('price list has no usable entries');
      const fetchedAt = Date.now();
      this.apply(prices, fetchedAt);
      try {
        // Only the parsed entries, written atomically: a reader never sees a torn file.
        fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
        const tmp = `${this.cacheFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ fetchedAt, prices: [...prices] }));
        fs.renameSync(tmp, this.cacheFile);
      } catch {
        /* read-only home: keep the list in memory only */
      }
    } catch (err) {
      // Keep whatever list is in use; the status shows why it is not fresh.
      this.status = { ...this.status, error: `Price list update failed: ${(err as Error).message}` };
    }
  }
}
