# Scruple Phase 5d (Demo-day Hardening + Deploy Prep) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demo-day insurance: an EIP-6963 multi-wallet picker (kills the Phantom-hijack failure mode) shared by dashboard + checkout, the metered rail feeding the dashboard automatically (seller → ingest forwarder), the RPC forwarder de-duplicated into one shared package, and everything ready for the public deploy (executed with Berkay — hosts/accounts are his call).

**Architecture:** wagmi v2 already discovers EIP-6963 announced providers (`multiInjectedProviderDiscovery` defaults on), so `useConnectors()` returns one connector per announced wallet plus the configured `injected()` fallback — the picker is pure choice-UI + dedupe, no new discovery code. It lives in `@scruple/checkout` (self-contained `sck-` styles) and the dashboard imports it. The RPC forwarder becomes workspace package `@scruple/rpc-forwarder` consumed by both Next apps' `/api/rpc` routes and `examples/rpc-shim.ts`.

**Tech Stack:** existing only (wagmi v2 connectors API, workspaces, vitest).

## Global Constraints

- Wallet dedupe rule: when ≥1 EIP-6963-discovered connector exists (has `rdns` or `id !== "injected"`), hide the generic `injected` fallback from the list; when the only choice is the generic injected, connect directly with no picker UI. Single discovered wallet → also connect directly (picker only for ≥2 real choices).
- Picker must show `connector.icon` when present (data URI per EIP-6963) and `connector.name`; connect calls include `chainId: ARC_CHAIN_ID` (5042002).
- No behavior change for already-connected sessions; disconnect/switch-account flows untouched.
- `@scruple/rpc-forwarder` extraction is a MOVE, not a rewrite: byte-identical logic (serial queue, minGap 75ms, -32011 array-aware retry/backoff); both apps and the shim import it; the two lib copies are deleted. Existing forwarder tests move with it.
- seller.ts forwarder wiring: only active when BOTH `SERVICE_INGEST_URL` and `SERVICE_INGEST_SECRET` are set; console logging stays regardless (compose, don't replace).
- UI copy English; commit trailer convention continues.

## File Structure

```
packages/checkout/src/wallet-picker.tsx   # new: <WalletPicker/> + pickWalletChoices() pure helper
packages/checkout/src/use-checkout.ts     # modify: connect step uses picker choices
packages/checkout/src/component.tsx       # modify: render picker on connect step
packages/checkout/src/index.ts            # modify: export WalletPicker, pickWalletChoices
packages/checkout/test/wallet-picker.test.ts  # new
apps/dashboard/components/chrome.tsx      # modify: ConnectButton uses picker
packages/rpc-forwarder/{package.json,src/index.ts,test/}  # new package (moved code+tests)
apps/dashboard/lib/rpc-forwarder.ts       # delete (import package)
apps/acme/lib/rpc-forwarder.ts            # delete (import package)
apps/dashboard/app/api/rpc/route.ts       # modify import
apps/acme/app/api/rpc/route.ts            # modify import
examples/rpc-shim.ts                      # modify import
examples/seller.ts                        # modify: optional createServiceForwarder
docs/demo/runbook.md                      # modify: picker note, seller env rows
```

---

### Task 1: EIP-6963 picker in @scruple/checkout (TDD for the pure part)

**Interfaces (Produces):**
- `pickWalletChoices(connectors: readonly {id: string; name: string; icon?: string; type?: string}[]): {mode: "none"} | {mode: "direct"; connector: T} | {mode: "pick"; connectors: T[]}` — implements the Global Constraints dedupe rule. Generic injected detector: `id === "injected"`.
- `<WalletPicker onPick(connector) choices/>` — sck-styled vertical list, icon (img, 20px, data-URI ok) + name per row.
- use-checkout: `connect()` becomes `connectWith(connector)` + state exposes `walletChoices` (from pickWalletChoices(useConnectors())); component's connect step: mode direct → single "Connect wallet" button (current behavior); mode pick → picker list; mode none → button falling back to `injected()` (SSR/no-wallet case keeps working).
- [ ] Steps: failing tests for pickWalletChoices (no connectors → none; only generic injected → direct(generic); one discovered + generic → direct(discovered); two discovered + generic → pick(both, generic excluded)) → FAIL → implement → PASS (`npm test -w @scruple/checkout`, 33+~4) → `npm run build -w scruple-dashboard` + acme build sanity → commit `feat(checkout): EIP-6963 wallet picker` + trailer.

---

### Task 2: Dashboard ConnectButton adopts the picker

- chrome.tsx ConnectButton: on click, run pickWalletChoices(useConnectors()); direct → connect immediately (today's behavior); pick → open a small popover (existing Drawer or a minimal absolute-positioned panel with existing classes) listing wallets via `<WalletPicker/>` from `@scruple/checkout` (already a workspace dep? if not, add it to dashboard package.json).
- [ ] Gates: dashboard tests 101 green (+ pure tests only if helper extracted), build clean. Commit `feat(dashboard): multi-wallet picker on connect` + trailer.

---

### Task 3: Extract @scruple/rpc-forwarder

- New workspace package (private, no deps beyond TS); move dashboard's rpc-forwarder.ts (the canonical copy) + its tests; delete both app-lib copies; update the two `/api/rpc` routes + `examples/rpc-shim.ts` imports; add the package to both apps' deps + root workspaces.
- [ ] Gates: `npm test` root (all suites; forwarder tests now under the new package), both Next builds clean, `npx tsc --noEmit` for the new package. Commit `refactor: extract shared @scruple/rpc-forwarder package` + trailer.

---

### Task 4: Seller → ingest forwarder wiring + runbook

- examples/seller.ts: when `SERVICE_INGEST_URL` + `SERVICE_INGEST_SECRET` set, `const forward = createServiceForwarder({url, secret})` and onPayment becomes `(e) => { console.log(...); void forward(e); }`. runbook: env rows + one line in the metered section ("set these two envs and live x402 payments appear on the dashboard's metered rate card via settlement.batched").
- [ ] Gates: `npx tsc --noEmit -p packages/server` (seller compiles via examples tsconfig if present — verify how examples are typechecked; at minimum `npx tsx --check examples/seller.ts` equivalent or a dry parse). Commit `feat(examples): seller forwards metered payments to the service` + trailer.

---

### Task 5: Live verification (controller-driven) + deploy prep notes

- [ ] Picker: dashboard + checkout with ≥2 wallet extensions can't be automated headless — verify pickWalletChoices behavior via tests + a manual note for Berkay's next session (his machine has MetaMask + Phantom: the original failure case). Controller verifies builds + a headless smoke (connectors list in jsdom = generic injected only → direct mode, today's behavior preserved).
- [ ] Seller forwarding: boot service + seller with the two envs + run examples/agent.ts for a couple of paid calls (needs Gateway deposits — reuse demo buyer; skip if Gateway balance/validity makes it flaky and note honestly) → dashboard metered table shows rows.
- [ ] Write `docs/demo/deploy.md`: exact steps for the public deploy (Vercel: dashboard + acme, env lists; Fly.io or Railway for the service: volume for SQLite, env list incl. ADMIN_SECRET/INGEST_SECRET/KEEPER_PRIVATE_KEY, START_BLOCK guidance; DNS-free URLs fine). Execution happens WITH Berkay (accounts/billing are his).

## Out of scope
Actual deploy execution (user-driven); mainnet; plan archiving.
