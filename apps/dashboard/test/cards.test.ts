import { describe, expect, it } from "vitest";
import type { EventRow } from "../lib/events";
import { cardProgress, deriveMyCards } from "../lib/cards";

function ev(partial: Partial<EventRow> & Pick<EventRow, "type" | "payload" | "at">): EventRow {
  return { id: "1", blockNumber: null, ...partial };
}

describe("deriveMyCards", () => {
  it("returns cardIds for card.created events matching the owner case-insensitively, deduped, ascending numeric order", () => {
    const owner = "0xAbCdEf0000000000000000000000000000AbCd";
    const events: EventRow[] = [
      ev({ type: "card.created", payload: { cardId: "10", owner: owner.toLowerCase(), signer: "0x1" }, at: 1 }),
      ev({ type: "card.created", payload: { cardId: "2", owner: owner.toUpperCase(), signer: "0x1" }, at: 2 }),
      ev({ type: "card.created", payload: { cardId: "2", owner, signer: "0x1" }, at: 3 }), // duplicate cardId
      ev({ type: "card.created", payload: { cardId: "3", owner: "0xSomeoneElse00000000000000000000000000", signer: "0x1" }, at: 4 }),
    ];

    expect(deriveMyCards(events, owner)).toEqual(["2", "10"]);
  });

  it("returns an empty array when no card.created events match", () => {
    const events: EventRow[] = [
      ev({ type: "card.created", payload: { cardId: "1", owner: "0xOther0000000000000000000000000000000", signer: "0x1" }, at: 1 }),
    ];
    expect(deriveMyCards(events, "0xMe00000000000000000000000000000000000")).toEqual([]);
  });

  it("ignores non-card.created event types", () => {
    const owner = "0xAbCdEf0000000000000000000000000000AbCd";
    const events: EventRow[] = [
      ev({ type: "card.frozen", payload: { cardId: "1" }, at: 1 }),
    ];
    expect(deriveMyCards(events, owner)).toEqual([]);
  });
});

describe("cardProgress", () => {
  it("is 0 / ok when nothing has been spent", () => {
    expect(cardProgress(0n, 100n)).toEqual({ pct: 0, tone: "ok" });
  });

  it("is exactly 70 / warn at the warn threshold", () => {
    expect(cardProgress(70n, 100n)).toEqual({ pct: 70, tone: "warn" });
  });

  it("is warn just under the bad threshold", () => {
    expect(cardProgress(99n, 100n)).toEqual({ pct: 99, tone: "warn" });
  });

  it("is exactly 100 / bad at the bad threshold", () => {
    expect(cardProgress(100n, 100n)).toEqual({ pct: 100, tone: "bad" });
  });

  it("clamps pct at 100 when spent exceeds limit, and stays bad", () => {
    expect(cardProgress(150n, 100n)).toEqual({ pct: 100, tone: "bad" });
  });

  it("is 0 / ok when limit is zero, regardless of spent", () => {
    expect(cardProgress(50n, 0n)).toEqual({ pct: 0, tone: "ok" });
  });
});
