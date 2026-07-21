import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ScrupleClient, PolicyTracker, PolicyExceededError } from "@scruple/client";

const privateKey = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) throw new Error("BUYER_PRIVATE_KEY env var required");
const base = process.env.BASE_URL ?? "http://localhost:3000";

// RPC_URL lets the agent route chain calls through a custom endpoint —
// e.g. examples/rpc-shim.ts, which smooths public-RPC rate limits.
const gateway = new GatewayClient({ chain: "arcTestnet", privateKey, rpcUrl: process.env.RPC_URL });

// One-time: make sure the Gateway balance is funded (deposit is an onchain tx).
const balances = await gateway.getBalances();
if (balances.gateway.available < 500_000n) {
  console.log("Depositing 1 USDC into Gateway…");
  const { depositTxHash } = await gateway.deposit("1");
  console.log(`Deposited: ${depositTxHash}`);
}

const client = new ScrupleClient({
  gateway,
  policy: new PolicyTracker({
    periodBudget: 2_000_000n,        // $2/day
    periodMs: 86_400_000,
    perTxCap: 50_000n,               // $0.05 per call
    allowedOrigins: [new URL(base).origin],
  }),
});

for (let i = 0; i < 20; i++) {
  try {
    const res = await client.fetch(`${base}/api/quote`);
    console.log(`#${i + 1}`, res.data, res.paid ? `(paid ${res.paid.atomic} atomic)` : "(free)");
  } catch (err) {
    if (err instanceof PolicyExceededError) {
      console.log(`Stopped by spending policy: ${err.reason}`);
      break;
    }
    throw err;
  }
}
