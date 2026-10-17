/** Token counts for one API request (or a sum of them). */
export interface Tokens {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** $ per million tokens. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** A model's rates, plus higher rates once a request's prompt exceeds `above` tokens. */
export interface ModelPrice extends Rates {
  tiers?: (Rates & { above: number })[];
}

/** Where a model's price came from; 'family' means a guess from the model family. */
export type PriceBasis = 'own' | 'litellm' | 'builtin' | 'family';

/** Date of the built-in price table, shown in the UI so stale prices are visible. */
export const PRICES_AS_OF = '2026-10';

/** Anthropic's standard cache multipliers: reads 0.1×, 5m writes 1.25×, 1h writes 2× input. */
function rates(input: number, output: number, cacheRead = input * 0.1): Rates {
  return { input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

// Offline fallback when the LiteLLM list is unavailable. First match wins, so
// exact versions come before the family rules that guess for unknown versions.
// Anthropic first-party rates as of PRICES_AS_OF.
const PRICES: [RegExp, ModelPrice, boolean][] = [
  [/(fable|mythos)-5-1/, rates(10, 50, 0.25), true],
  [/(fable|mythos)-5(?!-\d(?!\d))/, rates(10, 50, 1), true],
  [/fable|mythos/, rates(10, 50, 1), false],
  [/opus-5-5/, rates(4, 20, 0.2), true],
  [/opus-5(?!-\d(?!\d))|opus-4-[5-8]/, rates(5, 25), true],
  [/opus-4-[01]\b|3-opus/, rates(15, 75), true],
  [/opus/, rates(5, 25), false],
  [/sonnet-5-5/, rates(2, 10, 0.1), true],
  [/sonnet-5(?!-\d(?!\d))/, rates(2, 10, 0.2), true],
  [/sonnet-5/, rates(2, 10, 0.2), false],
  [/sonnet-4/, rates(3, 15), true],
  [/sonnet/, rates(3, 15), false],
  [/haiku-5-5/, { ...rates(0.1, 0.5, 0.01), tiers: [{ above: 100_000, ...rates(0.5, 2.5, 0.05) }] }, true],
  [/haiku-4-5/, rates(1, 5), true],
  [/haiku-3-5|3-5-haiku/, rates(0.8, 4), true],
  [/haiku/, rates(0.25, 1.25, 0.03), false],
];

/** User price entry: $ per million tokens. `cacheRead` defaults to 0.1× input. */
export interface PriceOverride {
  match: string;
  input: number;
  output: number;
  cacheRead?: number;
}

let overrides: [string, ModelPrice][] = [];
let remote: Map<string, ModelPrice> = new Map();
/** Bumped whenever prices change, so estimates made earlier can be recomputed. */
let generation = 0;

export function priceGeneration(): number {
  return generation;
}

/**
 * Validates the user's price file (`{ "<model substring>": { input, output, cacheRead? } }`)
 * and returns the usable entries plus one message per rejected entry.
 */
export function parseOverrides(json: unknown): { entries: PriceOverride[]; errors: string[] } {
  const entries: PriceOverride[] = [];
  const errors: string[] = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { entries, errors: ['expected an object keyed by model name'] };
  }
  const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  for (const [match, value] of Object.entries(json as Record<string, unknown>)) {
    const v = value as Record<string, unknown> | null;
    if (!match || !v || !isRate(v.input) || !isRate(v.output) || (v.cacheRead !== undefined && !isRate(v.cacheRead))) {
      errors.push(`"${match}": needs numeric input and output ($ per million tokens)`);
      continue;
    }
    entries.push({ match: match.toLowerCase(), input: v.input, output: v.output, cacheRead: v.cacheRead as number | undefined });
  }
  return { entries, errors };
}

/** Replaces the user prices; they are checked before every other source, in file order. */
export function setPriceOverrides(entries: PriceOverride[]): void {
  overrides = entries.map((e) => [e.match, rates(e.input, e.output, e.cacheRead)]);
  generation += 1;
}

/** Replaces the downloaded price list (keys are lower-case model ids). */
export function setRemotePrices(prices: Map<string, ModelPrice>): void {
  remote = prices;
  generation += 1;
}

/** Ids a model may be listed under: as is, without a date suffix, and without a provider prefix. */
function candidateIds(model: string): string[] {
  const lower = model.toLowerCase().replace(/\[[^\]]*\]$/, '');
  const bare = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;
  return [...new Set([lower, bare, bare.replace(/-\d{8}$/, '')])];
}

function findPrice(model: string): { price: ModelPrice; basis: PriceBasis } | null {
  const lower = model.toLowerCase();
  const own = overrides.find(([match]) => lower.includes(match));
  if (own) return { price: own[1], basis: 'own' };
  for (const id of candidateIds(model)) {
    const hit = remote.get(id);
    if (hit) return { price: hit, basis: 'litellm' };
  }
  const entry = PRICES.find(([re]) => re.test(model));
  return entry ? { price: entry[1], basis: entry[2] ? 'builtin' : 'family' } : null;
}

/** Where `model`'s price comes from, or null when it has none. */
export function priceBasis(model: string): PriceBasis | null {
  return findPrice(model)?.basis ?? null;
}

const M = 1_000_000;

export function zeroTokens(): Tokens {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

export function addTokens(a: Tokens, b: Tokens): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheWrite5m += b.cacheWrite5m;
  a.cacheWrite1h += b.cacheWrite1h;
  a.cacheRead += b.cacheRead;
}

/** All prompt-side tokens (fresh input + cache writes + cache reads). */
export function promptTokens(t: Tokens): number {
  return t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
}

export function totalTokens(t: Tokens): number {
  return promptTokens(t) + t.output;
}

/** Share of prompt tokens served from cache, 0..1; null when there was no prompt. */
export function cacheHitRate(t: Tokens): number | null {
  const p = promptTokens(t);
  return p > 0 ? t.cacheRead / p : null;
}

/** Estimated cost in dollars for one request, or null when the model has no price. */
export function estimateCost(model: string, t: Tokens, fast = false): number | null {
  const found = findPrice(model);
  if (!found) return null;
  const prompt = promptTokens(t);
  // The highest tier the prompt exceeds applies to the whole request.
  const tier = (found.price.tiers ?? []).filter((x) => prompt > x.above).sort((a, b) => b.above - a.above)[0];
  const r: Rates = tier ?? found.price;
  const mult = fast ? 2 : 1;
  return (
    mult *
    (t.input * r.input +
      t.output * r.output +
      t.cacheWrite5m * r.cacheWrite5m +
      t.cacheWrite1h * r.cacheWrite1h +
      t.cacheRead * r.cacheRead) /
    M
  );
}
