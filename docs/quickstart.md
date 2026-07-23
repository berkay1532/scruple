# Scruple in 5 minutes

You run a SaaS. At the end of this page you'll have: a live USDC subscription
plan on Arc testnet, a checkout panel on your own pricing page, and signed
webhook events (`payment.succeeded`, `subscription.at_risk`, `nudge.requested`)
hitting your backend.

Prereqs: Node 20+, this repo cloned with `npm install` done, a wallet on Arc
testnet with some testnet USDC. [Foundry](https://getfoundry.sh) (`cast`) only
if you take the CLI path in step 2.

## 1. Contracts — already deployed, nothing to do

Scruple's contracts are live on Arc testnet (chain id **5042002**, RPC
`https://rpc.testnet.arc.network`):

| Contract | Address |
|---|---|
| `SubscriptionManager` (plans, subscriptions, `charge`) | [`0x3d0b19b6B06E568A23AA916270008012Dca55795`](https://testnet.arcscan.app/address/0x3d0b19b6B06E568A23AA916270008012Dca55795) |
| `CardIssuer` (payer spending-policy cards) | [`0xE20EB808cF87B73D716C96CBbb1eee62282506d0`](https://testnet.arcscan.app/address/0xE20EB808cF87B73D716C96CBbb1eee62282506d0) |
| USDC (Arc native) | `0x3600000000000000000000000000000000000000` |

Every tool below defaults to these addresses. You deploy nothing.

## 2. Create a plan

The dashboard is the easiest place — and you'll want it running anyway. Two
terminals from the repo root (full env reference in step 4):

```bash
# terminal 1 — the service (indexer + webhooks + admin API) on :8787
CARD_ISSUER_ADDRESS=0xE20EB808cF87B73D716C96CBbb1eee62282506d0 \
SUBSCRIPTION_MANAGER_ADDRESS=0x3d0b19b6B06E568A23AA916270008012Dca55795 \
START_BLOCK=<recent block number> \
INGEST_PORT=8787 INGEST_SECRET=dev-secret \
npx tsx packages/service/bin/service.ts

# terminal 2 — the dashboard on :3000
SERVICE_URL=http://localhost:8787 SERVICE_EVENTS_SECRET=dev-secret \
npm run dev -w scruple-dashboard
```

(`START_BLOCK` = any recent Arc block from [arcscan](https://testnet.arcscan.app);
without it a fresh DB scans the chain from genesis.)

Open http://localhost:3000, connect your wallet, go to **Rate cards & plans →
Create plan**. Set a price (e.g. `29.00`), a billing period in days (default 30;
must be longer than the 3-day grace period), trial optional. Confirm in your
wallet — the plan appears once the transaction confirms, with its **plan id**.

Prefer the CLI? Same thing in one `cast` command ($29.00 / 30 days, no trial —
amounts are 6-decimal USDC units):

```bash
export PRIVATE_KEY=<your funded Arc-testnet key>
cast send 0x3d0b19b6B06E568A23AA916270008012Dca55795 \
  "createPlan(address,uint256,uint48,uint48)" \
  0x3600000000000000000000000000000000000000 29000000 2592000 0 \
  --rpc-url https://rpc.testnet.arc.network --private-key $PRIVATE_KEY
```

## 3. Put checkout on your pricing page

`@scruple/checkout` is a drop-in React panel — no redirect, no iframe. It lives
in this monorepo (`packages/checkout`); depend on it as a workspace package the
way `apps/acme` does (`"@scruple/checkout": "*"`). Peer dependencies your app
brings: `react` (>=19), `wagmi` (>=3), `viem` (>=2), `@tanstack/react-query`
(>=5) — and a `WagmiProvider` + `QueryClientProvider` mounted above the panel.

```tsx
import { ScrupleCheckout } from "@scruple/checkout";

<ScrupleCheckout
  planId={0n}                                    // bigint — your plan id from step 2
  onSuccess={({ subId }) => activatePro(subId)}  // subId: bigint — the new subscription
  onError={(message) => console.error(message)}  // optional
/>
```

It defaults to the deployed Arc testnet addresses from step 1 (pass `addresses`
to override). The panel handles the whole flow itself: connect, pick or mint a
spending-policy card, approve USDC, subscribe — funds move wallet-to-wallet,
never through you or us.

Living proof: `apps/acme` is a fictional pricing page with the embed live on its
Pro tier.

```bash
NEXT_PUBLIC_ACME_PLAN_ID=0 npm run dev -w acme-demo   # → http://localhost:3002
```

## 4. Run the service and add a webhook endpoint

The service you started in step 2 is the off-chain backbone: it indexes chain
events, dispatches signed webhooks, warns about at-risk renewals, and (with a
keeper key) collects due charges. Full env reference:

| Env var | Required | Purpose |
|---|---|---|
| `CARD_ISSUER_ADDRESS` | yes | Deployed `CardIssuer` (step 1). |
| `SUBSCRIPTION_MANAGER_ADDRESS` | yes | Deployed `SubscriptionManager` (step 1). |
| `RPC_URL` | no | Arc RPC endpoint. Default `https://rpc.testnet.arc.network`. |
| `START_BLOCK` | no | First block to index. Set it to a recent block on a fresh DB. |
| `DB_PATH` | no | SQLite file. Default `scruple-service.db`. |
| `INGEST_PORT` | to enable HTTP | Port for `GET /events` and the `/admin/*` API the dashboard uses. |
| `INGEST_SECRET` | with `INGEST_PORT` | Bearer secret for `/events` (the dashboard's `SERVICE_EVENTS_SECRET`). |
| `ADMIN_SECRET` | no | Separate bearer secret for `/admin/*` (endpoint CRUD, nudge). Falls back to `INGEST_SECRET`. |
| `KEEPER_PRIVATE_KEY` | no | Enables the keeper, which calls the permissionless `charge()` for due subscriptions. |

Now register where events should go: dashboard → **Webhooks → Add endpoint**,
enter your handler's URL (e.g. `https://your.app/scruple/webhooks`). You get
back a signing secret (`whsec_…`) — **shown once, copy it now**. It's never
displayed again; rotating the endpoint issues a new one.

## 5. Handle events — verify the signature, then act

Every delivery is a `POST` with body `{ id, type, at, data }` and two headers:
`scruple-event-id` (idempotency key) and `scruple-signature`, which is
`sha256=<hex HMAC-SHA256 of the raw body>` keyed with your `whsec_` secret.
Verify with a timing-safe compare before trusting anything. Complete Express
handler (the `examples/` directory uses Express too):

```js
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.SCRUPLE_WEBHOOK_SECRET; // the whsec_… from step 4

const app = express();
app.post("/scruple/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  const expected = Buffer.from(`sha256=${createHmac("sha256", SECRET).update(req.body).digest("hex")}`);
  const received = Buffer.from(String(req.headers["scruple-signature"] ?? ""));
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return res.status(401).end();
  }
  const event = JSON.parse(req.body.toString("utf8")); // { id, type, at, data }
  switch (event.type) {
    case "payment.succeeded":    // renewal collected — data: { subId, version, amount, fee }
      break;
    case "subscription.at_risk": // next charge will fail — data: { subId, reason, nextChargeAt, amount }
      break;
    case "nudge.requested":      // send your dunning email — data: { subId, nextChargeAt }
      break;
  }
  res.status(200).end(); // non-2xx (or a hang) retries at 1m/5m/30m/2h/12h, then dead-letters
});
app.listen(9099);
```

About `nudge.requested`: when a renewal is about to fail, the subscription shows
up in the dashboard's needs-attention list. Clicking **Nudge →** there emits one
`nudge.requested` event to your endpoint — at most once per billing period, no
matter how many times anyone clicks. Your handler owns what happens next:
typically a dunning email ("your renewal of `data.amount` USDC will fail — top
up or update your card") to the customer behind `data.subId`. Scruple never
touches your customer comms; it just tells you exactly when to send them.

That's it. Plan on-chain, checkout on your page, events in your backend —
non-custodial end to end. Deeper dives: [README](../README.md) for architecture,
`apps/acme` for a full integration, `docs/superpowers/specs/` for the design doc.
