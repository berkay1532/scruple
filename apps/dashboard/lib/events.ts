// Pure event aggregation logic — no React, no fetch. Consumes the service's
// GET /events shape (see packages/service/src/ingest.ts + events.ts) after
// the /api/events proxy has passed it through unchanged.
import { formatUsd, shortAddr } from "./format";

export interface EventRow {
  id: string;
  type: string;
  blockNumber: string | null;
  payload: Record<string, string>;
  at: number;
}

export type Tone = "ok" | "warn" | "bad" | "info" | "mut";

const DAY_MS = 24 * 60 * 60_000;

/** Maps a taxonomy event type (see packages/service/src/events.ts TAXONOMY) to a feed badge tone. */
export function feedTone(type: string): Tone {
  if (type === "card.created") return "mut";
  if (type.endsWith(".succeeded") || type.endsWith(".created")) return "ok";
  if (type.endsWith(".at_risk")) return "warn";
  if (type.endsWith(".attempt_failed") || type.endsWith(".overdue")) return "bad";
  if (type === "settlement.batched") return "info";
  return "mut";
}

/** Formats an atomic USDC amount with a fixed 2 decimals (dollar-scale copy, e.g. subscription charges). */
function usd2(atomic: string): string {
  return `$${(Number(atomic) / 1_000_000).toFixed(2)}`;
}

const AT_RISK_REASON_COPY: Record<string, string> = {
  insufficient_balance: "Balance below renewal amount",
  card_policy_blocks: "Card policy will decline next charge",
};

/** Human-readable one-line description of an event, per its taxonomy type. */
export function feedDesc(e: EventRow): string {
  const p = e.payload;
  switch (e.type) {
    case "payment.succeeded":
      return `Sub #${p.subId} · ${usd2(p.amount)} charged, ${usd2(p.fee)} fee`;
    case "settlement.batched":
      return `${p.endpoint} · ${formatUsd(p.atomic)} by ${shortAddr(p.payer)}`;
    case "subscription.at_risk":
      return `Sub #${p.subId} · ${p.reason.replace(/_/g, " ")}`;
    case "payment.overdue":
      return `Sub #${p.subId} · payment overdue`;
    case "payment.attempt_failed":
      return `Sub #${p.subId} · ${p.error}`;
    case "card.created":
      return `Card #${p.cardId} minted by ${shortAddr(p.owner)}`;
    case "subscription.created":
      return `Plan #${p.planId} · new subscriber ${shortAddr(p.customer)}`;
    default:
      return e.type;
  }
}

/**
 * Daily USD revenue vector, oldest → newest, `days` entries ending on the
 * UTC day containing `nowMs`. Sums payment.succeeded (payload.amount) and
 * settlement.batched (payload.atomic); days with no matching events are 0.
 * Floats — for chart display only, not accounting.
 */
export function revenueByDay(events: EventRow[], days: number, nowMs: number): number[] {
  const today = Math.floor(nowMs / DAY_MS);
  const start = today - (days - 1);
  const out = new Array(days).fill(0) as number[];

  for (const e of events) {
    let atomic: string | undefined;
    if (e.type === "payment.succeeded") atomic = e.payload.amount;
    else if (e.type === "settlement.batched") atomic = e.payload.atomic;
    if (atomic === undefined) continue;

    const day = Math.floor(e.at / DAY_MS);
    const idx = day - start;
    if (idx >= 0 && idx < days) out[idx] += Number(atomic) / 1_000_000;
  }

  return out;
}

/**
 * Merchant-scoped plan/sub id sets, derived purely from the event feed (no
 * contract reads) — the same join pattern as Cards' Activity view (subInfo /
 * merchantByPlan): plan.created events whose payload.merchant matches
 * `merchant` (case-insensitive) give `planIds`; subscription.created events
 * whose payload.planId is in that set give `subIds`.
 *
 * This scoping is required because contracts are a single shared deployment
 * across all merchants — createPlan records `merchant: msg.sender` on-chain,
 * and the service indexes every merchant's events into one feed. Without
 * this join, any view built directly off `events` (e.g. filtering
 * payment.succeeded by type alone) leaks other merchants' data.
 *
 * Safety note: subId matching downstream (e.g. `mySubIds.has(payload.subId)`)
 * relies on subId being globally unique across the shared
 * SubscriptionManager contract — true today since there's one contract
 * instance for all merchants, so no two merchants can mint the same subId.
 */
export function scopeToMerchant(events: EventRow[], merchant: string): { planIds: Set<string>; subIds: Set<string> } {
  const target = merchant.toLowerCase();
  const planIds = new Set<string>();
  for (const e of events) {
    if (e.type !== "plan.created") continue;
    if (e.payload.merchant?.toLowerCase() !== target) continue;
    planIds.add(e.payload.planId);
  }

  const subIds = new Set<string>();
  for (const e of events) {
    if (e.type !== "subscription.created") continue;
    if (!planIds.has(e.payload.planId)) continue;
    subIds.add(e.payload.subId);
  }

  return { planIds, subIds };
}

/**
 * Payment-shaped events scoped to one merchant: `payment.succeeded` is kept
 * only when its subId is in `mySubIds` (see `scopeToMerchant`).
 * `settlement.batched` rows are kept unconditionally — metered settlements
 * only ever arrive at a merchant's own ingest forwarder (there is no
 * cross-merchant metered feed to leak from), so they need no further
 * scoping. All other event types are dropped. Used by both the Payments
 * table and Overview's revenue chart so the two stay consistent.
 */
export function scopedPaymentEvents(events: EventRow[], mySubIds: ReadonlySet<string>): EventRow[] {
  return events.filter((e) => {
    if (e.type === "payment.succeeded") return mySubIds.has(e.payload.subId);
    return e.type === "settlement.batched";
  });
}

export interface AttentionRow {
  tone: "warn" | "bad";
  kind: string;
  title: string;
  why: string;
  subId: string;
}

/**
 * At most one row per subId, taken from that sub's most recent
 * subscription.at_risk / payment.overdue event, newest first.
 */
export function needsAttention(events: EventRow[]): AttentionRow[] {
  const latestBySub = new Map<string, EventRow>();
  for (const e of events) {
    if (e.type !== "subscription.at_risk" && e.type !== "payment.overdue") continue;
    const subId = e.payload.subId;
    const existing = latestBySub.get(subId);
    if (!existing || e.at > existing.at) latestBySub.set(subId, e);
  }

  return [...latestBySub.values()]
    .sort((a, b) => b.at - a.at)
    .map((e): AttentionRow => {
      if (e.type === "subscription.at_risk") {
        return {
          tone: "warn",
          kind: e.type,
          title: `Sub #${e.payload.subId}`,
          why: AT_RISK_REASON_COPY[e.payload.reason] ?? e.payload.reason,
          subId: e.payload.subId,
        };
      }
      return {
        tone: "bad",
        kind: e.type,
        title: `Sub #${e.payload.subId}`,
        why: "Payment overdue",
        subId: e.payload.subId,
      };
    });
}
