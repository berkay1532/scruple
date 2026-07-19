import { describe, it, expect } from "vitest";
import { Store } from "../src/db";
import { AtRiskMonitor, type SubReader, type UpcomingCharge } from "../src/atrisk";

const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

function reader(overrides: Partial<UpcomingCharge> = {}, balance = 100_000_000n, preview = true): SubReader {
  return {
    getUpcomingCharge: async () => ({
      active: true,
      nextChargeAt: NOW_S + 86_400, // due in 1 day (inside 3-day lookahead)
      amount: 29_000_000n,
      merchant: "0xmerchant",
      customer: "0xcustomer",
      cardId: "5",
      ...overrides,
    }),
    balanceOf: async () => balance,
    previewSpend: async () => preview,
  };
}

function setup(r: SubReader) {
  const store = new Store(":memory:");
  store.trackSub("7");
  return { store, monitor: new AtRiskMonitor({ store, reader: r, now: () => NOW_MS }) };
}

describe("AtRiskMonitor.runOnce", () => {
  it("emits insufficient_balance once per (sub, period)", async () => {
    const { store, monitor } = setup(reader({}, 1_000_000n)); // balance $1 < $29
    expect(await monitor.runOnce()).toBe(1);
    expect(await monitor.runOnce()).toBe(0); // dedupe
    const due = store.duePending(NOW_MS + 1); // no endpoints -> no deliveries, so read events via a fresh endpoint trick is overkill; assert via markAtRiskEmitted dedupe above
    expect(due).toHaveLength(0);
  });

  it("emits card_policy_blocks when balance is fine but the card refuses", async () => {
    const { monitor } = setup(reader({}, 100_000_000n, false));
    expect(await monitor.runOnce()).toBe(1);
  });

  it("stays quiet for healthy subs and far-future charges", async () => {
    const healthy = setup(reader());
    expect(await healthy.monitor.runOnce()).toBe(0);
    const far = setup(reader({ nextChargeAt: NOW_S + 10 * 86_400 }));
    expect(await far.monitor.runOnce()).toBe(0);
  });

  it("deactivates subs the chain reports inactive", async () => {
    const { store, monitor } = setup(reader({ active: false }));
    expect(await monitor.runOnce()).toBe(0);
    expect(store.listActiveSubs()).toEqual([]);
  });

  it("re-emits for a NEW period after a successful renewal", async () => {
    const store = new Store(":memory:");
    store.trackSub("7");
    let nca = NOW_S + 86_400;
    const r: SubReader = {
      getUpcomingCharge: async () => ({ active: true, nextChargeAt: nca, amount: 29_000_000n, merchant: "0xm", customer: "0xc", cardId: "5" }),
      balanceOf: async () => 0n,
      previewSpend: async () => true,
    };
    const monitor = new AtRiskMonitor({ store, reader: r, now: () => NOW_MS });
    expect(await monitor.runOnce()).toBe(1);
    nca = NOW_S + 86_400 + 2_592_000; // next period — but outside lookahead now
    expect(await monitor.runOnce()).toBe(0);
    const later = new AtRiskMonitor({ store, reader: r, now: () => NOW_MS + 2_592_000_000 });
    expect(await later.runOnce()).toBe(1); // same (sub) new (period) -> emits again
  });
});
