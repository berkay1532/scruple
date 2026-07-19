export interface SpendingPolicy {
  periodBudget: bigint;
  periodMs: number;
  perTxCap?: bigint;
  allowedOrigins?: string[];
}

export type PolicyDecision =
  | { ok: true }
  | { ok: false; reason: "over_budget" | "over_tx_cap" | "origin_not_allowed" };

/** Client-side spending policy with anchored rolling periods (mirrors CardIssuer semantics). */
export class PolicyTracker {
  private periodStart: number;
  private spent = 0n;

  constructor(
    private readonly policy: SpendingPolicy,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (policy.periodMs <= 0) throw new RangeError("periodMs must be > 0");
    this.periodStart = this.now();
  }

  private roll(): void {
    const elapsed = this.now() - this.periodStart;
    if (elapsed >= this.policy.periodMs) {
      const periods = Math.floor(elapsed / this.policy.periodMs);
      this.periodStart += periods * this.policy.periodMs;
      this.spent = 0n;
    }
  }

  check(atomic: bigint, origin: string): PolicyDecision {
    this.roll();
    const { allowedOrigins, perTxCap, periodBudget } = this.policy;
    if (allowedOrigins && !allowedOrigins.includes(origin)) {
      return { ok: false, reason: "origin_not_allowed" };
    }
    if (perTxCap !== undefined && atomic > perTxCap) {
      return { ok: false, reason: "over_tx_cap" };
    }
    if (this.spent + atomic > periodBudget) {
      return { ok: false, reason: "over_budget" };
    }
    return { ok: true };
  }

  record(atomic: bigint): void {
    this.roll();
    this.spent += atomic;
  }

  /**
   * Refunds a previously recorded (reserved) spend, e.g. when a payment
   * attempt fails after the spend was reserved synchronously. Floors at
   * zero: if a period rollover happened between the reservation and the
   * release, `spent` reflects the *new* period and cannot be driven
   * negative by refunding an amount that belonged to a prior period.
   */
  release(atomic: bigint): void {
    this.roll();
    this.spent = this.spent >= atomic ? this.spent - atomic : 0n;
  }

  spentInPeriod(): bigint {
    this.roll();
    return this.spent;
  }
}
