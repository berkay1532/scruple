import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { Store } from "../src/db";
import { createIngestServer } from "../src/ingest";

const SECRET = "svc-secret";
const ADMIN_SECRET = "admin-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function payment(id = "u-1") {
  return { id, endpoint: "/api/quote", payer: "0xP", atomic: "1000", price: "$0.001", transaction: "0xTX", at: 1234 };
}

function admin(path: string, init?: RequestInit) {
  return (base: string) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${ADMIN_SECRET}` },
    });
}

describe("ingest server", () => {
  let store: Store;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    store = new Store(":memory:");
    server = createIngestServer({ store, secret: SECRET, adminSecret: ADMIN_SECRET });
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it("ingests a signed metered payment as settlement.batched (idempotent)", async () => {
    const body = JSON.stringify(payment());
    const res = await fetch(`${base}/ingest`, { method: "POST", headers: { "scruple-signature": sign(body) }, body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inserted: true });

    const dup = await fetch(`${base}/ingest`, { method: "POST", headers: { "scruple-signature": sign(body) }, body });
    expect(await dup.json()).toEqual({ ok: true, inserted: false });

    const events = store.listRecentEvents({ type: "settlement.batched" });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("metered:u-1");
    expect(events[0].payload).toEqual({ endpoint: "/api/quote", payer: "0xP", atomic: "1000", price: "$0.001", transaction: "0xTX" });
  });

  it("rejects bad signatures and malformed payloads", async () => {
    const body = JSON.stringify(payment());
    expect((await fetch(`${base}/ingest`, { method: "POST", headers: { "scruple-signature": "sha256=deadbeef" }, body })).status).toBe(401);
    expect((await fetch(`${base}/ingest`, { method: "POST", body })).status).toBe(401);
    const bad = JSON.stringify({ id: "x" }); // missing fields
    expect((await fetch(`${base}/ingest`, { method: "POST", headers: { "scruple-signature": sign(bad) }, body: bad })).status).toBe(400);
  });

  it("serves recent events to bearer-authorized readers only", async () => {
    store.insertEvent({ id: "e1", type: "payment.succeeded", blockNumber: 7n, payload: { subId: "1" }, at: 100 });
    expect((await fetch(`${base}/events`)).status).toBe(401);
    const res = await fetch(`${base}/events?type=payment.succeeded`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    const { events } = await res.json();
    expect(events).toEqual([{ id: "e1", type: "payment.succeeded", blockNumber: "7", payload: { subId: "1" }, at: 100 }]);
  });

  it("404s unknown routes", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("rejects oversized bodies with 413", async () => {
    const body = "x".repeat(70_000);
    const res = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "scruple-signature": sign(body) },
      body,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body too large" });
  });

  it("rejects non-finite `at` values", async () => {
    const body = '{"id":"x","endpoint":"/e","price":"$1","atomic":"1","at":1e400}';
    const res = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "scruple-signature": sign(body) },
      body,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a null JSON body", async () => {
    const body = "null";
    const res = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "scruple-signature": sign(body) },
      body,
    });
    expect(res.status).toBe(400);
  });

  describe("admin API", () => {
    it("401s every /admin route without (or with wrong) bearer admin secret", async () => {
      const attempts: Array<() => Promise<Response>> = [
        () => fetch(`${base}/admin/endpoints`),
        () => fetch(`${base}/admin/endpoints`, { headers: { authorization: "Bearer nope" } }),
        () => fetch(`${base}/admin/endpoints`, { method: "POST", body: JSON.stringify({ url: "https://x.test" }) }),
        () => fetch(`${base}/admin/endpoints/1`, { method: "DELETE" }),
        () => fetch(`${base}/admin/endpoints/1/pause`, { method: "POST" }),
        () => fetch(`${base}/admin/endpoints/1/resume`, { method: "POST" }),
        () => fetch(`${base}/admin/endpoints/1/rotate`, { method: "POST" }),
        () => fetch(`${base}/admin/deliveries`),
        () => fetch(`${base}/admin/deliveries/1/e1/resend`, { method: "POST" }),
      ];
      for (const attempt of attempts) {
        const res = await attempt();
        expect(res.status).toBe(401);
      }
    });

    it("creates an endpoint with an autogenerated secret, returned in full only once", async () => {
      const res = await admin("/admin/endpoints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.test/hook" }),
      })(base);
      expect(res.status).toBe(200);
      const created = await res.json();
      expect(created.id).toEqual(expect.any(Number));
      expect(created.url).toBe("https://example.test/hook");
      expect(created.secret).toMatch(/^whsec_[0-9a-f]{32}$/);

      const listRes = await admin("/admin/endpoints")(base);
      const { endpoints } = await listRes.json();
      const found = endpoints.find((e: { id: number }) => e.id === created.id);
      expect(found).toBeDefined();
      expect(found.paused).toBe(false);
      expect(found.secretPreview).not.toBe(created.secret);
      expect(found.secretPreview.startsWith(created.secret.slice(0, 8))).toBe(true);
      expect(JSON.stringify(endpoints)).not.toContain(created.secret);
    });

    it("creates an endpoint with a caller-supplied secret", async () => {
      const res = await admin("/admin/endpoints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.test/hook", secret: "custom-secret-fixture" }),
      })(base);
      const created = await res.json();
      expect(created.secret).toBe("custom-secret-fixture");
    });

    it("rejects endpoint creation with a non-http(s) or malformed url", async () => {
      const bad1 = await admin("/admin/endpoints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "not-a-url" }),
      })(base);
      expect(bad1.status).toBe(400);

      const bad2 = await admin("/admin/endpoints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "ftp://example.test/hook" }),
      })(base);
      expect(bad2.status).toBe(400);
    });

    it("deletes an endpoint, 404 on repeat/unknown", async () => {
      const id = store.createEndpoint("https://example.test/del", "test-secret-delete-fixture");
      const res = await admin(`/admin/endpoints/${id}`, { method: "DELETE" })(base);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const again = await admin(`/admin/endpoints/${id}`, { method: "DELETE" })(base);
      expect(again.status).toBe(404);

      const missing = await admin(`/admin/endpoints/999999`, { method: "DELETE" })(base);
      expect(missing.status).toBe(404);
    });

    it("pauses and resumes an endpoint", async () => {
      const id = store.createEndpoint("https://example.test/pause", "test-secret-pause-fixture");

      const pauseRes = await admin(`/admin/endpoints/${id}/pause`, { method: "POST" })(base);
      expect(pauseRes.status).toBe(200);
      expect(await pauseRes.json()).toEqual({ ok: true, paused: true });
      expect(store.listEndpointsAdmin().find((e) => e.id === id)?.paused).toBe(true);

      const resumeRes = await admin(`/admin/endpoints/${id}/resume`, { method: "POST" })(base);
      expect(resumeRes.status).toBe(200);
      expect(await resumeRes.json()).toEqual({ ok: true, paused: false });
      expect(store.listEndpointsAdmin().find((e) => e.id === id)?.paused).toBe(false);

      const missing = await admin(`/admin/endpoints/999999/pause`, { method: "POST" })(base);
      expect(missing.status).toBe(404);
    });

    it("rotates an endpoint secret once, replacing the prior secret", async () => {
      const id = store.createEndpoint("https://example.test/rotate", "test-secret-original-fixture");
      const res = await admin(`/admin/endpoints/${id}/rotate`, { method: "POST" })(base);
      expect(res.status).toBe(200);
      const { ok, secret } = await res.json();
      expect(ok).toBe(true);
      expect(secret).toMatch(/^whsec_[0-9a-f]{32}$/);
      expect(secret).not.toBe("test-secret-original-fixture");

      const preview = store.listEndpointsAdmin().find((e) => e.id === id)?.secretPreview;
      expect(preview).not.toBe(`${"test-secret-original-fixture".slice(0, 8)}…${"test-secret-original-fixture".slice(-2)}`);

      const missing = await admin(`/admin/endpoints/999999/rotate`, { method: "POST" })(base);
      expect(missing.status).toBe(404);
    });

    it("lists deliveries and filters by status", async () => {
      const epId = store.createEndpoint("https://example.test/deliv", "test-secret-deliveries-fixture");
      store.insertEvent({ id: "ev-delivered", type: "payment.succeeded", blockNumber: null, payload: {}, at: 10 });
      store.insertEvent({ id: "ev-dead", type: "payment.succeeded", blockNumber: null, payload: {}, at: 20 });
      store.markAttempt("ev-delivered", epId, { ok: true, status: 200, now: 100, nextAttemptAt: null });
      store.markAttempt("ev-dead", epId, { ok: false, status: 500, now: 100, nextAttemptAt: null });

      const all = await admin("/admin/deliveries")(base);
      expect(all.status).toBe(200);
      const { deliveries } = await all.json();
      expect(deliveries.length).toBeGreaterThanOrEqual(2);

      const deadOnly = await admin("/admin/deliveries?status=dead")(base);
      const { deliveries: dead } = await deadOnly.json();
      expect(dead.every((d: { status: string }) => d.status === "dead")).toBe(true);
      expect(dead.some((d: { eventId: string }) => d.eventId === "ev-dead")).toBe(true);
    });

    it("resends a delivery, including an eventId that contains a colon", async () => {
      const epId = store.createEndpoint("https://example.test/resend", "test-secret-resend-fixture");
      store.insertEvent({ id: "0xdead:7", type: "payment.succeeded", blockNumber: null, payload: {}, at: 10 });
      store.markAttempt("0xdead:7", epId, { ok: false, status: 500, now: 100, nextAttemptAt: null });
      expect(store.listDeliveries({ status: "dead" }).some((d) => d.eventId === "0xdead:7")).toBe(true);

      const res = await admin(`/admin/deliveries/${epId}/0xdead:7/resend`, { method: "POST" })(base);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const revived = store.listDeliveries().find((d) => d.eventId === "0xdead:7" && d.endpointId === epId);
      expect(revived?.status).not.toBe("dead");

      const missing = await admin(`/admin/deliveries/${epId}/no-such-event/resend`, { method: "POST" })(base);
      expect(missing.status).toBe(404);
    });
  });
});
