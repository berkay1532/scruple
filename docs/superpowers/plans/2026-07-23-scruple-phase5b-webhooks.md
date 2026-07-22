# Scruple Phase 5b (Webhook Management End-to-End) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make webhooks a fully working product surface: a service **admin API** (endpoint CRUD, pause/resume, secret rotate, deliveries inspector, resend) and the dashboard **Webhooks screen gone live** — the mock's design with real data, replacing the informational panel.

**Architecture:** Admin API lives on the existing ingest HTTP server (`packages/service/src/ingest.ts` grows an `/admin/*` router; same `node:http`, zero new deps), authed via `authorization: Bearer <ADMIN_SECRET>` (env; **falls back to INGEST_SECRET** when unset). Store gains a `paused` column (idempotent migration), delivery-listing/revive queries, endpoint mutation helpers. The dispatcher skips paused endpoints at the query level. The dashboard reaches the API only through a server-side proxy (`/api/admin/[...path]`) so ADMIN_SECRET never ships to the browser; the Webhooks screen becomes endpoint CRUD + secret reveal-once/rotate + pause/resume + a deliveries table with status badges and Resend (Stripe semantics: resend keeps the attempt counter, revives dead).

**Tech Stack:** existing only (better-sqlite3, node:http/crypto, vitest; Next dashboard patterns already in place).

## Global Constraints

- Secrets: auto-generated as `whsec_<32 hex>` via `crypto.randomBytes(16)`; returned ONLY in the create/rotate response (never listed afterwards — list returns a `secretPreview` like `whsec_ab…89`). ADMIN_SECRET never logged, never in client bundle.
- Auth: every `/admin/*` route requires timing-safe Bearer check (reuse the `safeEqual` helper). 401 on failure.
- Delivery status derivation (single source of truth in Store): `delivered` (delivered_at set) · `retrying` (next_attempt_at set, attempts ≥ 1) · `pending` (next_attempt_at set, attempts 0) · `dead` (delivered_at null AND next_attempt_at null).
- Resend: sets `next_attempt_at = now` (revives dead too); attempts counter NOT reset. Pause: endpoint keeps receiving enqueued deliveries but `duePending` excludes it; resume re-includes (overdue ones fire on next tick).
- Deleting an endpoint hard-deletes its delivery rows (cascade in the same transaction).
- Schema migration must be idempotent against existing DBs (check `pragma table_info(endpoints)` before `ALTER TABLE ... ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`).
- Commit trailer convention continues.

## File Structure

```
packages/service/src/db.ts        # modify: migration, paused-aware queries, endpoint/delivery admin helpers
packages/service/src/ingest.ts    # modify: /admin router (same server), auth helper reuse
packages/service/src/webhooks.ts  # unchanged (dispatcher reads duePending which becomes paused-aware)
packages/service/bin/service.ts   # modify: ADMIN_SECRET env plumb + startup log flag
packages/service/test/db.test.ts  # extend
packages/service/test/ingest.test.ts  # extend (admin routes)
apps/dashboard/app/api/admin/[...path]/route.ts  # new: proxy (GET/POST/DELETE passthrough)
apps/dashboard/components/screens/merchant.tsx    # modify: Webhooks screen goes live
apps/dashboard/lib/use-admin.ts   # new: typed client for /api/admin (endpoints, deliveries, actions)
README.md                         # env table + webhook section update
```

---

### Task 1: Store — paused flag, admin queries, delivery inspector (TDD)

**Files:** modify `packages/service/src/db.ts`, extend `packages/service/test/db.test.ts`.

**Interfaces (Produces):**
- Migration: constructor runs `ensurePausedColumn()` — pragma-check then ALTER; existing DBs keep working.
- `listEndpointsAdmin(): Array<{ id: number; url: string; secretPreview: string; paused: boolean; createdAtKnown: false }>` — preview = first 8 + "…" + last 2 chars of secret.
- `createEndpoint(url: string, secret: string): number` (existing addEndpoint stays for runner compat; createEndpoint = same + returns id).
- `deleteEndpoint(id: number): boolean` — endpoint + its deliveries in one transaction; false if absent.
- `setEndpointPaused(id: number, paused: boolean): boolean`
- `rotateEndpointSecret(id: number, secret: string): boolean`
- `duePending(now)` — MODIFIED: `AND ep.paused = 0` (plus existing active=1).
- `listDeliveries(opts?: { limit?: number; status?: "delivered"|"retrying"|"pending"|"dead" }): Array<{ eventId, endpointId, url, type, attempts, lastStatus: number|null, nextAttemptAt: number|null, deliveredAt: number|null, status }>` — newest-first by event `at`, clamp limit 1..500, status derived per Global Constraints (derivation in SQL CASE or in-map — one place only).
- `reviveDelivery(eventId: string, endpointId: number, now: number): boolean` — sets next_attempt_at=now (works for dead + scheduled), false if delivered/absent.

- [ ] **Step 1: failing tests** (append to db.test.ts — concrete cases): migration idempotency (construct Store twice on same file-backed tmp DB — use `:memory:`? migration needs persistence: use a tmp file via `mkdtemp`, delete after); paused endpoint excluded from duePending, resumed included; listEndpointsAdmin preview shape; delete cascades deliveries; rotate changes stored secret (verify via duePending's secret field); listDeliveries statuses — craft all four states via insertEvent+markAttempt sequences and assert derived status + ordering + status filter; reviveDelivery revives dead (appears in duePending(now)) and returns false for delivered.
- [ ] **Step 2:** FAIL run. **Step 3:** implement. **Step 4:** PASS (`npm test -w @scruple/service`, expect 44+~8). **Step 5:** commit `feat(service): store admin surface — paused endpoints, delivery inspector, revive` + trailer.

---

### Task 2: Admin HTTP API (TDD)

**Files:** modify `packages/service/src/ingest.ts` (router grows; `createIngestServer` opts gain `adminSecret: string`), extend `test/ingest.test.ts`.

**Routes (all Bearer adminSecret; 401 otherwise; JSON):**
- `GET /admin/endpoints` → `{ endpoints: listEndpointsAdmin() }`
- `POST /admin/endpoints` body `{ url, secret? }` (validate url http/https; secret auto-gen `whsec_`+32hex when absent) → `{ id, url, secret }` (full secret ONCE)
- `DELETE /admin/endpoints/:id` → `{ ok }` / 404
- `POST /admin/endpoints/:id/pause` | `/resume` → `{ ok, paused }`
- `POST /admin/endpoints/:id/rotate` → `{ ok, secret }` (once)
- `GET /admin/deliveries?limit&status` → `{ deliveries }` 
- `POST /admin/deliveries/:endpointId/:eventId/resend` → `{ ok }` / 404 (note param order: endpointId first — eventIds contain colons/slashes-free but DO contain `:` (txHash:logIndex)! URL-encode: eventId as LAST path segment taken RAW after the prefix — implement by splitting pathname with a max-split so eventId may contain ':'; add a test with a `0xabc:7` id).
- [ ] Steps: failing tests (auth 401; create-with-autogen returns whsec_ full once + list shows preview only; pause→resume roundtrip; rotate returns new secret; deliveries filter; resend revives — reuse Task 1 fixtures via HTTP; eventId-with-colon resend) → FAIL → implement → PASS (`npm test -w @scruple/service`, +~8) → commit `feat(service): admin API — endpoints CRUD, pause/resume, rotate, deliveries, resend` + trailer.

---

### Task 3: Runner + README

**Files:** modify `packages/service/bin/service.ts` (pass `adminSecret: process.env.ADMIN_SECRET ?? secret` into createIngestServer; extend startup log with `admin=on`), README (env table row for ADMIN_SECRET; Services section: webhook management paragraph replacing "informational until inspector ships" note in runbook §5 too — runbook line update).
- [ ] Implement → `npx tsc --noEmit -p packages/service` + root `npm test` green → commit `feat(service): admin secret plumbing + docs` + trailer.

---

### Task 4: Dashboard — Webhooks screen live

**Files:** create `apps/dashboard/app/api/admin/[...path]/route.ts` (GET/POST/DELETE passthrough to `${SERVICE_URL}/admin/${path}?${qs}` with Bearer `process.env.SERVICE_ADMIN_SECRET ?? SERVICE_EVENTS_SECRET`; force-dynamic; never echo secrets; 502 guards like /api/events), create `apps/dashboard/lib/use-admin.ts` (typed fetch client + 10s polling for lists + action fns returning parsed JSON, error strings surfaced), modify `components/screens/merchant.tsx` Webhooks screen:
- Endpoints panel: rows (url, secretPreview, paused badge, Pause/Resume + Rotate + Delete buttons w/ confirm for delete) + "Add endpoint" drawer form (url; on create show the full secret ONCE in a copy-able `<code>` with the warning "Shown once — store it now").
- Rotate shows the same reveal-once treatment.
- Deliveries panel: table (event id short, type, endpoint url short, attempts, last HTTP, next attempt time via timeAgo/`—`, status Badge: delivered ok / retrying warn / pending mut / dead bad) + chip filter by status + Resend button on retrying/dead rows → toast.
- Empty states: no endpoints → CTA copy "Add your first endpoint — every payment and subscription event will be signed and delivered to it."
- Reuse Panel/Badge/Drawer/useToast/chips patterns; UI copy English; no new CSS beyond existing classes (+ tiny additions to globals.css allowed AFTER the mock block, commented).
- [ ] Gates: `npm test -w scruple-dashboard` (96 unchanged — screen is thin; add 1-2 pure tests ONLY if a helper is extracted), `npm run build -w scruple-dashboard`. Commit `feat(dashboard): live webhook management — endpoints, secrets, deliveries, resend` + trailer.

---

### Task 5: Live verification (controller-driven)

- [ ] Boot service (with ADMIN_SECRET) + dashboard; via UI: add a local receiver endpoint (`npx tsx`-spawned 12-line HTTP logger on :9099), watch a real event deliver (trigger: freeze/unfreeze a card on-chain), see `delivered` row; kill receiver → trigger → watch `retrying`; Resend after receiver returns; pause/resume roundtrip; rotate + receiver signature check with new secret. Record all in report. Update runbook §5 note. Commit any doc deltas.

## Out of scope
5c (quickstart/nudge/empty-state CTAs beyond webhooks), 5d (6963 picker, seller forwarder env wiring — though the receiver test may reuse examples patterns), public deploy.
