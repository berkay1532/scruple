import { describe, it, expect, beforeEach } from "vitest";
import { Store, type DomainEvent } from "../src/db";

function ev(id: string, at = 1000): DomainEvent {
  return { id, type: "payment.succeeded", blockNumber: 42n, payload: { subId: "1", amount: "29000000" }, at };
}

describe("Store", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });

  it("inserts events idempotently", () => {
    expect(store.insertEvent(ev("0xaa:1"))).toBe(true);
    expect(store.insertEvent(ev("0xaa:1"))).toBe(false);
  });

  it("persists and returns cursors", () => {
    expect(store.getCursor("core")).toBeNull();
    store.setCursor("core", 12345n);
    expect(store.getCursor("core")).toBe(12345n);
    store.setCursor("core", 20000n);
    expect(store.getCursor("core")).toBe(20000n);
  });

  it("auto-enqueues deliveries for active endpoints on insert", () => {
    const epId = store.addEndpoint("https://hooks.example/a", "s3cr3t");
    store.insertEvent(ev("0xaa:1", 1000));
    const due = store.duePending(1000);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ eventId: "0xaa:1", endpointId: epId, attempts: 0, url: "https://hooks.example/a", secret: "s3cr3t" });
    const parsed = JSON.parse(due[0].body);
    expect(parsed).toEqual({ id: "0xaa:1", type: "payment.succeeded", at: 1000, data: { subId: "1", amount: "29000000" } });
  });

  it("does not enqueue for events inserted before an endpoint existed", () => {
    store.insertEvent(ev("0xaa:1"));
    store.addEndpoint("https://hooks.example/a", "s");
    expect(store.duePending(99999)).toHaveLength(0);
  });

  it("markAttempt reschedules failures and finalizes successes and deaths", () => {
    const epId = store.addEndpoint("https://hooks.example/a", "s");
    store.insertEvent(ev("0xaa:1", 1000));
    store.markAttempt("0xaa:1", epId, { ok: false, status: 500, now: 1000, nextAttemptAt: 61_000 });
    expect(store.duePending(1000)).toHaveLength(0);       // rescheduled to future
    expect(store.duePending(61_000)).toHaveLength(1);     // due again
    expect(store.duePending(61_000)[0].attempts).toBe(1);
    store.markAttempt("0xaa:1", epId, { ok: false, status: 500, now: 61_000, nextAttemptAt: null }); // dead
    expect(store.duePending(9_999_999)).toHaveLength(0);
    store.insertEvent(ev("0xbb:2", 1000));
    store.markAttempt("0xbb:2", epId, { ok: true, status: 200, now: 2000, nextAttemptAt: null });
    expect(store.duePending(9_999_999)).toHaveLength(0);  // delivered
  });

  it("tracks subscription activity", () => {
    store.trackSub("7");
    store.trackSub("8");
    store.trackSub("7"); // idempotent
    expect(store.listActiveSubs().sort()).toEqual(["7", "8"]);
    store.deactivateSub("7");
    expect(store.listActiveSubs()).toEqual(["8"]);
  });

  it("applies sub side effects atomically with insert", () => {
    expect(store.insertEvent(ev("0xaa:1"), { trackSub: "9" })).toBe(true);
    expect(store.listActiveSubs()).toEqual(["9"]);

    // duplicate insert: no fresh insert, so side effect must not apply
    expect(store.insertEvent(ev("0xaa:1"), { deactivateSub: "9" })).toBe(false);
    expect(store.listActiveSubs()).toEqual(["9"]);

    // fresh event: side effect applies
    expect(store.insertEvent(ev("0xbb:2"), { deactivateSub: "9" })).toBe(true);
    expect(store.listActiveSubs()).toEqual([]);
  });

  it("emits at-risk once per (sub, period)", () => {
    expect(store.markAtRiskEmitted("7", 555)).toBe(true);
    expect(store.markAtRiskEmitted("7", 555)).toBe(false);
    expect(store.markAtRiskEmitted("7", 999)).toBe(true);
  });

  it("lists recent events newest-first with type filter and clamped limit", () => {
    store.insertEvent({ id: "e1", type: "payment.succeeded", blockNumber: 1n, payload: { subId: "1" }, at: 100 });
    store.insertEvent({ id: "e2", type: "card.created", blockNumber: null, payload: { cardId: "5" }, at: 200 });
    store.insertEvent({ id: "e3", type: "payment.succeeded", blockNumber: 3n, payload: { subId: "2" }, at: 300 });

    const all = store.listRecentEvents();
    expect(all.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect(all[1].blockNumber).toBeNull();
    expect(all[0].blockNumber).toBe(3n);
    expect(all[0].payload).toEqual({ subId: "2" });

    expect(store.listRecentEvents({ type: "payment.succeeded" }).map((e) => e.id)).toEqual(["e3", "e1"]);
    expect(store.listRecentEvents({ limit: 1 }).map((e) => e.id)).toEqual(["e3"]);
    expect(store.listRecentEvents({ limit: 9999 }).length).toBe(3); // clamp does not throw
  });
});
