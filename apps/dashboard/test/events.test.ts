import { describe, expect, it } from "vitest";
import {
  type EventRow,
  feedDesc,
  feedTone,
  needsAttention,
  revenueByDay,
} from "../lib/events";
import { timeAgo } from "../lib/format";

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

  it("describes a subscription.at_risk event", () => {
    const e = ev({
      type: "subscription.at_risk",
      payload: { subId: "17", reason: "insufficient_balance", nextChargeAt: "1753", amount: "29000000" },
      at: 0,
    });
    expect(feedDesc(e)).toBe("Sub #17 · insufficient balance");
  });

  it("describes a payment.overdue event", () => {
    const e = ev({
      type: "payment.overdue",
      payload: { subId: "31", nextChargeAt: "1753" },
      at: 0,
    });
    expect(feedDesc(e)).toBe("Sub #31 · payment overdue");
  });

  it("describes a payment.attempt_failed event", () => {
    const e = ev({
      type: "payment.attempt_failed",
      payload: { subId: "31", error: "insufficient allowance", nextChargeAt: "1753" },
      at: 0,
    });
    expect(feedDesc(e)).toBe("Sub #31 · insufficient allowance");
  });

  it("describes a card.created event", () => {
    const e = ev({
      type: "card.created",
      payload: { cardId: "6", owner: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01", signer: "0x9876543210FedCbA9876543210FedCbA9876543210" },
      at: 0,
    });
    expect(feedDesc(e)).toBe("Card #6 minted by 0xAbCd…Ef01");
  });

  it("describes a subscription.created event", () => {
    const e = ev({
      type: "subscription.created",
      payload: { subId: "7", planId: "1", customer: "0x19bcAF1f1b03e3ecC6bA09F43Af53D8b5B3fea8b", cardId: "5" },
      at: 0,
    });
    expect(feedDesc(e)).toBe("Plan #1 · new subscriber 0x19bc…ea8b");
  });

  it("falls back to type for unknown event types", () => {
    const e = ev({
      type: "plan.version_pushed",
      payload: {},
      at: 0,
    });
    expect(feedDesc(e)).toBe("plan.version_pushed");
  });
});

describe("timeAgo", () => {
  it("shows just now for diffs less than 60 seconds", () => {
    const now = 100_000;
    expect(timeAgo(now - 30_000, now)).toBe("just now");
  });

  it("shows minutes for diffs >= 60s and < 60m", () => {
    const now = 100_000;
    expect(timeAgo(now - 180_000, now)).toBe("3m ago");
  });

  it("shows hours for diffs >= 60m and < 24h", () => {
    const now = 100_000;
    expect(timeAgo(now - 7_200_000, now)).toBe("2h ago");
  });

  it("shows date for diffs >= 24h", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    const twoDaysAgo = now - 2 * 24 * 60 * 60_000;
    expect(timeAgo(twoDaysAgo, now)).toBe("Jul 18");
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
    expect(rows[0].subId).toBe("8");
    expect(rows[1].kind).toBe("subscription.at_risk");
    expect(rows[1].tone).toBe("warn");
    expect(rows[1].subId).toBe("17");
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

  it("keeps at_risk when it is newer than overdue for the same sub", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);

    const events: EventRow[] = [
      // sub 5: overdue first, then at_risk — at_risk should win
      ev({
        type: "payment.overdue",
        payload: { subId: "5", nextChargeAt: "1" },
        at: now - 5000,
      }),
      ev({
        type: "subscription.at_risk",
        payload: { subId: "5", reason: "insufficient_balance", nextChargeAt: "1", amount: "1" },
        at: now - 1000,
      }),
    ];

    const rows = needsAttention(events);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("subscription.at_risk");
    expect(rows[0].tone).toBe("warn");
    expect(rows[0].why).toBe("Balance below renewal amount");
    expect(rows[0].subId).toBe("5");
  });
});
