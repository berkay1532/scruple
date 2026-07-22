# Scruple — Phase 5 "Productization" Design

**Date:** 2026-07-22 · **Status:** Approved (scope locked with Berkay)
**Goal:** By ~Aug 6: a product a SaaS team can adopt in half a day — embeddable
checkout, fully working webhook management, developer onboarding, and a
publicly clickable live demo. Everything ships at the same quality bar as
Phases 1-4 (specs → plans → TDD → independent review).

## Scope (all approved)

### 5a — `@scruple/checkout` + "Acme Analytics" example
- New workspace package `packages/checkout` exporting `<ScrupleCheckout />`
  (peer deps: react, wagmi, viem, @tanstack/react-query).
- Component API:
  `ScrupleCheckout({ planId, subscriptionManager?, cardIssuer?, onSuccess?(subId), onError? })`
  — contract addresses default to the deployed Arc-testnet pair.
- Flow (single drawer-style panel, brand tokens):
  1. Connect wallet (EIP-6963 picker — see 5d, shared component).
  2. Load plan (price/period/trial) from chain; show summary.
  3. Card selection: list the buyer's existing ACTIVE cards whose policy can
     cover the plan (periodAmount ≥ plan amount, merchant allowed or open);
     **or mint inline** (approved decision): default limit = plan amount,
     period = plan period, allowlist = [merchant], signer = self — one click.
  4. USDC approve (amount = plan amount × 12, shown explicitly as "allows the
     next 12 renewals; revoke anytime") → `subscribe(planId, cardId)`.
  5. Success state with subId + "manage in dashboard" hint → `onSuccess`.
- **Acme Analytics** example: `apps/acme` — tiny Next.js pricing page (its own
  fictional branding, deliberately NOT Scruple-branded, to prove the embed
  drops into a foreign design) using `<ScrupleCheckout planId={…} />`.
- Tests: component logic (card-eligibility selector, approve math) unit-tested;
  full flow verified live on testnet.

### 5b — Webhook management end-to-end
- **Service admin API** (same HTTP server as ingest; auth: `authorization:
  Bearer <ADMIN_SECRET>`, env `ADMIN_SECRET` falls back to `INGEST_SECRET`):
  - `GET /admin/endpoints` · `POST /admin/endpoints {url, secret?}` (secret
    auto-generated when omitted; returned once) · `DELETE /admin/endpoints/:id`
  - `POST /admin/endpoints/:id/pause` / `…/resume` (Radom pattern; paused
    endpoints keep enqueuing but skip dispatch)
  - `POST /admin/endpoints/:id/rotate` → new secret returned once
  - `GET /admin/deliveries?limit&status=delivered|retrying|dead` — event id,
    type, endpoint, attempts, last HTTP status, next attempt, state
  - `POST /admin/deliveries/:endpointId/:eventId/resend` — revives dead or
    reschedules to now (attempt counter continues; Stripe semantics)
- Store: endpoint `paused` flag (distinct from delete), delivery queries,
  revive; migration-safe schema additions.
- **Dashboard Webhooks screen goes live**: endpoint CRUD + secret reveal/rotate
  + pause/resume + deliveries inspector table with status badges and Resend —
  the mock's design, real data. Dashboard talks through a server-side proxy
  route (`/api/admin/*`, ADMIN_SECRET stays server-side).

### 5c — Onboarding + product polish
- `docs/quickstart.md` — "Scruple in 5 minutes" for a SaaS team: create plan →
  drop `<ScrupleCheckout/>` → handle webhooks (verified HMAC handler sample) →
  go. Linked from README top.
- Dashboard empty states become guided CTAs (no plans → "Create your first
  plan" opens the drawer; no cards → mint CTA; webhooks unconfigured → setup CTA).
- **Nudge becomes real**: needs-attention "Nudge →" calls
  `POST /admin/nudge/:subId` → service inserts synthetic `nudge.requested`
  event (per-sub-per-period idempotent) → merchant's webhook receives it →
  their app emails the customer. Demo story: "one click, your dunning email
  goes out."

### 5d — Demo-day insurance + public deploy
- **EIP-6963 multi-wallet picker** replacing the bare injected connector
  (prevents the Phantom-hijack incident); shared by dashboard + checkout.
- **Seller → ingest wiring in examples**: `examples/seller.ts` gains
  `createServiceForwarder` when `SERVICE_INGEST_URL`/`SERVICE_INGEST_SECRET`
  set, so live x402 runs populate `settlement.batched` + the metered
  rate-card table.
- **Public deploy** (judges click, no video needed): dashboard + Acme on
  Vercel; service on a small always-on host (Fly.io or Railway; SQLite on a
  volume); public URLs in README + deck. Testnet-only keys; ADMIN/INGEST
  secrets set host-side; keeper funded with ~$1.

## Constraints (unchanged from earlier phases)
- Non-custodial invariant untouched; no secret ever reaches a client bundle.
- Same review pipeline: plan → subagent implementers → independent per-task
  review → whole-branch final review → merge.
- All money math atomic-bigint; USD inputs via the exact parser.
- Commit trailer convention continues.

## Order & rough calendar
5a (Jul 23-27) → 5b (Jul 27-31) → 5c (Aug 1-2) → 5d (Aug 3-5) → buffer +
video/deck production with the finished product (Aug 6-8) → submit Aug 9.
CP2 submission (user, by Jul 26) is independent of this work.

## Out of scope (explicitly)
- Mainnet anything; multi-token plans; plan archiving/card migration
  (post-hackathon backlog with 7715 hard-enforcement).
