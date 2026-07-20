import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { Store } from "../src/db";
import { createIngestServer } from "../src/ingest";

const SECRET = "svc-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function payment(id = "u-1") {
  return { id, endpoint: "/api/quote", payer: "0xP", atomic: "1000", price: "$0.001", transaction: "0xTX", at: 1234 };
}

describe("ingest server", () => {
  let store: Store;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    store = new Store(":memory:");
    server = createIngestServer({ store, secret: SECRET });
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
});
