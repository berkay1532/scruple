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

**Deployed addresses:** coming with CP2 deploy.

## Docs

- [Design doc](docs/superpowers/specs/2026-07-19-scruple-design.md) — full
  problem statement, architecture, flows, and delivery plan.
- [Contracts implementation plan](docs/superpowers/plans/2026-07-19-scruple-contracts.md)
