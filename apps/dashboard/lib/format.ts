// Pure formatting helpers — no React, no side effects. Mirrors the
// trailing-zero-trim convention in packages/server/src/ratecard.ts formatAtomic.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Formats an atomic (6-decimal) USDC amount as a dollar string, trimming trailing fractional zeros. */
export function formatUsd(atomic: bigint | string): string {
  const n = typeof atomic === "string" ? BigInt(atomic) : atomic;
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `$${whole}.${frac}` : `$${whole}`;
}

/** Truncates a hex string (address or hash) to its first 6 and last 4 characters. */
function shorten(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function shortAddr(a: string): string {
  return shorten(a);
}

export function shortHash(h: string): string {
  return shorten(h);
}

/** Renders a cosmetic 16-digit card number: "5crp" prefix + 3 groups of 4 digits, right-aligned. */
export function cosmeticCardNumber(cardId: string): string {
  const digits = cardId.padStart(12, "0").slice(-12);
  return `5crp ${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)}`;
}

/** Relative time copy: minutes/hours for recent timestamps, a short UTC date once more than a day has passed. */
export function timeAgo(atMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - atMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const d = new Date(atMs);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
