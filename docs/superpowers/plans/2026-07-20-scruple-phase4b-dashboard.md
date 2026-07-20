# Scruple Phase 4b (Dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `apps/dashboard` — a Next.js app implementing the user-approved design mock (`docs/design/dashboard-mock.html`) with live data: Merchant view (Overview/Plans/Subscriptions/Payments/Webhooks) fed by the service `GET /events` API, Cards view (gallery/activity) fed by chain reads, and wagmi writes (mint/freeze/unfreeze/cancel card, create plan, subscribe).

**Architecture:** The mock is the DESIGN SOURCE OF TRUTH — its CSS custom-property tokens, class names, markup structure, and copy are ported, not reinvented. App Router; server API routes proxy the service events API (bearer secret stays server-side); chain access via viem/wagmi against Arc testnet (chain 5042002) with the deployed contracts. Pure logic (event aggregation, card math, formatting) lives in `lib/` with vitest coverage; screens are thin compositions.

**Tech Stack:** Next.js ^16.1, React ^19.2, wagmi ^3, viem ^2.47 (workspace-resolved), @tanstack/react-query ^5, vitest + @testing-library/react + jsdom for lib/component tests. No Tailwind — the mock's handcrafted CSS ports as `globals.css` + CSS modules are NOT used (single global stylesheet, class names from the mock).

## Global Constraints

- **Design fidelity:** tokens, class names, spacing, copy, and interaction patterns come from `docs/design/dashboard-mock.html` (user-approved). Deviations only where static mock → live data requires it. Both themes (light/dark via `prefers-color-scheme` + `data-theme` override) must keep working.
- Deployed contracts (Arc testnet 5042002): CardIssuer `0xE20EB808cF87B73D716C96CBbb1eee62282506d0`, SubscriptionManager `0x3d0b19b6B06E568A23AA916270008012Dca55795`, USDC `0x3600000000000000000000000000000000000000`. Read via viem public client; write via wagmi `useWriteContract`.
- Events come ONLY through the Next server proxy `/api/events` (env: `SERVICE_URL`, `SERVICE_EVENTS_SECRET`) — the bearer secret must never reach the browser. Client polls the proxy every 5s.
- USDC amounts: atomic 6-decimal strings in event payloads → format with the shared `formatUsd` helper; bigint end-to-end elsewhere; `font-variant-numeric: tabular-nums` on numeric columns (mock classes already carry this).
- Empty states over crashes: no service/env → panels render with `empty-note` copy; no wallet → Cards view shows a connect prompt. Never throw to a blank screen.
- Tests: pure logic and presentational components get vitest coverage; screens/wagmi wiring verified by typecheck + `next build` (no e2e in this phase).
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

```
apps/dashboard/
  package.json  next.config.ts  tsconfig.json  vitest.config.ts  next-env.d.ts
  app/layout.tsx                # html shell, theme bootstrap, Providers
  app/globals.css               # ported 1:1 from the mock's <style>
  app/page.tsx                  # single-page app: view state + screen switching (mirrors mock JS)
  app/api/events/route.ts       # bearer proxy to service GET /events
  components/providers.tsx      # wagmi + react-query providers
  components/chrome.tsx         # Sidebar + Topbar (view switch, net pill, theme btn, ConnectButton)
  components/ui.tsx             # Badge, Panel, Toast, Drawer (ported markup)
  components/scruple-card.tsx   # the card visual (props-driven)
  components/rev-chart.tsx      # canvas revenue chart (ported drawChart)
  components/screens/merchant.tsx  # Overview, Plans, Subs, Payments, Webhooks screens
  components/screens/cards.tsx     # Gallery + Activity screens
  lib/abi.ts                    # CardIssuer + SubscriptionManager fragments
  lib/chain.ts                  # arcTestnet chain object, addresses, public client
  lib/format.ts                 # formatUsd, shortAddr, shortHash, timeAgo, cosmeticCardNumber
  lib/events.ts                 # EventRow type, fetchEvents (client), aggregations (revenueByDay, feedRows, needsAttention)
  lib/cards.ts                  # deriveMyCards(events, owner), cardProgress (pct + tone)
  test/format.test.ts  test/events.test.ts  test/cards.test.ts  test/scruple-card.test.tsx
```

Root `package.json` workspaces gains `"apps/dashboard"` (examples pattern already exists — keep `"examples"` entry).

---

### Task 1: App scaffold + design port (tokens, chrome, screen shell)

**Files:**
- Create: `apps/dashboard/package.json`, `next.config.ts`, `tsconfig.json`, `next-env.d.ts`, `vitest.config.ts`, `app/layout.tsx`, `app/globals.css`, `app/page.tsx` (static first pass), `components/chrome.tsx`, `components/ui.tsx`
- Modify: root `package.json` (add `"apps/dashboard"` to workspaces)

**Interfaces:**
- Produces: running `npm run dev -w scruple-dashboard` renders the shell with sidebar/topbar/one static screen, pixel-matching the mock; `Badge`, `Panel`, `Toast` (context-based `useToast`), `Drawer` components with the mock's exact class names; `globals.css` = the mock's `<style>` content verbatim (plus `body{}` resets Next needs).
- Key component APIs (later tasks rely on these exact signatures):
  - `Badge({ tone: "ok"|"warn"|"bad"|"info"|"mut", children })` → `<span class="badge {tone}"><span class="b"></span>{children}</span>`
  - `Panel({ className?, children })` → `<div class="panel {className}">`
  - `Drawer({ open, onClose, children })` — fixed wrap + scrim + aside, Escape closes
  - `useToast()` → `(msg: string) => void`
  - `Chrome({ view, onViewChange, screen, onScreenChange, children })` — sidebar nav items per view (merchant: overview/plans/subs/payments/webhooks; cards: gallery/activity), topbar with seg control, `Arc Testnet` pill, address short (from wagmi account when connected, else `—`), theme button toggling `data-theme` on `<html>`.

- [ ] **Step 1: Scaffold files**

`apps/dashboard/package.json`:
```json
{
  "name": "scruple-dashboard",
  "version": "0.1.0",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "start": "next start", "test": "vitest run" },
  "dependencies": {
    "@tanstack/react-query": "^5.60.0",
    "next": "^16.1.6",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "viem": "^2.47.1",
    "wagmi": "^3.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@types/node": "^25.4.0",
    "@types/react": "^19.0.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.9.3",
    "vitest": "^3.0.0"
  }
}
```
(If a listed version is unavailable, use the nearest available and record it in the report.)

`next.config.ts`:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default nextConfig;
```

`tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve", "lib": ["dom", "dom.iterable", "es2022"], "allowJs": true,
    "incremental": true, "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "jsdom" },
  esbuild: { jsx: "automatic" },
});
```

- [ ] **Step 2: Port the design**

`app/globals.css`: copy the ENTIRE `<style>` block content from `docs/design/dashboard-mock.html` verbatim, then append:
```css
html,body{height:auto}
```
`app/layout.tsx`:
```tsx
import "./globals.css";
import { Providers } from "@/components/providers"; // Task 4 adds real providers; create a passthrough now

export const metadata = { title: "Scruple Dashboard", description: "USDC billing on Arc" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
```
`components/providers.tsx` (passthrough for now):
```tsx
"use client";
export function Providers({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
```

`components/ui.tsx` — implement `Badge`, `Panel`, `ToastProvider`/`useToast`, `Drawer` as client components with the mock's exact markup/classes (toast div fixed at bottom, `.show` class timing 2200ms; drawer wrap `.open` toggling, scrim click + Escape close).

`components/chrome.tsx` — port sidebar (wordmark serif ⚖ Scruple, nav labels/items with `aria-current`, footer tagline) and topbar (seg control aria-pressed, testnet pill, addr span, theme button). Theme button toggles `data-theme` on `document.documentElement` exactly like the mock. Accepts the props from Interfaces above; renders `children` into `.content`.

`app/page.tsx` — client component holding `view` (`"merchant"|"cards"`) and `screen` state; renders `Chrome` and a placeholder `<section class="screen active">` with the mock's Overview static content minus feed/chart (they arrive with data tasks). Include the static "Needs attention" block markup for now.

- [ ] **Step 3: Install & run**

Root: add `"apps/dashboard"` to workspaces array; `npm install`. Then `npm run build -w scruple-dashboard`.
Expected: build succeeds. Also `npm run dev -w scruple-dashboard` starts (verify manually it renders; stop it).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(dashboard): Next.js scaffold with ported design system and chrome

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Pure logic — format, events aggregation, cards math (TDD)

**Files:**
- Create: `apps/dashboard/lib/format.ts`, `lib/events.ts`, `lib/cards.ts`, `test/format.test.ts`, `test/events.test.ts`, `test/cards.test.ts`

**Interfaces:**
- Produces:
  - `formatUsd(atomic: bigint | string): string` — `1000n|"1000"` → `"$0.001"`; `29_990_000n` → `"$29.99"`; `0n` → `"$0"` (same trailing-zero trim as `@scruple/server` formatAtomic).
  - `shortAddr(a: string): string` — `0x2526a4Eb…` → `"0x2526…d931"`; `shortHash(h)` → `"0xca8f…a7ad"`; `timeAgo(atMs: number, nowMs: number): string` → `"2m ago"|"3h ago"|"Jul 20"`.
  - `cosmeticCardNumber(cardId: string): string` — `"4"` → `"5crp 0000 0000 0004"` (pad to 4 groups).
  - `interface EventRow { id: string; type: string; blockNumber: string | null; payload: Record<string, string>; at: number }`
  - `feedTone(type: string): "ok"|"warn"|"bad"|"info"|"mut"` — succeeded/created→ok (card.created→mut), at_risk→warn, attempt_failed/overdue→bad, settlement.batched→info, else mut.
  - `feedDesc(e: EventRow): string` — human copy per type (e.g. payment.succeeded → `"Sub #7 · $29.00 charged, $0.29 fee"`; settlement.batched → `"GET /api/quote · $0.001 by 0x84a1…c2f0"`).
  - `revenueByDay(events: EventRow[], days: number, nowMs: number): number[]` — daily USD totals (floats for chart only) from `payment.succeeded` (`payload.amount`) + `settlement.batched` (`payload.atomic`), oldest→newest, missing days = 0.
  - `needsAttention(events: EventRow[]): Array<{ tone: "warn"|"bad"; kind: string; title: string; why: string }>` — latest `subscription.at_risk` (warn, why from `payload.reason`: insufficient_balance→"Balance below renewal amount", card_policy_blocks→"Card policy will decline next charge") and `payment.overdue` (bad) per subId, at-most-one row per sub, newest first.
  - `deriveMyCards(events: EventRow[], owner: string): string[]` — cardIds from `card.created` where `payload.owner` equals owner (case-insensitive), ascending numeric order, deduped.
  - `cardProgress(spent: bigint, limit: bigint): { pct: number; tone: "ok"|"warn"|"bad" }` — pct 0..100 clamped; tone warn ≥70, bad ≥100; limit 0 → pct 0 tone ok.

- [ ] **Step 1: Write the failing tests** — three test files covering every bullet above with concrete cases (write assertions for each example literally as given; for `revenueByDay` use two payment events on different days + one batched event and assert the 3-day vector; for `needsAttention` assert dedupe-per-sub and ordering).

- [ ] **Step 2: Run to verify FAIL** — `npm test -w scruple-dashboard` (unresolvable imports).

- [ ] **Step 3: Implement** the three lib files (no React imports — pure TS).

- [ ] **Step 4: Run to verify PASS** — expect ~18-24 assertions green.

- [ ] **Step 5: Commit** — `feat(dashboard): pure logic — formatting, event aggregation, card math` + trailer.

---

### Task 3: Card component + events proxy + hooks

**Files:**
- Create: `apps/dashboard/components/scruple-card.tsx`, `components/rev-chart.tsx`, `app/api/events/route.ts`, `lib/use-events.ts`, `test/scruple-card.test.tsx`

**Interfaces:**
- Produces:
  - `ScrupleCard({ label, cardId, limitText, spent, limit, expiry, status, allowlistCount, onClick })` — `status: "active"|"frozen"|"cancelled"`; renders the mock's `.scard` markup exactly: brand row + Badge (Active ok / Frozen mut / Cancelled bad), cosmetic number, label, meta (limit/spent/exp), progress `.bar` via `cardProgress`, netline `Arc · USDC` + `🔒 N merchants`/`open`, `.frozen` class + FROZEN stamp when frozen.
  - `RevChart({ daily }: { daily: number[] })` — the mock's canvas drawing ported to a component (redraw on resize + theme change via MutationObserver on `data-theme`; label shows today's total via `formatUsd`-style text).
  - `GET /api/events` route: reads `SERVICE_URL` + `SERVICE_EVENTS_SECRET` env; missing → `503 { error: "service not configured" }`; else proxy `${SERVICE_URL}/events?limit=200` with bearer, pass through JSON. `export const dynamic = "force-dynamic"`.
  - `useEvents(): { events: EventRow[]; error: string | null }` — client hook polling `/api/events` every 5s (setInterval + fetch, cleanup on unmount).
- Consumes: Task 2 lib.

- [ ] **Step 1: Test-first for ScrupleCard** — `test/scruple-card.test.tsx` with @testing-library/react: renders label + cosmetic number; frozen adds `.frozen` + stamp text "FROZEN"; progress bar width style matches pct; allowlistCount 0 renders "open". Run FAIL.

- [ ] **Step 2: Implement** all four files. Run tests PASS (`npm test -w scruple-dashboard`).

- [ ] **Step 3: Build check** — `npm run build -w scruple-dashboard` green.

- [ ] **Step 4: Commit** — `feat(dashboard): ScrupleCard, revenue chart, events proxy + polling hook` + trailer.

---

### Task 4: Chain layer — wagmi providers, reads, writes

**Files:**
- Create: `apps/dashboard/lib/chain.ts`, `lib/abi.ts`, `lib/use-cards.ts`, `lib/use-merchant.ts`
- Modify: `components/providers.tsx` (real wagmi+query providers), `components/chrome.tsx` (ConnectButton: injected connector connect/disconnect, shortAddr display)

**Interfaces:**
- Produces:
  - `lib/chain.ts`: `arcTestnet` chain via viem `defineChain` (id 5042002, name "Arc Testnet", currency USDC 18 dec native, rpc `process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.arc.network"`), `ADDRESSES` const (three contracts above), `wagmiConfig` (injected connector).
  - `lib/abi.ts`: `CARD_ISSUER_ABI` — `getCard(uint256) returns ((address owner,address signer,address token,uint256 periodAmount,uint48 periodDuration,uint48 expiry,uint8 state,uint48 periodStart,uint256 spentInPeriod,bool useAllowlist))`, `mintCard(address,address,uint256,uint48,uint48,address[])`, `freeze(uint256)`, `unfreeze(uint256)`, `cancel(uint256)`; `SUBSCRIPTION_MANAGER_ABI` — `createPlan(address,uint256,uint48,uint48)`, `subscribe(uint256,uint256)`, `getSubscription`, `getPlan`, `getPlanVersion` (same tuple shapes as `packages/service/bin/service.ts`).
  - `useMyCards(events)` — wagmi `useAccount` + `deriveMyCards` + `useReadContracts` batching `getCard` per id → `Array<{ cardId, label: "Card #"+id, status, spent, limit, periodDuration, expiry, allowlisted: boolean }>` (status mapping 0/1/2 → active/frozen/cancelled).
  - `useCardActions()` — `{ mint(opts), freeze(id), unfreeze(id), cancel(id), pending }` via `useWriteContract` (mint opts: periodAmount bigint, periodDurationS number, expiryS number|0, allowlist: address[], signer defaults to connected address, token USDC).
  - `useMerchant(events)` — plans from `plan.created` events where `payload.merchant` = connected address + `getPlan/getPlanVersion` reads; subscriptions from `subscription.created` events joined to those plans with live `getSubscription` reads (status text incl. at-risk/overdue overlay from events); `createPlan(amountAtomic, periodS, trialS)` write.
- Consumes: Tasks 2-3.

- [ ] **Step 1: Implement** (no unit tests — hook wiring; correctness gate is typecheck + build + the screens task).
- [ ] **Step 2: Build check** — `npm run build -w scruple-dashboard` green; `npx tsc --noEmit -p apps/dashboard` clean.
- [ ] **Step 3: Commit** — `feat(dashboard): wagmi chain layer — card and merchant reads/writes` + trailer.

---

### Task 5: Screens — live compositions + mint/create forms

**Files:**
- Create: `apps/dashboard/components/screens/merchant.tsx`, `components/screens/cards.tsx`
- Modify: `app/page.tsx` (replace static placeholder with real screens)

**Interfaces:**
- Consumes: everything above. Mock sections map 1:1:
  - **Overview**: stats (revenue this month = sum via `revenueByDay(events, 30)`; active subs count; metered calls today = count of settlement.batched today) + `RevChart(revenueByDay(events, 30))` + `needsAttention` rows + feed (`feedTone`/`feedDesc`/`timeAgo`, top 8).
  - **Plans**: table of `useMerchant().plans` (name = `"Plan #"+planId`, price `formatUsd`, period days, version, active badge) + "New plan" button → Drawer form (amount USD input → atomic, period days, trial days) calling `createPlan`; toast on submit; row click → Drawer detail (mock's plan drawer with live values + "Push new version" disabled placeholder-free: wire to `pushPlanVersion`? NOT in ABI task — omit the button entirely, show version history text instead).
  - **Subscriptions**: chip filters (client-side status filter), table from `useMerchant().subs`, row Drawer with live fields.
  - **Payments**: rows from payment.succeeded + settlement.batched events (type badge, detail via feedDesc, amount, fee for succeeded, tx short link → `https://testnet.arcscan.app/tx/{hash}` when payload.transaction/txHash present via blockNumber? payment.succeeded events carry no tx hash in payload — link the event id's tx part: `id.split(":")[0]` for chain events).
  - **Webhooks**: static informational panel from mock (endpoint config lives in service env for MVP) — keep the mock's table as a "sample deliveries" demo section with an `empty-note` explaining configuration via `WEBHOOK_URL` env. No fake Resend actions: render delivery rows ONLY from real events? Delivery status isn't exposed by the API — so show the endpoint info + retry-schedule copy + `empty-note`; DROP the fake deliveries table (design deviation, justified: no fabricated data in a live product).
  - **Cards gallery**: `useMyCards` → `ScrupleCard` grid + "Mint card" Drawer form (label is local-only cosmetic → skip label input; inputs: daily/monthly limit USD, period select day/month, expiry optional date → unix, allowlist textarea of addresses, signer default self) calling `useCardActions().mint`; card click → Drawer: live kv fields + freeze/unfreeze toggle (optimistic: flip local state immediately, revert on tx error, toast) + allowlist chips (read-only list from... getCard doesn't return allowlist entries — show `useAllowlist ? "allowlisted" : "open"` badge only; per-merchant chips need an events-derived list: skip, show badge) + cancel with `confirm()`.
  - **Activity**: settlement.batched + payment.succeeded events where connected address is the payer/customer → table rows (result badge "paid"); no decline log in MVP (declines are client-side in SDK) — `empty-note` explains.
  - Not-connected states: Cards view without wallet → single Panel with connect button + copy "Connect a wallet to see your cards."
- [ ] **Step 1: Implement** both screen files + page wiring.
- [ ] **Step 2: Verify** — `npm test -w scruple-dashboard` (all green), `npm run build -w scruple-dashboard` green, root `npm test` unaffected (85 + dashboard suites).
- [ ] **Step 3: README** — root README gains a `## Dashboard (Phase 4b)` section: run instructions (`SERVICE_URL=http://localhost:8787 SERVICE_EVENTS_SECRET=… npm run dev -w scruple-dashboard`), env table, screenshot placeholder line `_Screenshots land with the demo assets (Phase 4c)._`
- [ ] **Step 4: Commit** — `feat(dashboard): live merchant + cards screens with mint/create flows` + trailer.

---

## Out of scope

- Passkey wallet mode, per-merchant allowlist chips (needs event-derived allowlist), webhook delivery inspector (needs a deliveries API), pushPlanVersion UI, e2e tests — Phase 4c/backlog.
- Demo runbook + video + deck = Phase 4c.
