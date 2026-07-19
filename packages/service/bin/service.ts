import { createPublicClient, createWalletClient, erc20Abi, getContract, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { Store } from "../src/db";
import { Indexer, type ChainReader } from "../src/indexer";
import { Dispatcher } from "../src/webhooks";
import { AtRiskMonitor, type SubReader } from "../src/atrisk";
import { Keeper } from "../src/keeper";
import type { RawLog } from "../src/events";

const RPC_URL = process.env.RPC_URL ?? "https://rpc.testnet.arc.network";
const CARD_ISSUER = required("CARD_ISSUER_ADDRESS");
const SUBSCRIPTION_MANAGER = required("SUBSCRIPTION_MANAGER_ADDRESS");
const USDC = "0x3600000000000000000000000000000000000000";
const DB_PATH = process.env.DB_PATH ?? "scruple-service.db";
const pollRaw = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const POLL_INTERVAL_MS = Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : 5000;

function required(name: string): `0x${string}` {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  return v as `0x${string}`;
}

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });

const SUBS_READ_ABI = parseAbi([
  "struct Subscription { address customer; uint256 planId; uint16 planVersion; uint256 cardId; uint48 nextChargeAt; uint8 state; }",
  "struct Plan { address merchant; address token; uint16 latestVersion; bool active; }",
  "struct PlanVersion { uint256 amount; uint48 period; uint48 trialPeriod; }",
  "function getSubscription(uint256 subId) view returns (Subscription memory)",
  "function getPlan(uint256 planId) view returns (Plan memory)",
  "function getPlanVersion(uint256 planId, uint16 version) view returns (PlanVersion memory)",
  "function charge(uint256 subId)",
]);
const ISSUER_READ_ABI = parseAbi([
  "function previewSpend(uint256 cardId, address merchant, uint256 amount) view returns (bool)",
]);

const subsContract = getContract({ address: SUBSCRIPTION_MANAGER, abi: SUBS_READ_ABI, client: publicClient });
const issuerContract = getContract({ address: CARD_ISSUER, abi: ISSUER_READ_ABI, client: publicClient });

const chainReader: ChainReader = {
  getBlockNumber: () => publicClient.getBlockNumber(),
  getLogs: async ({ addresses, fromBlock, toBlock }) => {
    const logs = await publicClient.getLogs({ address: addresses as `0x${string}`[], fromBlock, toBlock });
    return logs.map((l): RawLog => ({
      address: l.address,
      topics: [...l.topics],
      data: l.data,
      blockNumber: l.blockNumber,
      transactionHash: l.transactionHash,
      logIndex: l.logIndex,
    }));
  },
};

const subReader: SubReader = {
  async getUpcomingCharge(subId) {
    const s = await subsContract.read.getSubscription([BigInt(subId)]);
    const plan = await subsContract.read.getPlan([s.planId]);
    const v = await subsContract.read.getPlanVersion([s.planId, plan.latestVersion]);
    return {
      active: s.state === 0 && s.customer !== "0x0000000000000000000000000000000000000000",
      nextChargeAt: Number(s.nextChargeAt),
      amount: v.amount,
      merchant: plan.merchant,
      customer: s.customer,
      cardId: s.cardId.toString(),
    };
  },
  balanceOf: async (address) =>
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] }),
  previewSpend: (cardId, merchant, amount) =>
    issuerContract.read.previewSpend([BigInt(cardId), merchant as `0x${string}`, amount]),
};

const store = new Store(DB_PATH);
if (process.env.WEBHOOK_URL && process.env.WEBHOOK_SECRET && store.listEndpoints().length === 0) {
  store.addEndpoint(process.env.WEBHOOK_URL, process.env.WEBHOOK_SECRET);
}

const indexer = new Indexer({ store, reader: chainReader, cardIssuer: CARD_ISSUER, subscriptionManager: SUBSCRIPTION_MANAGER });
const dispatcher = new Dispatcher({ store });
const monitor = new AtRiskMonitor({ store, reader: subReader });

let keeper: Keeper | null = null;
if (process.env.KEEPER_PRIVATE_KEY) {
  const account = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(RPC_URL) });
  keeper = new Keeper({
    store,
    reader: subReader,
    sender: {
      charge: async (subId) => ({
        txHash: await walletClient.writeContract({
          address: SUBSCRIPTION_MANAGER, abi: SUBS_READ_ABI, functionName: "charge", args: [BigInt(subId)],
        }),
      }),
    },
  });
}

async function tick() {
  try {
    const idx = await indexer.runOnce();
    const hooks = await dispatcher.dispatchDue();
    const risks = await monitor.runOnce();
    const kept = keeper ? await keeper.runOnce() : { charged: [], failed: [] };
    if (idx.processed || hooks.delivered || hooks.failed || risks || kept.charged.length || kept.failed.length) {
      console.log(`[scruple-service] indexed=${idx.processed} delivered=${hooks.delivered} hookFails=${hooks.failed} atRisk=${risks} charged=${kept.charged.length} chargeFails=${kept.failed.length}`);
      for (const f of kept.failed) console.error(`[scruple-service] charge(${f.subId}) failed: ${f.error}`);
    }
  } catch (err) {
    console.error("[scruple-service] tick failed:", err);
  }
}

console.log(`[scruple-service] starting — rpc=${RPC_URL} db=${DB_PATH} keeper=${keeper ? "on" : "off"}`);
const loop = async () => {
  await tick();
  setTimeout(loop, POLL_INTERVAL_MS);
};
await loop();
