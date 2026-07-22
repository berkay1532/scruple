# Scruple — Demo Runbook

Battle-tested operating procedure for the final-submission video and Demo Day.
Every rule below was earned during live testing (2026-07-21/22); don't skip the
pre-flight.

## 0. Golden rules (learned the hard way)

1. **RPC assignment (updated after the rate-limit findings):** server-side
   proxies (`ARC_RPC_URL` for dashboard + acme, `RPC_URL` for the service) use
   the **authenticated canteen RPC** (`arc-canteen rpc-url` — no rate limits,
   batch-capable; token never reaches a browser). **MetaMask stays on the
   public RPC** (`https://rpc.testnet.arc.network`). The public RPC rate-limits
   PER BATCH ELEMENT, so it cannot back a busy proxy. CAVEAT: the canteen node
   once lagged ~93k blocks and later went down entirely — hence rule 2 is
   mandatory, and if it drifts, fall back to the public RPC and accept slower
   loads (the proxy's queue/backoff absorbs it).
2. **Pre-flight sync check** — two independent RPCs must agree on head:
   ```bash
   cast block-number --rpc-url https://rpc.testnet.arc.network
   # compare against a second provider if available; drift > ~50 blocks = do not demo
   ```
3. **MetaMask hygiene before recording:** Arc Testnet RPC = public URL; the
   deployer account (`0x2526…d931`) selected; Activity tab has no pending txs
   (Settings → Advanced → Clear activity tab data if unsure); no other wallet
   extension enabled (Phantom hijacks `window.ethereum` and impersonates
   MetaMask — disable it or set it to "always ask").
4. **Dollar inputs are dollars.** The plan/card forms take USD ("2" = $2.00,
   "0.02" = two cents). Sanity-check amounts before confirming.
5. Rate-limit resilience (proxy queue + backoff + last-good retention) is
   built in — a slow tile for ~15s is normal warm-up, not a failure. Don't
   panic-refresh on camera.

## 1. Environment boot (T-30 min)

```bash
cd ~/Documents/beko/Arc/scruple
PUB=https://rpc.testnet.arc.network

# Terminal 1 — service (indexer + webhooks + at-risk + keeper + ingest)
RPC_URL=$PUB \
CARD_ISSUER_ADDRESS=0xE20EB808cF87B73D716C96CBbb1eee62282506d0 \
SUBSCRIPTION_MANAGER_ADDRESS=0x3d0b19b6B06E568A23AA916270008012Dca55795 \
START_BLOCK=52790400 DB_PATH=$HOME/scruple-demo.db \
INGEST_PORT=8787 INGEST_SECRET=demo-secret \
KEEPER_PRIVATE_KEY=$(sed -n "s/^private_key: *//p" ~/.arc-canteen/wallet.yaml | tr -d "'\"") \
npx tsx packages/service/bin/service.ts

# Terminal 2 — dashboard
SERVICE_URL=http://localhost:8787 SERVICE_EVENTS_SECRET=demo-secret \
ARC_RPC_URL=$PUB npm run dev -w scruple-dashboard

# Terminal 3 — metered demo pair (see §3)
```

Checklist after boot:
- [ ] Service log shows `ingest+events API on :8787` and an `indexed=` line
- [ ] `curl -s -H "authorization: Bearer demo-secret" localhost:8787/events | head -c 100` returns JSON
- [ ] Dashboard `localhost:3000` → connect wallet → topbar shows `0x2526…d931`, no "Wrong network" pill
- [ ] Overview shows non-zero revenue and the plans table is populated

## 2. Demo storyline A — subscriptions (the on-chain rail)

Scene beats (see `video-storyboard.md` for timings):

1. **Merchant hat:** Overview (revenue chart, needs-attention, live feed) →
   Plans (create one live: `$5 / 30 days / 0 trial`; it lands in ~15s with a
   `plan.created` feed row).
2. **Payer hat:** Cards → Mint card (`$10 / month`, no expiry, allowlist =
   merchant address, signer = self) → card visual appears.
3. **Subscribe (terminal, cast — no UI flow by design):**
   ```bash
   RPC=https://rpc.testnet.arc.network
   PK=$(sed -n "s/^private_key: *//p" ~/.arc-canteen/wallet.yaml | tr -d "'\"")
   SM=0x3d0b19b6B06E568A23AA916270008012Dca55795
   cast send 0x3600000000000000000000000000000000000000 "approve(address,uint256)" $SM 100000000 --private-key $PK --rpc-url $RPC
   cast send $SM "subscribe(uint256,uint256)" <planId> <cardId> --private-key $PK --rpc-url $RPC
   ```
4. **The money moment:** keeper picks up the due charge on its next tick (≤5s)
   → `payment.succeeded` hits the live feed → revenue ticks up → Payments row
   shows amount + exact 1% fee + ArcScan link.
5. **The control moment:** freeze the card → attempt/point out that the next
   charge would decline (card greys out with FROZEN stamp instantly) → unfreeze.

## 3. Demo storyline B — metered / agent (the x402 rail)

Live-proven procedure (2026-07-22 run: 20/20 payments succeeded). Three
hard-won rules first:

- **Buyer wallet MUST differ from the seller address** — Gateway rejects
  settlements where payer == payee (`self_transfer`). Demo buyer:
  `0x75dca3CA1CEbb69cA7381C200491C4b03131C3d4` (key in
  `~/.scruple-demo-buyer.key`, funded from the deployer).
- **Authorization validity ≥ 7 days** — the middleware ships
  `maxTimeoutSeconds: 691200` (8 days); shorter windows get
  `authorization_validity_too_short`. Don't lower it.
- **Gateway deposits credit with a delay** (seconds to ~1 min). If the first
  payment after a fresh deposit fails, wait and rerun — check
  `POST gateway-api-testnet.circle.com/v1/balances` for the credited amount.

```bash
# Terminal 3a — RPC shim (smooths public-RPC rate limits for the SDK)
npx tsx examples/rpc-shim.ts

# Terminal 3b — seller API (dashboard must be stopped: both want :3000; the
# storyline B screen capture is terminal + dashboard-feed anyway)
SELLER_ADDRESS=0x2526a4Ebc2FFa3caE58F0861FfD78027fc86d931 npx tsx examples/seller.ts

# Terminal 3c — agent (auto-deposits $1 into Gateway on first run)
BUYER_PRIVATE_KEY=$(cat ~/.scruple-demo-buyer.key) BASE_URL=http://localhost:3000 \
RPC_URL=http://localhost:8547 npx tsx examples/agent.ts
```

Beats: agent fires requests → per-call $0.001 payments stream in the seller
log → stop at the spending-policy line ("Stopped by spending policy") to show
the budget guard → merchant side: `settlement.batched` rows appear in the
dashboard feed via the ingest forwarder.

Honest-architecture talking point (if asked): pool cap is hard on-chain,
per-day/merchant granularity is SDK-enforced + on-chain-declared today;
subscriptions rail is fully contract-enforced; ERC-7715 alignment makes the
hard-enforcement upgrade mechanical.

## 4. Contingencies

| Symptom | Fix |
|---|---|
| Tx stuck "pending" in MetaMask | Wrong/stale RPC in wallet → set public RPC, Clear activity tab data, retry |
| "nonce too low" | A node saw txs another didn't → check §0.2 sync; worst case send replacement tx with bumped gas from terminal |
| Tables empty but feed alive | Chain-read path issue → check `/api/rpc` with a curl `eth_blockNumber`; restart dashboard |
| `plan.created` visible, table lagging | Normal ≤15s (indexer 5s + events poll 5s + read refetch 15s) — narrate, don't refresh |
| Everything on fire | `~/scruple-demo.db` is disposable: delete it, restart service (re-indexes from START_BLOCK in seconds) |

## 5. Known cosmetic facts (don't let them surprise you on camera)

- Plans #1/#2 are an accidental duplicate pair ($35/29d) from the stuck-tx
  saga — either narrate as "price experiments" or create a fresh plan and
  ignore them. No archive function by design (immutable pricing); backlog.
- Metered rate-card table fills only after storyline B has run at least once.
- Webhooks screen is informational until the delivery inspector ships
  (final-submission goal).
