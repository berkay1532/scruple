import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(store.listRecentEvents({ limit: Number.NaN }).length).toBe(3);
    expect(store.listRecentEvents({ limit: 0 }).map((e) => e.id)).toEqual(["e3"]); // 0 clamps to 1
    expect(store.listRecentEvents({ limit: 2.7 }).length).toBe(2);
  });

  it("round-trips block numbers above Number.MAX_SAFE_INTEGER without precision loss", () => {
    const huge = 2n ** 60n + 12345n;
    store.insertEvent({ id: "e1", type: "payment.succeeded", blockNumber: huge, payload: { subId: "1" }, at: 100 });
    expect(store.listRecentEvents()[0].blockNumber).toBe(huge);
  });
});

describe("Store admin surface", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });

  describe("migration idempotency", () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "scruple-db-"));
      dbPath = join(dir, "store.sqlite");
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("constructing the Store twice on the same file-backed DB does not throw and paused defaults to 0", () => {
      const first = new Store(dbPath);
      const epId = first.addEndpoint("https://hooks.example/a", "s3cr3t");
      first.close();

      expect(() => {
        const second = new Store(dbPath);
        const admin = second.listEndpointsAdmin();
        expect(admin).toHaveLength(1);
        expect(admin[0]).toMatchObject({ id: epId, url: "https://hooks.example/a", paused: false });
        second.close();
      }).not.toThrow();

      // third construction: still idempotent (ALTER TABLE must not re-run)
      expect(() => {
        const third = new Store(dbPath);
        third.close();
      }).not.toThrow();
    });
  });

  describe("paused endpoints", () => {
    it("excludes a paused endpoint from duePending and includes it again on resume", () => {
      const epId = store.addEndpoint("https://hooks.example/a", "s3cr3t");
      store.insertEvent(ev("0xaa:1", 1000));
      expect(store.duePending(1000)).toHaveLength(1);

      expect(store.setEndpointPaused(epId, true)).toBe(true);
      expect(store.duePending(1000)).toHaveLength(0);

      expect(store.setEndpointPaused(epId, false)).toBe(true);
      expect(store.duePending(1000)).toHaveLength(1);
    });

    it("setEndpointPaused returns false for an absent endpoint", () => {
      expect(store.setEndpointPaused(999, true)).toBe(false);
    });
  });

  describe("listEndpointsAdmin", () => {
    it("returns id/url/secretPreview/paused/createdAtKnown shape with masked secret", () => {
      // Built at runtime so secret scanners don't flag a whsec_-shaped literal.
      const fakeSecret = "whsec_" + "abcdefghijklmnopqrstuvwxyz89";
      const epId = store.createEndpoint("https://hooks.example/a", fakeSecret);
      const admin = store.listEndpointsAdmin();
      expect(admin).toHaveLength(1);
      expect(admin[0]).toEqual({
        id: epId,
        url: "https://hooks.example/a",
        secretPreview: "whsec_ab…89",
        paused: false,
        createdAtKnown: false,
      });
    });
  });

  describe("deleteEndpoint", () => {
    it("cascades: removes the endpoint and its deliveries in one transaction", () => {
      const epId = store.addEndpoint("https://hooks.example/a", "s3cr3t");
      store.insertEvent(ev("0xaa:1", 1000));
      expect(store.duePending(1000)).toHaveLength(1);

      expect(store.deleteEndpoint(epId)).toBe(true);

      expect(store.listEndpointsAdmin()).toHaveLength(0);
      expect(store.duePending(1000)).toHaveLength(0);
      expect(store.listDeliveries()).toHaveLength(0);
    });

    it("returns false when the endpoint does not exist", () => {
      expect(store.deleteEndpoint(999)).toBe(false);
    });
  });

  describe("rotateEndpointSecret", () => {
    it("changes the stored secret, verified via duePending's secret field", () => {
      const epId = store.addEndpoint("https://hooks.example/a", "old-secret");
      store.insertEvent(ev("0xaa:1", 1000));
      expect(store.duePending(1000)[0].secret).toBe("old-secret");

      expect(store.rotateEndpointSecret(epId, "new-secret")).toBe(true);
      expect(store.duePending(1000)[0].secret).toBe("new-secret");
    });

    it("returns false for an absent endpoint", () => {
      expect(store.rotateEndpointSecret(999, "x")).toBe(false);
    });
  });

  describe("listDeliveries", () => {
    it("derives delivered/retrying/pending/dead, orders newest-first, and supports a status filter", () => {
      const epId = store.addEndpoint("https://hooks.example/a", "s3cr3t");

      // e-delivered: event at=1000, then a success
      store.insertEvent(ev("0xaa:delivered", 1000));
      store.markAttempt("0xaa:delivered", epId, { ok: true, status: 200, now: 1500, nextAttemptAt: null });

      // e-retrying: event at=2000, one failed attempt with a future retry
      store.insertEvent(ev("0xaa:retrying", 2000));
      store.markAttempt("0xaa:retrying", epId, { ok: false, status: 500, now: 2500, nextAttemptAt: 9999 });

      // e-pending: event at=3000, never attempted (still attempts=0, next_attempt_at set at insert)
      store.insertEvent(ev("0xaa:pending", 3000));

      // e-dead: event at=4000, failed with no further retry scheduled
      store.insertEvent(ev("0xaa:dead", 4000));
      store.markAttempt("0xaa:dead", epId, { ok: false, status: 500, now: 4500, nextAttemptAt: 8888 });
      store.markAttempt("0xaa:dead", epId, { ok: false, status: 500, now: 8888, nextAttemptAt: null });

      const all = store.listDeliveries();
      expect(all.map((d) => d.eventId)).toEqual(["0xaa:dead", "0xaa:pending", "0xaa:retrying", "0xaa:delivered"]);

      const byId = Object.fromEntries(all.map((d) => [d.eventId, d]));
      expect(byId["0xaa:delivered"]).toMatchObject({
        endpointId: epId, url: "https://hooks.example/a", type: "payment.succeeded",
        attempts: 0, lastStatus: 200, nextAttemptAt: null, status: "delivered",
      });
      expect(byId["0xaa:delivered"].deliveredAt).toBe(1500);

      expect(byId["0xaa:retrying"]).toMatchObject({
        attempts: 1, lastStatus: 500, nextAttemptAt: 9999, deliveredAt: null, status: "retrying",
      });

      expect(byId["0xaa:pending"]).toMatchObject({
        attempts: 0, lastStatus: null, deliveredAt: null, status: "pending",
      });
      expect(byId["0xaa:pending"].nextAttemptAt).toBe(3000);

      expect(byId["0xaa:dead"]).toMatchObject({
        attempts: 2, lastStatus: 500, nextAttemptAt: null, deliveredAt: null, status: "dead",
      });

      expect(store.listDeliveries({ status: "dead" }).map((d) => d.eventId)).toEqual(["0xaa:dead"]);
      expect(store.listDeliveries({ status: "delivered" }).map((d) => d.eventId)).toEqual(["0xaa:delivered"]);
      expect(store.listDeliveries({ status: "retrying" }).map((d) => d.eventId)).toEqual(["0xaa:retrying"]);
      expect(store.listDeliveries({ status: "pending" }).map((d) => d.eventId)).toEqual(["0xaa:pending"]);
    });

    it("clamps limit to 1..500", () => {
      const epId = store.addEndpoint("https://hooks.example/a", "s3cr3t");
      store.insertEvent(ev("0xaa:1", 1000));
      store.insertEvent(ev("0xaa:2", 2000));
      void epId;
      expect(store.listDeliveries({ limit: 0 })).toHaveLength(1);
      expect(store.listDeliveries({ limit: 9999 })).toHaveLength(2);
    });
  });

  describe("reviveDelivery", () => {
    it("revives a dead delivery so it reappears in duePending(now), without resetting attempts", () => {
      const epId = store.addEndpoint("https://hooks.example/a", "s3cr3t");
      store.insertEvent(ev("0xaa:1", 1000));
      store.markAttempt("0xaa:1", epId, { ok: false, status: 500, now: 1500, nextAttemptAt: 2000 });
      store.markAttempt("0xaa:1", epId, { ok: false, status: 500, now: 2000, nextAttemptAt: null }); // dead
      expect(store.duePending(9_999_999)).toHaveLength(0);

      expect(store.reviveDelivery("0xaa:1", epId, 5000)).toBe(true);
      const due = store.duePending(5000);
      expect(due).toHaveLength(1);
      expect(due[0].attempts).toBe(2); // attempts counter not reset
    });

    it("returns false for a delivered delivery and leaves it delivered", () => {
      const epId = store.addEndpoint("https://hooks.example/a", "s3cr3t");
      store.insertEvent(ev("0xaa:1", 1000));
      store.markAttempt("0xaa:1", epId, { ok: true, status: 200, now: 1500, nextAttemptAt: null });

      expect(store.reviveDelivery("0xaa:1", epId, 5000)).toBe(false);
      expect(store.duePending(9_999_999)).toHaveLength(0);
    });

    it("returns false for an absent delivery", () => {
      expect(store.reviveDelivery("nope", 1, 5000)).toBe(false);
    });
  });
});
