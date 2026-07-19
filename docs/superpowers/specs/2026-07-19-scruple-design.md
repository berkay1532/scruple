# Scruple — Design Document

**Date:** 2026-07-19
**Status:** Approved draft (pre-implementation)
**Authors:** Berkay Gündüz, with Claude

---

## 1. What Scruple is

Scruple is billing infrastructure for the USDC economy on Arc, Circle's stablecoin-native L1. It has two product faces sharing one platform:

- **Scruple Billing (merchant side):** usage-based (metered) and recurring (subscription) USDC collection for APIs, SaaS, and AI services — the way Stripe let websites charge cards.
- **Scruple Cards (payer side):** users and AI agents mint on-chain "cards" — scoped, limited, revocable payment permissions with a familiar card visual — instead of granting raw unlimited token approvals.

One-line positioning: *Nevermined does agent metering on Base. Radom does crypto subscriptions for humans. Scruple unifies both — usage-based and recurring USDC billing in one non-custodial platform, built where neither exists: Arc.*

> A *scruple* is the smallest weight an apothecary's scale could measure. We make the smallest payments measurable and billable.

## 2. Problem

1. **Sub-cent billing is impossible on card rails.** AI API providers earn per-request but can't bill per-request: 2.9% + $0.30 minimums force prepaid credit systems that add friction and kill conversion.
2. **AI agents can't hold credit cards.** The fastest-growing customer segment for APIs has no payment instrument with built-in spending controls.
3. **Crypto has no pull payments.** Subscriptions require the merchant to chase customers with invoices every period; allowance-based systems churn silently when allowances run out (observed failure mode in Radom production).
4. **Raw approvals are terrifying.** The payer-side UX today is "grant unlimited allowance and hope" — no limits, no expiry, no per-merchant isolation, no freeze button.

## 3. Goals and non-goals

### MVP goals (hackathon final, Aug 9)

- Metered billing: a merchant protects an API route with one middleware line; a human or agent pays per-call via x402; settlement batches on Arc.
- Subscription billing: a customer grants a periodic USDC permission once; a keeper charges each period; cancellation is one signature.
- Cards: mint a card (periodic limit + merchant allowlist + expiry), attach it to a human passkey or an agent key, freeze/cancel it; charges beyond policy are refused.
- Merchant dashboard: rate cards, plans, live revenue, webhook config.
- All flows live on Arc testnet (chain 5042002) with real transactions.

### Explicit non-goals for MVP (v1.1+ backlog)

- Fiat on/off-ramp, card-to-USDC top-ups, ERP integrations (Xero/QuickBooks bridge is a distinctive v2 opportunity — both competitors lack it).
- Fully silent human payments (session-key UX beyond one-approval-per-session).
- On-chain enforcement of *agent* budgets beyond card policy (SDK-level soft policy is acceptable where the card contract doesn't cover it).
- Confidential amounts (depends on Arc's opt-in privacy roadmap; see §9).
- Multi-chain deployment (Gateway makes it possible later; Arc-first is deliberate).

### Product principles

1. **Non-custodial, always.** Customer funds never pass through Scruple. Platform fees are taken as an on-chain split at settlement. This keeps Scruple a software company, not a money transmitter.
2. **Two concepts only:** *plan* (merchant side) and *card* (payer side). Credits, sessions, delegations, schemes are internal details, never top-level concepts (anti-lesson from Nevermined's concept sprawl).
3. **Percentage-only pricing, no fixed cents, no monthly fee.** Target ~1%. A fixed $0.50 fee makes a $10 metered invoice cost 5.5% (Radom anti-lesson).
4. **Standards-aligned, not standards-inventing.** Card permissions follow ERC-7715 field shapes (`erc20-token-periodic`, expiry, signer). x402 for metered flows. No proprietary protocol where a standard exists.
5. **One honest price sheet, one honest doc site,** with an `llms.txt` (docs must be as readable by agents as by humans).

## 4. Architecture

Five components; each independently testable.

```
                    ┌──────────────────────────────────────────┐
                    │              Arc (testnet)               │
                    │  GatewayWalletBatched (Circle, live)     │
                    │  SubscriptionManager.sol  CardIssuer.sol │
                    └───────▲──────────────▲───────────▲───────┘
                            │              │           │
       settle (batch)       │       charge()           │ mint/freeze/policy
┌───────────────┐    ┌──────┴────────┐   ┌─┴───────────┴─┐
│  Payer SDK    │402 │ Merchant SDK  │   │ Keeper        │
│  human/agent  ├───►│ middleware    │   │ (cron)        │
└───────────────┘    └──────┬────────┘   └───────────────┘
                            │ events                ▲
                     ┌──────▼────────────────────── ┴──────┐
                     │ Indexer (getLogs polling) + Postgres │
                     │ → Webhooks → Dashboard (Next.js)     │
                     └──────────────────────────────────────┘
```

### 4.1 Contracts (Solidity, Foundry)

- **`SubscriptionManager.sol`** — plan registry (id, token, amount, period, trial, version), subscription objects (customer, card, plan, state), `charge(subId)` callable only inside the period window, grace-period bookkeeping, cancellation. Fee split to Scruple treasury happens inside `charge` (non-custodial percentage).
  - **Plan versioning is first-class:** plans are immutable rows; a "price change" creates a new version and migrates subscribers with proration at next renewal (Radom anti-lesson: their prices are frozen forever).
- **`CardIssuer.sol` + card policy** — a card is an on-chain record: `{owner, signer, token, periodAmount, periodDuration, allowlist (merchant addresses), expiry, state: Active|Frozen|Cancelled}`. Field names/semantics mirror ERC-7715 `erc20-token-periodic` so a future migration to native 7715 wallets is mechanical. `charge`-side contracts consult card policy; out-of-policy charges revert.
- **Metered settlement has no custom contract.** Settlement rides Circle's audited, live `GatewayWalletBatched`. Deliberate: minimize novel attack surface in a 4-week build.

### 4.2 Merchant SDK (TypeScript, npm)

- `scruple({ rateCard })` middleware for Express/Next (FastAPI port if time allows).
- **Verify/settle separation** (Nevermined's best pattern): on request, cheap off-chain `verify` (signature validity + card policy + balance); after the work completes, `settle` records actual consumption. Enables refuse-before-work and outcome-based pricing later.
- Settlement loop: accumulated EIP-3009 authorizations are batched through `@circle-fin/x402-batching` `GatewayClient` — thousands of sub-cent payments per on-chain transaction (the scaling problem Nevermined has not solved; our core advantage).

### 4.3 Payer SDK + Cards (TypeScript)

- **Human mode:** passkey smart account (`@circle-fin/modular-wallets-core`), one biometric approval per session; `scruple.fetch()` transparently answers 402 challenges within card policy.
- **Agent mode:** the card's `signer` is the agent's key (the ERC-7715 `signer` concept). The agent SDK runs the catch-402 → sign → retry loop under card policy: periodic budget, allowlist, per-tx cap, expiry. Out-of-budget requests are refused locally and (where the flow touches contracts) on-chain.
- Card metaphor in UX: card visual with Scruple logo (no Visa/Mastercard imitation), cosmetic number derived from the address, label, real expiry (= permission expiry), limit, `Arc · USDC` badge, status. **No CVV, no name** — signatures replace possession secrets; identity stays pseudonymous (optional ERC-8004 identity attachment for agents later).

### 4.4 Indexer + webhook service (Node, Postgres)

- Chunked `getLogs` polling (Arc testnet drops `eth_newFilter` subscriptions — known quirk, verified workaround).
- **Proactive allowance/balance monitoring:** before each renewal, check the customer's balance and remaining card budget; emit `subscription.at_risk` *before* the charge date (kills Radom's silent-churn failure mode).
- Webhook taxonomy (adapted from Radom's production set): `subscription.created`, `payment.succeeded`, `payment.attempt_failed`, `payment.overdue`, `subscription.at_risk`, `subscription.cancelled`, `subscription.expired`, `card.created`, `card.frozen`, `card.cancelled`, `settlement.batched`. Idempotency key on every event; HMAC signature header; retry schedule documented in exactly one place.

### 4.5 Dashboard (Next.js + Supabase auth)

- Merchant: rate cards, plans (with versioning UI), revenue stream, customers, API keys, webhook config.
- Payer: card gallery (the card visuals), per-card history, remaining budget, freeze/cancel.

## 5. Core flows

**Metered (pay-per-call):**
```
client request → 402 challenge (price, plan, nonce)
→ payer SDK checks card policy → EIP-3009 signature → retry with payment header
→ middleware verify (sig + policy + balance) → serve response
→ authorizations accumulate → GatewayClient batch-settles on Arc (fee split)
→ indexer sees settlement → dashboard + settlement.batched webhook
```

**Subscription:**
```
customer mints/uses a card → grants periodic permission to plan (one signature)
→ keeper calls SubscriptionManager.charge(subId) inside each period window
→ USDC moves customer → merchant (minus fee split) → payment.succeeded webhook
[failure] → grace period (default 3 days, merchant-configurable) → retries
→ payment.overdue → subscription.expired ; at-risk warnings fire before the date
[cancel] → customer freezes/cancels card or subscription → next charge reverts
```

**Card lifecycle:**
```
mint (policy: limit/period/allowlist/expiry, signer: passkey or agent key)
→ active use → [freeze] instant, reversible → [cancel] terminal
→ dashboard shows per-card spend vs budget in real time
```

## 6. Error handling

| Failure | Behavior |
|---|---|
| Insufficient balance at renewal | Predicted by at-risk monitor beforehand; charge fails → grace + retry + webhooks |
| Card budget exhausted mid-period | Verify refuses before work; agent SDK surfaces "budget exceeded" to its operator |
| Batch settlement tx fails | Authorizations are durable (nonce-tracked); retry with backoff; alert merchant if stale > threshold |
| Replayed/expired payment signature | Nonce registry + EIP-3009 validAfter/validBefore; verify rejects |
| RPC flakiness | Read path: retrying provider with fallback endpoint; indexer resumes from last processed block |
| 18-vs-6 decimal confusion (Arc native USDC vs ERC-20 interface) | Single money-math module, unit-tested; no raw arithmetic anywhere else |
| Keeper downtime | Charges are window-based, not instant-based: any actor can call `charge` inside the window (permissionless keeper fallback) |

## 7. Testing

- **Contracts:** Foundry unit + invariant tests (charge windows, versioning/proration math, card policy enforcement, fee split). Target: every state transition covered.
- **SDKs:** vitest; mocked 402 exchanges; golden tests for EIP-3009 payloads (6-decimal edge cases).
- **Integration:** end-to-end script on Arc testnet — mint card → agent pays metered → batch settles → subscribe → keeper charges → freeze card → charge reverts. This script doubles as the demo-video storyboard.
- **Monitoring quirk regression:** indexer test against `getLogs` chunking with simulated gaps.

## 8. Market context (July 2026)

- x402 is now a Linux Foundation standard effort (AWS, Circle, Coinbase, Google, Mastercard, Microsoft, Shopify, Stripe, Visa); 165M transactions / $50M volume by Apr 2026. Category validated.
- **Nevermined** (Base): agent metering, verify/settle, delegations. No batching (per-request on-chain settles), card-rail pilots capped at $10, concept-heavy. 1–2% take.
- **Radom** (multi-EVM): allowance+pull subscriptions in production, good webhook taxonomy, 3-day grace. Immutable prices, undocumented usage API, 0.5% + $0.50 fee, custody ambiguity, no ERP integrations. Loop Crypto (closest predecessor) shut down Feb 2026 — custody + general-crypto model failed; stablecoin-only non-custodial is the counter-position.
- **ERC-7715**: draft but shipping (MetaMask Advanced Permissions, Coinbase SpendPermissions, Safe, Biconomy). Nobody has productized it as "cards", and nobody is on Arc.
- **Arc showcase (182 projects):** no billing platform; 4 metered vertical apps (VPN, video, proxy, agent labor) are ideal first customers.

## 9. Privacy posture

- Metered flows are batch-settled: individual calls never hit the chain — only netted totals. Real, marketable property today.
- Subscriptions are public on-chain today (amounts + parties). Mitigation: only addresses/IDs on-chain, labels off-chain.
- Arc's opt-in privacy (confidential transfers + view keys) is roadmap, not live. Scruple schema is designed not to block it; "confidential but auditable subscriptions/payroll" is the v2 story when Arc ships it.

## 10. Delivery plan (hackathon frame)

Encode × Arc "Programmable Money Hackathon", both tracks (DeFi + Agentic Economy). Prize: top ~8 teams enter Arc's 8-week accelerator.

- **CP1 (due Jul 19, AoE):** project registration + idea text (text ready; registration is a manual step on Encode's platform).
- **Week of Jul 20 → CP2 (Jul 26):** repo public; contracts skeleton (SubscriptionManager + CardIssuer) with Foundry tests; merchant middleware verify path; progress summary.
- **Week of Jul 27:** payer SDK (agent mode first), batch settlement loop, indexer + webhooks, keeper.
- **Week of Aug 3 → Final (Aug 9):** dashboard + card visuals, human passkey mode, end-to-end demo script, deploy on Arc testnet, 3-min video + deck.
- **Demo Day: Aug 20.**

Demo storyline (one continuous scene, covers both tracks): merchant defines a rate card → customer mints an agent card ($2/day, 3-API allowlist) → agent autonomously pays per-call → dashboard revenue ticks up → batch settles on-chain → same customer subscribes to a $29/mo plan with one signature → keeper charges → customer freezes the card → next charge declines (card visual turns red).

## 11. Post-hackathon path (real-product commitments)

1. Testnet MVP = product v0.1 (same codebase, no throwaway).
2. Metered module can go to existing mainnets (Gateway is live on 11 chains incl. Base) for first revenue before Arc mainnet.
3. Arc mainnet launch: positioned as the billing layer present on day one (accelerator = the bridge to Circle's ecosystem team).
4. Known risks: Arc mainnet timing (external), subscription UX adoption (smart-account dependence), Stripe/Tempo long-term shadow, ERC-7715 finalization drift (mitigated by field-shape alignment).
