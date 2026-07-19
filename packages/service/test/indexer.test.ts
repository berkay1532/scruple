import { describe, it, expect } from "vitest";
import { encodeEventLog } from "./helpers";
import { Store } from "../src/db";
import { SUBSCRIPTION_MANAGER_ABI, type RawLog } from "../src/events";
import { Indexer, type ChainReader } from "../src/indexer";

const ISSUER = "0x1111111111111111111111111111111111111111";
const SUBS = "0x2222222222222222222222222222222222222222";

function subCreatedLog(subId: bigint, block: bigint, idx: number): RawLog {
  const enc = encodeEventLog({
    abi: SUBSCRIPTION_MANAGER_ABI,
    eventName: "SubscriptionCreated",
    args: { subId, planId: 1n, customer: "0x00000000000000000000000000000000000000aa", cardId: 5n },
  });
  return { address: SUBS, topics: [...enc.topics], data: enc.data, blockNumber: block, transactionHash: `0xt${subId}`, logIndex: idx };
}

function expiredLog(subId: bigint, block: bigint): RawLog {
  const enc = encodeEventLog({ abi: SUBSCRIPTION_MANAGER_ABI, eventName: "SubscriptionExpired", args: { subId } });
  return { address: SUBS, topics: [...enc.topics], data: enc.data, blockNumber: block, transactionHash: `0xe${subId}`, logIndex: 0 };
}

function reader(head: bigint, logs: RawLog[]): ChainReader & { calls: Array<{ from: bigint; to: bigint }> } {
  const calls: Array<{ from: bigint; to: bigint }> = [];
  return {
    calls,
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push({ from: fromBlock, to: toBlock });
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
}

function makeIndexer(store: Store, r: ChainReader, opts: Partial<ConstructorParameters<typeof Indexer>[0]> = {}) {
  return new Indexer({ store, reader: r, cardIssuer: ISSUER, subscriptionManager: SUBS, now: () => 1234, ...opts });
}

describe("Indexer.runOnce", () => {
  it("indexes events, tracks subs, advances cursor", async () => {
    const store = new Store(":memory:");
    const r = reader(150n, [subCreatedLog(7n, 100n, 0), expiredLog(7n, 149n)]);
    const res = await makeIndexer(store, r).runOnce();
    expect(res).toEqual({ processed: 2, toBlock: 150n });
    expect(store.getCursor("core")).toBe(150n);
    expect(store.listActiveSubs()).toEqual([]); // created then expired
  });

  it("chunks ranges and resumes from the cursor", async () => {
    const store = new Store(":memory:");
    store.setCursor("core", 999n);
    const r = reader(20_000n, []);
    await makeIndexer(store, r, { chunkSize: 9000n }).runOnce();
    expect(r.calls).toEqual([
      { from: 1000n, to: 9999n },
      { from: 10_000n, to: 18_999n },
      { from: 19_000n, to: 20_000n },
    ]);
    expect(store.getCursor("core")).toBe(20_000n);
  });

  it("is idempotent across overlapping runs", async () => {
    const store = new Store(":memory:");
    const logs = [subCreatedLog(7n, 100n, 0)];
    await makeIndexer(store, reader(150n, logs)).runOnce();
    store.setCursor("core", 50n); // simulate cursor rollback / overlap
    const res = await makeIndexer(store, reader(150n, logs)).runOnce();
    expect(res.processed).toBe(0); // duplicate insert skipped
    expect(store.listActiveSubs()).toEqual(["7"]);
  });

  it("no-ops when head is behind the cursor", async () => {
    const store = new Store(":memory:");
    store.setCursor("core", 500n);
    const res = await makeIndexer(store, reader(400n, [])).runOnce();
    expect(res).toEqual({ processed: 0, toBlock: null });
    expect(store.getCursor("core")).toBe(500n);
  });
});
