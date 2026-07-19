import type { Store } from "./db";
import { decodeLog, type RawLog } from "./events";

export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: { addresses: string[]; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>;
}

const CURSOR_KEY = "core";

/**
 * Chunked getLogs poller. Arc testnet drops eth_newFilter subscriptions, so we
 * poll ranges instead. Arc finality is deterministic and irreversible — no
 * reorg handling required.
 */
export class Indexer {
  private readonly store: Store;
  private readonly reader: ChainReader;
  private readonly addresses: { cardIssuer: string; subscriptionManager: string };
  private readonly startBlock: bigint;
  private readonly chunkSize: bigint;
  private readonly now: () => number;

  constructor(opts: {
    store: Store;
    reader: ChainReader;
    cardIssuer: string;
    subscriptionManager: string;
    startBlock?: bigint;
    chunkSize?: bigint;
    now?: () => number;
  }) {
    this.store = opts.store;
    this.reader = opts.reader;
    this.addresses = { cardIssuer: opts.cardIssuer, subscriptionManager: opts.subscriptionManager };
    this.startBlock = opts.startBlock ?? 0n;
    this.chunkSize = opts.chunkSize ?? 9000n;
    this.now = opts.now ?? (() => Date.now());
  }

  async runOnce(): Promise<{ processed: number; toBlock: bigint | null }> {
    const head = await this.reader.getBlockNumber();
    const cursor = this.store.getCursor(CURSOR_KEY);
    let from = cursor === null ? this.startBlock : cursor + 1n;
    if (head < from) return { processed: 0, toBlock: null };

    let processed = 0;
    while (from <= head) {
      const to = from + this.chunkSize - 1n > head ? head : from + this.chunkSize - 1n;
      const logs = await this.reader.getLogs({
        addresses: [this.addresses.cardIssuer, this.addresses.subscriptionManager],
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const event = decodeLog(log, this.addresses, this.now());
        if (!event) continue;
        const sideEffects =
          event.type === "subscription.created"
            ? { trackSub: event.payload.subId }
            : event.type === "subscription.expired" || event.type === "subscription.cancelled"
              ? { deactivateSub: event.payload.subId }
              : undefined;
        const inserted = this.store.insertEvent(event, sideEffects);
        if (!inserted) continue;
        processed += 1;
      }
      this.store.setCursor(CURSOR_KEY, to); // per-chunk: crash-safe resume
      from = to + 1n;
    }
    return { processed, toBlock: head };
  }
}
