# Scruple Phase 2 (SDKs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@scruple/server` (Express middleware: rate cards → HTTP 402 → payment verification → Gateway settlement) and `@scruple/client` (payer/agent client: catch 402 → spending-policy check → pay → retry), fully unit-tested with dependency-injected network boundaries, plus a runnable examples pair.

**Architecture:** Both SDKs wrap Circle's `@circle-fin/x402-batching` (settlement batching happens inside Circle's Gateway backend — we do NOT build a client-side batch buffer). Scruple's value-add: declarative rate cards, the 402 protocol plumbing, typed payment events (Phase 3 webhook feed), and client-side spending policies mirroring CardIssuer's rolling-period semantics. All Circle SDK calls go through injected interfaces so unit tests never touch the network.

**Tech Stack:** TypeScript (^5.9), npm workspaces monorepo, vitest, Express ^4, supertest (dev), `@circle-fin/x402-batching` ^2.0.4, viem ^2.47. No build step in Phase 2 — packages are consumed in-repo via TS source (`main: src/index.ts`); examples run with `tsx`.

## Global Constraints

- USDC money math is **atomic 6-decimal `bigint`** everywhere ($1 = `1_000_000n`). Price strings are `"$0.001"` form; conversion must round to nearest atomic unit. NEVER use 18 decimals for payment USDC.
- x402 protocol headers, exact names: request→`payment-signature` (read lowercase), response→`PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`, values = base64(JSON).
- Payment requirements object (per Circle sample, verbatim field names): `{ scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: string, payTo, maxTimeoutSeconds: 345600, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" } }`.
- Production settlement pattern: call facilitator `settle()` directly — do NOT call `verify()` then `settle()` (Circle docs recommendation).
- All network boundaries (facilitator, GatewayClient, global fetch) are constructor-injected interfaces; unit tests use fakes, never live endpoints.
- Client spending-policy periods use anchored rolling windows (same semantics as `CardIssuer._rolledPeriodStart`: `periodStart += elapsedPeriods * periodMs`, spent resets).
- EOA-only signing (Gateway uses ecrecover; SCA/EIP-1271 unsupported) — document, don't work around.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

```
scruple/
  package.json                      # npm workspaces root (private)
  tsconfig.base.json
  packages/
    server/                         # @scruple/server
      package.json
      tsconfig.json
      vitest.config.ts
      src/index.ts                  # re-exports
      src/constants.ts              # Arc testnet constants
      src/ratecard.ts               # price parsing + route matching
      src/x402.ts                   # 402 build / payment-signature decode
      src/middleware.ts             # scruple() Express middleware
      test/ratecard.test.ts
      test/x402.test.ts
      test/middleware.test.ts
    client/                         # @scruple/client
      package.json
      tsconfig.json
      vitest.config.ts
      src/index.ts
      src/policy.ts                 # SpendingPolicy + PolicyTracker
      src/client.ts                 # ScrupleClient (fetch → 402 → pay)
      test/policy.test.ts
      test/client.test.ts
  examples/
    seller.ts                       # Express API with scruple() middleware
    agent.ts                        # agent paying with ScrupleClient + policy
```

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json` (root), `tsconfig.base.json`, `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/vitest.config.ts`, `packages/server/src/index.ts`, `packages/client/package.json`, `packages/client/tsconfig.json`, `packages/client/vitest.config.ts`, `packages/client/src/index.ts`

**Interfaces:**
- Produces: workspace layout where `npm test -w @scruple/server` / `-w @scruple/client` run vitest; later tasks add sources under `packages/*/src`.

- [ ] **Step 1: Root workspace files**

Root `package.json` (the repo root has no package.json yet — this creates it):
```json
{
  "name": "scruple-monorepo",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "npm run test --workspaces --if-present"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  }
}
```

- [ ] **Step 2: Server package skeleton**

`packages/server/package.json`:
```json
{
  "name": "@scruple/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "dependencies": {
    "@circle-fin/x402-batching": "^2.0.4"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^25.4.0",
    "@types/supertest": "^6.0.2",
    "express": "^4.21.0",
    "supertest": "^7.0.0",
    "typescript": "^5.9.3",
    "vitest": "^3.0.0"
  },
  "peerDependencies": { "express": ">=4" }
}
```

`packages/server/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

`packages/server/src/index.ts`:
```ts
export {};
```

- [ ] **Step 3: Client package skeleton**

`packages/client/package.json`:
```json
{
  "name": "@scruple/client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "dependencies": {
    "@circle-fin/x402-batching": "^2.0.4",
    "viem": "^2.47.1"
  },
  "devDependencies": {
    "@types/node": "^25.4.0",
    "typescript": "^5.9.3",
    "vitest": "^3.0.0"
  }
}
```

`packages/client/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/client/vitest.config.ts`: same content as server's.

`packages/client/src/index.ts`:
```ts
export {};
```

- [ ] **Step 4: Install and verify**

Run from repo root: `npm install`
Expected: lockfile created, workspaces linked, no errors. Then `npm test` → both workspaces report "no test files found" (vitest exits 0 with `--passWithNoTests`? It does NOT by default — so instead verify with `npx vitest --version` and defer `npm test` until Task 2 adds the first test. Acceptable check: `npm ls @circle-fin/x402-batching` shows the dep resolved in both packages.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: npm workspaces scaffold for @scruple/server and @scruple/client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Server — money parsing + rate card matching

**Files:**
- Create: `packages/server/src/constants.ts`, `packages/server/src/ratecard.ts`, `packages/server/test/ratecard.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces:
  - `constants.ts`: `ARC_TESTNET_NETWORK = "eip155:5042002"`, `ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000"`, `ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"`, `USDC_DECIMALS = 6`
  - `priceToAtomic(price: string): bigint` — `"$0.001"` → `1000n`; throws `InvalidPriceError` on malformed/negative/NaN input; rounds to nearest atomic unit.
  - `formatAtomic(amount: bigint): string` — `1000n` → `"$0.001"` (trailing zeros trimmed, min "$0").
  - `type RateCard = Record<string, string>` — key `"GET /api/quote"` (method uppercase + space + path), value price string.
  - `matchRoute(rateCard: RateCard, method: string, path: string): { price: string; atomic: bigint } | null` — exact match on `${method.toUpperCase()} ${path}`; query strings must be stripped by caller (middleware strips).

- [ ] **Step 1: Write the failing tests**

`packages/server/test/ratecard.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { priceToAtomic, formatAtomic, matchRoute, InvalidPriceError } from "../src/ratecard";

describe("priceToAtomic", () => {
  it("converts dollar strings to 6-decimal atomic bigints", () => {
    expect(priceToAtomic("$0.001")).toBe(1000n);
    expect(priceToAtomic("$1")).toBe(1_000_000n);
    expect(priceToAtomic("$0.0003")).toBe(300n);
    expect(priceToAtomic("$29.99")).toBe(29_990_000n);
  });
  it("rounds sub-atomic prices to nearest unit", () => {
    expect(priceToAtomic("$0.0000015")).toBe(2n); // 1.5 -> 2
  });
  it("throws on malformed input", () => {
    expect(() => priceToAtomic("0.01")).toThrow(InvalidPriceError);   // missing $
    expect(() => priceToAtomic("$abc")).toThrow(InvalidPriceError);
    expect(() => priceToAtomic("$-1")).toThrow(InvalidPriceError);
    expect(() => priceToAtomic("$")).toThrow(InvalidPriceError);
  });
});

describe("formatAtomic", () => {
  it("formats atomic back to dollar strings", () => {
    expect(formatAtomic(1000n)).toBe("$0.001");
    expect(formatAtomic(1_000_000n)).toBe("$1");
    expect(formatAtomic(29_990_000n)).toBe("$29.99");
    expect(formatAtomic(0n)).toBe("$0");
  });
});

describe("matchRoute", () => {
  const card = { "GET /api/quote": "$0.001", "POST /api/compute": "$0.0003" };
  it("matches method+path and returns price with atomic amount", () => {
    expect(matchRoute(card, "get", "/api/quote")).toEqual({ price: "$0.001", atomic: 1000n });
    expect(matchRoute(card, "POST", "/api/compute")).toEqual({ price: "$0.0003", atomic: 300n });
  });
  it("returns null for unpriced routes", () => {
    expect(matchRoute(card, "GET", "/health")).toBeNull();
    expect(matchRoute(card, "DELETE", "/api/quote")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/server`
Expected: FAIL — cannot resolve `../src/ratecard`.

- [ ] **Step 3: Implement**

`packages/server/src/constants.ts`:
```ts
export const ARC_TESTNET_NETWORK = "eip155:5042002";
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
export const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
export const USDC_DECIMALS = 6;
```

`packages/server/src/ratecard.ts`:
```ts
export class InvalidPriceError extends Error {
  constructor(price: string) {
    super(`Invalid price string: "${price}" (expected "$<decimal>", e.g. "$0.001")`);
    this.name = "InvalidPriceError";
  }
}

const PRICE_RE = /^\$(\d+(?:\.\d+)?)$/;

/** "$0.001" -> 1000n (6-decimal atomic USDC), rounded to nearest unit. */
export function priceToAtomic(price: string): bigint {
  const m = PRICE_RE.exec(price);
  if (!m) throw new InvalidPriceError(price);
  const [whole, frac = ""] = m[1].split(".");
  const fracPadded = (frac + "0000000").slice(0, 7); // 7th digit for rounding
  const atomic7 = BigInt(whole) * 10_000_000n + BigInt(fracPadded);
  return (atomic7 + 5n) / 10n; // round half-up to 6 decimals
}

/** 1000n -> "$0.001" (trailing zeros trimmed). */
export function formatAtomic(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `$${whole}.${frac}` : `$${whole}`;
}

export type RateCard = Record<string, string>;

export function matchRoute(
  rateCard: RateCard,
  method: string,
  path: string,
): { price: string; atomic: bigint } | null {
  const price = rateCard[`${method.toUpperCase()} ${path}`];
  if (price === undefined) return null;
  return { price, atomic: priceToAtomic(price) };
}
```

`packages/server/src/index.ts`:
```ts
export * from "./constants";
export * from "./ratecard";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/server`
Expected: 1 file, 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): price parsing and rate card matching

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Server — 402 protocol encoding/decoding

**Files:**
- Create: `packages/server/src/x402.ts`, `packages/server/test/x402.test.ts`
- Modify: `packages/server/src/index.ts` (add `export * from "./x402";`)

**Interfaces:**
- Produces:
  - `buildPaymentRequirements(opts: { atomic: bigint; payTo: string }): PaymentRequirements` — exact Circle shape (Global Constraints), `amount` as decimal string.
  - `buildPaymentRequiredHeader(opts: { endpoint: string; price: string; requirements: PaymentRequirements }): string` — base64 of `{ x402Version: 2, resource: { url, description: \`Paid resource (${price} USDC)\`, mimeType: "application/json" }, accepts: [requirements] }`.
  - `decodePaymentSignature(header: string): PaymentPayload` — base64 JSON parse; throws `MalformedPaymentError` on bad base64/JSON.
  - Types: `PaymentRequirements`, `PaymentPayload { x402Version: number; resource?: unknown; accepted?: unknown; payload: Record<string, unknown>; extensions?: unknown }`, `SettleResult { success: boolean; errorReason?: string; payer?: string; transaction?: string | null }`, `Facilitator { settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult> }`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/x402.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  buildPaymentRequirements, buildPaymentRequiredHeader,
  decodePaymentSignature, MalformedPaymentError,
} from "../src/x402";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC, ARC_TESTNET_GATEWAY_WALLET } from "../src/constants";

const SELLER = "0x00000000000000000000000000000000000SE11e" as const;

describe("buildPaymentRequirements", () => {
  it("produces the exact Circle Gateway shape", () => {
    expect(buildPaymentRequirements({ atomic: 1000n, payTo: SELLER })).toEqual({
      scheme: "exact",
      network: ARC_TESTNET_NETWORK,
      asset: ARC_TESTNET_USDC,
      amount: "1000",
      payTo: SELLER,
      maxTimeoutSeconds: 345600,
      extra: {
        name: "GatewayWalletBatched",
        version: "1",
        verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
      },
    });
  });
});

describe("buildPaymentRequiredHeader / decode roundtrip", () => {
  it("base64-encodes the x402 v2 payment-required envelope", () => {
    const requirements = buildPaymentRequirements({ atomic: 1000n, payTo: SELLER });
    const header = buildPaymentRequiredHeader({ endpoint: "/api/quote", price: "$0.001", requirements });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe("/api/quote");
    expect(decoded.resource.description).toBe("Paid resource ($0.001 USDC)");
    expect(decoded.accepts).toEqual([requirements]);
  });
});

describe("decodePaymentSignature", () => {
  it("decodes a base64 payment payload", () => {
    const payload = { x402Version: 2, payload: { signature: "0xabc" } };
    const header = Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(decodePaymentSignature(header)).toEqual(payload);
  });
  it("throws MalformedPaymentError on garbage", () => {
    expect(() => decodePaymentSignature("!!!not-base64-json!!!")).toThrow(MalformedPaymentError);
    expect(() => decodePaymentSignature(Buffer.from("[1,2,3]").toString("base64"))).toThrow(MalformedPaymentError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/server`
Expected: FAIL — cannot resolve `../src/x402`.

- [ ] **Step 3: Implement**

`packages/server/src/x402.ts`:
```ts
import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC, ARC_TESTNET_GATEWAY_WALLET } from "./constants";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; verifyingContract: string };
}

export interface PaymentPayload {
  x402Version: number;
  resource?: unknown;
  accepted?: unknown;
  payload: Record<string, unknown>;
  extensions?: unknown;
}

export interface SettleResult {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string | null;
}

/** Injected settlement boundary — production impl is Circle's BatchFacilitatorClient. */
export interface Facilitator {
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult>;
}

export class MalformedPaymentError extends Error {
  constructor(detail: string) {
    super(`Malformed payment-signature header: ${detail}`);
    this.name = "MalformedPaymentError";
  }
}

export function buildPaymentRequirements(opts: { atomic: bigint; payTo: string }): PaymentRequirements {
  return {
    scheme: "exact",
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: opts.atomic.toString(),
    payTo: opts.payTo,
    maxTimeoutSeconds: 345600,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  };
}

export function buildPaymentRequiredHeader(opts: {
  endpoint: string;
  price: string;
  requirements: PaymentRequirements;
}): string {
  const envelope = {
    x402Version: 2,
    resource: {
      url: opts.endpoint,
      description: `Paid resource (${opts.price} USDC)`,
      mimeType: "application/json",
    },
    accepts: [opts.requirements],
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

export function decodePaymentSignature(header: string): PaymentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    throw new MalformedPaymentError("not base64-encoded JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MalformedPaymentError("payload is not an object");
  }
  return parsed as PaymentPayload;
}
```

Add to `packages/server/src/index.ts`: `export * from "./x402";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/server`
Expected: 2 files, 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): x402 payment-required encoding and payment-signature decoding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Server — Express middleware

**Files:**
- Create: `packages/server/src/middleware.ts`, `packages/server/test/middleware.test.ts`
- Modify: `packages/server/src/index.ts` (add `export * from "./middleware";`)

**Interfaces:**
- Produces:
  - `scruple(opts: ScrupleOptions): express.RequestHandler`
  - `interface ScrupleOptions { rateCard: RateCard; sellerAddress: string; facilitator: Facilitator; onPayment?: (e: PaymentEvent) => void }`
  - `interface PaymentEvent { endpoint: string; payer?: string; atomic: bigint; price: string; transaction?: string | null; at: number }`
  - Request augmentation: on success sets `(req as PaidRequest).payment = { payer, atomic, transaction }`.
  - Behavior: unpriced route → `next()` untouched. Priced + no `payment-signature` header → 402, body `{}`, `PAYMENT-REQUIRED` header. Malformed header → 402 `{ error: "Malformed payment" }`. `settle()` fails → 402 `{ error: "Payment settlement failed", reason }`. Success → set `PAYMENT-RESPONSE` header (base64 of `{ success: true, transaction, network, payer }`), fire `onPayment`, `next()`.
  - Path matching uses `req.path` (Express strips query string automatically).
- Consumes: Task 2 `matchRoute`, Task 3 x402 functions + `Facilitator`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/middleware.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { scruple, type PaidRequest } from "../src/middleware";
import { buildPaymentRequirements, type Facilitator } from "../src/x402";

const SELLER = "0x00000000000000000000000000000000000SE11e";

function makeApp(facilitator: Facilitator, onPayment?: (e: any) => void) {
  const app = express();
  app.use(scruple({
    rateCard: { "GET /api/quote": "$0.001" },
    sellerAddress: SELLER,
    facilitator,
    onPayment,
  }));
  app.get("/api/quote", (req, res) => {
    res.json({ quote: 42, payer: (req as PaidRequest).payment?.payer });
  });
  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  return app;
}

const okFacilitator: Facilitator = {
  settle: async () => ({ success: true, payer: "0xPAYER", transaction: "0xTX" }),
};

function encodePayload() {
  return Buffer.from(JSON.stringify({ x402Version: 2, payload: { sig: "0xabc" } })).toString("base64");
}

describe("scruple middleware", () => {
  it("passes unpriced routes through untouched", async () => {
    const res = await request(makeApp(okFacilitator)).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["payment-required"]).toBeUndefined();
  });

  it("returns 402 with PAYMENT-REQUIRED header when no payment attached", async () => {
    const res = await request(makeApp(okFacilitator)).get("/api/quote");
    expect(res.status).toBe(402);
    expect(res.body).toEqual({});
    const decoded = JSON.parse(Buffer.from(res.headers["payment-required"], "base64").toString());
    expect(decoded.accepts[0]).toEqual(buildPaymentRequirements({ atomic: 1000n, payTo: SELLER }));
    expect(decoded.resource.url).toBe("/api/quote");
  });

  it("settles and serves when payment-signature is valid", async () => {
    const settle = vi.fn(async () => ({ success: true, payer: "0xPAYER", transaction: "0xTX" }));
    const events: any[] = [];
    const app = makeApp({ settle }, (e) => events.push(e));
    const res = await request(app).get("/api/quote").set("payment-signature", encodePayload());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ quote: 42, payer: "0xPAYER" });
    expect(settle).toHaveBeenCalledOnce();
    const [payload, requirements] = settle.mock.calls[0];
    expect(payload.x402Version).toBe(2);
    expect(requirements.amount).toBe("1000");
    const pr = JSON.parse(Buffer.from(res.headers["payment-response"], "base64").toString());
    expect(pr).toEqual({ success: true, transaction: "0xTX", network: "eip155:5042002", payer: "0xPAYER" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ endpoint: "/api/quote", payer: "0xPAYER", atomic: 1000n, price: "$0.001" });
  });

  it("returns 402 with reason when settlement fails, and does not serve", async () => {
    const app = makeApp({ settle: async () => ({ success: false, errorReason: "insufficient_balance" }) });
    const res = await request(app).get("/api/quote").set("payment-signature", encodePayload());
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: "Payment settlement failed", reason: "insufficient_balance" });
  });

  it("returns 402 for malformed payment-signature without calling settle", async () => {
    const settle = vi.fn();
    const res = await request(makeApp({ settle } as unknown as Facilitator))
      .get("/api/quote").set("payment-signature", "!!!garbage!!!");
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("Malformed payment");
    expect(settle).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/server`
Expected: FAIL — cannot resolve `../src/middleware`.

- [ ] **Step 3: Implement**

`packages/server/src/middleware.ts`:
```ts
import type { Request, RequestHandler } from "express";
import { matchRoute, type RateCard } from "./ratecard";
import { ARC_TESTNET_NETWORK } from "./constants";
import {
  buildPaymentRequirements, buildPaymentRequiredHeader,
  decodePaymentSignature, MalformedPaymentError, type Facilitator,
} from "./x402";

export interface PaymentEvent {
  endpoint: string;
  payer?: string;
  atomic: bigint;
  price: string;
  transaction?: string | null;
  at: number;
}

export interface PaidRequest extends Request {
  payment?: { payer?: string; atomic: bigint; transaction?: string | null };
}

export interface ScrupleOptions {
  rateCard: RateCard;
  sellerAddress: string;
  facilitator: Facilitator;
  onPayment?: (e: PaymentEvent) => void;
}

export function scruple(opts: ScrupleOptions): RequestHandler {
  return async (req, res, next) => {
    const match = matchRoute(opts.rateCard, req.method, req.path);
    if (!match) return next();

    const requirements = buildPaymentRequirements({ atomic: match.atomic, payTo: opts.sellerAddress });
    const header = req.headers["payment-signature"];
    if (typeof header !== "string") {
      res.status(402)
        .set("PAYMENT-REQUIRED", buildPaymentRequiredHeader({
          endpoint: req.path, price: match.price, requirements,
        }))
        .json({});
      return;
    }

    let payload;
    try {
      payload = decodePaymentSignature(header);
    } catch (err) {
      if (err instanceof MalformedPaymentError) {
        res.status(402).json({ error: "Malformed payment", reason: err.message });
        return;
      }
      throw err;
    }

    const settled = await opts.facilitator.settle(payload, requirements);
    if (!settled.success) {
      res.status(402).json({ error: "Payment settlement failed", reason: settled.errorReason });
      return;
    }

    (req as PaidRequest).payment = {
      payer: settled.payer, atomic: match.atomic, transaction: settled.transaction,
    };
    res.set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({
      success: true, transaction: settled.transaction ?? null,
      network: ARC_TESTNET_NETWORK, payer: settled.payer,
    })).toString("base64"));
    opts.onPayment?.({
      endpoint: req.path, payer: settled.payer, atomic: match.atomic,
      price: match.price, transaction: settled.transaction, at: Date.now(),
    });
    next();
  };
}
```

Add to `packages/server/src/index.ts`: `export * from "./middleware";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/server`
Expected: 3 files, 15 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): scruple() Express middleware — 402 challenge, settle, payment events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Client — spending policy

**Files:**
- Create: `packages/client/src/policy.ts`, `packages/client/test/policy.test.ts`
- Modify: `packages/client/src/index.ts` (add `export * from "./policy";`)

**Interfaces:**
- Produces:
  - `interface SpendingPolicy { periodBudget: bigint; periodMs: number; perTxCap?: bigint; allowedOrigins?: string[] }`
  - `type PolicyDecision = { ok: true } | { ok: false; reason: "over_budget" | "over_tx_cap" | "origin_not_allowed" }`
  - `class PolicyTracker { constructor(policy: SpendingPolicy, now?: () => number); check(atomic: bigint, origin: string): PolicyDecision; record(atomic: bigint): void; spentInPeriod(): bigint }`
  - Anchored rolling windows: period start advances by whole periods (`start += floor(elapsed/periodMs)*periodMs`), spent resets on rollover — same semantics as `CardIssuer`.
  - `check` does NOT mutate; `record` debits. Throws `RangeError` if `periodMs <= 0` at construction.

- [ ] **Step 1: Write the failing tests**

`packages/client/test/policy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PolicyTracker } from "../src/policy";

const ORIGIN = "https://api.example.com";

function tracker(overrides = {}, startAt = 1_000_000) {
  let t = startAt;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const p = new PolicyTracker(
    { periodBudget: 2_000_000n, periodMs: 86_400_000, allowedOrigins: [ORIGIN], perTxCap: 1_500_000n, ...overrides },
    clock.now,
  );
  return { p, clock };
}

describe("PolicyTracker", () => {
  it("allows within budget and records spend", () => {
    const { p } = tracker();
    expect(p.check(1_000_000n, ORIGIN)).toEqual({ ok: true });
    p.record(1_000_000n);
    expect(p.spentInPeriod()).toBe(1_000_000n);
  });

  it("rejects over period budget", () => {
    const { p } = tracker();
    p.record(1_500_000n);
    expect(p.check(600_000n, ORIGIN)).toEqual({ ok: false, reason: "over_budget" });
  });

  it("rejects over per-tx cap even when budget remains", () => {
    const { p } = tracker();
    expect(p.check(1_500_001n, ORIGIN)).toEqual({ ok: false, reason: "over_tx_cap" });
  });

  it("rejects disallowed origins; allows any origin when list omitted", () => {
    const { p } = tracker();
    expect(p.check(1n, "https://evil.example")).toEqual({ ok: false, reason: "origin_not_allowed" });
    const open = new PolicyTracker({ periodBudget: 10n, periodMs: 1000 });
    expect(open.check(1n, "https://anywhere.example")).toEqual({ ok: true });
  });

  it("resets spend on anchored period rollover", () => {
    const { p, clock } = tracker();
    p.record(2_000_000n);
    expect(p.check(1n, ORIGIN)).toEqual({ ok: false, reason: "over_budget" });
    clock.advance(86_400_000 + 1);
    expect(p.check(1_000_000n, ORIGIN)).toEqual({ ok: true });
    expect(p.spentInPeriod()).toBe(0n);
  });

  it("anchors periods to the start, not to the last spend", () => {
    const { p, clock } = tracker();
    clock.advance(86_400_000 * 2 + 5); // 2 full periods + 5ms
    p.record(1n);
    clock.advance(86_400_000 - 10); // still inside period 3
    p.record(1n);
    expect(p.spentInPeriod()).toBe(2n);
  });

  it("rejects nonpositive periodMs", () => {
    expect(() => new PolicyTracker({ periodBudget: 1n, periodMs: 0 })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/client`
Expected: FAIL — cannot resolve `../src/policy`.

- [ ] **Step 3: Implement**

`packages/client/src/policy.ts`:
```ts
export interface SpendingPolicy {
  periodBudget: bigint;
  periodMs: number;
  perTxCap?: bigint;
  allowedOrigins?: string[];
}

export type PolicyDecision =
  | { ok: true }
  | { ok: false; reason: "over_budget" | "over_tx_cap" | "origin_not_allowed" };

/** Client-side spending policy with anchored rolling periods (mirrors CardIssuer semantics). */
export class PolicyTracker {
  private periodStart: number;
  private spent = 0n;

  constructor(
    private readonly policy: SpendingPolicy,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (policy.periodMs <= 0) throw new RangeError("periodMs must be > 0");
    this.periodStart = this.now();
  }

  private roll(): void {
    const elapsed = this.now() - this.periodStart;
    if (elapsed >= this.policy.periodMs) {
      const periods = Math.floor(elapsed / this.policy.periodMs);
      this.periodStart += periods * this.policy.periodMs;
      this.spent = 0n;
    }
  }

  check(atomic: bigint, origin: string): PolicyDecision {
    this.roll();
    const { allowedOrigins, perTxCap, periodBudget } = this.policy;
    if (allowedOrigins && !allowedOrigins.includes(origin)) {
      return { ok: false, reason: "origin_not_allowed" };
    }
    if (perTxCap !== undefined && atomic > perTxCap) {
      return { ok: false, reason: "over_tx_cap" };
    }
    if (this.spent + atomic > periodBudget) {
      return { ok: false, reason: "over_budget" };
    }
    return { ok: true };
  }

  record(atomic: bigint): void {
    this.roll();
    this.spent += atomic;
  }

  spentInPeriod(): bigint {
    this.roll();
    return this.spent;
  }
}
```

Add to `packages/client/src/index.ts`: `export * from "./policy";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/client`
Expected: 1 file, 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): spending policy with anchored rolling periods

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Client — ScrupleClient (catch 402 → policy → pay → retry)

**Files:**
- Create: `packages/client/src/client.ts`, `packages/client/test/client.test.ts`
- Modify: `packages/client/src/index.ts` (add `export * from "./client";`)

**Interfaces:**
- Produces:
  - `interface GatewayLike { pay(url: string, opts?: { method?: string; body?: unknown }): Promise<{ status: number; data: unknown; formattedAmount?: string }> }` — production impl is Circle's `GatewayClient` (`new GatewayClient({ chain: "arcTestnet", privateKey })`).
  - `class PolicyExceededError extends Error { reason: string; atomic: bigint }`
  - `class ScrupleClient { constructor(opts: { gateway: GatewayLike; policy?: PolicyTracker; fetchImpl?: typeof fetch }); async fetch(url: string, init?: { method?: string; body?: unknown }): Promise<ScrupleResponse> }`
  - `interface ScrupleResponse { status: number; data: unknown; paid?: { atomic: bigint } }`
  - Behavior: initial request via `fetchImpl` (default `globalThis.fetch`). Non-402 → return `{ status, data }` (JSON body parsed; non-JSON → `data: null`). 402 → read `PAYMENT-REQUIRED` header, base64-decode, take `accepts[0].amount` as atomic bigint; policy check against `new URL(url).origin`; fail → throw `PolicyExceededError`; pass → `gateway.pay(url, init)`, then `policy.record(atomic)`, return `{ status, data, paid: { atomic } }`. Missing/undecodable `PAYMENT-REQUIRED` on a 402 → throw `MalformedChallengeError`.
- Consumes: Task 5 `PolicyTracker`.

- [ ] **Step 1: Write the failing tests**

`packages/client/test/client.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { ScrupleClient, PolicyExceededError, MalformedChallengeError } from "../src/client";
import { PolicyTracker } from "../src/policy";

const URL_ = "https://api.example.com/api/quote";

function challenge(atomic: bigint) {
  const envelope = { x402Version: 2, accepts: [{ amount: atomic.toString() }] };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

function fetch402(atomic: bigint) {
  return vi.fn(async () => new Response("{}", {
    status: 402,
    headers: { "PAYMENT-REQUIRED": challenge(atomic) },
  }));
}

describe("ScrupleClient.fetch", () => {
  it("returns non-402 responses without paying", async () => {
    const gateway = { pay: vi.fn() };
    const fetchImpl = vi.fn(async () => Response.json({ free: true }));
    const c = new ScrupleClient({ gateway, fetchImpl });
    const res = await c.fetch(URL_);
    expect(res).toEqual({ status: 200, data: { free: true } });
    expect(gateway.pay).not.toHaveBeenCalled();
  });

  it("pays a 402 within policy and records spend", async () => {
    const gateway = { pay: vi.fn(async () => ({ status: 200, data: { quote: 42 } })) };
    const policy = new PolicyTracker({ periodBudget: 10_000n, periodMs: 1000 });
    const c = new ScrupleClient({ gateway, policy, fetchImpl: fetch402(1000n) });
    const res = await c.fetch(URL_, { method: "GET" });
    expect(res).toEqual({ status: 200, data: { quote: 42 }, paid: { atomic: 1000n } });
    expect(gateway.pay).toHaveBeenCalledWith(URL_, { method: "GET" });
    expect(policy.spentInPeriod()).toBe(1000n);
  });

  it("refuses payment beyond policy without calling pay", async () => {
    const gateway = { pay: vi.fn() };
    const policy = new PolicyTracker({ periodBudget: 500n, periodMs: 1000 });
    const c = new ScrupleClient({ gateway, policy, fetchImpl: fetch402(1000n) });
    await expect(c.fetch(URL_)).rejects.toThrow(PolicyExceededError);
    expect(gateway.pay).not.toHaveBeenCalled();
    expect(policy.spentInPeriod()).toBe(0n);
  });

  it("enforces origin allowlist", async () => {
    const gateway = { pay: vi.fn() };
    const policy = new PolicyTracker({
      periodBudget: 10_000n, periodMs: 1000, allowedOrigins: ["https://other.example"],
    });
    const c = new ScrupleClient({ gateway, policy, fetchImpl: fetch402(1n) });
    await expect(c.fetch(URL_)).rejects.toMatchObject({ reason: "origin_not_allowed" });
  });

  it("pays without limits when no policy given", async () => {
    const gateway = { pay: vi.fn(async () => ({ status: 200, data: "ok" })) };
    const c = new ScrupleClient({ gateway, fetchImpl: fetch402(999_999n) });
    const res = await c.fetch(URL_);
    expect(res.paid).toEqual({ atomic: 999_999n });
  });

  it("throws MalformedChallengeError when 402 lacks a decodable challenge", async () => {
    const gateway = { pay: vi.fn() };
    const bad = vi.fn(async () => new Response("{}", { status: 402 }));
    const c = new ScrupleClient({ gateway, fetchImpl: bad });
    await expect(c.fetch(URL_)).rejects.toThrow(MalformedChallengeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @scruple/client`
Expected: FAIL — cannot resolve `../src/client`.

- [ ] **Step 3: Implement**

`packages/client/src/client.ts`:
```ts
import type { PolicyTracker } from "./policy";

export interface GatewayLike {
  pay(url: string, opts?: { method?: string; body?: unknown }): Promise<{
    status: number; data: unknown; formattedAmount?: string;
  }>;
}

export interface ScrupleResponse {
  status: number;
  data: unknown;
  paid?: { atomic: bigint };
}

export class PolicyExceededError extends Error {
  constructor(public readonly reason: string, public readonly atomic: bigint) {
    super(`Payment of ${atomic} atomic USDC refused by spending policy: ${reason}`);
    this.name = "PolicyExceededError";
  }
}

export class MalformedChallengeError extends Error {
  constructor(detail: string) {
    super(`402 response without a valid PAYMENT-REQUIRED challenge: ${detail}`);
    this.name = "MalformedChallengeError";
  }
}

export class ScrupleClient {
  private readonly gateway: GatewayLike;
  private readonly policy?: PolicyTracker;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { gateway: GatewayLike; policy?: PolicyTracker; fetchImpl?: typeof fetch }) {
    this.gateway = opts.gateway;
    this.policy = opts.policy;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async fetch(url: string, init?: { method?: string; body?: unknown }): Promise<ScrupleResponse> {
    const first = await this.fetchImpl(url, init as RequestInit | undefined);
    if (first.status !== 402) {
      return { status: first.status, data: await safeJson(first) };
    }

    const header = first.headers.get("PAYMENT-REQUIRED");
    if (!header) throw new MalformedChallengeError("missing header");
    let atomic: bigint;
    try {
      const envelope = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
      atomic = BigInt(envelope.accepts[0].amount);
    } catch {
      throw new MalformedChallengeError("undecodable envelope");
    }

    if (this.policy) {
      const decision = this.policy.check(atomic, new URL(url).origin);
      if (!decision.ok) throw new PolicyExceededError(decision.reason, atomic);
    }

    const result = await this.gateway.pay(url, init);
    this.policy?.record(atomic);
    return { status: result.status, data: result.data, paid: { atomic } };
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
```

Add to `packages/client/src/index.ts`: `export * from "./client";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @scruple/client`
Expected: 2 files, 13 tests PASS. Also run root `npm test` — all workspaces green (server 15 + client 13).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): ScrupleClient — 402 detection, policy gate, gateway pay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Examples + README

**Files:**
- Create: `examples/seller.ts`, `examples/agent.ts`, `examples/package.json`, `examples/README.md`
- Modify: `README.md` (root — add SDK section)

**Interfaces:**
- Consumes: both packages + Circle SDK real implementations. Examples are NOT unit-tested (they hit live testnet); they must typecheck (`npx tsc --noEmit -p examples`) and are runnable once funded wallets exist.

- [ ] **Step 1: Write the examples**

`examples/package.json`:
```json
{
  "name": "scruple-examples",
  "private": true,
  "type": "module",
  "dependencies": {
    "@circle-fin/x402-batching": "^2.0.4",
    "@scruple/client": "*",
    "@scruple/server": "*",
    "express": "^4.21.0"
  },
  "devDependencies": { "tsx": "^4.19.0", "typescript": "^5.9.3", "@types/express": "^4.17.21" }
}
```
(Also add `"examples"` to the root package.json `workspaces` array.)

`examples/seller.ts`:
```ts
import express from "express";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { scruple, formatAtomic } from "@scruple/server";

const sellerAddress = process.env.SELLER_ADDRESS;
if (!sellerAddress) throw new Error("SELLER_ADDRESS env var required");

const app = express();
app.use(scruple({
  rateCard: {
    "GET /api/quote": "$0.001",
    "GET /api/dataset": "$0.01",
    "POST /api/compute": "$0.0003",
  },
  sellerAddress,
  facilitator: new BatchFacilitatorClient(),
  onPayment: (e) => console.log(`[scruple] ${e.endpoint} paid ${formatAtomic(e.atomic)} by ${e.payer} (tx: ${e.transaction ?? "batching"})`),
}));

app.get("/api/quote", (_req, res) => { res.json({ pair: "USDC/EURC", mid: 0.9214 }); });
app.get("/api/dataset", (_req, res) => { res.json({ rows: 128, sample: [1, 2, 3] }); });
app.post("/api/compute", (_req, res) => { res.json({ result: 42 }); });
app.get("/health", (_req, res) => { res.json({ ok: true }); });

app.listen(3000, () => console.log("Scruple demo seller on :3000"));
```

`examples/agent.ts`:
```ts
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ScrupleClient, PolicyTracker, PolicyExceededError } from "@scruple/client";

const privateKey = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) throw new Error("BUYER_PRIVATE_KEY env var required");
const base = process.env.BASE_URL ?? "http://localhost:3000";

const gateway = new GatewayClient({ chain: "arcTestnet", privateKey });

// One-time: make sure the Gateway balance is funded (deposit is an onchain tx).
const balances = await gateway.getBalances();
if (balances.gateway.available < 500_000n) {
  console.log("Depositing 1 USDC into Gateway…");
  const { depositTxHash } = await gateway.deposit("1");
  console.log(`Deposited: ${depositTxHash}`);
}

const client = new ScrupleClient({
  gateway,
  policy: new PolicyTracker({
    periodBudget: 2_000_000n,        // $2/day
    periodMs: 86_400_000,
    perTxCap: 50_000n,               // $0.05 per call
    allowedOrigins: [new URL(base).origin],
  }),
});

for (let i = 0; i < 20; i++) {
  try {
    const res = await client.fetch(`${base}/api/quote`);
    console.log(`#${i + 1}`, res.data, res.paid ? `(paid ${res.paid.atomic} atomic)` : "(free)");
  } catch (err) {
    if (err instanceof PolicyExceededError) {
      console.log(`Stopped by spending policy: ${err.reason}`);
      break;
    }
    throw err;
  }
}
```

`examples/README.md`:
```markdown
# Scruple examples

Requires two funded Arc testnet wallets (https://faucet.circle.com/).

    # terminal 1 — merchant
    SELLER_ADDRESS=0x… npx tsx examples/seller.ts

    # terminal 2 — agent with a $2/day policy
    BUYER_PRIVATE_KEY=0x… npx tsx examples/agent.ts

The agent auto-deposits 1 USDC into Circle Gateway on first run (onchain tx),
then pays per-call via gasless EIP-3009 authorizations that Gateway batch-settles.
Note: payer must be an EOA (Gateway verifies via ecrecover; smart accounts unsupported).
```

- [ ] **Step 2: Typecheck examples**

Run from root: `npm install`, then `npx tsc --noEmit examples/seller.ts examples/agent.ts --module esnext --moduleResolution bundler --target es2022 --strict --skipLibCheck`
Expected: no errors. (If Circle SDK types clash, document the exact error in the report rather than loosening `strict`.)

- [ ] **Step 3: Update root README** — add after the Quickstart section:

```markdown
## SDKs (Phase 2)

| Package | What it does |
|---|---|
| `@scruple/server` | Express middleware: declarative rate card → HTTP 402 challenge → payment verification → settlement via Circle Gateway (batch-settled onchain). |
| `@scruple/client` | Payer/agent client: detects 402, enforces a spending policy (period budget, per-tx cap, origin allowlist — mirroring CardIssuer semantics), pays via Circle `GatewayClient`, retries. |

See `examples/` for a runnable merchant + agent pair on Arc testnet.

    npm install
    npm test        # unit suites for both SDKs (network boundaries mocked)
```

- [ ] **Step 4: Run full test suite once**

Run: `npm test`
Expected: server 15 + client 13, all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(examples): runnable seller + policy-gated agent demo; README SDK section

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope for this plan (later phases)

- **Phase 3:** Indexer (chunked `getLogs`), webhook delivery service (`PaymentEvent` → HTTP webhooks with HMAC + idempotency), `subscription.at_risk` monitor, keeper bot for `SubscriptionManager.charge()`.
- **Phase 4:** Dashboard (Next.js, card visuals), passkey human-payer mode, demo video + deck, testnet deploy of contracts + live end-to-end run.
