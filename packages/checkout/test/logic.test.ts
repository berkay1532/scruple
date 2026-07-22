import { describe, expect, it } from "vitest";
import {
  approveAmountFor,
  checkoutReducer,
  formatUsd,
  isCardEligible,
  type CandidateCard,
  type CheckoutState,
} from "../src/logic.js";

describe("formatUsd", () => {
  it("trims trailing fractional zeros", () => {
    expect(formatUsd(1000n)).toBe("$0.001");
    expect(formatUsd(29_000_000n)).toBe("$29");
  });

  it("handles whole dollars and partial cents", () => {
    expect(formatUsd(0n)).toBe("$0");
    expect(formatUsd(1_000_000n)).toBe("$1");
    expect(formatUsd(1_500_000n)).toBe("$1.5");
  });
});

describe("approveAmountFor", () => {
  it("is 12x the plan amount", () => {
    expect(approveAmountFor(1_000_000n)).toBe(12_000_000n);
    expect(approveAmountFor(0n)).toBe(0n);
  });
});

describe("isCardEligible", () => {
  const base: CandidateCard = {
    cardId: 1n,
    state: 0,
    periodAmount: 10_000_000n,
    useAllowlist: false,
    merchantAllowed: false,
  };
  const planAmount = 5_000_000n;

  it("is false when the card is not Active", () => {
    expect(isCardEligible({ ...base, state: 1 }, planAmount)).toBe(false);
  });

  it("is false when the card's budget is below the plan amount", () => {
    expect(isCardEligible({ ...base, periodAmount: 1_000_000n }, planAmount)).toBe(false);
  });

  it("is true when active, budget sufficient, and no allowlist restriction", () => {
    expect(isCardEligible(base, planAmount)).toBe(true);
  });

  it("is true at the exact budget boundary (periodAmount == planAmount)", () => {
    expect(isCardEligible({ ...base, periodAmount: planAmount }, planAmount)).toBe(true);
  });

  it("is true when allowlisted and the merchant is allowed", () => {
    expect(
      isCardEligible({ ...base, useAllowlist: true, merchantAllowed: true }, planAmount),
    ).toBe(true);
  });

  it("is false when allowlisted and the merchant is blocked", () => {
    expect(
      isCardEligible({ ...base, useAllowlist: true, merchantAllowed: false }, planAmount),
    ).toBe(false);
  });
});

describe("checkoutReducer", () => {
  it("walks the happy path with an existing card end to end", () => {
    let state: CheckoutState = { step: "connect" };
    state = checkoutReducer(state, { type: "connected" });
    expect(state.step).toBe("loading");

    state = checkoutReducer(state, { type: "planLoaded" });
    expect(state.step).toBe("pick");

    state = checkoutReducer(state, { type: "select", cardId: 7n });
    expect(state.step).toBe("pick");
    expect(state.selectedCardId).toBe(7n);

    state = checkoutReducer(state, { type: "approveStart" });
    expect(state.step).toBe("approving");

    state = checkoutReducer(state, { type: "approveDone" });
    expect(state.step).toBe("pick");
    expect(state.selectedCardId).toBe(7n);

    state = checkoutReducer(state, { type: "subscribeStart" });
    expect(state.step).toBe("subscribing");

    state = checkoutReducer(state, { type: "subscribeDone", subId: 42n });
    expect(state.step).toBe("done");
    expect(state.subId).toBe(42n);
  });

  it("walks the mint path, storing the minted card as selected before approving", () => {
    let state: CheckoutState = { step: "pick" };
    state = checkoutReducer(state, { type: "mintStart" });
    expect(state.step).toBe("minting");

    state = checkoutReducer(state, { type: "mintDone", cardId: 99n });
    expect(state.step).toBe("pick");
    expect(state.selectedCardId).toBe(99n);

    state = checkoutReducer(state, { type: "approveStart" });
    expect(state.step).toBe("approving");
  });

  it("transitions to error from any step on fail, carrying the message", () => {
    const steps: CheckoutState[] = [
      { step: "connect" },
      { step: "loading" },
      { step: "pick" },
      { step: "minting" },
      { step: "approving", selectedCardId: 1n },
      { step: "subscribing", selectedCardId: 1n },
    ];
    for (const s of steps) {
      const next = checkoutReducer(s, { type: "fail", message: "boom" });
      expect(next.step).toBe("error");
      expect(next.error).toBe("boom");
    }
  });

  it("reset returns to pick, keeping plan loaded (dropping error/selection)", () => {
    const errored: CheckoutState = { step: "error", error: "boom", selectedCardId: 3n };
    const next = checkoutReducer(errored, { type: "reset" });
    expect(next.step).toBe("pick");
    expect(next.error).toBeUndefined();
  });

  it("no-ops on invalid transitions (e.g. approveDone while in pick)", () => {
    const state: CheckoutState = { step: "pick", selectedCardId: 7n };
    const next = checkoutReducer(state, { type: "approveDone" });
    expect(next).toBe(state);
  });

  it("no-ops when approveStart is dispatched from pick without a selection", () => {
    const state: CheckoutState = { step: "pick" };
    const next = checkoutReducer(state, { type: "approveStart" });
    expect(next).toBe(state);
  });

  it("no-ops when subscribeDone is dispatched outside subscribing", () => {
    const state: CheckoutState = { step: "pick", selectedCardId: 7n };
    const next = checkoutReducer(state, { type: "subscribeDone", subId: 1n });
    expect(next).toBe(state);
  });
});
