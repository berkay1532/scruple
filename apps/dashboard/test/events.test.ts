import { describe, expect, it } from "vitest";
import {
  type EventRow,
  feedDesc,
  feedTone,
  needsAttention,
  revenueByDay,
} from "../lib/events";

function ev(partial: Partial<EventRow> & Pick<EventRow, "type" | "payload" | "at">): EventRow {
  return { id: "1", blockNumber: null, ...partial };
}

describe("feedTone", () => {
  it("maps payment.succeeded to ok", () => {
    expect(feedTone("payment.succeeded")).toBe("ok");
  });

  it("maps subscription.created to ok", () => {
    expect(feedTone("subscription.created")).toBe("ok");
  });

  it("special-cases card.created to mut, not ok", () => {
    expect(feedTone("card.created")).toBe("mut");
  });

  it("maps subscription.at_risk to warn", () => {
    expect(feedTone("subscription.at_risk")).toBe("warn");
  });

  it("maps payment.attempt_failed to bad", () => {
    expect(feedTone("payment.attempt_failed")).toBe("bad");
  });

  it("maps payment.overdue to bad", () => {
    expect(feedTone("payment.overdue")).toBe("bad");
  });

  it("maps settlement.batched to info", () => {
    expect(feedTone("settlement.batched")).toBe("info");
  });

  it("falls back to mut for unrecognized types", () => {
    expect(feedTone("plan.version_pushed")).toBe("mut");
  });
});

describe("feedDesc", () => {
  it("describes a payment.succeeded event", () => {
    const e = ev({
      type: "payment.succeeded",
      payload: { subId: "7", version: "1", amount: "29000000", fee: "290000" },
      at: 0,
    });
    expect(feedDesc(e)).toBe("Sub #7 · $29.00 charged, $0.29 fee");
  });

  it("describes a settlement.batched event", () => {
    const e = ev({
      type: "settlement.batched",
      payload: {
        endpoint: "GET /api/quote",
        payer: "0x84a100000000000000000000000000000000c2f0",
        atomic: "1000",
        price: "$0.001",
        transaction: "0xabc",
      },
      at: 0,
    });
    expect(feedDesc(e)).toBe("GET /api/quote · $0.001 by 0x84a1…c2f0");
  });
});

describe("revenueByDay", () => {
  it("buckets payment.succeeded + settlement.batched into a daily USD vector, oldest to newest", () => {
    const DAY = 24 * 60 * 60_000;
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    const twoDaysAgo = now - 2 * DAY;
    const oneDayAgo = now - 1 * DAY;

    const events: EventRow[] = [
      ev({ type: "payment.succeeded", payload: { subId: "1", version: "1", amount: "5000000", fee: "50000" }, at: twoDaysAgo }),
      ev({ type: "payment.succeeded", payload: { subId: "2", version: "1", amount: "2000000", fee: "20000" }, at: oneDayAgo }),
      ev({
        type: "settlement.batched",
        payload: { endpoint: "/api/quote", payer: "0x1", atomic: "1500000", price: "$1.50", transaction: "0x1" },
        at: now,
      }),
    ];

    expect(revenueByDay(events, 3, now)).toEqual([5, 2, 1.5]);
  });

  it("fills days with no events as 0", () => {
    const DAY = 24 * 60 * 60_000;
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    const twoDaysAgo = now - 2 * DAY;

    const events: EventRow[] = [
      ev({ type: "payment.succeeded", payload: { subId: "1", version: "1", amount: "1000000", fee: "10000" }, at: twoDaysAgo }),
    ];

    expect(revenueByDay(events, 3, now)).toEqual([1, 0, 0]);
  });

  it("ignores event types that are not revenue events", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    const events: EventRow[] = [
      ev({ type: "card.created", payload: { cardId: "1", owner: "0x1", signer: "0x1" }, at: now }),
    ];
    expect(revenueByDay(events, 1, now)).toEqual([0]);
  });
});

describe("needsAttention", () => {
  it("dedupes per sub, keeping only the latest event, and sorts newest first", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);

    const events: EventRow[] = [
      // sub 17: at_risk only
      ev({
        type: "subscription.at_risk",
        payload: { subId: "17", reason: "insufficient_balance", nextChargeAt: "1", amount: "1" },
        at: now - 5000,
      }),
      // sub 8: two events, overdue is the later one — should win and dedupe to one row
      ev({
        type: "subscription.at_risk",
        payload: { subId: "8", reason: "card_policy_blocks", nextChargeAt: "1", amount: "1" },
        at: now - 20_000,
      }),
      ev({
        type: "payment.overdue",
        payload: { subId: "8", nextChargeAt: "1" },
        at: now - 1000,
      }),
    ];

    const rows = needsAttention(events);

    expect(rows).toHaveLength(2);
    // newest first: sub 8's overdue (now - 1000) is newer than sub 17's at_risk (now - 5000)
    expect(rows[0].kind).toBe("payment.overdue");
    expect(rows[0].tone).toBe("bad");
    expect(rows[1].kind).toBe("subscription.at_risk");
    expect(rows[1].tone).toBe("warn");
  });

  it("maps insufficient_balance reason to its display copy", () => {
    const events: EventRow[] = [
      ev({
        type: "subscription.at_risk",
        payload: { subId: "17", reason: "insufficient_balance", nextChargeAt: "1", amount: "1" },
        at: 1000,
      }),
    ];
    expect(needsAttention(events)[0].why).toBe("Balance below renewal amount");
  });

  it("maps card_policy_blocks reason to its display copy", () => {
    const events: EventRow[] = [
      ev({
        type: "subscription.at_risk",
        payload: { subId: "8", reason: "card_policy_blocks", nextChargeAt: "1", amount: "1" },
        at: 1000,
      }),
    ];
    expect(needsAttention(events)[0].why).toBe("Card policy will decline next charge");
  });

  it("ignores unrelated event types", () => {
    const events: EventRow[] = [
      ev({ type: "payment.succeeded", payload: { subId: "1", version: "1", amount: "1", fee: "0" }, at: 1000 }),
    ];
    expect(needsAttention(events)).toEqual([]);
  });
});
