# Scruple Phase 4a (Service Completion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the event taxonomy (`payment.attempt_failed`, `payment.overdue`, `settlement.batched`) and give the upcoming dashboard a read API: metered payments flow from `@scruple/server` into the service via an HMAC-authenticated ingest endpoint, the keeper emits failure/overdue events, and a small HTTP server exposes recent events.

**Architecture:** Three additions, no new packages. (1) `@scruple/server`: `PaymentEvent` gains a unique `id` (Phase-2 deferred item) and a `createServiceForwarder` posts events to the service. (2) `@scruple/service` keeper: synthetic `payment.attempt_failed` / `payment.overdue` events with per-(sub, period) idempotent ids, same pattern as at-risk. (3) `@scruple/service` ingest: a `node:http` server — `POST /ingest` (HMAC body signature, inserts `settlement.batched` events, which auto-enqueue merchant webhooks via the existing Store) and `GET /events` (bearer secret, feeds the dashboard). All boundaries injected; tests use `server.listen(0)` + real fetch on localhost.

**Tech Stack:** Existing stack only (TypeScript, node:http, node:crypto, better-sqlite3, vitest). No new dependencies.

## Global Constraints

- Event ids stay deterministic/idempotent: keeper `attemptfail:${subId}:${nextChargeAt}` and `overdue:${subId}:${nextChargeAt}`; ingest `metered:${event.id}` (source id minted with `crypto.randomUUID()` in the middleware).
- Ingested `settlement.batched` events go through `Store.insertEvent` so merchant webhooks fire for metered payments exactly like chain events.
- HMAC scheme reuses `signBody` (`scruple-signature: sha256=<hex>`) for POST /ingest; GET /events uses `authorization: Bearer <secret>`. Constant-time comparison (`crypto.timingSafeEqual`) for both.
- All bigints serialized as strings at JSON boundaries; USDC stays 6-decimal atomic.
- Keeper `payment.overdue` fires when a due charge is still failing `overdueAfterS` (default 86400) past `nextChargeAt`; both keeper events only on FAILED charges (success path stays chain-event-driven).
- No new npm dependencies anywhere.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

```
packages/server/src/middleware.ts        # modify: PaymentEvent.id
packages/server/src/forwarder.ts         # new: createServiceForwarder
packages/server/test/forwarder.test.ts
packages/service/src/db.ts               # modify: listRecentEvents
packages/service/src/keeper.ts           # modify: attempt_failed/overdue emission
packages/service/src/ingest.ts           # new: HTTP ingest + events API
packages/service/test/ingest.test.ts
packages/service/bin/service.ts          # modify: INGEST_PORT/INGEST_SECRET wiring
README.md                                # modify: taxonomy + ingest docs
```

---

### Task 1: `@scruple/server` — PaymentEvent id + service forwarder

**Files:**
- Modify: `packages/server/src/middleware.ts`
- Create: `packages/server/src/forwarder.ts`, `packages/server/test/forwarder.test.ts`
- Modify: `packages/server/src/index.ts` (add `export * from "./forwarder";`)
- Test (modify): `packages/server/test/middleware.test.ts` (extend one existing assertion)

**Interfaces:**
- Produces:
  - `PaymentEvent` gains `id: string` (uuid, minted in the middleware at emission time).
  - `createServiceForwarder(opts: { url: string; secret: string; fetchImpl?: typeof fetch }): (e: PaymentEvent) => Promise<void>` — POSTs `{ ...e, atomic: e.atomic.toString() }` as JSON to `url` with header `scruple-signature: sha256=<hex hmac-sha256(secret, body)>`; non-2xx or rejection → `console.error("[scruple] service forward failed:", …)`, never throws (the middleware already contains callback errors, this adds its own belt).
- Consumes: Phase-2 middleware (`onPayment` accepts `void | Promise<void>` — the forwarder plugs straight in).

- [ ] **Step 1: Write the failing tests**

`packages/server/test/forwarder.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createServiceForwarder } from "../src/forwarder";
import type { PaymentEvent } from "../src/middleware";

const EVENT: PaymentEvent = {
  id: "11111111-2222-3333-4444-555555555555",
  endpoint: "/api/quote",
  payer: "0xPAYER",
  atomic: 1000n,
  price: "$0.001",
  transaction: "0xTX",
  at: 1234,
};

describe("createServiceForwarder", () => {
  it("POSTs the event with a valid HMAC signature and stringified atomic", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const forward = createServiceForwarder({ url: "http://svc/ingest", secret: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await forward(EVENT);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://svc/ingest");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({ ...EVENT, atomic: "1000" });
    const expected = createHmac("sha256", "k").update(body).digest("hex");
    expect((init.headers as Record<string, string>)["scruple-signature"]).toBe(`sha256=${expected}`);
  });

  it("never throws — logs on non-2xx and on rejection", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = createServiceForwarder({ url: "http://svc/ingest", secret: "k", fetchImpl: (async () => new Response("x", { status: 500 })) as unknown as typeof fetch });
    await expect(bad(EVENT)).resolves.toBeUndefined();
    const boom = createServiceForwarder({ url: "http://svc/ingest", secret: "k", fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    await expect(boom(EVENT)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
```

In `packages/server/test/middleware.test.ts`, extend the existing successful-payment test's event assertion — after the line `expect(events[0]).toMatchObject({ endpoint: "/api/quote", payer: "0xPAYER", atomic: 1000n, price: "$0.001" });` add:
```ts
    expect(typeof events[0].id).toBe("string");
    expect(events[0].id.length).toBeGreaterThan(10);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/server`
Expected: FAIL — cannot resolve `../src/forwarder`; middleware test fails on missing `id`.

- [ ] **Step 3: Implement**

In `packages/server/src/middleware.ts`: add `import { randomUUID } from "node:crypto";` at the top; add `id: string;` as the first field of `PaymentEvent`; in the event construction inside the middleware add `id: randomUUID(),` as the first property.

`packages/server/src/forwarder.ts`:
```ts
import { createHmac } from "node:crypto";
import type { PaymentEvent } from "./middleware";

/**
 * Returns an onPayment handler that forwards metered payments to the
 * Scruple service ingest endpoint (which turns them into settlement.batched
 * events + merchant webhooks). Fire-and-forget: failures are logged, never
 * thrown — a dead service must not affect payment serving.
 */
export function createServiceForwarder(opts: {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): (e: PaymentEvent) => Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  return async (e: PaymentEvent) => {
    const body = JSON.stringify({ ...e, atomic: e.atomic.toString() });
    const signature = createHmac("sha256", opts.secret).update(body).digest("hex");
    try {
      const res = await fetchImpl(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", "scruple-signature": `sha256=${signature}` },
        body,
      });
      if (res.status < 200 || res.status >= 300) {
        console.error("[scruple] service forward failed:", res.status);
      }
    } catch (err) {
      console.error("[scruple] service forward failed:", err);
    }
  };
}
```

Add to `packages/server/src/index.ts`: `export * from "./forwarder";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/server`
Expected: 23 tests PASS (21 existing incl. extended assertion + 2 new).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): PaymentEvent id + fire-and-forget service forwarder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `@scruple/service` — Store.listRecentEvents

**Files:**
- Modify: `packages/service/src/db.ts`
- Test: `packages/service/test/db.test.ts` (append)

**Interfaces:**
- Produces: `listRecentEvents(opts?: { limit?: number; type?: string }): DomainEvent[]` — newest first (by `at` DESC, tie-break `id`), default limit 100, max 500 (clamp), optional exact-type filter. `blockNumber` round-trips as bigint or null; `payload` parsed back to the object.

- [ ] **Step 1: Write the failing test** (append to `db.test.ts`)

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/service`
Expected: FAIL — `listRecentEvents` is not a function.

- [ ] **Step 3: Implement** (add to `Store` in `db.ts`)

```ts
  listRecentEvents(opts?: { limit?: number; type?: string }): DomainEvent[] {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const rows = (opts?.type
      ? this.db.prepare("SELECT id, type, block_number, payload, at FROM events WHERE type = ? ORDER BY at DESC, id DESC LIMIT ?").all(opts.type, limit)
      : this.db.prepare("SELECT id, type, block_number, payload, at FROM events ORDER BY at DESC, id DESC LIMIT ?").all(limit)
    ) as Array<{ id: string; type: string; block_number: string | null; payload: string; at: number }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      blockNumber: r.block_number === null ? null : BigInt(r.block_number),
      payload: JSON.parse(r.payload),
      at: r.at,
    }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/service`
Expected: 33 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(service): Store.listRecentEvents for the dashboard read API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Keeper — payment.attempt_failed / payment.overdue

**Files:**
- Modify: `packages/service/src/keeper.ts`
- Test: `packages/service/test/keeper.test.ts` (append)

**Interfaces:**
- Produces: `Keeper` constructor gains `overdueAfterS?: number` (default 86_400). On a FAILED charge for a due sub:
  - always insert `{ id: "attemptfail:" + subId + ":" + nextChargeAt, type: "payment.attempt_failed", blockNumber: null, payload: { subId, error, nextChargeAt: String(nextChargeAt) }, at: now() }` (INSERT OR IGNORE dedupes per period);
  - additionally, when `nowS > nextChargeAt + overdueAfterS`, insert `{ id: "overdue:" + subId + ":" + nextChargeAt, type: "payment.overdue", blockNumber: null, payload: { subId, nextChargeAt: String(nextChargeAt) }, at: now() }`.
  - Successful charges emit nothing (chain events cover them). `runOnce` return shape unchanged.
- Consumes: Task 2's Store (insertEvent already available).

- [ ] **Step 1: Write the failing tests** (append inside `describe("Keeper.runOnce")`; reuse the existing `reader` helper and `NOW_MS`/`NOW_S` constants)

```ts
  it("emits payment.attempt_failed once per (sub, period) on failed charges", async () => {
    const store = new Store(":memory:");
    store.trackSub("1");
    const charge = vi.fn(async () => { throw new Error("insufficient allowance"); });
    const keeper = new Keeper({ store, reader: reader({}), sender: { charge }, now: () => NOW_MS });
    await keeper.runOnce();
    await keeper.runOnce(); // second failure, same period
    const events = store.listRecentEvents({ type: "payment.attempt_failed" });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(`attemptfail:1:${NOW_S - 10}`);
    expect(events[0].payload).toEqual({ subId: "1", error: "insufficient allowance", nextChargeAt: String(NOW_S - 10) });
  });

  it("escalates to payment.overdue when still failing past overdueAfterS", async () => {
    const store = new Store(":memory:");
    store.trackSub("1");
    const charge = vi.fn(async () => { throw new Error("still broken"); });
    const dueAt = NOW_S - 2 * 86_400; // due 2 days ago
    const keeper = new Keeper({
      store, reader: reader({ "1": { nextChargeAt: dueAt } }), sender: { charge },
      now: () => NOW_MS, overdueAfterS: 86_400,
    });
    await keeper.runOnce();
    await keeper.runOnce();
    expect(store.listRecentEvents({ type: "payment.overdue" })).toHaveLength(1);
    expect(store.listRecentEvents({ type: "payment.attempt_failed" })).toHaveLength(1);
  });

  it("emits nothing on successful charges", async () => {
    const store = new Store(":memory:");
    store.trackSub("1");
    const keeper = new Keeper({ store, reader: reader({}), sender: { charge: async () => ({ txHash: "0x1" }) }, now: () => NOW_MS });
    await keeper.runOnce();
    expect(store.listRecentEvents()).toHaveLength(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/service`
Expected: FAIL — events not emitted (length 0 vs 1) and unknown `overdueAfterS` option (TS error).

- [ ] **Step 3: Implement** (modify `keeper.ts`)

Add to the constructor opts and fields: `overdueAfterS?: number` → `private readonly overdueAfterS: number;` … `this.overdueAfterS = opts.overdueAfterS ?? 86_400;`

Replace the catch block in `runOnce` with:
```ts
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ subId, error: message });
        this.store.insertEvent({
          id: `attemptfail:${subId}:${s.nextChargeAt}`,
          type: "payment.attempt_failed",
          blockNumber: null,
          payload: { subId, error: message, nextChargeAt: String(s.nextChargeAt) },
          at: this.now(),
        });
        if (nowS > s.nextChargeAt + this.overdueAfterS) {
          this.store.insertEvent({
            id: `overdue:${subId}:${s.nextChargeAt}`,
            type: "payment.overdue",
            blockNumber: null,
            payload: { subId, nextChargeAt: String(s.nextChargeAt) },
            at: this.now(),
          });
        }
      }
```
Note: `s` must be visible in the catch — hoist `let s` above the `try` and assign inside (the reader call stays inside the try; if the READER itself failed, `s` is undefined → skip event emission and only record `failed`):
```ts
      let s: UpcomingCharge | undefined;
      try {
        s = await this.reader.getUpcomingCharge(subId);
        ...
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ subId, error: message });
        if (s !== undefined) { /* the two insertEvent blocks above */ }
      }
```
(import `UpcomingCharge` type from "./atrisk".)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/service`
Expected: 36 tests PASS (33 + 3).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(service): keeper emits payment.attempt_failed and payment.overdue

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Ingest + events HTTP API

**Files:**
- Create: `packages/service/src/ingest.ts`, `packages/service/test/ingest.test.ts`
- Modify: `packages/service/src/index.ts` (add `export * from "./ingest";`)

**Interfaces:**
- Produces: `createIngestServer(opts: { store: Store; secret: string; now?: () => number }): http.Server` (not yet listening; caller does `.listen(port)`).
  - `POST /ingest` — headers `scruple-signature: sha256=<hex hmac(secret, rawBody)>`; body JSON `{ id, endpoint, payer?, atomic, price, transaction?, at }` (atomic as string). Valid → insert `{ id: "metered:" + body.id, type: "settlement.batched", blockNumber: null, payload: { endpoint, payer: payer ?? "", atomic, price, transaction: transaction ?? "" }, at: body.at }`, respond `200 { ok: true, inserted }` (inserted=false on duplicate). Bad/missing signature → `401 { error: "bad signature" }` (timingSafeEqual; length mismatch = bad). Unparseable/missing-field body → `400 { error: "bad payload" }` (id, atomic, price, endpoint, at required; at must be a number, atomic a decimal string).
  - `GET /events?limit=N&type=T` — header `authorization: Bearer <secret>` (timingSafeEqual) else `401`. Responds `200 { events: [...] }` with `blockNumber` as string|null (JSON-safe), newest first, via `listRecentEvents`.
  - Anything else → `404 { error: "not found" }`.
- Consumes: Task 2 `listRecentEvents`; `signBody` from `./webhooks` for HMAC.

- [ ] **Step 1: Write the failing tests**

`packages/service/test/ingest.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/service`
Expected: FAIL — cannot resolve `../src/ingest`.

- [ ] **Step 3: Implement**

`packages/service/src/ingest.ts`:
```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "./db";
import { signBody } from "./webhooks";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** HTTP surface: POST /ingest (HMAC, metered payments) + GET /events (bearer, dashboard). */
export function createIngestServer(opts: { store: Store; secret: string; now?: () => number }): Server {
  const { store, secret } = opts;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "POST" && url.pathname === "/ingest") {
        const body = await readBody(req);
        const sig = req.headers["scruple-signature"];
        if (typeof sig !== "string" || !safeEqual(sig, `sha256=${signBody(secret, body)}`)) {
          return json(res, 401, { error: "bad signature" });
        }
        let p: Record<string, unknown>;
        try {
          p = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "bad payload" });
        }
        if (
          typeof p.id !== "string" || typeof p.endpoint !== "string" || typeof p.price !== "string" ||
          typeof p.at !== "number" || typeof p.atomic !== "string" || !/^\d+$/.test(p.atomic)
        ) {
          return json(res, 400, { error: "bad payload" });
        }
        const inserted = store.insertEvent({
          id: `metered:${p.id}`,
          type: "settlement.batched",
          blockNumber: null,
          payload: {
            endpoint: p.endpoint,
            payer: typeof p.payer === "string" ? p.payer : "",
            atomic: p.atomic,
            price: p.price,
            transaction: typeof p.transaction === "string" ? p.transaction : "",
          },
          at: p.at,
        });
        return json(res, 200, { ok: true, inserted });
      }

      if (req.method === "GET" && url.pathname === "/events") {
        const auth = req.headers.authorization;
        if (typeof auth !== "string" || !safeEqual(auth, `Bearer ${secret}`)) {
          return json(res, 401, { error: "unauthorized" });
        }
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        const type = url.searchParams.get("type") ?? undefined;
        const events = store.listRecentEvents({ limit, type }).map((e) => ({
          ...e,
          blockNumber: e.blockNumber === null ? null : e.blockNumber.toString(),
        }));
        return json(res, 200, { events });
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[scruple-service] ingest request failed:", err);
      return json(res, 500, { error: "internal" });
    }
  });
}
```

Add to `packages/service/src/index.ts`: `export * from "./ingest";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/service`
Expected: 40 tests PASS (36 + 4).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(service): HMAC ingest for metered payments + bearer events API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Runner wiring + README

**Files:**
- Modify: `packages/service/bin/service.ts`, `README.md`

**Interfaces:**
- Consumes: Task 4 `createIngestServer`. New env: `INGEST_PORT` (optional — server disabled without it), `INGEST_SECRET` (required when INGEST_PORT set).

- [ ] **Step 1: Wire the ingest server** — in `bin/service.ts`, after the keeper block, add:

```ts
import { createIngestServer } from "../src/ingest";   // add to the existing imports from ../src

let ingest: ReturnType<typeof createIngestServer> | null = null;
if (process.env.INGEST_PORT) {
  const secret = process.env.INGEST_SECRET;
  if (!secret) throw new Error("INGEST_SECRET env var required when INGEST_PORT is set");
  ingest = createIngestServer({ store, secret });
  ingest.listen(Number(process.env.INGEST_PORT), () => {
    console.log(`[scruple-service] ingest+events API on :${process.env.INGEST_PORT}`);
  });
}
```
And extend the startup log line with `` ingest=${process.env.INGEST_PORT ?? "off"} ``.

- [ ] **Step 2: Typecheck + full suite**

Run: `npx tsc --noEmit -p packages/service` → clean. Run root `npm test` → server 23 + client 17 + service 40 = 80 PASS.

- [ ] **Step 3: README updates**

In the Services section: replace the backlog parenthetical "(`payment.attempt_failed`/`payment.overdue` detection and `settlement.batched` ingest land with the dashboard phase.)" with:
```markdown
Full taxonomy is live: `payment.attempt_failed`/`payment.overdue` are detected by
the keeper, and metered payments flow in as `settlement.batched` via the ingest API
(`POST /ingest`, HMAC-signed — plug `createServiceForwarder` from `@scruple/server`
into the middleware's `onPayment`). The dashboard reads `GET /events` (bearer auth).
Enable with `INGEST_PORT`/`INGEST_SECRET`.
```
Update the test-count line to `80/80 tests passing (server 23, client 17, service 40; network boundaries mocked).`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(service): wire ingest API into runner; README taxonomy completion

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope for this plan

- **Phase 4b:** dashboard (Next.js, card visuals, wagmi writes, consumes GET /events).
- **Phase 4c:** demo runbook (live Gateway deposit + x402 attempt), video storyboard, deck.
