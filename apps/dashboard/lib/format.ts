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

/**
 * Truncates a webhook delivery event id for table display. Chain-decoded ids
 * are `${txHash}:${logIndex}` — keep the log-index suffix and shorten the
 * hash (e.g. "0xca8f…:9"); short synthetic ids pass through untouched.
 */
export function shortEventId(id: string): string {
  const i = id.lastIndexOf(":");
  if (i > 0) {
    const head = id.slice(0, i);
    return head.length > 10 ? `${head.slice(0, 6)}…${id.slice(i)}` : id;
  }
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

/** Strips the http(s) scheme and truncates long webhook URLs for table display. */
export function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, "");
  return bare.length > 34 ? `${bare.slice(0, 33)}…` : bare;
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

/** Formats a unix-seconds timestamp as a full UTC date, e.g. "Aug 19, 2026". */
export function formatDate(atS: number): string {
  const d = new Date(atS * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * Parses a USD decimal string (e.g. "29", "29.5", "0.001") into an atomic
 * (6-decimal) bigint. Returns null for anything that isn't a non-negative
 * decimal with at most 6 fractional digits (empty string, negative sign,
 * multiple dots, stray characters, >6 decimal places).
 */
export function parseUsdToAtomic(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}
