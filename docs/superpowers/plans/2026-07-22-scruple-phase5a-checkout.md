# Scruple Phase 5a (Checkout Embed + Acme Example) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@scruple/checkout` — an embeddable `<ScrupleCheckout planId={…}/>` React component that takes a stranger's wallet from "connected" to "subscribed" in one panel (existing-card selection OR inline card mint → USDC approve → subscribe) — plus `apps/acme`, a deliberately foreign-branded example SaaS pricing page proving the embed drops into any design.

**Architecture:** The embed is **chain-only** — no dependency on the merchant's service: plan data via `getPlan/getPlanVersion` reads, buyer's cards discovered by scanning `nextCardId` + `getCard` multicall filtered by owner (bounded on testnet; documented tradeoff). Pure logic (eligibility, approve math, flow reducer) lives in testable modules; the component is a thin renderer over a `useCheckoutFlow` hook. Styles are self-contained and class-prefixed (`sck-`) so they can't collide with or leak into the host page. Writes are chainId-pinned. Wallet connect uses the plain injected connector for now (EIP-6963 picker arrives in 5d as a shared component).

**Tech Stack:** packages/checkout (React 19 peer, wagmi ^3 peer, viem peer, @tanstack/react-query peer; vitest + testing-library + jsdom dev). apps/acme: Next ^16 consuming the workspace package.

## Global Constraints

- Deployed defaults (overridable via props): SubscriptionManager `0x3d0b19b6B06E568A23AA916270008012Dca55795`, CardIssuer `0xE20EB808cF87B73D716C96CBbb1eee62282506d0`, USDC `0x3600000000000000000000000000000000000000`, chain 5042002.
- All money math atomic-bigint; display via a local `formatUsd` identical in behavior to `@scruple/server`'s `formatAtomic`.
- Approve amount = plan amount × 12n, surfaced in the UI copy verbatim: "Allows the next 12 renewals — revoke anytime." Skip the approve step when existing allowance ≥ that amount.
- Inline mint defaults (per spec): periodAmount = plan amount, periodDuration = plan period, expiry 0, allowlist = [merchant], signer = buyer.
- Card eligibility: state Active AND (no allowlist OR merchant allowed) AND periodAmount ≥ plan amount. (Allowlist membership is not readable per-merchant on-chain in one call — `getCard` exposes `useAllowlist` only; the `allowlist(cardId, merchant)` public mapping IS readable: use it.)
- Every write pinned `chainId: 5042002`; no secrets anywhere; component never fetches non-chain URLs.
- Styles: every class prefixed `sck-`; a single `<style>` injected once; no global resets; component works on light AND dark host pages (self-contained panel surface).
- Commit trailer convention continues.

## File Structure

```
packages/checkout/
  package.json  tsconfig.json  vitest.config.ts
  src/index.ts            # export ScrupleCheckout + types
  src/config.ts           # addresses, chain, ABIs (plan/card/usdc fragments)
  src/logic.ts            # formatUsd, approveAmountFor, isCardEligible, checkoutReducer
  src/use-checkout.ts     # useCheckoutFlow hook (reads, writes, state machine)
  src/component.tsx       # <ScrupleCheckout/> UI + scoped styles
  test/logic.test.ts
  test/component.test.tsx
apps/acme/
  package.json  next.config.ts  tsconfig.json  next-env.d.ts
  app/layout.tsx  app/globals.css  app/page.tsx  app/providers.tsx
```

Root workspaces: add `"packages/checkout"`? — root already globs `packages/*`; add `"apps/acme"` alongside `"apps/dashboard"`.

---

### Task 1: Package scaffold + pure logic (TDD)

**Files:**
- Create: `packages/checkout/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/config.ts`, `src/logic.ts`, `test/logic.test.ts`
- Modify: root `package.json` workspaces (add `"apps/acme"` now to save a later step; harmless before the app exists — REMOVE if npm complains, and add it in Task 4 instead).

**Interfaces:**
- `config.ts` exports: `ARC_CHAIN_ID = 5042002`, `DEFAULT_ADDRESSES = { subscriptionManager, cardIssuer, usdc }` (values above), `SUBSCRIPTION_MANAGER_ABI` (getPlan, getPlanVersion, subscribe — same tuple shapes as apps/dashboard/lib/abi.ts), `CARD_ISSUER_ABI` (nextCardId, getCard, allowlist(uint256,address)→bool, mintCard), `USDC_ABI` (allowance, approve — viem `erc20Abi` re-export is fine).
- `logic.ts` exports:
  - `formatUsd(atomic: bigint): string` — port from dashboard lib/format.ts (same trim rules).
  - `approveAmountFor(planAmount: bigint): bigint` — `planAmount * 12n`.
  - `interface CandidateCard { cardId: bigint; state: number; periodAmount: bigint; useAllowlist: boolean; merchantAllowed: boolean }`
  - `isCardEligible(c: CandidateCard, planAmount: bigint): boolean` — Active(0) && periodAmount ≥ planAmount && (!useAllowlist || merchantAllowed).
  - `type Step = "connect" | "loading" | "pick" | "minting" | "approving" | "subscribing" | "done" | "error"`
  - `interface CheckoutState { step: Step; error?: string; selectedCardId?: bigint; subId?: bigint }`
  - `checkoutReducer(state, action)` with actions: `{type:"connected"}`, `{type:"planLoaded"}`, `{type:"select", cardId}`, `{type:"mintStart"}`, `{type:"mintDone", cardId}`, `{type:"approveStart"}`, `{type:"approveDone"}`, `{type:"subscribeStart"}`, `{type:"subscribeDone", subId}`, `{type:"fail", message}`, `{type:"reset"}`. Transition table: connect→(connected)→loading→(planLoaded)→pick; pick→(select)→pick(with selection); pick→(mintStart)→minting→(mintDone)→approving-eligible… encode exactly: select stores selection; from pick with a selection, approveStart→approving; approveDone→subscribing after subscribeStart; any fail→error(message); reset→pick (keeps plan loaded). Invalid transitions return state unchanged.

- [ ] **Step 1: Write the failing tests** — `test/logic.test.ts`: formatUsd cases (`1000n→"$0.001"`, `29_000_000n→"$29"` wait — server formatAtomic gives "$29" for 29_000_000n; assert exactly that), approveAmountFor (×12), isCardEligible truth table (active/inactive, budget ≥/<, allowlist open/allowed/blocked = 6 cases), reducer walkthrough: happy path with existing card (connected→planLoaded→select→approveStart→approveDone→subscribeStart→subscribeDone) asserting step+subId; mint path (mintStart→mintDone stores cardId as selected→approving); fail from any step→error with message; invalid transition no-op (e.g. approveDone while in pick).
- [ ] **Step 2: FAIL run** — `npm test -w @scruple/checkout` (after scaffold files exist; unresolved src imports).
- [ ] **Step 3: Implement** scaffold + logic.

`packages/checkout/package.json`:
```json
{
  "name": "@scruple/checkout",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "peerDependencies": {
    "@tanstack/react-query": ">=5",
    "react": ">=19",
    "viem": ">=2",
    "wagmi": ">=3"
  },
  "devDependencies": {
    "@tanstack/react-query": "^5.60.0",
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.0",
    "jsdom": "^25.0.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "typescript": "^5.9.3",
    "viem": "^2.47.1",
    "vitest": "^3.0.0",
    "wagmi": "^3.0.0"
  }
}
```
`tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "jsx": "react-jsx", "lib": ["dom","dom.iterable","es2022"] }, "include": ["src","test"] }`
`vitest.config.ts`: jsdom env + `esbuild: { jsx: "automatic" }` (same as dashboard).
Implement `config.ts`/`logic.ts` per Interfaces (copy ABI tuples from `apps/dashboard/lib/abi.ts`; add `nextCardId()` and `allowlist(uint256,address)(bool)` fragments).
- [ ] **Step 4: PASS run** — expect ~16-20 assertions green.
- [ ] **Step 5: Commit** — `feat(checkout): package scaffold + pure checkout logic` + trailer.

---

### Task 2: useCheckoutFlow hook

**Files:**
- Create: `packages/checkout/src/use-checkout.ts`
- Test: extend `test/logic.test.ts` only if pure helpers extracted; the hook itself is gated by typecheck + Task 3 render tests + live run (wagmi wiring, consistent with dashboard precedent).

**Interfaces:**
- `useCheckoutFlow(opts: { planId: bigint; addresses?: Partial<typeof DEFAULT_ADDRESSES> }): {
    state: CheckoutState;
    plan?: { amount: bigint; periodS: number; trialS: number; merchant: string };
    cards: Array<{ cardId: bigint; label: string; eligible: boolean }>;
    connect(): void; isConnected: boolean; address?: string;
    select(cardId: bigint): void;
    mintAndUse(): Promise<void>;      // inline mint with spec defaults → select
    payAndSubscribe(): Promise<void>; // allowance check → approve (skip if sufficient) → subscribe → done
  }`
- Implementation notes (write exactly):
  - Reads via `useReadContract`/`useReadContracts` pinned `chainId: ARC_CHAIN_ID`, `query: { retry: 2 }`: plan = getPlan + getPlanVersion(latest); card scan = nextCardId → getCard×N + allowlist(cardId, merchant)×N multicall (N capped at 64 most-recent ids; testnet-bounded, comment the tradeoff).
  - `mintAndUse`: `writeContractAsync` mintCard(signer=address, usdc, plan.amount, periodS, 0, [merchant]) pinned; then dispatch mintDone with cardId = previous nextCardId (read fresh right before mint via `readContract` on the public client to avoid races — viem `usePublicClient()`).
  - `payAndSubscribe`: read `allowance(address, subscriptionManager)`; if < approveAmountFor(plan.amount) → approve write (pinned) and await; then subscribe write; parse subId from fresh `nextSubId`-1? SubscriptionManager has no nextSubId getter? IT DOES: `nextSubId` public → include in ABI; read after subscribe receipt... simpler: read `nextSubId` BEFORE subscribe, that value IS the new subId. Use `useWaitForTransactionReceipt`? Keep simple: `publicClient.waitForTransactionReceipt({hash})` after each write, then dispatch.
  - Every failure path → dispatch `fail` with a short human message (wallet reject → "Request cancelled in wallet."; revert → shortMessage).
- [ ] **Step 1: Implement** per notes. **Step 2:** typecheck via a temporary `npx tsc --noEmit -p packages/checkout` (add `"types": ["node"]` needs? follow dashboard). **Step 3: Commit** — `feat(checkout): useCheckoutFlow — chain reads, inline mint, approve+subscribe` + trailer.

---

### Task 3: `<ScrupleCheckout/>` component (TDD-light)

**Files:**
- Create: `packages/checkout/src/component.tsx`, `test/component.test.tsx`
- Modify: `src/index.ts` re-exports.

**Interfaces:**
- `ScrupleCheckout({ planId, addresses?, onSuccess?, onError? })` renders a self-contained panel:
  - Header: plan summary — "`{formatUsd(amount)}` / `{days}` days" + trial line when >0.
  - Body by step: connect button → card list (radio rows: "Card #id — eligible" / disabled ineligible with reason) + "or mint a new card for this plan" button → approve/subscribe progress states (spinner text: "Confirm in wallet…", "Waiting for Arc…") → success (subId, checkmark) → error (message + retry).
  - Footer: "Powered by ⚖ Scruple · non-custodial — funds move wallet-to-wallet" + the approve disclosure line when approving.
  - Styles: one injected `<style data-sck>` (guard against double-inject), all classes `sck-*`, panel = dark ink surface with brass accent (self-contained identity independent of host), max-width 380px, border-radius 14px.
- Render tests (mock the hook module with `vi.mock`): pick-step renders plan summary + eligible/ineligible rows + mint button; done-step renders subId + fires onSuccess once; error-step renders message + retry calls reset. (3-4 tests — component is a renderer; flow logic already covered.)
- [ ] Steps: failing tests → implement → pass (`npm test -w @scruple/checkout`) → commit `feat(checkout): ScrupleCheckout panel UI` + trailer.

---

### Task 4: Acme Analytics example app

**Files:**
- Create: `apps/acme/package.json` (name `acme-demo`, deps: next/react/react-dom + workspace `@scruple/checkout` `"*"` + wagmi/viem/@tanstack/react-query), `next.config.ts`, `tsconfig.json`, `next-env.d.ts`, `app/layout.tsx`, `app/globals.css`, `app/providers.tsx` (wagmi injected + query client, ssr-safe — copy pattern from dashboard providers), `app/page.tsx`.
- Modify: root workspaces if not done in Task 1.

**Design requirement (from spec): deliberately foreign branding** — Acme is a cheerful light-mode SaaS: white ground, indigo accent (#4F46E5), rounded sans (system-ui), playful copy. NO Scruple ink/brass anywhere except inside the embedded panel itself — that contrast IS the proof.
- `page.tsx`: hero ("Acme Analytics — dashboards your team actually reads"), 3-tier pricing grid (Starter free / **Pro — wired to a real planId via `NEXT_PUBLIC_ACME_PLAN_ID` env, default "0"** / Enterprise "contact us"), Pro card's button opens a modal containing `<ScrupleCheckout planId={BigInt(process.env.NEXT_PUBLIC_ACME_PLAN_ID ?? "0")} onSuccess={…toast/confetti-free success banner}/>`.
- [ ] Steps: implement → `npm install` → `npm run build -w acme-demo` green → root `npm test` unaffected → commit `feat(acme): example SaaS pricing page embedding ScrupleCheckout` + trailer.

---

### Task 5: Live verification + docs

- [ ] **Step 1: Live run (manual, controller-driven):** boot acme (`npm run dev -w acme-demo` on :3002) + service; with the demo buyer wallet: full checkout — existing-eligible-card path AND fresh-mint path (two subs on a throwaway $0.50 plan created for this). Record subIds/tx hashes in the report.
- [ ] **Step 2:** README section "Checkout embed (Phase 5a)" — usage snippet + Acme run instructions; note chain-only design + 64-id scan tradeoff.
- [ ] **Step 3:** Commit `docs: checkout embed usage + acme example` + trailer.

## Out of scope
5b admin API/inspector · 5c quickstart/nudge · 5d 6963 picker (checkout upgrades to it then), seller forwarder, public deploy.
