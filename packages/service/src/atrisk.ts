import type { Store } from "./db";

export interface UpcomingCharge {
  active: boolean;
  nextChargeAt: number; // unix seconds, mirrors contract
  amount: bigint;       // atomic USDC (latest plan version — charge migrates on renewal)
  merchant: string;
  customer: string;
  cardId: string;
}

export interface SubReader {
  getUpcomingCharge(subId: string): Promise<UpcomingCharge>;
  balanceOf(address: string): Promise<bigint>;
  previewSpend(cardId: string, merchant: string, amount: bigint): Promise<boolean>;
}

/** Predicts failing renewals BEFORE the charge date (kills Radom-style silent churn). */
export class AtRiskMonitor {
  private readonly store: Store;
  private readonly reader: SubReader;
  private readonly lookaheadS: number;
  private readonly now: () => number;

  constructor(opts: { store: Store; reader: SubReader; lookaheadS?: number; now?: () => number }) {
    this.store = opts.store;
    this.reader = opts.reader;
    this.lookaheadS = opts.lookaheadS ?? 259_200; // 3 days
    this.now = opts.now ?? (() => Date.now());
  }

  async runOnce(): Promise<number> {
    const nowS = Math.floor(this.now() / 1000);
    let emitted = 0;
    for (const subId of this.store.listActiveSubs()) {
      const s = await this.reader.getUpcomingCharge(subId);
      if (!s.active) {
        this.store.deactivateSub(subId);
        continue;
      }
      if (s.nextChargeAt - nowS > this.lookaheadS) continue;

      let reason: string | null = null;
      if ((await this.reader.balanceOf(s.customer)) < s.amount) reason = "insufficient_balance";
      else if (!(await this.reader.previewSpend(s.cardId, s.merchant, s.amount))) reason = "card_policy_blocks";
      if (reason === null) continue;

      if (!this.store.markAtRiskEmitted(subId, s.nextChargeAt)) continue;
      this.store.insertEvent({
        id: `atrisk:${subId}:${s.nextChargeAt}`,
        type: "subscription.at_risk",
        blockNumber: null,
        payload: { subId, reason, nextChargeAt: String(s.nextChargeAt), amount: String(s.amount) },
        at: this.now(),
      });
      emitted += 1;
    }
    return emitted;
  }
}
