/** Token counts for one API request (or a sum of them). */
export interface Tokens {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** $ per million tokens: [input, output, cacheRead]. Cache writes derive from input. */
type Price = [number, number, number];

/** Date of the built-in price table, shown in the UI so stale prices are visible. */
export const PRICES_AS_OF = '2026-10';

// First match wins, so specific versions come before family fallbacks.
// Anthropic first-party rates as of PRICES_AS_OF.
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25]],
  [/fable|mythos/, [10, 50, 1]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus-4-[01]\b|3-opus/, [15, 75, 1.5]],
  [/opus/, [5, 25, 0.5]],
  [/sonnet-5/, [2, 10, 0.2]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-5-5/, [0.1, 0.5, 0.01]],
  [/haiku-4/, [1, 5, 0.1]],
  [/haiku-3-5|3-5-haiku/, [0.8, 4, 0.08]],
  [/haiku/, [0.25, 1.25, 0.03]],
];

/** User price entry: $ per million tokens. `cacheRead` defaults to 0.1× input. */
export interface PriceOverride {
  match: string;
  input: number;
  output: number;
  cacheRead?: number;
}

let overrides: [string, Price][] = [];
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

/** Replaces the user prices; they are checked before the built-in table, in file order. */
export function setPriceOverrides(entries: PriceOverride[]): void {
  overrides = entries.map((e) => [e.match, [e.input, e.output, e.cacheRead ?? e.input * 0.1]]);
  generation += 1;
}

function findPrice(model: string): { price: Price; builtIn: boolean } | null {
  const lower = model.toLowerCase();
  const own = overrides.find(([match]) => lower.includes(match));
  if (own) return { price: own[1], builtIn: false };
  const price = PRICES.find(([re]) => re.test(model))?.[1];
  return price ? { price, builtIn: true } : null;
}

const M = 1_000_000;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const HAIKU_55_LONG_PROMPT = 100_000;

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

/** Estimated cost in dollars for one request, or null when the model is not in the price table. */
export function estimateCost(model: string, t: Tokens, fast = false): number | null {
  const found = findPrice(model);
  if (!found) return null;
  let [inp, out, cr] = found.price;
  if (found.builtIn && /haiku-5-5/.test(model) && promptTokens(t) > HAIKU_55_LONG_PROMPT) {
    inp = 0.5;
    out = 2.5;
    cr = 0.05;
  }
  const mult = fast ? 2 : 1;
  return (
    mult *
    (t.input * inp +
      t.output * out +
      t.cacheWrite5m * inp * CACHE_WRITE_5M +
      t.cacheWrite1h * inp * CACHE_WRITE_1H +
      t.cacheRead * cr) /
    M
  );
}
