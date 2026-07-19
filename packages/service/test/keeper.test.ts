import { describe, it, expect, vi } from "vitest";
import { Store } from "../src/db";
import { Keeper } from "../src/keeper";
import type { SubReader, UpcomingCharge } from "../src/atrisk";

const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

function reader(perSub: Record<string, Partial<UpcomingCharge>>): SubReader {
  return {
    getUpcomingCharge: async (subId) => ({
      active: true, nextChargeAt: NOW_S - 10, amount: 29_000_000n,
      merchant: "0xm", customer: "0xc", cardId: "5", ...perSub[subId],
    }),
    balanceOf: async () => 0n,
    previewSpend: async () => true,
  };
}

describe("Keeper.runOnce", () => {
  it("charges due subs, skips not-yet-due, deactivates inactive", async () => {
    const store = new Store(":memory:");
    ["1", "2", "3"].forEach((s) => store.trackSub(s));
    const charge = vi.fn(async (subId: string) => ({ txHash: `0xtx${subId}` }));
    const keeper = new Keeper({
      store,
      reader: reader({ "2": { nextChargeAt: NOW_S + 999 }, "3": { active: false } }),
      sender: { charge },
      now: () => NOW_MS,
    });
    const res = await keeper.runOnce();
    expect(res.charged).toEqual(["1"]);
    expect(res.failed).toEqual([]);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(store.listActiveSubs().sort()).toEqual(["1", "2"]); // 3 deactivated
  });

  it("contains per-sub failures and continues the loop", async () => {
    const store = new Store(":memory:");
    ["1", "2"].forEach((s) => store.trackSub(s));
    const charge = vi.fn(async (subId: string) => {
      if (subId === "1") throw new Error("execution reverted: ChargeNotDue");
      return { txHash: "0xtx2" };
    });
    const keeper = new Keeper({ store, reader: reader({}), sender: { charge }, now: () => NOW_MS });
    const res = await keeper.runOnce();
    expect(res.charged).toEqual(["2"]);
    expect(res.failed).toEqual([{ subId: "1", error: "execution reverted: ChargeNotDue" }]);
  });

  it("continues when the reader itself rejects for one sub", async () => {
    const store = new Store(":memory:");
    ["1", "2"].forEach((s) => store.trackSub(s));
    const readerImpl: SubReader = {
      getUpcomingCharge: async (subId) => {
        if (subId === "1") throw new Error("rpc down");
        return {
          active: true, nextChargeAt: NOW_S - 10, amount: 29_000_000n,
          merchant: "0xm", customer: "0xc", cardId: "5",
        };
      },
      balanceOf: async () => 0n,
      previewSpend: async () => true,
    };
    const charge = vi.fn(async () => ({ txHash: "0xtx2" }));
    const keeper = new Keeper({ store, reader: readerImpl, sender: { charge }, now: () => NOW_MS });
    const res = await keeper.runOnce();
    expect(res.charged).toEqual(["2"]);
    expect(res.failed).toEqual([{ subId: "1", error: "rpc down" }]);
  });
});
