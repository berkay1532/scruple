export class InvalidPriceError extends Error {
  constructor(price: string) {
    super(`Invalid price string: "${price}" (expected "$<decimal>", e.g. "$0.001")`);
    this.name = "InvalidPriceError";
  }
}

const PRICE_RE = /^\$(\d+(?:\.\d+)?)$/;

/** "$0.001" -> 1000n (6-decimal atomic USDC), rounded to nearest unit. */
export function priceToAtomic(price: string): bigint {
  const m = PRICE_RE.exec(price);
  if (!m) throw new InvalidPriceError(price);
  const [whole, frac = ""] = m[1].split(".");
  const fracPadded = (frac + "0000000").slice(0, 7); // 7th digit for rounding
  const atomic7 = BigInt(whole) * 10_000_000n + BigInt(fracPadded);
  return (atomic7 + 5n) / 10n; // round half-up to 6 decimals
}

/** 1000n -> "$0.001" (trailing zeros trimmed). */
export function formatAtomic(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `$${whole}.${frac}` : `$${whole}`;
}

export type RateCard = Record<string, string>;

/**
 * Normalizes a route path the same way for both rate-card keys and incoming
 * request paths, so lookups are insensitive to the trailing-slash and case
 * variations Express's default (non-strict, case-insensitive) routing
 * already treats as equivalent. Without this, e.g. `GET /api/quote/` or
 * `GET /API/quote` would fail to match a `GET /api/quote` rate-card entry
 * and be served for free.
 */
function normalizePath(path: string): string {
  const stripped = path.replace(/\/+$/, "");
  return (stripped || "/").toLowerCase();
}

/** Normalizes a "METHOD /path" rate-card key: method uppercased, path normalized. */
function normalizeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

/** Splits a "METHOD /path" rate-card key into its method and path parts. */
function splitKey(key: string): { method: string; path: string } {
  const spaceIdx = key.indexOf(" ");
  return spaceIdx === -1
    ? { method: "", path: key }
    : { method: key.slice(0, spaceIdx), path: key.slice(spaceIdx + 1) };
}

export function matchRoute(
  rateCard: RateCard,
  method: string,
  path: string,
): { price: string; atomic: bigint } | null {
  const wantKey = normalizeKey(method, path);
  for (const [key, price] of Object.entries(rateCard)) {
    const { method: keyMethod, path: keyPath } = splitKey(key);
    if (normalizeKey(keyMethod, keyPath) === wantKey) {
      return { price, atomic: priceToAtomic(price) };
    }
  }
  return null;
}

/**
 * Precomputes a normalized-key -> {price, atomic} lookup from a rate card,
 * eagerly validating every price string. Throws `InvalidPriceError` at
 * build time (e.g. server startup) rather than deferring the parse to
 * request time, where a malformed entry would otherwise crash the async
 * request handler on the first request that hits it.
 */
export function buildRateCardLookup(rateCard: RateCard): Map<string, { price: string; atomic: bigint }> {
  const lookup = new Map<string, { price: string; atomic: bigint }>();
  for (const [key, price] of Object.entries(rateCard)) {
    const { method, path } = splitKey(key);
    lookup.set(normalizeKey(method, path), { price, atomic: priceToAtomic(price) });
  }
  return lookup;
}

/** Looks up a request's method+path in a precomputed rate-card lookup. */
export function matchRouteInLookup(
  lookup: Map<string, { price: string; atomic: bigint }>,
  method: string,
  path: string,
): { price: string; atomic: bigint } | null {
  return lookup.get(normalizeKey(method, path)) ?? null;
}
