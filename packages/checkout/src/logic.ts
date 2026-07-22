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

/** The subset of a `getCard(cardId)` return value that eligibility/labeling
 * needs. Deliberately narrower than the full `Card` struct (no owner/signer/
 * etc.) — owner-based filtering is a separate concern the caller (the hook)
 * still owns; see use-checkout.ts's `cards` memo. */
export interface CardResultData {
  state: number;
  periodAmount: bigint;
  useAllowlist: boolean;
}

/** Mirrors wagmi/viem's `useReadContracts({ allowFailure: true })` per-call
 * result shape: every element is tagged success/failure rather than the call
 * throwing, so a single bad `cardId` can't take down the whole multicall
 * response — but it also means array *shape* (length, order, per-slot
 * status) is the only signal callers get for "did this align with what I
 * asked for", which is exactly what `assembleCards` exists to check. */
export type MulticallResult<T> = { status: "success"; result: T } | { status: "failure"; error?: unknown };

export interface AssembledCard {
  cardId: bigint;
  label: string;
  eligible: boolean;
}

export interface AssembledCards {
  /** False if the three inputs can't be safely zipped by index (missing
   * array, length mismatch, or any per-element read failure) — in which
   * case `cards` is always `[]`, never a partial/best-effort list. */
  ready: boolean;
  cards: AssembledCard[];
}

/**
 * Pure card-list assembly: zips a buyer's scanned candidate ids against the
 * two positionally-parallel multicall result arrays (`getCard` and
 * `allowlist(cardId, merchant)`, both built from the same `scanIds` in the
 * same order) into a labeled, eligibility-flagged list.
 *
 * This is deliberately paranoid about alignment because the three chain
 * reads it draws from (`nextCardId` → derived `scanIds` → the two
 * multicalls) are three independent react-query caches that can settle,
 * refetch, and re-key on their own schedules (see use-checkout.ts's
 * post-mint refetch comment) — a length or ordering mismatch between them
 * must never get silently zipped by index into a wrong-card/wrong-flag
 * result. So:
 *   - `scanIds.length === 0` short-circuits to `{ready: true, cards: []}` —
 *     there is nothing to wait for or misalign.
 *   - otherwise, if either result array is missing or its length doesn't
 *     exactly match `scanIds.length`, the whole assembly is rejected
 *     (`ready: false, cards: []`) rather than zipping the overlapping
 *     prefix.
 *   - otherwise, if ANY element of either array isn't `status: "success"`,
 *     the whole assembly is rejected too — atomicity beats a partial reveal
 *     (simpler to reason about than per-card fallback states, and a single
 *     flaky RPC call for one card shouldn't be allowed to mis-render a
 *     sibling card just because the arrays "happen to" still be the right
 *     length).
 *
 * Owner filtering is NOT done here — it's a separate, cheap pass the caller
 * (use-checkout.ts's `cards` memo) applies to this function's output using
 * the same `cardResults` array, gated on `ready` being true so that indexing
 * it by position is safe.
 */
export function assembleCards(
  scanIds: bigint[],
  cardResults: MulticallResult<CardResultData>[] | undefined,
  allowlistResults: MulticallResult<boolean>[] | undefined,
  planAmount: bigint,
): AssembledCards {
  if (scanIds.length === 0) return { ready: true, cards: [] };
  if (!cardResults || !allowlistResults) return { ready: false, cards: [] };
  if (cardResults.length !== scanIds.length || allowlistResults.length !== scanIds.length) {
    return { ready: false, cards: [] };
  }

  const cards: AssembledCard[] = [];
  for (let i = 0; i < scanIds.length; i++) {
    const cardResult = cardResults[i];
    const allowlistResult = allowlistResults[i];
    if (cardResult.status !== "success" || allowlistResult.status !== "success") {
      return { ready: false, cards: [] };
    }
    const card = cardResult.result;
    const candidate: CandidateCard = {
      cardId: scanIds[i],
      state: card.state,
      periodAmount: card.periodAmount,
      useAllowlist: card.useAllowlist,
      merchantAllowed: allowlistResult.result,
    };
    cards.push({
      cardId: scanIds[i],
      label: `Card #${scanIds[i]}`,
      eligible: isCardEligible(candidate, planAmount),
    });
  }
  return { ready: true, cards };
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
