import { describe, it, expect } from "vitest";
import { PolicyTracker } from "../src/policy";

const ORIGIN = "https://api.example.com";

function tracker(overrides = {}, startAt = 1_000_000) {
  let t = startAt;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const p = new PolicyTracker(
    { periodBudget: 2_000_000n, periodMs: 86_400_000, allowedOrigins: [ORIGIN], perTxCap: 1_500_000n, ...overrides },
    clock.now,
  );
  return { p, clock };
}

describe("PolicyTracker", () => {
  it("allows within budget and records spend", () => {
    const { p } = tracker();
    expect(p.check(1_000_000n, ORIGIN)).toEqual({ ok: true });
    p.record(1_000_000n);
    expect(p.spentInPeriod()).toBe(1_000_000n);
  });

  it("rejects over period budget", () => {
    const { p } = tracker();
    p.record(1_500_000n);
    expect(p.check(600_000n, ORIGIN)).toEqual({ ok: false, reason: "over_budget" });
  });

  it("rejects over per-tx cap even when budget remains", () => {
    const { p } = tracker();
    expect(p.check(1_500_001n, ORIGIN)).toEqual({ ok: false, reason: "over_tx_cap" });
  });

  it("rejects disallowed origins; allows any origin when list omitted", () => {
    const { p } = tracker();
    expect(p.check(1n, "https://evil.example")).toEqual({ ok: false, reason: "origin_not_allowed" });
    const open = new PolicyTracker({ periodBudget: 10n, periodMs: 1000 });
    expect(open.check(1n, "https://anywhere.example")).toEqual({ ok: true });
  });

  it("resets spend on anchored period rollover", () => {
    const { p, clock } = tracker();
    p.record(2_000_000n);
    expect(p.check(1n, ORIGIN)).toEqual({ ok: false, reason: "over_budget" });
    clock.advance(86_400_000 + 1);
    expect(p.check(1_000_000n, ORIGIN)).toEqual({ ok: true });
    expect(p.spentInPeriod()).toBe(0n);
  });

  it("anchors periods to the start, not to the last spend", () => {
    const { p, clock } = tracker();
    clock.advance(86_400_000 * 2 + 5); // 2 full periods + 5ms
    p.record(1n);
    clock.advance(86_400_000 - 10); // still inside period 3
    p.record(1n);
    expect(p.spentInPeriod()).toBe(2n);
  });

  it("rejects nonpositive periodMs", () => {
    expect(() => new PolicyTracker({ periodBudget: 1n, periodMs: 0 })).toThrow(RangeError);
  });
});
