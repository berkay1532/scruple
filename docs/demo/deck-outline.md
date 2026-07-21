# Scruple — Deck Outline (10 slides)

Visual language: the dashboard's own identity — ink ground (#0C0F14), brass
accent (#C9A96A), serif display for headlines, mono for numbers. Sparse
slides; the demo video carries the product, the deck carries the argument.

1. **Title** — ⚖ Scruple · "Stripe-grade billing for the USDC economy." ·
   built on Arc · team + repo QR.
2. **Problem** — Three lines: (a) AI APIs earn per-request, can't bill
   per-request (2.9% + $0.30 kills sub-cent); (b) agents have no payment
   instrument with limits; (c) crypto has no pull payments — and its approval
   UX is "unlimited, trust me."
3. **Product** — One platform, two faces: **Billing** (rate cards → 402 →
   batched settlement; plans → contract-enforced recurring charges) and
   **Cards** (scoped, limited, freezable spend permissions — for humans AND
   agents). Screenshot strip: Overview + card gallery.
4. **Why Arc / why now** — USDC-native gas ≈ $0.01 stable; sub-second
   irreversible finality; Gateway batching makes $0.0003 payments economical;
   EURC/StableFX adjacency. This product is not viable on card rails and not
   pleasant on any other chain.
5. **Live on testnet** — addresses (CardIssuer, SubscriptionManager) +
   first-charge tx hash with exact 1% split; screenshot of ArcScan. "Not a
   mock: every number in the demo is a chain read."
6. **Architecture** — contracts (immutable versioned plans, card policy,
   permissionless charge) · SDKs (server 402 middleware, client policy-gated
   payer) · service (indexer, HMAC webhooks w/ retry schedule, at-risk
   monitor, keeper, ingest) · dashboard. Non-custodial end-to-end — fee is an
   on-chain split at settlement.
7. **Honest enforcement model** (differentiator slide, judges love rigor) —
   layered: pool cap = hard on-chain · subscriptions rail = fully
   contract-enforced · metered granularity = SDK-enforced + on-chain-declared
   (merchant-verifiable via previewSpend) · ERC-7715-aligned schema makes the
   full-hard upgrade mechanical when smart-account signatures land.
8. **Market** — x402 now a Linux Foundation standard (AWS/Google/Visa/
   Stripe/Circle…), 165M tx by Apr '26. Nevermined = agent metering on Base;
   Radom = human subscriptions; **Scruple unifies both, non-custodial, where
   neither exists: Arc.** 182-project Arc showcase: zero billing platforms.
9. **Traction & roadmap** — Built in 4 weeks: 28 Foundry + ~170 vitest tests,
   7 live-testing hardening fixes, deployed + first real charges. Next:
   webhook delivery inspector → mainnet-day-one launch with Arc → 7715
   hard-enforcement → (accelerator) first design partners = the metered
   verticals already building on Arc.
10. **Close** — "Stripe taught websites to take cards. Scruple teaches apps
    and agents to charge USDC — measured exactly." · repo · contact.
