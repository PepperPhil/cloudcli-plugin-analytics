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

// First match wins, so specific versions come before family fallbacks.
// Anthropic first-party rates as of 2026-10.
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
  const price = PRICES.find(([re]) => re.test(model))?.[1];
  if (!price) return null;
  let [inp, out, cr] = price;
  if (/haiku-5-5/.test(model) && promptTokens(t) > HAIKU_55_LONG_PROMPT) {
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
