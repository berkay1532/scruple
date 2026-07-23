# Scruple — Public Deploy Runbook (execute together with Berkay)

Goal: judge-clickable public URLs — dashboard + Acme on Vercel, the service on
an always-on host with a persistent disk for SQLite. Testnet-only keys
throughout; every secret lives host-side.

## 1. Service (Fly.io or Railway — pick one)

Needs: Node 20+, a persistent volume for the SQLite file, one exposed HTTP
port (the ingest+admin API), outbound HTTPS (RPC + webhook deliveries).

Env (from the README table — values for the live deploy):

| Var | Value |
|---|---|
| `RPC_URL` | canteen authenticated RPC (fallback: `https://rpc.testnet.arc.network`) |
| `START_BLOCK` | current head at first boot (avoids a week-long backfill) |
| `CARD_ISSUER_ADDRESS` | `0xE20EB808cF87B73D716C96CBbb1eee62282506d0` |
| `SUBSCRIPTION_MANAGER_ADDRESS` | `0x3d0b19b6B06E568A23AA916270008012Dca55795` |
| `DB_PATH` | path on the mounted volume, e.g. `/data/scruple.db` |
| `INGEST_PORT` | the port the host routes to |
| `INGEST_SECRET` | fresh 32-hex (`openssl rand -hex 16`) |
| `ADMIN_SECRET` | fresh 32-hex, DIFFERENT from INGEST_SECRET (`admin=dedicated`) |
| `KEEPER_PRIVATE_KEY` | optional; testnet-only key funded ~$1 for `charge()` gas |
| `POLL_INTERVAL_MS` | `5000` |

Start command: `npx tsx packages/service/bin/service.ts` (or a small Dockerfile
`node:20-slim` + `npm ci` + that command). Health check: `GET /events` returns
401 without a bearer — 401 IS the healthy signal.

Fly.io sketch: `fly launch --no-deploy` → `fly volumes create scruple_data
--size 1` → mount at `/data` in fly.toml → `fly secrets set` each env →
`fly deploy`. Railway: add a volume in the service settings, set envs, deploy
from the GitHub repo with a start command.

## 2. Dashboard (Vercel)

Project root `apps/dashboard` (monorepo: set Root Directory; Vercel handles
workspace deps). Env:

| Var | Value |
|---|---|
| `ARC_RPC_URL` | canteen RPC (server-side only — used by `/api/rpc`) |
| `SERVICE_URL` | the service host URL from step 1 |
| `SERVICE_EVENTS_SECRET` | = INGEST_SECRET |
| `SERVICE_ADMIN_SECRET` | = ADMIN_SECRET |

No NEXT_PUBLIC_ secrets exist by design — verify none are added.

## 3. Acme (Vercel, second project)

Root Directory `apps/acme`. Env: `ARC_RPC_URL` (same as above),
`NEXT_PUBLIC_ACME_PLAN_ID` (the demo plan id — plan #0 or a fresh one).

## 4. Post-deploy smoke (10 min)

1. Dashboard loads; connect wallet (MetaMask on Arc testnet via public RPC).
2. Webhooks screen: add a test endpoint (e.g. webhook.site), freeze/unfreeze a
   card, watch the delivery turn `delivered`.
3. Acme pricing page → checkout drawer → real subscribe with a test wallet.
4. Metered: run `examples/agent.ts` against a locally-run seller pointed at the
   PUBLIC service ingest (SERVICE_INGEST_URL=https://…/ingest) — rows appear on
   the dashboard metered table.
5. Put both URLs in README + deck.

## Notes / decisions Berkay owns

- Host choice (Fly vs Railway) and accounts/billing.
- Whether the canteen RPC key may be used from a third-party host (if not:
  public RPC works — the rpc-forwarder queue absorbs the rate limits, slightly
  slower first paint).
- Fresh INGEST/ADMIN secrets at deploy time (never reuse the local dev ones).
