# Scruple Phase 5c (Onboarding + Nudge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SaaS team can onboard in 5 minutes (quickstart doc), the dashboard guides empty states into action, and the needs-attention "Nudge →" button becomes real: one click emits a `nudge.requested` webhook the merchant's app can turn into a dunning email.

**Architecture:** Nudge rides the existing synthetic-event pattern (AtRiskMonitor's `INSERT OR IGNORE` dedup): `POST /admin/nudge/:subId` on the admin API finds the sub's current attention period from its latest at-risk/attempt-failed/overdue event and inserts `nudge:{subId}:{nextChargeAt}` — per-sub-per-period idempotent by construction, delivered by the existing dispatcher. The dashboard calls it through the existing `/api/admin` proxy. Empty-state CTAs reuse existing drawers/screens; no new panels.

**Tech Stack:** existing only (better-sqlite3 w/ JSON1, node:http, vitest; Next dashboard patterns in place).

## Global Constraints

- Nudge idempotency: event id `nudge:${subId}:${nextChargeAt}` via the existing `insertEvent` INSERT OR IGNORE path; repeat calls return 200 `{ ok: true, emitted: false }` (never an error, never a duplicate delivery).
- No attention event for the sub → 404 `{ error: "nothing to nudge" }` (Nudge is only meaningful for subs the attention list surfaced).
- Attention event types (exact, from taxonomy): `subscription.at_risk`, `payment.attempt_failed`, `payment.overdue`; all carry `payload.subId` and `payload.nextChargeAt` (strings).
- All /admin routes stay behind the existing timing-safe Bearer check; error shape `{error: string}` consistent with existing routes.
- UI copy English. CSS: reuse existing classes only; tiny additions allowed AFTER the mock block in globals.css, commented.
- quickstart code samples must be REAL: exact package names, current component/props (`<ScrupleCheckout planId={…} onSuccess={…}/>`), the actual `scruple-signature: sha256=<hmac-sha256-hex>` verification, current env names (SERVICE_URL, SERVICE_ADMIN_SECRET, ADMIN_SECRET, INGEST_SECRET). No pseudo-code, no invented APIs.
- Commit trailer convention continues.

## File Structure

```
packages/service/src/db.ts         # modify: latestAttentionPeriod(subId)
packages/service/src/ingest.ts     # modify: POST /admin/nudge/:subId
packages/service/test/db.test.ts   # extend
packages/service/test/ingest.test.ts  # extend
apps/dashboard/lib/use-admin.ts    # modify: nudge(subId) action + endpointsEmpty signal
apps/dashboard/components/screens/merchant.tsx  # modify: Nudge button, plans empty CTA, webhooks-unconfigured hint
apps/dashboard/components/screens/cards.tsx     # modify: no-cards mint CTA
docs/quickstart.md                 # new
README.md                          # modify: prominent quickstart link near top
```

---

### Task 1: Service — nudge endpoint (TDD)

**Files:** modify `packages/service/src/db.ts`, `packages/service/src/ingest.ts`; extend `test/db.test.ts`, `test/ingest.test.ts`.

**Interfaces (Produces):**
- `Store.latestAttentionPeriod(subId: string): string | null` — newest (`ORDER BY at DESC, id DESC`) event of the three attention types whose `payload.subId` equals subId; returns its `payload.nextChargeAt`; null when none. Use SQLite JSON1: `WHERE type IN (...) AND json_extract(payload, '$.subId') = ?`.
- Route `POST /admin/nudge/:subId` (subId = digits, same `\d+`-style match pattern as endpoint ids BUT subId is a decimal string — accept `[0-9]+`): period = latestAttentionPeriod; 404 `{error:"nothing to nudge"}` when null; else `insertEvent({ id: `nudge:${subId}:${period}`, type: "nudge.requested", blockNumber: null, payload: { subId, nextChargeAt: period }, at: now })` → 200 `{ ok: true, emitted: <insertEvent result> }`.

- [ ] **Step 1: failing tests.** db.test.ts: (a) latestAttentionPeriod returns nextChargeAt of the NEWEST attention event for that sub (insert an older at_risk and a newer overdue with different nextChargeAt; expect the newer's); (b) ignores other subs' events and non-attention types; (c) null when none. ingest.test.ts: (d) 401 without Bearer; (e) 404 nothing-to-nudge; (f) happy path → 200 `{ok:true, emitted:true}` AND the event lands in the store with id `nudge:<subId>:<period>` and a delivery row is enqueued for an active endpoint; (g) second call → 200 `{ok:true, emitted:false}`, no second delivery row.
- [ ] **Step 2:** run, expect FAIL. **Step 3:** implement. **Step 4:** PASS (`npm test -w @scruple/service`, 66 + ~7). **Step 5:** commit `feat(service): nudge endpoint — per-period idempotent nudge.requested` + trailer.

---

### Task 2: Dashboard — Nudge button + guided empty states

**Files:** modify `apps/dashboard/lib/use-admin.ts`, `apps/dashboard/components/screens/merchant.tsx`, `apps/dashboard/components/screens/cards.tsx`.

**Work:**
- `use-admin.ts`: add `nudge(subId: string)` action → `POST /api/admin/nudge/${subId}` → parsed `{ok, emitted}`; errors surface as strings like existing actions.
- Overview needs-attention rows (merchant.tsx ~line 171): add a `Nudge →` button (`className="btn small"`, right-aligned in the row) → on click call nudge(row.subId); toast on success: emitted=true → "Nudge sent — your webhook will receive nudge.requested."; emitted=false → "Already nudged for this billing period."; error → toast the error string. Busy-guard per row (disable while in flight).
- Plans empty state (Rate cards & plans screen): when the merchant has zero plans, replace the bare empty text with CTA copy "Create your first plan — subscribers can check out the moment it's live." + a button that opens the existing create-plan drawer.
- Cards screen (cards.tsx ~line 275-276): when connected and zero cards, add a button under the copy that opens the existing mint drawer/form ("Mint your first card").
- Webhooks-unconfigured hint on Overview: if the admin endpoints fetch SUCCEEDS and returns zero endpoints, show one dismissable inline hint row (session-state dismiss, no persistence) under the attention panel: "Webhooks aren't set up — add an endpoint to get payment and subscription events." linking to the Webhooks screen (existing nav switch). On admin fetch error show nothing (dashboards without a configured service must not nag).
- Tests: pure helpers only if extracted; otherwise dashboard suite stays at 101. `npm run build -w scruple-dashboard` must pass.
- [ ] Commit `feat(dashboard): nudge action + guided empty states` + trailer.

---

### Task 3: Onboarding doc

**Files:** create `docs/quickstart.md`; modify `README.md` (link near top).

"Scruple in 5 minutes" for a SaaS team, in order: (1) contracts + addresses (deployed Arc-testnet pair, chain 5042002); (2) create a plan (dashboard drawer, or `cast send` one-liner); (3) drop `<ScrupleCheckout planId={N} onSuccess={...}/>` into their pricing page (real import from `@scruple/checkout`, peer deps listed, the Acme example referenced as living proof); (4) run the service (env table: RPC_URL, START_BLOCK, CARD_ISSUER_ADDRESS, SUBSCRIPTION_MANAGER_ADDRESS, DB_PATH, INGEST_PORT, INGEST_SECRET, ADMIN_SECRET, KEEPER_PRIVATE_KEY optional) and add a webhook endpoint from the dashboard; (5) verified HMAC handler sample — a complete ~20-line Express/node:http handler that checks `scruple-signature: sha256=<hex>` with timing-safe compare against their whsec_ secret and switches on `event.type` incl. `nudge.requested` → send dunning email. Every sample compiles against current code (verify names against packages/ before writing).
- [ ] README: add a one-line "**New here? [Scruple in 5 minutes](docs/quickstart.md)**" link in the intro section. Commit `docs: quickstart — Scruple in 5 minutes` + trailer.

---

### Task 4: Live verification (controller-driven)

- [ ] Boot service (+ADMIN_SECRET) + dashboard + local receiver; seed a `subscription.at_risk` event for a real subId directly into the run DB (sqlite3 insert mirroring AtRiskMonitor's shape — chain state can't produce at-risk on demand); Overview shows the needs-attention row with Nudge; click-path via proxy: nudge → 200 emitted:true → receiver gets `nudge.requested` (HMAC verified) → repeat → emitted:false, no second delivery; 404 path for a sub with no attention events. Record in `.superpowers/sdd/p5c-task-4-report.md`.

## Out of scope
5d (6963 picker, seller forwarder env wiring, public deploy, forwarder extraction); dunning email itself (merchant's app owns it — that's the story).
