// Pure logic for the checkout embed — no React, no chain calls, no side
// effects. Everything here is unit-testable in isolation from wagmi/viem.

/** Formats an atomic (6-decimal) USDC amount as a dollar string, trimming
 * trailing fractional zeros. Ported verbatim from apps/dashboard/lib/format.ts
 * (itself mirroring packages/server/src/ratecard.ts's formatAtomic). */
export function formatUsd(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `$${whole}.${frac}` : `$${whole}`;
}

/** The approve embed asks for 12 renewals' worth of allowance up front so the
 * buyer isn't re-prompted every period; "revoke anytime" is surfaced in the UI copy. */
export function approveAmountFor(planAmount: bigint): bigint {
  return planAmount * 12n;
}

/** CardIssuer.CardState.Active — see contracts/src/CardIssuer.sol. */
const CARD_STATE_ACTIVE = 0;

export interface CandidateCard {
  cardId: bigint;
  state: number;
  periodAmount: bigint;
  useAllowlist: boolean;
  merchantAllowed: boolean;
}

/** A card can pay this plan iff it's Active, its per-period budget covers the
 * plan amount, and — when it restricts spending to an allowlist — this
 * merchant is on it. */
export function isCardEligible(c: CandidateCard, planAmount: bigint): boolean {
  return (
    c.state === CARD_STATE_ACTIVE &&
    c.periodAmount >= planAmount &&
    (!c.useAllowlist || c.merchantAllowed)
  );
}

export type Step =
  | "connect"
  | "loading"
  | "pick"
  | "minting"
  | "approving"
  | "subscribing"
  | "done"
  | "error";

export interface CheckoutState {
  step: Step;
  error?: string;
  selectedCardId?: bigint;
  subId?: bigint;
}

export type CheckoutAction =
  | { type: "connected" }
  | { type: "planLoaded" }
  | { type: "select"; cardId: bigint }
  | { type: "mintStart" }
  | { type: "mintDone"; cardId: bigint }
  | { type: "approveStart" }
  | { type: "approveDone" }
  | { type: "subscribeStart" }
  | { type: "subscribeDone"; subId: bigint }
  | { type: "fail"; message: string }
  | { type: "reset" };

/**
 * Checkout flow state machine. Transition table:
 *
 *   connect    --connected-->     loading
 *   loading    --planLoaded-->    pick
 *   pick       --select-->        pick (selectedCardId set)
 *   pick       --mintStart-->     minting
 *   minting    --mintDone-->      pick (selectedCardId set to minted card)
 *   pick(sel)  --approveStart-->  approving
 *   approving  --approveDone-->   pick (selection kept — ready to subscribe)
 *   pick(sel)  --subscribeStart--> subscribing
 *   subscribing --subscribeDone--> done (subId set)
 *   *          --fail-->          error (message set)
 *   *          --reset-->         pick (clears error/selection/subId, keeps plan loaded)
 *
 * `fail` and `reset` are valid from any step. Every other transition requires
 * the exact preconditions above (including "pick with a selection" for
 * approveStart/subscribeStart); anything else is a no-op that returns the
 * same state reference unchanged.
 */
export function checkoutReducer(state: CheckoutState, action: CheckoutAction): CheckoutState {
  switch (action.type) {
    case "connected":
      return state.step === "connect" ? { ...state, step: "loading" } : state;

    case "planLoaded":
      return state.step === "loading" ? { ...state, step: "pick" } : state;

    case "select":
      return state.step === "pick" ? { ...state, selectedCardId: action.cardId } : state;

    case "mintStart":
      return state.step === "pick" ? { ...state, step: "minting" } : state;

    case "mintDone":
      return state.step === "minting"
        ? { ...state, step: "pick", selectedCardId: action.cardId }
        : state;

    case "approveStart":
      return state.step === "pick" && state.selectedCardId !== undefined
        ? { ...state, step: "approving" }
        : state;

    case "approveDone":
      return state.step === "approving" ? { ...state, step: "pick" } : state;

    case "subscribeStart":
      return state.step === "pick" && state.selectedCardId !== undefined
        ? { ...state, step: "subscribing" }
        : state;

    case "subscribeDone":
      return state.step === "subscribing"
        ? { ...state, step: "done", subId: action.subId }
        : state;

    case "fail":
      return { ...state, step: "error", error: action.message };

    case "reset":
      return { step: "pick" };

    default:
      return state;
  }
}
