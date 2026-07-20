// Pure card math + event-derived card ownership — no React, no chain reads.
import type { EventRow } from "./events";

/**
 * cardIds from card.created events whose payload.owner matches `owner`
 * case-insensitively, deduped, ascending numeric order.
 */
export function deriveMyCards(events: EventRow[], owner: string): string[] {
  const target = owner.toLowerCase();
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== "card.created") continue;
    if (e.payload.owner?.toLowerCase() !== target) continue;
    ids.add(e.payload.cardId);
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

export interface CardProgress {
  pct: number;
  tone: "ok" | "warn" | "bad";
}

/** Spend-vs-limit progress: pct clamped to 0..100; tone escalates ok → warn (≥70) → bad (≥100). Zero limit reads as 0 / ok. */
export function cardProgress(spent: bigint, limit: bigint): CardProgress {
  if (limit <= 0n) return { pct: 0, tone: "ok" };

  const raw = Number((spent * 100n) / limit);
  const pct = Math.min(100, Math.max(0, raw));
  const tone = pct >= 100 ? "bad" : pct >= 70 ? "warn" : "ok";
  return { pct, tone };
}
