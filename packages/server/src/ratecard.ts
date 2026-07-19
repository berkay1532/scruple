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

export function matchRoute(
  rateCard: RateCard,
  method: string,
  path: string,
): { price: string; atomic: bigint } | null {
  const price = rateCard[`${method.toUpperCase()} ${path}`];
  if (price === undefined) return null;
  return { price, atomic: priceToAtomic(price) };
}
