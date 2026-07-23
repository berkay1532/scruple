import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ScrupleClient, PolicyTracker, PolicyExceededError } from "@scruple/client";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

const privateKey = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) throw new Error("BUYER_PRIVATE_KEY env var required");
const base = process.env.BASE_URL ?? "http://localhost:3000";

// RPC_URL lets the agent route chain calls through a custom endpoint —
// e.g. examples/rpc-shim.ts, which smooths public-RPC rate limits.
const RPC_URL = process.env.RPC_URL ?? "https://rpc.testnet.arc.network";
const gateway = new GatewayClient({ chain: "arcTestnet", privateKey, rpcUrl: process.env.RPC_URL });

// --- card-bound mode ---------------------------------------------------
// Resolved (and fails fast on) before the Gateway funding step below, since
// this is a startup precondition check, not something worth an onchain
// deposit tx first.
// CardIssuer ABI fragment — struct/order copied verbatim from
// contracts/src/CardIssuer.sol (kept in sync there and in
// packages/checkout/src/config.ts / packages/service/bin/service.ts).
const CARD_ISSUER_ABI = parseAbi([
  "struct Card { address owner; address signer; address token; uint256 periodAmount; uint48 periodDuration; uint48 expiry; uint8 state; uint48 periodStart; uint256 spentInPeriod; bool useAllowlist; }",
  "function getCard(uint256 cardId) view returns (Card memory)",
  "function previewSpend(uint256 cardId, address merchant, uint256 amount) view returns (bool)",
]);
const CARD_STATE_ACTIVE = 0;

const cardIdRaw = process.env.CARD_ID;

// `previewGate` is undefined unless CARD_ID is set — the loop below skips
// the chain check entirely in that case, so default behavior is unchanged.
let previewGate: (() => Promise<boolean>) | undefined;
let policy: PolicyTracker;

if (cardIdRaw !== undefined) {
  const cardId = BigInt(cardIdRaw);
  const cardIssuerAddress = (process.env.CARD_ISSUER_ADDRESS ??
    "0xE20EB808cF87B73D716C96CBbb1eee62282506d0") as `0x${string}`;
  const merchantAddress = (process.env.MERCHANT_ADDRESS ??
    "0x2526a4Ebc2FFa3caE58F0861FfD78027fc86d931") as `0x${string}`;

  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });

  const card = await publicClient.readContract({
    address: cardIssuerAddress,
    abi: CARD_ISSUER_ABI,
    functionName: "getCard",
    args: [cardId],
  });

  // A never-minted cardId zero-initializes every field, including `owner`.
  // Check that before state — a zero-initialized state also happens to equal
  // CardState.Active (0), so state alone can't distinguish "not minted" from
  // "active".
  if (BigInt(card.owner) === 0n) {
    throw new Error(`card-bound: card #${cardId} not found on CardIssuer ${cardIssuerAddress}`);
  }
  if (card.state !== CARD_STATE_ACTIVE) {
    throw new Error(`card-bound: card #${cardId} is not Active (state=${card.state})`);
  }

  const agentAddress = privateKeyToAccount(privateKey).address;
  if (card.signer.toLowerCase() !== agentAddress.toLowerCase()) {
    throw new Error(
      `card-bound: card #${cardId} signer (${card.signer}) does not match agent address (${agentAddress}) — refusing to run`,
    );
  }

  // Policy derived FROM the card, not hard-coded.
  const periodBudget = card.periodAmount;
  const periodMs = Number(card.periodDuration) * 1000;
  const perTxCap = periodBudget < 50_000n ? periodBudget : 50_000n;

  policy = new PolicyTracker({
    periodBudget,
    periodMs,
    perTxCap,
    allowedOrigins: [new URL(base).origin],
  });

  console.log(
    `card-bound: card #${cardId}, limit $${Number(periodBudget) / 1_000_000} per ${Number(card.periodDuration)}s, signer verified`,
  );

  // Chain-declared advisory gate: previewSpend reflects the CardIssuer
  // contract's own view of whether it would still authorize a charge of
  // this size to this merchant right now. It is NOT the enforcement path
  // for metered spend today — Gateway settlements are plain EOA transfers
  // that don't route through the card contract until 7715/4337 session keys
  // land — so this is a read-only, advisory check layered on top of the
  // local PolicyTracker above (which is the hard budget, itself derived
  // from this same on-chain card).
  previewGate = () =>
    publicClient.readContract({
      address: cardIssuerAddress,
      abi: CARD_ISSUER_ABI,
      functionName: "previewSpend",
      args: [cardId, merchantAddress, perTxCap],
    });
} else {
  policy = new PolicyTracker({
    periodBudget: 2_000_000n,        // $2/day
    periodMs: 86_400_000,
    perTxCap: 50_000n,               // $0.05 per call
    allowedOrigins: [new URL(base).origin],
  });
}

// One-time: make sure the Gateway balance is funded (deposit is an onchain tx).
const balances = await gateway.getBalances();
if (balances.gateway.available < 500_000n) {
  console.log("Depositing 1 USDC into Gateway…");
  const { depositTxHash } = await gateway.deposit("1");
  console.log(`Deposited: ${depositTxHash}`);
}

const client = new ScrupleClient({ gateway, policy });

for (let i = 0; i < 20; i++) {
  if (previewGate && !(await previewGate())) {
    console.log("card policy declines further spend — stopping");
    break;
  }
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
