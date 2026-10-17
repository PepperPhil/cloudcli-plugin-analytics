// Subscriptions against API-equivalent usage: what the requests in a range
// would have cost at API prices, compared with the matching share of the
// monthly subscription fee.

export type Currency = 'USD' | 'EUR';
export type SubscriptionTool = 'claude' | 'copilot';

export interface SubscriptionPrice {
  monthly: number;
  currency: Currency;
}

export interface Settings {
  /** undefined = use the detected plan's list price; null = don't compare. */
  claude?: SubscriptionPrice | null;
  /** Copilot can't be detected, so it is compared only once a price is set. */
  copilot?: SubscriptionPrice | null;
  /** Conversion for EUR prices; a user estimate, not a live rate. */
  usdPerEur: number;
}

export const DEFAULT_SETTINGS: Settings = { usdPerEur: 1.1 };

export interface DetectedPlan {
  key: 'pro' | 'max5x' | 'max20x' | 'team' | 'enterprise' | 'other';
  label: string;
  /** List price in USD per month; null when there is no single list price. */
  listPrice: number | null;
}

/** Claude list prices per month, USD. */
const CLAUDE_PLANS: Record<DetectedPlan['key'], { label: string; price: number | null }> = {
  pro: { label: 'Claude Pro', price: 20 },
  max5x: { label: 'Claude Max 5x', price: 100 },
  max20x: { label: 'Claude Max 20x', price: 200 },
  team: { label: 'Claude Team', price: null },
  enterprise: { label: 'Claude Enterprise', price: null },
  other: { label: 'Claude', price: null },
};

/** Maps the credentials' subscriptionType and rateLimitTier to a plan. */
export function detectPlan(subscriptionType: string | null, tier: string | null): DetectedPlan | null {
  if (!subscriptionType) return null;
  const type = subscriptionType.toLowerCase();
  const t = (tier ?? '').toLowerCase();
  let key: DetectedPlan['key'] = 'other';
  if (type === 'pro') key = 'pro';
  else if (type === 'max') key = t.includes('20x') ? 'max20x' : 'max5x';
  else if (type === 'team') key = 'team';
  else if (type === 'enterprise') key = 'enterprise';
  const plan = CLAUDE_PLANS[key];
  return { key, label: plan.label, listPrice: plan.price };
}

function parsePrice(v: unknown): SubscriptionPrice | null | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const p = v as Record<string, unknown>;
  if (!p || typeof p !== 'object' || typeof p.monthly !== 'number' || !Number.isFinite(p.monthly) || p.monthly < 0 || p.monthly > 100_000) return 'invalid';
  if (p.currency !== 'USD' && p.currency !== 'EUR') return 'invalid';
  return { monthly: p.monthly, currency: p.currency };
}

/** Validates settings from the UI or the settings file. */
export function parseSettings(json: unknown): { settings: Settings; error: string | null } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { settings: { ...DEFAULT_SETTINGS }, error: 'expected an object' };
  const j = json as Record<string, unknown>;
  const claude = parsePrice(j.claude);
  const copilot = parsePrice(j.copilot);
  if (claude === 'invalid' || copilot === 'invalid') {
    return { settings: { ...DEFAULT_SETTINGS }, error: 'a price needs monthly (number ≥ 0) and currency USD or EUR' };
  }
  const rate = j.usdPerEur === undefined ? DEFAULT_SETTINGS.usdPerEur : j.usdPerEur;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 10) {
    return { settings: { ...DEFAULT_SETTINGS }, error: 'usdPerEur must be a positive number' };
  }
  const settings: Settings = { usdPerEur: rate };
  if (claude !== undefined) settings.claude = claude;
  if (copilot !== undefined) settings.copilot = copilot;
  return { settings, error: null };
}

export interface Comparison {
  tool: SubscriptionTool;
  label: string;
  monthly: number;
  currency: Currency;
  /** Monthly fee in USD (EUR converted with the user's rate). */
  monthlyUsd: number;
  /** Where the fee comes from: the plan's list price or the user's entry. */
  priceSource: 'list' | 'own';
  /** Fee share for the range, USD. */
  share: number;
  /** API-equivalent cost of the tool's requests in the range, USD. */
  apiCost: number;
  /** apiCost / share; null when the share is 0. */
  ratio: number | null;
  /** API-equivalent cost of the last 30 days, USD, against one month's fee. */
  apiCost30d: number;
  ratio30d: number | null;
}

const MONTH_MS = 30 * 86_400_000;

/**
 * Compares each subscription with the API-equivalent cost of its tool.
 * `cost` and `cost30d` give a tool's cost in the range and over 30 days.
 */
export function compare(
  settings: Settings,
  plan: DetectedPlan | null,
  rangeMs: number,
  cost: Record<SubscriptionTool, number>,
  cost30d: Record<SubscriptionTool, number>,
): Comparison[] {
  const out: Comparison[] = [];
  const add = (tool: SubscriptionTool, label: string, price: SubscriptionPrice, priceSource: Comparison['priceSource']) => {
    const monthlyUsd = price.currency === 'EUR' ? price.monthly * settings.usdPerEur : price.monthly;
    const share = monthlyUsd * Math.min(rangeMs, MONTH_MS) / MONTH_MS;
    out.push({
      tool, label, monthly: price.monthly, currency: price.currency, monthlyUsd, priceSource, share,
      apiCost: cost[tool], ratio: share > 0 ? cost[tool] / share : null,
      apiCost30d: cost30d[tool], ratio30d: monthlyUsd > 0 ? cost30d[tool] / monthlyUsd : null,
    });
  };
  if (settings.claude !== null) {
    const label = plan?.label ?? 'Claude';
    if (settings.claude) add('claude', label, settings.claude, 'own');
    else if (plan?.listPrice != null) add('claude', label, { monthly: plan.listPrice, currency: 'USD' }, 'list');
  }
  if (settings.copilot) add('copilot', 'GitHub Copilot', settings.copilot, 'own');
  return out;
}
