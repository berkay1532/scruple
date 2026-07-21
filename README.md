# Scruple

Stripe-grade billing for the USDC economy on Arc: usage-based + subscription
billing (merchant side) and spending-policy Cards (payer side). Non-custodial.

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

## Quickstart

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
- **Webhooks** — HMAC-SHA256-signed deliveries (`scruple-signature`), idempotency id on every event, retries at 1m/5m/30m/2h/12h then dead-lettered.
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
Enable with `INGEST_PORT`/`INGEST_SECRET`.
Store is SQLite for the MVP (schema is Postgres-portable).

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
live revenue, plans, subscriptions, payments, and webhook config; payers/agents get their
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
| `ARC_RPC_URL` | no | Authenticated Arc RPC URL for chain reads, proxied server-side through `app/api/rpc` (defaults to `https://rpc.testnet.arc.network`) — any token in it never reaches the browser. |
| `NEXT_PUBLIC_RPC_URL` | no | Browser-direct RPC override, requires a CORS-enabled endpoint (defaults to same-origin `/api/rpc`, which proxies to `ARC_RPC_URL`). |

Honest-data note: a handful of the design mock's sections show data the live API doesn't
expose yet (webhook delivery status, per-card allowlist address lists, declined-payment
history) — those panels are trimmed to what's real rather than filled with fabricated
rows; see `apps/dashboard/components/screens/*.tsx` for the specifics.

_Screenshots land with the demo assets (Phase 4c)._

## Docs

- [Design doc](docs/superpowers/specs/2026-07-19-scruple-design.md) — full
  problem statement, architecture, flows, and delivery plan.
- [Contracts implementation plan](docs/superpowers/plans/2026-07-19-scruple-contracts.md)
