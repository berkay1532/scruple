# Scruple — 3-Minute Video Storyboard

Target: exactly 3:00. One continuous product story, both hackathon tracks in
one arc. Screen-record at 1512×945+ (hide bookmarks bar, dark theme,
`localhost` visible is fine — judges like real). Voiceover lines are cues,
not a script to read robotically.

| # | Time | Screen | Voiceover cue |
|---|---|---|---|
| 1 | 0:00–0:15 | Title card (deck slide 1: ⚖ Scruple, tagline) | "AI APIs earn per request but can't bill per request — card rails make sub-cent charges impossible, and AI agents don't have credit cards at all. Scruple is Stripe-grade billing for the USDC economy, live on Arc." |
| 2 | 0:15–0:35 | Dashboard Overview (merchant, populated) | "This is a merchant on Arc testnet. Real revenue from real on-chain charges — an exact 1% fee split, enforced by the contract. The needs-attention queue flags subscribers who *will* fail renewal — before it happens, not after." |
| 3 | 0:35–0:55 | Plans → create plan live | "Pricing is immutable on-chain: a price change is a new version, and subscribers only migrate at renewal. No mid-period surprises — that promise is in the contract, not the terms of service." |
| 4 | 0:55–1:25 | Cards view → mint card (limit, allowlist, signer=agent) | "Now the payer side. Instead of 'unlimited approval, trust me,' you mint a card: $2 a day, only these three merchants, this expiry — and hand the signer key to an AI agent. A corporate card for software." |
| 5 | 1:25–1:50 | Terminal: agent.ts firing x402 calls; seller log streaming | "The agent pays per call — tenths of a cent, gasless, batched by Circle Gateway. Watch the budget guard: at two dollars, it refuses. The box wins, not the agent's good intentions." |
| 6 | 1:50–2:15 | Back to dashboard: settlement.batched in feed + subscribe→keeper charge lands, revenue ticks | "Both rails meet in one event stream: metered settlements and subscription charges, webhooks with signed payloads and an at-risk monitor watching every renewal. The money went wallet-to-wallet — Scruple never held a cent." |
| 7 | 2:15–2:35 | Card drawer → freeze → card greys, FROZEN stamp | "Something feels off? Freeze. Every future charge declines instantly — reversible, no funds ever parked on the card." |
| 8 | 2:35–3:00 | Closing slide: architecture strip (contracts+SDKs+service+dashboard), test counts, addresses, repo link | "Two audited-pattern contracts on Arc, two SDKs, an indexer-webhook backbone, and this dashboard — ~300 tests, all open source. Stripe taught websites to take cards. Scruple teaches apps and agents to charge USDC — measured exactly. We're Scruple." |

Production notes:
- Record scenes 5–6 immediately after storyline B in the runbook so the feed
  is fresh.
- Cursor discipline: move deliberately, hover before clicking.
- If a live tx confirms slower than the cut, hold on the toast — never refresh
  on camera.
- Capture 10s of spare footage per scene for edit slack.
