# Scruple

Stripe-grade billing for the USDC economy on Arc: usage-based + subscription
billing (merchant side) and spending-policy Cards (payer side). Non-custodial.

**New here? [Scruple in 5 minutes](docs/quickstart.md)** — plan → checkout embed → webhooks, end to end.

Encode × Arc Programmable Money Hackathon 2026 — tracks: DeFi + Agentic Economy.

## Architecture

Two on-chain components (Solidity / Foundry), non-custodial throughout —
customer USDC never leaves the customer's wallet until a `charge()` pulls it
directly to the merchant + treasury via `transferFrom`:

- **`CardIssuer.sol`** — payer-side spending-policy cards: mint a card with a
  periodic budget, merchant allowlist, expiry, and signer; freeze/cancel;
  `authorizeSpend` debits the period budget. Field shapes mirror ERC-7715
  `erc20-token-periodic` semantics so a future migration to native 7715
  wallets is mechanical. Only addresses the admin has authorized via
  `setChargerAuthorization` may debit a card's budget.
- **`SubscriptionManager.sol`** — merchant-side plan registry with immutable,
  versioned pricing (a price change creates a new version; subscribers
  migrate at next renewal — no mid-period proration); permissionless
  `charge(subId)` callable by anyone inside the charge window; 1% platform
  fee split to the treasury on every charge; 3-day grace period before a
  subscription expires. It is the sole authorized charger against
  `CardIssuer` in this phase.
- **Metered (pay-per-call) settlement has no custom contract.** It rides
  Circle's live, audited `GatewayWalletBatched` — deliberately minimizing
  novel attack surface. See the design doc (§4) for the full five-component
  architecture, including the SDKs, indexer, and dashboard planned for later
  phases.

## Build & test the contracts

```bash
git clone --recurse-submodules https://github.com/berkay1532/scruple.git
cd scruple/contracts
forge test
```

28/28 tests passing (`CardIssuer`, `SubscriptionManager`, `MockUSDC`).

## SDKs (Phase 2)

| Package | What it does |
|---|---|
| `@scruple/server` | Express middleware: declarative rate card → HTTP 402 challenge → payment verification → settlement via Circle Gateway (batch-settled onchain). |
| `@scruple/client` | Payer/agent client: detects 402, enforces a spending policy (period budget, per-tx cap, origin allowlist — mirroring CardIssuer semantics), pays via Circle `GatewayClient`, retries. |

See `examples/` for a runnable merchant + agent pair on Arc testnet.

    npm install
    npm test        # unit suites for both SDKs (network boundaries mocked)

84/84 tests passing (server 23, client 17, service 44; network boundaries mocked).

## Services (Phase 3)

`@scruple/service` — the off-chain backbone:

- **Indexer** — chunked `getLogs` polling (Arc drops `eth_newFilter`), resumable cursor, deterministic event ids (`txHash:logIndex`).
- **Webhooks** — HMAC-SHA256-signed deliveries (`scruple-signature`), idempotency id on every event, retries at 1m/5m/30m/2h/12h then dead-lettered. Fully manageable live via the service admin API: endpoint CRUD, pause/resume, secret rotate, and a deliveries inspector with Resend (revives dead deliveries, keeps the attempt counter) — all driven end-to-end from the dashboard's Webhooks screen.
- **At-risk monitor** — emits `subscription.at_risk` *before* a renewal that would fail (insufficient balance or card policy), killing silent churn.
- **Keeper** — calls the permissionless `charge()` for due subscriptions.

    # after deploying contracts (see Deploy):
    CARD_ISSUER_ADDRESS=0x… SUBSCRIPTION_MANAGER_ADDRESS=0x… \
    WEBHOOK_URL=https://your.app/hooks WEBHOOK_SECRET=whsec_… \
    KEEPER_PRIVATE_KEY=0x… npx tsx packages/service/bin/service.ts

Event taxonomy: `card.created|frozen|unfrozen|cancelled`, `plan.created|version_pushed`,
`subscription.created|expired|cancelled|at_risk`, `payment.succeeded`.
Full taxonomy is live: `payment.attempt_failed`/`payment.overdue` are detected by
the keeper, and metered payments flow in as `settlement.batched` via the ingest API
(`POST /ingest`, HMAC-signed — plug `createServiceForwarder` from `@scruple/server`
into the middleware's `onPayment`). The dashboard reads `GET /events` (bearer auth).
Store is SQLite for the MVP (schema is Postgres-portable).

Enable the HTTP surface with `INGEST_PORT`/`INGEST_SECRET`:

| Env var | Required | Purpose |
|---|---|---|
| `INGEST_PORT` | to enable the HTTP surface | Port for `POST /ingest`, `GET /events`, and the `/admin/*` webhook-management API. |
| `INGEST_SECRET` | yes, when `INGEST_PORT` is set | Bearer/HMAC secret for `/ingest` and `/events`; also the fallback for `/admin/*` auth when `ADMIN_SECRET` is unset. |
| `ADMIN_SECRET` | no | Bearer secret for `/admin/*` (endpoint CRUD, pause/resume, rotate, deliveries, resend). Falls back to `INGEST_SECRET` when unset — set a dedicated value to scope down who can manage webhooks. Never logged. |

## Deploy (Arc testnet, chain 5042002)

```bash
cd contracts
export RPC=https://rpc.testnet.arc.network
export PRIVATE_KEY=<funded deployer key>
export TREASURY=<fee-recipient address>
forge script script/Deploy.s.sol --rpc-url $RPC --broadcast -vv
```

`script/Deploy.s.sol` deploys `CardIssuer` and `SubscriptionManager`, then
wires `CardIssuer.setChargerAuthorization(subscriptionManager, true)` in the
same broadcast. Verify deployed contracts on
[`testnet.arcscan.app`](https://testnet.arcscan.app).

**Deployed on Arc testnet (chain 5042002):**

| Contract | Address |
|---|---|
| `CardIssuer` | [`0xE20EB808cF87B73D716C96CBbb1eee62282506d0`](https://testnet.arcscan.app/address/0xE20EB808cF87B73D716C96CBbb1eee62282506d0) |
| `SubscriptionManager` | [`0x3d0b19b6B06E568A23AA916270008012Dca55795`](https://testnet.arcscan.app/address/0x3d0b19b6B06E568A23AA916270008012Dca55795) |

First live subscription charge (plan → card → subscribe → `charge()`, $1.00 pulled with an exact 1% fee split): [`0xca8f7227…d1ea7ad`](https://testnet.arcscan.app/tx/0xca8f7227b0d0c20c6c693e07bceac143b967227285f3b44f1d5e759b6d1ea7ad)

## Dashboard (Phase 4b)

`apps/dashboard` — a Next.js App Router dashboard for both sides of Scruple: merchants get
live revenue, plans, subscriptions, payments, and full webhook management (endpoint CRUD,
reveal-once signing secrets, pause/resume/rotate, and a deliveries inspector with Resend,
all through the service's `/admin` API); payers/agents get their
Cards (mint, freeze/unfreeze, cancel) and spend activity. It's a thin read/write layer —
reads join the service's event feed (`GET /events`, proxied server-side so the bearer
secret never reaches the browser) with live `viem`/`wagmi` chain reads against
`CardIssuer`/`SubscriptionManager` on Arc testnet; writes go straight to the chain via the
connected wallet.

Run it against a running `@scruple/service` instance (see [Services](#services-phase-3)):

```bash
SERVICE_URL=http://localhost:8787 SERVICE_EVENTS_SECRET=<INGEST_SECRET value> \
  npm run dev -w scruple-dashboard
```

| Env var | Required | Purpose |
|---|---|---|
| `SERVICE_URL` | yes | Base URL of the `@scruple/service` instance backing this dashboard (its `GET /events` is proxied through `app/api/events`). |
| `SERVICE_EVENTS_SECRET` | yes | Matches the service's `INGEST_SECRET` — sent as a bearer token to `GET /events`, server-side only. |
| `SERVICE_ADMIN_SECRET` | no | Matches the service's `ADMIN_SECRET` — sent as a bearer token to `/admin/*` through the `app/api/admin` proxy (server-side only). Falls back to `SERVICE_EVENTS_SECRET` when unset. |
| `ARC_RPC_URL` | no | Authenticated Arc RPC URL for chain reads, proxied server-side through `app/api/rpc` (defaults to `https://rpc.testnet.arc.network`) — any token in it never reaches the browser. |
| `NEXT_PUBLIC_RPC_URL` | no | Browser-direct RPC override, requires a CORS-enabled endpoint (defaults to same-origin `/api/rpc`, which proxies to `ARC_RPC_URL`). |

Honest-data note: a couple of the design mock's sections show data the live API doesn't
expose yet (per-card allowlist address lists, declined-payment history) — those panels
are trimmed to what's real rather than filled with fabricated rows; see
`apps/dashboard/components/screens/*.tsx` for the specifics. Webhook delivery status,
formerly on this list, is now live on the Webhooks screen via the `/admin` API.

_Screenshots land with the demo assets (Phase 4c)._

## Checkout embed (Phase 5a)

`@scruple/checkout` — a drop-in `<ScrupleCheckout/>` React panel a merchant embeds directly on
their own pricing page to sell a Scruple subscription plan, no redirect and no iframe:

```tsx
import { ScrupleCheckout } from "@scruple/checkout";

<ScrupleCheckout planId={1n} onSuccess={({ subId }) => activatePro(subId)} />
```

Peer dependencies: `react`, `wagmi`, `viem`, `@tanstack/react-query` — the host app brings its
own versions of each, and must already have a `WagmiProvider` (and `QueryClientProvider`)
mounted somewhere above wherever `<ScrupleCheckout/>` renders; the embed does not configure or
wrap either itself.

Run the Acme example — a fictional, foreign-branded pricing page with the embed live on its Pro
tier (`apps/acme`):

```bash
NEXT_PUBLIC_ACME_PLAN_ID=0 ARC_RPC_URL=<rpc> npm run dev -w acme-demo   # → http://localhost:3002
```

Design notes: the embed is chain-only — every read (`getPlan`, `getPlanVersion`, card
eligibility) goes straight to `CardIssuer`/`SubscriptionManager` on Arc through the host's own
`wagmi` config, with no dependency on `@scruple/service` or any indexer. Buyer cards are
discovered by scanning the 64 most-recently-minted card ids network-wide and filtering to the
ones the connected wallet owns and can spend on this plan — there is no on-chain "cards by
owner" enumeration to query instead, so this is a deliberate, documented testnet-scale
tradeoff (see `CARD_SCAN_LIMIT` in `packages/checkout/src/use-checkout.ts`): a buyer whose
eligible card is older than that window won't see it offered here and falls back to minting a
fresh one. The one-time USDC allowance the panel requests before subscribing covers 12
renewals up front (disclosed in-panel — "revoke anytime") so the buyer isn't re-prompted every
billing period. Non-custodial throughout: funds move wallet-to-wallet on `subscribe()`/
`charge()`, the embed never custodies buyer funds or keys.

## Docs

- [Design doc](docs/superpowers/specs/2026-07-19-scruple-design.md) — full
  problem statement, architecture, flows, and delivery plan.
- [Contracts implementation plan](docs/superpowers/plans/2026-07-19-scruple-contracts.md)
