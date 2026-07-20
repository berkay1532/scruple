import type { Store } from "./db";
import type { SubReader, UpcomingCharge } from "./atrisk";

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
  private readonly overdueAfterS: number;

  constructor(opts: { store: Store; reader: SubReader; sender: ChargeSender; now?: () => number; overdueAfterS?: number }) {
    this.store = opts.store;
    this.reader = opts.reader;
    this.sender = opts.sender;
    this.now = opts.now ?? (() => Date.now());
    this.overdueAfterS = opts.overdueAfterS ?? 86_400;
  }

  async runOnce(): Promise<{ charged: string[]; failed: Array<{ subId: string; error: string }> }> {
    const nowS = Math.floor(this.now() / 1000);
    const charged: string[] = [];
    const failed: Array<{ subId: string; error: string }> = [];
    for (const subId of this.store.listActiveSubs()) {
      let s: UpcomingCharge | undefined;
      try {
        s = await this.reader.getUpcomingCharge(subId);
        if (!s.active) {
          this.store.deactivateSub(subId);
          continue;
        }
        if (nowS < s.nextChargeAt) continue;
        await this.sender.charge(subId);
        charged.push(subId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ subId, error: message });
        if (s !== undefined) {
          this.store.insertEvent({
            id: `attemptfail:${subId}:${s.nextChargeAt}`,
            type: "payment.attempt_failed",
            blockNumber: null,
            payload: { subId, error: message, nextChargeAt: String(s.nextChargeAt) },
            at: this.now(),
          });
          if (nowS > s.nextChargeAt + this.overdueAfterS) {
            this.store.insertEvent({
              id: `overdue:${subId}:${s.nextChargeAt}`,
              type: "payment.overdue",
              blockNumber: null,
              payload: { subId, nextChargeAt: String(s.nextChargeAt) },
              at: this.now(),
            });
          }
        }
      }
    }
    return { charged, failed };
  }
}
