# Scruple Phase 3 (Indexer + Webhooks + Keeper) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@scruple/service` — the off-chain backbone: an Arc event indexer (chunked `getLogs`, resumable cursor), a webhook dispatcher (HMAC-signed, idempotent, single documented retry schedule), a `subscription.at_risk` monitor, and a permissionless-charge keeper bot.

**Architecture:** One package, four modules around a SQLite store (`better-sqlite3`; spec §4.4 said Postgres — deliberate MVP deviation: zero-infra, synchronous, tests run on `:memory:` against real SQL, schema is Postgres-portable). Every chain/network/clock boundary is constructor-injected (`ChainReader`, `SubReader`, `ChargeSender`, `fetchImpl`, `now`) so unit tests never touch a network. Event idempotency ids are deterministic: `${txHash}:${logIndex}` for chain events, `atrisk:${subId}:${nextChargeAt}` for synthetic ones — this also delivers the Phase-2 deferred "PaymentEvent idempotency id" requirement for everything flowing through webhooks.

**Tech Stack:** TypeScript ^5.9, better-sqlite3 ^11, viem ^2.47 (ABI encode/decode + runner clients), vitest. Same no-build convention as Phase 2 (`main: src/index.ts`).

## Global Constraints

- Arc testnet drops `eth_newFilter` — indexer MUST use chunked `getLogs` polling; chunk size default `9000n` blocks; cursor persisted per contract-set so restarts resume.
- Arc finality is deterministic and irreversible — no reorg handling needed (state this in a comment; do not build reorg logic).
- Webhook events: idempotency `id` on every event; HMAC-SHA256 signature of the raw body in header `scruple-signature: sha256=<hex>`; event id also in header `scruple-event-id`.
- Retry schedule documented in EXACTLY one place: `RETRY_DELAYS_S = [60, 300, 1800, 7200, 43200]` in `webhooks.ts` (first attempt immediate; 5 retries; then dead).
- Event taxonomy (spec §4.4): `card.created|frozen|unfrozen|cancelled`, `plan.created|version_pushed`, `subscription.created|expired|cancelled|at_risk`, `payment.succeeded`. (`payment.attempt_failed`/`overdue` need keeper-side detection — Phase 4 backlog, note in README.)
- All bigints in stored/sent JSON payloads are serialized as strings (JSON has no bigint).
- USDC math stays 6-decimal atomic bigint until the JSON boundary.
- `charge(subId)` is permissionless on-chain; keeper failures must be contained per-sub (one revert must not stop the loop).
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

```
packages/service/                 # @scruple/service
  package.json
  tsconfig.json
  vitest.config.ts
  src/index.ts                    # re-exports
  src/db.ts                       # Store: schema + all SQL (events, cursor, endpoints, deliveries, subs, at_risk_emitted)
  src/events.ts                   # contract ABIs + decodeLog → DomainEvent (taxonomy mapping)
  src/indexer.ts                  # Indexer.runOnce: chunked getLogs → store
  src/webhooks.ts                 # Dispatcher.dispatchDue: HMAC delivery + retry schedule
  src/atrisk.ts                   # AtRiskMonitor.runOnce: balance/card checks → synthetic events
  src/keeper.ts                   # Keeper.runOnce: due subs → charge()
  bin/service.ts                  # runner: wires viem + Store + intervals (typecheck-only)
  test/db.test.ts
  test/events.test.ts
  test/indexer.test.ts
  test/webhooks.test.ts
  test/atrisk.test.ts
  test/keeper.test.ts
```

---

### Task 1: Package scaffold + Store (SQLite)

**Files:**
- Create: `packages/service/package.json`, `packages/service/tsconfig.json`, `packages/service/vitest.config.ts`, `packages/service/src/index.ts`, `packages/service/src/db.ts`, `packages/service/test/db.test.ts`
- Modify: root `package.json` is untouched (workspaces glob `packages/*` already matches)

**Interfaces:**
- Produces (consumed by every later task):
  - `interface DomainEvent { id: string; type: string; blockNumber: bigint | null; payload: Record<string, string>; at: number }` (payload values pre-stringified)
  - `interface Endpoint { id: number; url: string; secret: string }`
  - `interface DueDelivery { eventId: string; endpointId: number; attempts: number; url: string; secret: string; body: string }` (`body` = canonical JSON `{id, type, at, data}`)
  - `class Store { constructor(dbPath: string) }` with methods:
    - `insertEvent(e: DomainEvent): boolean` — false on duplicate id (no throw); on success auto-enqueues a delivery row per active endpoint (attempts 0, next_attempt_at = e.at)
    - `getCursor(key: string): bigint | null` / `setCursor(key: string, block: bigint): void`
    - `addEndpoint(url: string, secret: string): number` / `listEndpoints(): Endpoint[]`
    - `duePending(now: number): DueDelivery[]` — undelivered, non-dead, `next_attempt_at <= now`
    - `markAttempt(eventId: string, endpointId: number, opts: { ok: boolean; status: number | null; now: number; nextAttemptAt: number | null }): void` — ok → delivered_at=now; else attempts+1, reschedule (or dead when nextAttemptAt null)
    - `trackSub(subId: string): void` / `deactivateSub(subId: string): void` / `listActiveSubs(): string[]`
    - `markAtRiskEmitted(subId: string, nextChargeAt: number): boolean` — false if already emitted for that (sub, period)
    - `close(): void`

- [ ] **Step 1: Package skeleton**

`packages/service/package.json`:
```json
{
  "name": "@scruple/service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "dependencies": {
    "better-sqlite3": "^11.10.0",
    "viem": "^2.47.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^25.4.0",
    "typescript": "^5.9.3",
    "vitest": "^3.0.0"
  }
}
```

`packages/service/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "bin"] }
```

`packages/service/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

`packages/service/src/index.ts`:
```ts
export * from "./db";
```

Run `npm install` from repo root (links the new workspace).

- [ ] **Step 2: Write the failing tests**

`packages/service/test/db.test.ts`:
```ts
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

  it("emits at-risk once per (sub, period)", () => {
    expect(store.markAtRiskEmitted("7", 555)).toBe(true);
    expect(store.markAtRiskEmitted("7", 555)).toBe(false);
    expect(store.markAtRiskEmitted("7", 999)).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w @scruple/service`
Expected: FAIL — cannot resolve `../src/db`.

- [ ] **Step 4: Implement**

`packages/service/src/db.ts`:
```ts
import Database from "better-sqlite3";

export interface DomainEvent {
  id: string;
  type: string;
  blockNumber: bigint | null;
  payload: Record<string, string>;
  at: number;
}

export interface Endpoint { id: number; url: string; secret: string }

export interface DueDelivery {
  eventId: string;
  endpointId: number;
  attempts: number;
  url: string;
  secret: string;
  body: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  block_number INTEGER,
  payload TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, last_block TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS deliveries (
  event_id TEXT NOT NULL,
  endpoint_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  delivered_at INTEGER,
  last_status INTEGER,
  PRIMARY KEY (event_id, endpoint_id)
);
CREATE TABLE IF NOT EXISTS subs (sub_id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS at_risk_emitted (
  sub_id TEXT NOT NULL,
  next_charge_at INTEGER NOT NULL,
  PRIMARY KEY (sub_id, next_charge_at)
);
`;

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  insertEvent(e: DomainEvent): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO events (id, type, block_number, payload, at) VALUES (?, ?, ?, ?, ?)")
      .run(e.id, e.type, e.blockNumber === null ? null : e.blockNumber.toString(), JSON.stringify(e.payload), e.at);
    if (res.changes === 0) return false;
    const enqueue = this.db.prepare(
      "INSERT OR IGNORE INTO deliveries (event_id, endpoint_id, attempts, next_attempt_at) VALUES (?, ?, 0, ?)",
    );
    for (const ep of this.listEndpoints()) enqueue.run(e.id, ep.id, e.at);
    return true;
  }

  getCursor(key: string): bigint | null {
    const row = this.db.prepare("SELECT last_block FROM cursors WHERE key = ?").get(key) as { last_block: string } | undefined;
    return row ? BigInt(row.last_block) : null;
  }

  setCursor(key: string, block: bigint): void {
    this.db
      .prepare("INSERT INTO cursors (key, last_block) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_block = excluded.last_block")
      .run(key, block.toString());
  }

  addEndpoint(url: string, secret: string): number {
    const res = this.db.prepare("INSERT INTO endpoints (url, secret) VALUES (?, ?)").run(url, secret);
    return Number(res.lastInsertRowid);
  }

  listEndpoints(): Endpoint[] {
    return this.db.prepare("SELECT id, url, secret FROM endpoints WHERE active = 1").all() as Endpoint[];
  }

  duePending(now: number): DueDelivery[] {
    const rows = this.db
      .prepare(`
        SELECT d.event_id, d.endpoint_id, d.attempts, ep.url, ep.secret, ev.type, ev.payload, ev.at
        FROM deliveries d
        JOIN endpoints ep ON ep.id = d.endpoint_id AND ep.active = 1
        JOIN events ev ON ev.id = d.event_id
        WHERE d.delivered_at IS NULL AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?
        ORDER BY d.next_attempt_at ASC
      `)
      .all(now) as Array<{
        event_id: string; endpoint_id: number; attempts: number;
        url: string; secret: string; type: string; payload: string; at: number;
      }>;
    return rows.map((r) => ({
      eventId: r.event_id,
      endpointId: r.endpoint_id,
      attempts: r.attempts,
      url: r.url,
      secret: r.secret,
      body: JSON.stringify({ id: r.event_id, type: r.type, at: r.at, data: JSON.parse(r.payload) }),
    }));
  }

  markAttempt(
    eventId: string,
    endpointId: number,
    opts: { ok: boolean; status: number | null; now: number; nextAttemptAt: number | null },
  ): void {
    if (opts.ok) {
      this.db
        .prepare("UPDATE deliveries SET delivered_at = ?, last_status = ?, next_attempt_at = NULL WHERE event_id = ? AND endpoint_id = ?")
        .run(opts.now, opts.status, eventId, endpointId);
    } else {
      this.db
        .prepare("UPDATE deliveries SET attempts = attempts + 1, last_status = ?, next_attempt_at = ? WHERE event_id = ? AND endpoint_id = ?")
        .run(opts.status, opts.nextAttemptAt, eventId, endpointId);
    }
  }

  trackSub(subId: string): void {
    this.db.prepare("INSERT INTO subs (sub_id, active) VALUES (?, 1) ON CONFLICT(sub_id) DO UPDATE SET active = 1").run(subId);
  }

  deactivateSub(subId: string): void {
    this.db.prepare("UPDATE subs SET active = 0 WHERE sub_id = ?").run(subId);
  }

  listActiveSubs(): string[] {
    return (this.db.prepare("SELECT sub_id FROM subs WHERE active = 1").all() as Array<{ sub_id: string }>).map((r) => r.sub_id);
  }

  markAtRiskEmitted(subId: string, nextChargeAt: number): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO at_risk_emitted (sub_id, next_charge_at) VALUES (?, ?)")
      .run(subId, nextChargeAt);
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @scruple/service`
Expected: 1 file, 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(service): SQLite store — events, cursors, deliveries, subs, at-risk dedupe

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Event decoding (chain log → DomainEvent)

**Files:**
- Create: `packages/service/src/events.ts`, `packages/service/test/events.test.ts`
- Modify: `packages/service/src/index.ts` (add `export * from "./events";`)

**Interfaces:**
- Produces:
  - `CARD_ISSUER_ABI`, `SUBSCRIPTION_MANAGER_ABI` (viem `parseAbi` results, events only)
  - `interface RawLog { address: string; topics: string[]; data: string; blockNumber: bigint; transactionHash: string; logIndex: number }`
  - `decodeLog(log: RawLog, addresses: { cardIssuer: string; subscriptionManager: string }, at: number): DomainEvent | null` — returns null for unknown addresses/events (SpendAuthorized and ChargerAuthorizationSet deliberately unmapped). Event id = `${transactionHash}:${logIndex}`. Taxonomy: CardMinted→`card.created`, CardFrozen→`card.frozen`, CardUnfrozen→`card.unfrozen`, CardCancelled→`card.cancelled`, PlanCreated→`plan.created`, PlanVersionPushed→`plan.version_pushed`, SubscriptionCreated→`subscription.created`, PaymentSucceeded→`payment.succeeded`, SubscriptionExpired→`subscription.expired`, SubscriptionCancelled→`subscription.cancelled`. Address comparison case-insensitive.
- Consumes: Task 1 `DomainEvent`.

- [ ] **Step 1: Write the failing tests**

`packages/service/test/events.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { encodeEventLog } from "viem";
import { decodeLog, CARD_ISSUER_ABI, SUBSCRIPTION_MANAGER_ABI, type RawLog } from "../src/events";

const ISSUER = "0x1111111111111111111111111111111111111111";
const SUBS = "0x2222222222222222222222222222222222222222";
const ADDRS = { cardIssuer: ISSUER, subscriptionManager: SUBS };

function log(address: string, enc: { data: `0x${string}`; topics: readonly `0x${string}`[] }, idx = 3): RawLog {
  return { address, topics: [...enc.topics], data: enc.data, blockNumber: 100n, transactionHash: "0xdead", logIndex: idx };
}

describe("decodeLog", () => {
  it("maps PaymentSucceeded to payment.succeeded with stringified bigints", () => {
    const enc = encodeEventLog({
      abi: SUBSCRIPTION_MANAGER_ABI,
      eventName: "PaymentSucceeded",
      args: { subId: 7n, version: 2, amount: 29_000_000n, fee: 290_000n },
    });
    const e = decodeLog(log(SUBS, enc), ADDRS, 1234);
    expect(e).toEqual({
      id: "0xdead:3",
      type: "payment.succeeded",
      blockNumber: 100n,
      payload: { subId: "7", version: "2", amount: "29000000", fee: "290000" },
      at: 1234,
    });
  });

  it("maps SubscriptionCreated with all identity fields", () => {
    const enc = encodeEventLog({
      abi: SUBSCRIPTION_MANAGER_ABI,
      eventName: "SubscriptionCreated",
      args: { subId: 7n, planId: 1n, customer: "0x00000000000000000000000000000000000000AA", cardId: 5n },
    });
    const e = decodeLog(log(SUBS, enc), ADDRS, 1);
    expect(e?.type).toBe("subscription.created");
    expect(e?.payload).toEqual({
      subId: "7", planId: "1", customer: "0x00000000000000000000000000000000000000aa", cardId: "5",
    });
  });

  it("maps CardMinted / CardFrozen from the issuer address only", () => {
    const enc = encodeEventLog({
      abi: CARD_ISSUER_ABI,
      eventName: "CardMinted",
      args: { cardId: 5n, owner: "0x00000000000000000000000000000000000000bb", signer: "0x00000000000000000000000000000000000000cc" },
    });
    expect(decodeLog(log(ISSUER, enc), ADDRS, 1)?.type).toBe("card.created");
    expect(decodeLog(log(SUBS, enc), ADDRS, 1)).toBeNull(); // wrong contract for this topic
  });

  it("is case-insensitive on addresses", () => {
    const enc = encodeEventLog({ abi: CARD_ISSUER_ABI, eventName: "CardFrozen", args: { cardId: 5n } });
    expect(decodeLog(log(ISSUER.toUpperCase().replace("0X", "0x"), enc), ADDRS, 1)?.type).toBe("card.frozen");
  });

  it("returns null for unknown events and addresses", () => {
    const enc = encodeEventLog({
      abi: CARD_ISSUER_ABI,
      eventName: "SpendAuthorized",
      args: { cardId: 5n, merchant: "0x00000000000000000000000000000000000000dd", amount: 1n },
    });
    expect(decodeLog(log(ISSUER, enc), ADDRS, 1)).toBeNull();               // unmapped by design
    expect(decodeLog(log("0x9999999999999999999999999999999999999999", enc), ADDRS, 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/service`
Expected: FAIL — cannot resolve `../src/events`.

- [ ] **Step 3: Implement**

`packages/service/src/events.ts`:
```ts
import { decodeEventLog, parseAbi } from "viem";
import type { DomainEvent } from "./db";

export const CARD_ISSUER_ABI = parseAbi([
  "event CardMinted(uint256 indexed cardId, address indexed owner, address signer)",
  "event CardFrozen(uint256 indexed cardId)",
  "event CardUnfrozen(uint256 indexed cardId)",
  "event CardCancelled(uint256 indexed cardId)",
  "event SpendAuthorized(uint256 indexed cardId, address indexed merchant, uint256 amount)",
]);

export const SUBSCRIPTION_MANAGER_ABI = parseAbi([
  "event PlanCreated(uint256 indexed planId, address indexed merchant, uint16 version)",
  "event PlanVersionPushed(uint256 indexed planId, uint16 version)",
  "event SubscriptionCreated(uint256 indexed subId, uint256 indexed planId, address indexed customer, uint256 cardId)",
  "event PaymentSucceeded(uint256 indexed subId, uint16 version, uint256 amount, uint256 fee)",
  "event SubscriptionExpired(uint256 indexed subId)",
  "event SubscriptionCancelled(uint256 indexed subId)",
]);

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

/** eventName → webhook taxonomy type. Unlisted events (SpendAuthorized, …) are not exported. */
const TAXONOMY: Record<string, string> = {
  CardMinted: "card.created",
  CardFrozen: "card.frozen",
  CardUnfrozen: "card.unfrozen",
  CardCancelled: "card.cancelled",
  PlanCreated: "plan.created",
  PlanVersionPushed: "plan.version_pushed",
  SubscriptionCreated: "subscription.created",
  PaymentSucceeded: "payment.succeeded",
  SubscriptionExpired: "subscription.expired",
  SubscriptionCancelled: "subscription.cancelled",
};

function stringifyArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) out[k] = String(v).toLowerCase().startsWith("0x") ? String(v).toLowerCase() : String(v);
  return out;
}

export function decodeLog(
  log: RawLog,
  addresses: { cardIssuer: string; subscriptionManager: string },
  at: number,
): DomainEvent | null {
  const addr = log.address.toLowerCase();
  let abi;
  if (addr === addresses.cardIssuer.toLowerCase()) abi = CARD_ISSUER_ABI;
  else if (addr === addresses.subscriptionManager.toLowerCase()) abi = SUBSCRIPTION_MANAGER_ABI;
  else return null;

  let decoded;
  try {
    decoded = decodeEventLog({
      abi,
      data: log.data as `0x${string}`,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
  } catch {
    return null; // unknown topic for this contract
  }

  const type = TAXONOMY[decoded.eventName];
  if (!type) return null;

  return {
    id: `${log.transactionHash}:${log.logIndex}`,
    type,
    blockNumber: log.blockNumber,
    payload: stringifyArgs(decoded.args as unknown as Record<string, unknown>),
    at,
  };
}
```

Add to `packages/service/src/index.ts`: `export * from "./events";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/service`
Expected: 2 files, 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(service): contract event decoding to webhook taxonomy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Indexer (chunked getLogs → store)

**Files:**
- Create: `packages/service/src/indexer.ts`, `packages/service/test/indexer.test.ts`
- Modify: `packages/service/src/index.ts` (add `export * from "./indexer";`)

**Interfaces:**
- Produces:
  - `interface ChainReader { getBlockNumber(): Promise<bigint>; getLogs(args: { addresses: string[]; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]> }`
  - `class Indexer { constructor(opts: { store: Store; reader: ChainReader; cardIssuer: string; subscriptionManager: string; startBlock?: bigint; chunkSize?: bigint; now?: () => number }); async runOnce(): Promise<{ processed: number; toBlock: bigint | null }> }`
  - Behavior: cursor key `"core"`. From = cursor+1 (or `startBlock`, default 0n). Chunks of `chunkSize` (default 9000n) until head. Each decoded event inserted (duplicates skipped); on `subscription.created` → `trackSub(payload.subId)`; on `subscription.expired`/`subscription.cancelled` → `deactivateSub`. Cursor advances per chunk (crash-safe resume). Head < from → `{ processed: 0, toBlock: null }`.
- Consumes: Task 1 `Store`, Task 2 `decodeLog`/`RawLog`.

- [ ] **Step 1: Write the failing tests**

`packages/service/test/indexer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { encodeEventLog } from "viem";
import { Store } from "../src/db";
import { SUBSCRIPTION_MANAGER_ABI, type RawLog } from "../src/events";
import { Indexer, type ChainReader } from "../src/indexer";

const ISSUER = "0x1111111111111111111111111111111111111111";
const SUBS = "0x2222222222222222222222222222222222222222";

function subCreatedLog(subId: bigint, block: bigint, idx: number): RawLog {
  const enc = encodeEventLog({
    abi: SUBSCRIPTION_MANAGER_ABI,
    eventName: "SubscriptionCreated",
    args: { subId, planId: 1n, customer: "0x00000000000000000000000000000000000000aa", cardId: 5n },
  });
  return { address: SUBS, topics: [...enc.topics], data: enc.data, blockNumber: block, transactionHash: `0xt${subId}`, logIndex: idx };
}

function expiredLog(subId: bigint, block: bigint): RawLog {
  const enc = encodeEventLog({ abi: SUBSCRIPTION_MANAGER_ABI, eventName: "SubscriptionExpired", args: { subId } });
  return { address: SUBS, topics: [...enc.topics], data: enc.data, blockNumber: block, transactionHash: `0xe${subId}`, logIndex: 0 };
}

function reader(head: bigint, logs: RawLog[]): ChainReader & { calls: Array<{ from: bigint; to: bigint }> } {
  const calls: Array<{ from: bigint; to: bigint }> = [];
  return {
    calls,
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push({ from: fromBlock, to: toBlock });
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
}

function makeIndexer(store: Store, r: ChainReader, opts: Partial<ConstructorParameters<typeof Indexer>[0]> = {}) {
  return new Indexer({ store, reader: r, cardIssuer: ISSUER, subscriptionManager: SUBS, now: () => 1234, ...opts });
}

describe("Indexer.runOnce", () => {
  it("indexes events, tracks subs, advances cursor", async () => {
    const store = new Store(":memory:");
    const r = reader(150n, [subCreatedLog(7n, 100n, 0), expiredLog(7n, 149n)]);
    const res = await makeIndexer(store, r).runOnce();
    expect(res).toEqual({ processed: 2, toBlock: 150n });
    expect(store.getCursor("core")).toBe(150n);
    expect(store.listActiveSubs()).toEqual([]); // created then expired
  });

  it("chunks ranges and resumes from the cursor", async () => {
    const store = new Store(":memory:");
    store.setCursor("core", 999n);
    const r = reader(20_000n, []);
    await makeIndexer(store, r, { chunkSize: 9000n }).runOnce();
    expect(r.calls).toEqual([
      { from: 1000n, to: 9999n },
      { from: 10_000n, to: 18_999n },
      { from: 19_000n, to: 20_000n },
    ]);
    expect(store.getCursor("core")).toBe(20_000n);
  });

  it("is idempotent across overlapping runs", async () => {
    const store = new Store(":memory:");
    const logs = [subCreatedLog(7n, 100n, 0)];
    await makeIndexer(store, reader(150n, logs)).runOnce();
    store.setCursor("core", 50n); // simulate cursor rollback / overlap
    const res = await makeIndexer(store, reader(150n, logs)).runOnce();
    expect(res.processed).toBe(0); // duplicate insert skipped
    expect(store.listActiveSubs()).toEqual(["7"]);
  });

  it("no-ops when head is behind the cursor", async () => {
    const store = new Store(":memory:");
    store.setCursor("core", 500n);
    const res = await makeIndexer(store, reader(400n, [])).runOnce();
    expect(res).toEqual({ processed: 0, toBlock: null });
    expect(store.getCursor("core")).toBe(500n);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/service`
Expected: FAIL — cannot resolve `../src/indexer`.

- [ ] **Step 3: Implement**

`packages/service/src/indexer.ts`:
```ts
import type { Store } from "./db";
import { decodeLog, type RawLog } from "./events";

export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: { addresses: string[]; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>;
}

const CURSOR_KEY = "core";

/**
 * Chunked getLogs poller. Arc testnet drops eth_newFilter subscriptions, so we
 * poll ranges instead. Arc finality is deterministic and irreversible — no
 * reorg handling required.
 */
export class Indexer {
  private readonly store: Store;
  private readonly reader: ChainReader;
  private readonly addresses: { cardIssuer: string; subscriptionManager: string };
  private readonly startBlock: bigint;
  private readonly chunkSize: bigint;
  private readonly now: () => number;

  constructor(opts: {
    store: Store;
    reader: ChainReader;
    cardIssuer: string;
    subscriptionManager: string;
    startBlock?: bigint;
    chunkSize?: bigint;
    now?: () => number;
  }) {
    this.store = opts.store;
    this.reader = opts.reader;
    this.addresses = { cardIssuer: opts.cardIssuer, subscriptionManager: opts.subscriptionManager };
    this.startBlock = opts.startBlock ?? 0n;
    this.chunkSize = opts.chunkSize ?? 9000n;
    this.now = opts.now ?? (() => Date.now());
  }

  async runOnce(): Promise<{ processed: number; toBlock: bigint | null }> {
    const head = await this.reader.getBlockNumber();
    const cursor = this.store.getCursor(CURSOR_KEY);
    let from = cursor === null ? this.startBlock : cursor + 1n;
    if (head < from) return { processed: 0, toBlock: null };

    let processed = 0;
    while (from <= head) {
      const to = from + this.chunkSize - 1n > head ? head : from + this.chunkSize - 1n;
      const logs = await this.reader.getLogs({
        addresses: [this.addresses.cardIssuer, this.addresses.subscriptionManager],
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const event = decodeLog(log, this.addresses, this.now());
        if (!event) continue;
        const inserted = this.store.insertEvent(event);
        if (!inserted) continue;
        processed += 1;
        if (event.type === "subscription.created") this.store.trackSub(event.payload.subId);
        if (event.type === "subscription.expired" || event.type === "subscription.cancelled") {
          this.store.deactivateSub(event.payload.subId);
        }
      }
      this.store.setCursor(CURSOR_KEY, to); // per-chunk: crash-safe resume
      from = to + 1n;
    }
    return { processed, toBlock: head };
  }
}
```

Add to `packages/service/src/index.ts`: `export * from "./indexer";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/service`
Expected: 3 files, 16 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(service): chunked getLogs indexer with resumable cursor and sub tracking

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Webhook dispatcher (HMAC + retries)

**Files:**
- Create: `packages/service/src/webhooks.ts`, `packages/service/test/webhooks.test.ts`
- Modify: `packages/service/src/index.ts` (add `export * from "./webhooks";`)

**Interfaces:**
- Produces:
  - `RETRY_DELAYS_S = [60, 300, 1800, 7200, 43200]` — THE single documented retry schedule (first attempt immediate; after the 5th retry the delivery is dead).
  - `signBody(secret: string, body: string): string` — hex HMAC-SHA256 (node:crypto).
  - `class Dispatcher { constructor(opts: { store: Store; fetchImpl?: typeof fetch; now?: () => number }); async dispatchDue(): Promise<{ delivered: number; failed: number }> }`
  - Delivery: `POST url`, headers `content-type: application/json`, `scruple-event-id: <id>`, `scruple-signature: sha256=<signBody(secret, body)>`, body = the stored canonical JSON. 2xx → delivered. Non-2xx or fetch rejection → `markAttempt(ok:false)` with `nextAttemptAt = now + RETRY_DELAYS_S[attempts] * 1000` (attempts = count BEFORE this attempt); when `attempts >= RETRY_DELAYS_S.length` → `nextAttemptAt: null` (dead).
- Consumes: Task 1 `Store.duePending/markAttempt`.

- [ ] **Step 1: Write the failing tests**

`packages/service/test/webhooks.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { Store, type DomainEvent } from "../src/db";
import { Dispatcher, signBody, RETRY_DELAYS_S } from "../src/webhooks";

function ev(id: string, at = 1000): DomainEvent {
  return { id, type: "payment.succeeded", blockNumber: 1n, payload: { subId: "7" }, at };
}

function setup(fetchImpl: typeof fetch, nowMs = 1000) {
  const store = new Store(":memory:");
  store.addEndpoint("https://hooks.example/a", "s3cr3t");
  store.insertEvent(ev("0xaa:1", nowMs));
  const dispatcher = new Dispatcher({ store, fetchImpl, now: () => nowMs });
  return { store, dispatcher };
}

describe("signBody", () => {
  it("is hex HMAC-SHA256", () => {
    expect(signBody("k", "body")).toBe(createHmac("sha256", "k").update("body").digest("hex"));
  });
});

describe("Dispatcher.dispatchDue", () => {
  it("delivers with signature and id headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const { store, dispatcher } = setup(fetchImpl as unknown as typeof fetch);
    const res = await dispatcher.dispatchDue();
    expect(res).toEqual({ delivered: 1, failed: 0 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example/a");
    const body = init.body as string;
    const headers = init.headers as Record<string, string>;
    expect(headers["scruple-event-id"]).toBe("0xaa:1");
    expect(headers["scruple-signature"]).toBe(`sha256=${signBody("s3cr3t", body)}`);
    expect(JSON.parse(body).id).toBe("0xaa:1");
    expect(store.duePending(9_999_999)).toHaveLength(0); // delivered
  });

  it("schedules the documented retry delays on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const { store, dispatcher } = setup(fetchImpl as unknown as typeof fetch, 1000);
    await dispatcher.dispatchDue();
    expect(store.duePending(1000)).toHaveLength(0);
    expect(store.duePending(1000 + RETRY_DELAYS_S[0] * 1000)).toHaveLength(1);
  });

  it("treats fetch rejection like failure and eventually kills the delivery", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const store = new Store(":memory:");
    store.addEndpoint("https://hooks.example/a", "s");
    store.insertEvent(ev("0xaa:1", 0));
    let t = 0;
    const dispatcher = new Dispatcher({ store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t });
    for (let i = 0; i <= RETRY_DELAYS_S.length; i++) {
      await dispatcher.dispatchDue();
      t += 43_200_000; // jump past any scheduled delay
    }
    expect(store.duePending(t + 1)).toHaveLength(0); // dead, never due again
    expect(fetchImpl).toHaveBeenCalledTimes(RETRY_DELAYS_S.length + 1); // 1 initial + 5 retries
  });

  it("one endpoint failing does not block another", async () => {
    const store = new Store(":memory:");
    store.addEndpoint("https://hooks.example/bad", "s1");
    store.addEndpoint("https://hooks.example/good", "s2");
    store.insertEvent(ev("0xaa:1", 0));
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("bad") ? new Response("x", { status: 500 }) : new Response("ok", { status: 200 }),
    );
    const dispatcher = new Dispatcher({ store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    expect(await dispatcher.dispatchDue()).toEqual({ delivered: 1, failed: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/service`
Expected: FAIL — cannot resolve `../src/webhooks`.

- [ ] **Step 3: Implement**

`packages/service/src/webhooks.ts`:
```ts
import { createHmac } from "node:crypto";
import type { Store } from "./db";

/**
 * THE retry schedule (seconds). First attempt is immediate; each failure
 * reschedules by RETRY_DELAYS_S[attemptsSoFar]; after the last entry the
 * delivery is dead. Documented here and nowhere else.
 */
export const RETRY_DELAYS_S = [60, 300, 1800, 7200, 43200] as const;

export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export class Dispatcher {
  private readonly store: Store;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: { store: Store; fetchImpl?: typeof fetch; now?: () => number }) {
    this.store = opts.store;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async dispatchDue(): Promise<{ delivered: number; failed: number }> {
    const now = this.now();
    let delivered = 0;
    let failed = 0;
    for (const d of this.store.duePending(now)) {
      let ok = false;
      let status: number | null = null;
      try {
        const res = await this.fetchImpl(d.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "scruple-event-id": d.eventId,
            "scruple-signature": `sha256=${signBody(d.secret, d.body)}`,
          },
          body: d.body,
        });
        status = res.status;
        ok = res.status >= 200 && res.status < 300;
      } catch {
        ok = false;
      }
      if (ok) {
        delivered += 1;
        this.store.markAttempt(d.eventId, d.endpointId, { ok: true, status, now, nextAttemptAt: null });
      } else {
        failed += 1;
        const delay = d.attempts < RETRY_DELAYS_S.length ? RETRY_DELAYS_S[d.attempts] * 1000 : null;
        this.store.markAttempt(d.eventId, d.endpointId, {
          ok: false,
          status,
          now,
          nextAttemptAt: delay === null ? null : now + delay,
        });
      }
    }
    return { delivered, failed };
  }
}
```

Add to `packages/service/src/index.ts`: `export * from "./webhooks";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/service`
Expected: 4 files, 21 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(service): HMAC-signed webhook dispatcher with single documented retry schedule

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: At-risk monitor

**Files:**
- Create: `packages/service/src/atrisk.ts`, `packages/service/test/atrisk.test.ts`
- Modify: `packages/service/src/index.ts` (add `export * from "./atrisk";`)

**Interfaces:**
- Produces:
  - `interface UpcomingCharge { active: boolean; nextChargeAt: number; amount: bigint; merchant: string; customer: string; cardId: string }` (nextChargeAt in unix SECONDS, like the contract)
  - `interface SubReader { getUpcomingCharge(subId: string): Promise<UpcomingCharge>; balanceOf(address: string): Promise<bigint>; previewSpend(cardId: string, merchant: string, amount: bigint): Promise<boolean> }`
  - `class AtRiskMonitor { constructor(opts: { store: Store; reader: SubReader; lookaheadS?: number; now?: () => number }); async runOnce(): Promise<number> }` — for each active sub: skip if `!active` (and `deactivateSub`); skip if `nextChargeAt - nowS > lookaheadS` (default 259200 = 3 days); check `balanceOf(customer) < amount` → reason `insufficient_balance`, else `!previewSpend(cardId, merchant, amount)` → reason `card_policy_blocks`, else healthy. At-risk → synthetic event `{ id: "atrisk:" + subId + ":" + nextChargeAt, type: "subscription.at_risk", blockNumber: null, payload: { subId, reason, nextChargeAt: String(nextChargeAt), amount: String(amount) }, at: now() }` inserted at most once per (sub, nextChargeAt) via `markAtRiskEmitted`. Returns count of newly emitted events.
- Consumes: Task 1 `Store`.

- [ ] **Step 1: Write the failing tests**

`packages/service/test/atrisk.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/service`
Expected: FAIL — cannot resolve `../src/atrisk`.

- [ ] **Step 3: Implement**

`packages/service/src/atrisk.ts`:
```ts
import type { Store } from "./db";

export interface UpcomingCharge {
  active: boolean;
  nextChargeAt: number; // unix seconds, mirrors contract
  amount: bigint;       // atomic USDC (latest plan version — charge migrates on renewal)
  merchant: string;
  customer: string;
  cardId: string;
}

export interface SubReader {
  getUpcomingCharge(subId: string): Promise<UpcomingCharge>;
  balanceOf(address: string): Promise<bigint>;
  previewSpend(cardId: string, merchant: string, amount: bigint): Promise<boolean>;
}

/** Predicts failing renewals BEFORE the charge date (kills Radom-style silent churn). */
export class AtRiskMonitor {
  private readonly store: Store;
  private readonly reader: SubReader;
  private readonly lookaheadS: number;
  private readonly now: () => number;

  constructor(opts: { store: Store; reader: SubReader; lookaheadS?: number; now?: () => number }) {
    this.store = opts.store;
    this.reader = opts.reader;
    this.lookaheadS = opts.lookaheadS ?? 259_200; // 3 days
    this.now = opts.now ?? (() => Date.now());
  }

  async runOnce(): Promise<number> {
    const nowS = Math.floor(this.now() / 1000);
    let emitted = 0;
    for (const subId of this.store.listActiveSubs()) {
      const s = await this.reader.getUpcomingCharge(subId);
      if (!s.active) {
        this.store.deactivateSub(subId);
        continue;
      }
      if (s.nextChargeAt - nowS > this.lookaheadS) continue;

      let reason: string | null = null;
      if ((await this.reader.balanceOf(s.customer)) < s.amount) reason = "insufficient_balance";
      else if (!(await this.reader.previewSpend(s.cardId, s.merchant, s.amount))) reason = "card_policy_blocks";
      if (reason === null) continue;

      if (!this.store.markAtRiskEmitted(subId, s.nextChargeAt)) continue;
      this.store.insertEvent({
        id: `atrisk:${subId}:${s.nextChargeAt}`,
        type: "subscription.at_risk",
        blockNumber: null,
        payload: { subId, reason, nextChargeAt: String(s.nextChargeAt), amount: String(s.amount) },
        at: this.now(),
      });
      emitted += 1;
    }
    return emitted;
  }
}
```

Add to `packages/service/src/index.ts`: `export * from "./atrisk";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/service`
Expected: 5 files, 26 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(service): at-risk monitor — predicts failing renewals before the charge date

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Keeper bot

**Files:**
- Create: `packages/service/src/keeper.ts`, `packages/service/test/keeper.test.ts`
- Modify: `packages/service/src/index.ts` (add `export * from "./keeper";`)

**Interfaces:**
- Produces:
  - `interface ChargeSender { charge(subId: string): Promise<{ txHash: string }> }`
  - `class Keeper { constructor(opts: { store: Store; reader: SubReader; sender: ChargeSender; now?: () => number }); async runOnce(): Promise<{ charged: string[]; failed: Array<{ subId: string; error: string }> }> }` — for each active sub: `!active` → `deactivateSub`, skip; `nowS >= nextChargeAt` → `sender.charge(subId)`; a rejected charge is caught, recorded in `failed`, and MUST NOT stop the loop. Chain events from successful charges reach the store via the indexer, not the keeper.
- Consumes: Task 1 `Store`, Task 5 `SubReader`.

- [ ] **Step 1: Write the failing tests**

`packages/service/test/keeper.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/service`
Expected: FAIL — cannot resolve `../src/keeper`.

- [ ] **Step 3: Implement**

`packages/service/src/keeper.ts`:
```ts
import type { Store } from "./db";
import type { SubReader } from "./atrisk";

export interface ChargeSender {
  charge(subId: string): Promise<{ txHash: string }>;
}

/**
 * Calls SubscriptionManager.charge(subId) for due subscriptions. charge() is
 * permissionless on-chain, so the keeper is a convenience, not a trust point.
 * Successful charges surface as chain events via the Indexer, not here.
 */
export class Keeper {
  private readonly store: Store;
  private readonly reader: SubReader;
  private readonly sender: ChargeSender;
  private readonly now: () => number;

  constructor(opts: { store: Store; reader: SubReader; sender: ChargeSender; now?: () => number }) {
    this.store = opts.store;
    this.reader = opts.reader;
    this.sender = opts.sender;
    this.now = opts.now ?? (() => Date.now());
  }

  async runOnce(): Promise<{ charged: string[]; failed: Array<{ subId: string; error: string }> }> {
    const nowS = Math.floor(this.now() / 1000);
    const charged: string[] = [];
    const failed: Array<{ subId: string; error: string }> = [];
    for (const subId of this.store.listActiveSubs()) {
      const s = await this.reader.getUpcomingCharge(subId);
      if (!s.active) {
        this.store.deactivateSub(subId);
        continue;
      }
      if (nowS < s.nextChargeAt) continue;
      try {
        await this.sender.charge(subId);
        charged.push(subId);
      } catch (err) {
        failed.push({ subId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { charged, failed };
  }
}
```

Add to `packages/service/src/index.ts`: `export * from "./keeper";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/service`
Expected: 6 files, 28 tests PASS. Also run root `npm test` — all workspaces green (server 21, client 17, service 28).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(service): keeper bot with contained per-sub failures

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Runner + README

**Files:**
- Create: `packages/service/bin/service.ts`
- Modify: root `README.md` (add Services section after "SDKs (Phase 2)")

**Interfaces:**
- Consumes: everything above + viem real clients. Runner is typecheck-only (live run needs deployed contracts + funded keeper wallet).
- Env: `RPC_URL` (default `https://rpc.testnet.arc.network`), `CARD_ISSUER_ADDRESS`, `SUBSCRIPTION_MANAGER_ADDRESS` (required), `DB_PATH` (default `scruple-service.db`), `WEBHOOK_URL`/`WEBHOOK_SECRET` (optional, registers one endpoint at boot if the DB has none), `KEEPER_PRIVATE_KEY` (optional — keeper disabled without it), `POLL_INTERVAL_MS` (default 5000).

- [ ] **Step 1: Write the runner**

`packages/service/bin/service.ts`:
```ts
import { createPublicClient, createWalletClient, erc20Abi, getContract, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { Store } from "../src/db";
import { Indexer, type ChainReader } from "../src/indexer";
import { Dispatcher } from "../src/webhooks";
import { AtRiskMonitor, type SubReader } from "../src/atrisk";
import { Keeper } from "../src/keeper";
import type { RawLog } from "../src/events";

const RPC_URL = process.env.RPC_URL ?? "https://rpc.testnet.arc.network";
const CARD_ISSUER = required("CARD_ISSUER_ADDRESS");
const SUBSCRIPTION_MANAGER = required("SUBSCRIPTION_MANAGER_ADDRESS");
const USDC = "0x3600000000000000000000000000000000000000";
const DB_PATH = process.env.DB_PATH ?? "scruple-service.db";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);

function required(name: string): `0x${string}` {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  return v as `0x${string}`;
}

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });

const SUBS_READ_ABI = parseAbi([
  "struct Subscription { address customer; uint256 planId; uint16 planVersion; uint256 cardId; uint48 nextChargeAt; uint8 state; }",
  "struct Plan { address merchant; address token; uint16 latestVersion; bool active; }",
  "struct PlanVersion { uint256 amount; uint48 period; uint48 trialPeriod; }",
  "function getSubscription(uint256 subId) view returns (Subscription memory)",
  "function getPlan(uint256 planId) view returns (Plan memory)",
  "function getPlanVersion(uint256 planId, uint16 version) view returns (PlanVersion memory)",
  "function charge(uint256 subId)",
]);
const ISSUER_READ_ABI = parseAbi([
  "function previewSpend(uint256 cardId, address merchant, uint256 amount) view returns (bool)",
]);

const subsContract = getContract({ address: SUBSCRIPTION_MANAGER, abi: SUBS_READ_ABI, client: publicClient });
const issuerContract = getContract({ address: CARD_ISSUER, abi: ISSUER_READ_ABI, client: publicClient });

const chainReader: ChainReader = {
  getBlockNumber: () => publicClient.getBlockNumber(),
  getLogs: async ({ addresses, fromBlock, toBlock }) => {
    const logs = await publicClient.getLogs({ address: addresses as `0x${string}`[], fromBlock, toBlock });
    return logs.map((l): RawLog => ({
      address: l.address,
      topics: [...l.topics],
      data: l.data,
      blockNumber: l.blockNumber,
      transactionHash: l.transactionHash,
      logIndex: l.logIndex,
    }));
  },
};

const subReader: SubReader = {
  async getUpcomingCharge(subId) {
    const s = await subsContract.read.getSubscription([BigInt(subId)]);
    const plan = await subsContract.read.getPlan([s.planId]);
    const v = await subsContract.read.getPlanVersion([s.planId, plan.latestVersion]);
    return {
      active: s.state === 0 && s.customer !== "0x0000000000000000000000000000000000000000",
      nextChargeAt: Number(s.nextChargeAt),
      amount: v.amount,
      merchant: plan.merchant,
      customer: s.customer,
      cardId: s.cardId.toString(),
    };
  },
  balanceOf: async (address) =>
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] }),
  previewSpend: (cardId, merchant, amount) =>
    issuerContract.read.previewSpend([BigInt(cardId), merchant as `0x${string}`, amount]),
};

const store = new Store(DB_PATH);
if (process.env.WEBHOOK_URL && process.env.WEBHOOK_SECRET && store.listEndpoints().length === 0) {
  store.addEndpoint(process.env.WEBHOOK_URL, process.env.WEBHOOK_SECRET);
}

const indexer = new Indexer({ store, reader: chainReader, cardIssuer: CARD_ISSUER, subscriptionManager: SUBSCRIPTION_MANAGER });
const dispatcher = new Dispatcher({ store });
const monitor = new AtRiskMonitor({ store, reader: subReader });

let keeper: Keeper | null = null;
if (process.env.KEEPER_PRIVATE_KEY) {
  const account = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(RPC_URL) });
  keeper = new Keeper({
    store,
    reader: subReader,
    sender: {
      charge: async (subId) => ({
        txHash: await walletClient.writeContract({
          address: SUBSCRIPTION_MANAGER, abi: SUBS_READ_ABI, functionName: "charge", args: [BigInt(subId)],
        }),
      }),
    },
  });
}

async function tick() {
  try {
    const idx = await indexer.runOnce();
    const hooks = await dispatcher.dispatchDue();
    const risks = await monitor.runOnce();
    const kept = keeper ? await keeper.runOnce() : { charged: [], failed: [] };
    if (idx.processed || hooks.delivered || hooks.failed || risks || kept.charged.length || kept.failed.length) {
      console.log(`[scruple-service] indexed=${idx.processed} delivered=${hooks.delivered} hookFails=${hooks.failed} atRisk=${risks} charged=${kept.charged.length} chargeFails=${kept.failed.length}`);
      for (const f of kept.failed) console.error(`[scruple-service] charge(${f.subId}) failed: ${f.error}`);
    }
  } catch (err) {
    console.error("[scruple-service] tick failed:", err);
  }
}

console.log(`[scruple-service] starting — rpc=${RPC_URL} db=${DB_PATH} keeper=${keeper ? "on" : "off"}`);
await tick();
setInterval(tick, POLL_INTERVAL_MS);
```

- [ ] **Step 2: Typecheck**

Run from root: `npx tsc --noEmit -p packages/service` (the package tsconfig includes `bin/`). If viem struct-ABI syntax in `parseAbi` fails to typecheck, switch `SUBS_READ_ABI` to a plain const-asserted ABI array with tuple components — record what you did in your report.
Expected: no errors.

- [ ] **Step 3: README section** — insert after the "SDKs (Phase 2)" section:

```markdown
## Services (Phase 3)

`@scruple/service` — the off-chain backbone:

- **Indexer** — chunked `getLogs` polling (Arc drops `eth_newFilter`), resumable cursor, deterministic event ids (`txHash:logIndex`).
- **Webhooks** — HMAC-SHA256-signed deliveries (`scruple-signature`), idempotency id on every event, retries at 1m/5m/30m/2h/12h then dead-lettered.
- **At-risk monitor** — emits `subscription.at_risk` *before* a renewal that would fail (insufficient balance or card policy), killing silent churn.
- **Keeper** — calls the permissionless `charge()` for due subscriptions.

    # after deploying contracts (see Deploy):
    CARD_ISSUER_ADDRESS=0x… SUBSCRIPTION_MANAGER_ADDRESS=0x… \
    WEBHOOK_URL=https://your.app/hooks WEBHOOK_SECRET=whsec_… \
    KEEPER_PRIVATE_KEY=0x… npx tsx packages/service/bin/service.ts

Event taxonomy: `card.created|frozen|unfrozen|cancelled`, `plan.created|version_pushed`,
`subscription.created|expired|cancelled|at_risk`, `payment.succeeded`.
(`payment.attempt_failed`/`payment.overdue` detection lands with the dashboard phase.)
Store is SQLite for the MVP (schema is Postgres-portable).
```

- [ ] **Step 4: Run full test suite once**

Run: `npm test`
Expected: server 21 + client 17 + service 28 = 66 tests, all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(service): runner wiring viem clients + README services section

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope for this plan (Phase 4)

- Dashboard (Next.js, card visuals), `payment.attempt_failed`/`payment.overdue` detection, metered `PaymentEvent` → webhook ingest from `@scruple/server`, human passkey payer mode, demo video + deck, live testnet deploy + end-to-end run.
