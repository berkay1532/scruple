# Scruple examples

Requires two funded Arc testnet wallets (https://faucet.circle.com/).

    # terminal 1 — merchant
    SELLER_ADDRESS=0x… npx tsx examples/seller.ts

    # terminal 2 — agent with a $2/day policy
    BUYER_PRIVATE_KEY=0x… npx tsx examples/agent.ts

The agent auto-deposits 1 USDC into Circle Gateway on first run (onchain tx),
then pays per-call via gasless EIP-3009 authorizations that Gateway batch-settles.
Note: payer must be an EOA (Gateway verifies via ecrecover; smart accounts unsupported).
