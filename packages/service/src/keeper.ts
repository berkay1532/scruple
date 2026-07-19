import type { Store } from "./db";
import type { SubReader } from "./atrisk";

export interface ChargeSender {
  charge(subId: string): Promise<{ txHash: string }>;
}

/**
 * Calls SubscriptionManager.charge(subId) for due subscriptions. charge() is
 * permissionless on-chain, so the keeper is a convenience, not a trust point.
 * Successful charges surface as chain events via the Indexer, not here.
 */
export class Keeper {
  private readonly store: Store;
  private readonly reader: SubReader;
  private readonly sender: ChargeSender;
  private readonly now: () => number;

  constructor(opts: { store: Store; reader: SubReader; sender: ChargeSender; now?: () => number }) {
    this.store = opts.store;
    this.reader = opts.reader;
    this.sender = opts.sender;
    this.now = opts.now ?? (() => Date.now());
  }

  async runOnce(): Promise<{ charged: string[]; failed: Array<{ subId: string; error: string }> }> {
    const nowS = Math.floor(this.now() / 1000);
    const charged: string[] = [];
    const failed: Array<{ subId: string; error: string }> = [];
    for (const subId of this.store.listActiveSubs()) {
      try {
        const s = await this.reader.getUpcomingCharge(subId);
        if (!s.active) {
          this.store.deactivateSub(subId);
          continue;
        }
        if (nowS < s.nextChargeAt) continue;
        await this.sender.charge(subId);
        charged.push(subId);
      } catch (err) {
        failed.push({ subId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { charged, failed };
  }
}
