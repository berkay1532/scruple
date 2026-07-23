"use client";

// The chain-side flow driver for the checkout embed: reads the plan and the
// connected buyer's cards, then drives inline mint / approve / subscribe
// writes through the `checkoutReducer` state machine (see logic.ts for the
// transition table this hook must obey exactly).
import { useEffect, useMemo, useReducer, useRef } from "react";
import {
  useAccount,
  useConnect,
  useConnectors,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWriteContract,
} from "wagmi";
import type { Connector, CreateConnectorFn } from "wagmi";
import type { Hash } from "viem";
import { BaseError, UserRejectedRequestError, zeroAddress } from "viem";
import { ARC_CHAIN_ID, CARD_ISSUER_ABI, DEFAULT_ADDRESSES, SUBSCRIPTION_MANAGER_ABI, USDC_ABI } from "./config";
import {
  approveAmountFor,
  assembleCards,
  checkoutReducer,
  type CheckoutState,
} from "./logic";
import { pickWalletChoices, type WalletChoices } from "./wallet-picker";

/** Buyer card discovery scans backward from `nextCardId`, capped at this many
 * most-recent ids. There is no "cards by owner" enumeration on-chain (see
 * apps/dashboard/lib/use-cards.ts's comment on the same gap — the dashboard
 * solves it by joining an event feed the embed deliberately doesn't depend
 * on, since the embed is chain-only). 64 is a testnet-scale bound: a buyer
 * whose eligible card is older than the 64 most-recently-minted cards
 * network-wide simply won't see it offered here and falls back to minting a
 * fresh one. Acceptable for the demo; a production embed would need either
 * an indexer or a real "cards by owner" view. */
const CARD_SCAN_LIMIT = 64n;

/** Turns a thrown error into a short, human-readable message for the UI.
 * Wallet-reject (EIP-1193 code 4001, or viem's UserRejectedRequestError in
 * the BaseError cause chain) gets a friendly fixed message; any other viem
 * BaseError (e.g. a revert) surfaces its `shortMessage`; anything else falls
 * back to `Error#message` or a generic string. */
function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    const rejected = err.walk((e) => e instanceof UserRejectedRequestError);
    if (rejected) return "Request cancelled in wallet.";
    return err.shortMessage;
  }
  if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === 4001) {
    return "Request cancelled in wallet.";
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

type PublicClient = NonNullable<ReturnType<typeof usePublicClient>>;

/** Waits for a transaction receipt and throws if it landed but reverted.
 * `publicClient.waitForTransactionReceipt` only rejects on network/timeout
 * errors — a mined-but-reverted transaction resolves normally with
 * `receipt.status === "reverted"`, so callers must check status explicitly
 * or a reverted transaction gets reported as a success. */
async function awaitSuccess(publicClient: PublicClient, hash: Hash, what: string): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${what} transaction reverted on-chain.`);
}

export interface UseCheckoutFlowOptions {
  planId: bigint;
  addresses?: Partial<typeof DEFAULT_ADDRESSES>;
}

export interface CheckoutPlan {
  amount: bigint;
  periodS: number;
  trialS: number;
  merchant: string;
}

export interface CheckoutCard {
  cardId: bigint;
  label: string;
  eligible: boolean;
}

export interface UseCheckoutFlowReturn {
  state: CheckoutState;
  plan?: CheckoutPlan;
  cards: CheckoutCard[];
  /** True until every initial-load chain read has settled (success or
   * error): the plan reads, nextCardId, and — if nextCardId revealed any
   * candidate ids — both the getCard and allowlist multicalls. While this is
   * true, `cards` is guaranteed to be `[]` rather than a partially-eligible
   * interim list — the UI should render a single loading placeholder and
   * nothing else, never a staged reveal of cards flipping eligible. */
  initialLoading: boolean;
  /** Non-null iff the initial load failed outright — a plan/card read errored
   * after retries (see `query: { retry: 2 }` on each read above), or the
   * plan resolved but is invalid (no such plan, or the merchant deactivated
   * it — see I2's check on `planRaw` above). Always `null` while
   * `initialLoading` is still legitimately in-flight-and-recoverable; once
   * non-null it stays that way until `retryInitial()` is called and the
   * underlying reads resolve differently. Distinct from `state.error`, which
   * is only ever set by a failed mint/approve/subscribe write. */
  initialError: string | null;
  /** Re-runs every initial-load read; wired to the "Retry" button the
   * component renders alongside `initialError`. */
  retryInitial(): void;
  /** Connects with a specific connector — one of `walletChoices`' connectors,
   * or a freshly-created `injected()` as the no-wallet/SSR fallback (mode
   * "none"). Always targets Arc (`chainId: ARC_CHAIN_ID`). */
  connectWith(connector: Connector | CreateConnectorFn): void;
  /** The EIP-6963 dedupe result over wagmi's current connector list — see
   * pickWalletChoices (wallet-picker.tsx) for the mode semantics. The
   * component maps: direct → single "Connect wallet" button, pick →
   * `<WalletPicker/>` list, none → button falling back to `injected()`. */
  walletChoices: WalletChoices<Connector>;
  /** True while wagmi is restoring a previous session (`useAccount().status
   * === "reconnecting"`). EIP-6963 announcements land before the async
   * reconnect flips `isConnected`, so without this gate a
   * previously-connected buyer with ≥2 wallets would see the picker list
   * flash before the panel snaps to loading. The component renders a
   * disabled single "Connect wallet" button — never the picker — while this
   * is true. */
  isReconnecting: boolean;
  isConnected: boolean;
  address?: string;
  select(cardId: bigint): void;
  mintAndUse(): Promise<void>;
  payAndSubscribe(): Promise<void>;
  reset(): void;
}

export function useCheckoutFlow(opts: UseCheckoutFlowOptions): UseCheckoutFlowReturn {
  const addresses = useMemo(
    () => ({ ...DEFAULT_ADDRESSES, ...opts.addresses }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.addresses?.subscriptionManager, opts.addresses?.cardIssuer, opts.addresses?.usdc],
  );

  const [state, dispatch] = useReducer(checkoutReducer, { step: "connect" });

  const { address, isConnected, isReconnecting } = useAccount();
  const { connect: wagmiConnect } = useConnect();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });

  // Guards mintAndUse/payAndSubscribe against a double-fire (e.g. a fast
  // double-click on the CTA before React re-renders the disabled state):
  // both handlers bail out immediately if a call is already in flight.
  const busyRef = useRef(false);

  // wagmi's multiInjectedProviderDiscovery (on by default) makes this list
  // carry one connector per EIP-6963-announced wallet in addition to
  // whatever the host app configured; pickWalletChoices dedupes the generic
  // injected fallback out whenever real discovered wallets exist (the
  // Phantom-hijacks-window.ethereum incident this feature exists for).
  const connectors = useConnectors();
  const walletChoices = useMemo<WalletChoices<Connector>>(() => pickWalletChoices(connectors), [connectors]);

  function connectWith(connector: Connector | CreateConnectorFn) {
    wagmiConnect({ connector, chainId: ARC_CHAIN_ID });
  }

  useEffect(() => {
    if (isConnected) dispatch({ type: "connected" });
  }, [isConnected]);

  // --- Plan reads: getPlan, then getPlanVersion(latestVersion) once the
  // plan is known (the version number isn't available until the first read
  // resolves, so this can't be a single multicall — same two-step pattern as
  // apps/dashboard/lib/use-merchant.ts).
  const {
    data: planRaw,
    status: planStatus,
    refetch: refetchPlan,
  } = useReadContract({
    address: addresses.subscriptionManager,
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName: "getPlan",
    args: [opts.planId],
    chainId: ARC_CHAIN_ID,
    query: { retry: 2 },
  });

  const {
    data: versionRaw,
    status: versionStatus,
    refetch: refetchVersion,
  } = useReadContract({
    address: addresses.subscriptionManager,
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName: "getPlanVersion",
    args: [opts.planId, planRaw?.latestVersion ?? 0],
    chainId: ARC_CHAIN_ID,
    query: { enabled: planRaw !== undefined, retry: 2 },
  });

  // I2: a plan id with no real plan behind it (or one the merchant has since
  // deactivated) decodes just fine rather than reverting — Solidity mappings
  // default to a zeroed struct for any key that was never written — so this
  // can't be caught by `planStatus` alone. Treating it as "no plan" here
  // (rather than a plan whose merchant happens to be the zero address) keeps
  // every downstream consumer (the `planLoaded` dispatch below, `cards`,
  // mint/subscribe) from ever acting on it; `initialError` (below) is what
  // actually surfaces this to the UI.
  const plan = useMemo<CheckoutPlan | undefined>(() => {
    if (!planRaw || !versionRaw) return undefined;
    if (planRaw.merchant === zeroAddress || !planRaw.active) return undefined;
    return {
      amount: versionRaw.amount,
      periodS: Number(versionRaw.period),
      trialS: Number(versionRaw.trialPeriod),
      merchant: planRaw.merchant,
    };
  }, [planRaw, versionRaw]);

  // Depends on state.step too: the plan query needs no wallet, so it can
  // resolve while the reducer is still on "connect" (e.g. during the SSR
  // session-restore window) — that early planLoaded is ignored, and `plan`'s
  // reference never changes again. Re-firing when the step reaches "loading"
  // is what advances to "pick" in that ordering (live-caught on the deployed
  // Acme checkout: plan header rendered, body stuck empty until remount).
  useEffect(() => {
    if (plan && state.step === "loading") dispatch({ type: "planLoaded" });
  }, [plan, state.step]);

  // --- Card scan: nextCardId, then getCard + allowlist(cardId, merchant)
  // multicall over the most-recent CARD_SCAN_LIMIT ids (see the constant's
  // doc-comment for the tradeoff), filtered down to cards this buyer owns.
  const {
    data: nextCardId,
    status: nextCardIdStatus,
    refetch: refetchNextCardId,
  } = useReadContract({
    address: addresses.cardIssuer,
    abi: CARD_ISSUER_ABI,
    functionName: "nextCardId",
    chainId: ARC_CHAIN_ID,
    query: { retry: 2 },
  });

  const scanIds = useMemo<bigint[]>(() => {
    if (nextCardId === undefined || nextCardId === 0n) return [];
    const lowest = nextCardId > CARD_SCAN_LIMIT ? nextCardId - CARD_SCAN_LIMIT : 0n;
    const ids: bigint[] = [];
    // Most-recently-minted first — a buyer is more likely to want the card
    // they just made than one from many mints ago.
    for (let id = nextCardId - 1n; id >= lowest; id--) ids.push(id);
    return ids;
  }, [nextCardId]);

  // getCard×N and allowlist(cardId, merchant)×N as two separate homogeneous
  // multicalls rather than one interleaved 2N-length call: each keeps a
  // single `functionName`, so wagmi can infer each result's type positionally
  // instead of collapsing to a `Card | boolean` union per slot. Both still
  // fire in parallel (React Query has no reason to serialize them), so the
  // wall-clock cost vs. one combined multicall is negligible.
  //
  // getCardContracts depends only on scanIds (i.e. nextCardId) — it doesn't
  // read anything plan-shaped, so it must not wait on `plan` to resolve first
  // (that would be an artificial dependency stalling the initial load).
  // allowlistContracts genuinely needs `plan.merchant` as a call argument, so
  // it fires once plan is ready, in parallel with (not after) getCardContracts.
  const getCardContracts = useMemo(() => {
    if (scanIds.length === 0) return [];
    return scanIds.map(
      (id) => ({ address: addresses.cardIssuer, abi: CARD_ISSUER_ABI, functionName: "getCard", args: [id] }) as const,
    );
  }, [scanIds, addresses.cardIssuer]);

  const allowlistContracts = useMemo(() => {
    if (!plan || scanIds.length === 0) return [];
    return scanIds.map(
      (id) =>
        ({
          address: addresses.cardIssuer,
          abi: CARD_ISSUER_ABI,
          functionName: "allowlist",
          args: [id, plan.merchant as `0x${string}`],
        }) as const,
    );
  }, [scanIds, plan, addresses.cardIssuer]);

  const {
    data: cardResults,
    status: cardResultsStatus,
    refetch: refetchCardResults,
  } = useReadContracts({
    contracts: getCardContracts,
    allowFailure: true,
    chainId: ARC_CHAIN_ID,
    query: { enabled: getCardContracts.length > 0, retry: 2 },
  });

  const {
    data: allowlistResults,
    status: allowlistResultsStatus,
    refetch: refetchAllowlistResults,
  } = useReadContracts({
    contracts: allowlistContracts,
    allowFailure: true,
    chainId: ARC_CHAIN_ID,
    query: { enabled: allowlistContracts.length > 0, retry: 2 },
  });

  // --- Atomic initial-load gate. Settled means "resolved to success or
  // error", not merely "has data" — a disabled query (e.g. versionRaw before
  // planRaw lands, or the multicalls before scanIds/plan are ready) reports
  // status "pending" forever, so gating on status alone (rather than data
  // !== undefined) correctly waits through that disabled phase too.
  const planSettled =
    planStatus === "error" || (planStatus === "success" && (versionStatus === "success" || versionStatus === "error"));
  const nextCardIdSettled = nextCardIdStatus === "success" || nextCardIdStatus === "error";
  // If plan never resolved to a usable value, or there are no candidate ids
  // to scan, there's nothing further to wait for from the card multicalls
  // (allowlistContracts can't even fire without plan.merchant).
  const cardScanSettled =
    !plan || scanIds.length === 0
      ? true
      : (cardResultsStatus === "success" || cardResultsStatus === "error") &&
        (allowlistResultsStatus === "success" || allowlistResultsStatus === "error");

  // assembleCards (logic.ts) is the single source of truth for "do
  // scanIds/cardResults/allowlistResults line up by index" — it rejects
  // (ready: false, cards: []) on any length mismatch or per-element read
  // failure rather than zipping a partial/misaligned result. `initialLoading`
  // folds `!assembled.ready` in below, so query-status settling alone is no
  // longer sufficient to reveal cards — the assembly must also report ready.
  const assembled = useMemo(
    () => assembleCards(scanIds, cardResults, allowlistResults, plan?.amount ?? 0n),
    [scanIds, cardResults, allowlistResults, plan],
  );

  // I1: a human-readable reason the initial load can't proceed, distinct
  // from `state.error` (which is only ever set by write-flow failures —
  // mint/approve/subscribe — via the `fail` action). Checked in a fixed
  // priority order: a failed plan read is reported before a failed card
  // read, and a *resolved-but-invalid* plan (I2) is checked last since it
  // requires `planRaw` to actually be present. Every status this reads
  // (`error`) only occurs after react-query has exhausted the `retry: 2`
  // configured on each query above, so this never fires on a merely
  // in-flight or about-to-retry read.
  const initialError = useMemo<string | null>(() => {
    if (planStatus === "error" || versionStatus === "error") {
      return "Couldn't load this plan. Check your connection and try again.";
    }
    if (nextCardIdStatus === "error" || cardResultsStatus === "error" || allowlistResultsStatus === "error") {
      return "Couldn't load your cards. Check your connection and try again.";
    }
    if (planRaw && (planRaw.merchant === zeroAddress || !planRaw.active)) {
      return "This plan doesn't exist or is no longer accepting subscribers.";
    }
    return null;
  }, [planStatus, versionStatus, nextCardIdStatus, cardResultsStatus, allowlistResultsStatus, planRaw]);

  // Folding `initialError` in here (rather than leaving it to the component)
  // guarantees the invariant documented on `initialLoading` below still
  // holds when the load has failed outright: `cards` stays `[]`, the plan
  // summary stays hidden, and — critically for I2 — an invalid plan can
  // settle every query involved (nothing ever errors) and still never flip
  // `initialLoading` to false, since `plan` itself is undefined in that case
  // and nothing downstream can genuinely be "ready".
  const initialLoading = !(planSettled && nextCardIdSettled && cardScanSettled) || !assembled.ready || initialError !== null;

  /** Re-runs every initial-load read after a failure (e.g. the "Retry"
   * button the component renders alongside `initialError`). Safe to call
   * even for reads that are currently disabled (e.g. the multicalls before
   * `scanIds`/`plan` exist) — react-query no-ops a refetch on a disabled
   * query rather than throwing. */
  function retryInitial(): void {
    void refetchPlan();
    void refetchVersion();
    void refetchNextCardId();
    void refetchCardResults();
    void refetchAllowlistResults();
  }

  const cards = useMemo<CheckoutCard[]>(() => {
    // Never compute eligibility from a partial result set: until every
    // initial-load read has settled AND assembleCards has confirmed the
    // three arrays line up, hold `cards` at `[]` rather than surfacing an
    // interim or misaligned list.
    if (initialLoading || !plan || !address) return [];
    // Owner filtering stays here (not in assembleCards, which has no notion
    // of the connected address) — safe to index `cardResults` positionally
    // because `initialLoading` being false implies `assembled.ready`, which
    // in turn guarantees `cardResults.length === scanIds.length`.
    const ownedCardIds = new Set<bigint>();
    for (let i = 0; i < scanIds.length; i++) {
      const cardResult = cardResults?.[i];
      if (cardResult?.status === "success" && cardResult.result.owner.toLowerCase() === address.toLowerCase()) {
        ownedCardIds.add(scanIds[i]);
      }
    }
    return assembled.cards.filter((c) => ownedCardIds.has(c.cardId));
  }, [initialLoading, assembled, cardResults, scanIds, plan, address]);

  function select(cardId: bigint) {
    dispatch({ type: "select", cardId });
  }

  /** Recovers from the error step (e.g. a "Retry" button in the UI): clears
   * the error/selection and returns to "pick" without re-fetching the plan
   * or the card scan (both are already cached by react-query). Valid from
   * any step per the reducer's transition table, but the component only
   * needs it from "error". */
  function reset() {
    dispatch({ type: "reset" });
  }

  async function mintAndUse(): Promise<void> {
    if (state.step !== "pick" || !plan || !address || !publicClient) return;
    if (busyRef.current) return;
    busyRef.current = true;
    dispatch({ type: "mintStart" });
    try {
      // Read nextCardId fresh, right before sending the mint, so the id we
      // record as "the minted card" can't be stale relative to some other
      // mint landing first (single-user demo assumption — see the
      // subscribe-side nextSubId comment below for the same pattern).
      const freshCardId = await publicClient.readContract({
        address: addresses.cardIssuer,
        abi: CARD_ISSUER_ABI,
        functionName: "nextCardId",
      });
      // I3: mint the card in this plan's actual settlement token, not a
      // hardcoded USDC address — a plan can be denominated in any ERC-20.
      // `addresses.usdc` is only a defensive fallback for the pathological
      // case where the decoded plan token is somehow falsy.
      const token = planRaw?.token ?? addresses.usdc;
      const hash = await writeContractAsync({
        address: addresses.cardIssuer,
        abi: CARD_ISSUER_ABI,
        functionName: "mintCard",
        args: [address, token, plan.amount, plan.periodS, 0, [plan.merchant as `0x${string}`]],
        chainId: ARC_CHAIN_ID,
      });
      await awaitSuccess(publicClient, hash, "Card mint");
      // Only nextCardId needs an explicit refetch. getCardContracts and
      // allowlistContracts are useMemos derived from `scanIds` (itself
      // derived from `nextCardId`), so once the refetch below lands and
      // scanIds grows to include the new card, both multicalls get a brand
      // new `contracts` array — a new query key wagmi/react-query fetches
      // automatically (`enabled: length > 0`, no manual refetch needed).
      //
      // The previous version of this fix instead force-refetched all three
      // queries concurrently via Promise.all. That's the bug this replaces:
      // refetchCardResults()/refetchAllowlistResults() were called in the
      // same tick as refetchNextCardId(), i.e. *before* nextCardId's new
      // value had propagated through a re-render — so those two calls just
      // re-fetched the OLD (pre-mint) getCard/allowlist contracts arrays.
      // scanIds (read fresh on the next render, once nextCardId updates)
      // would then include the new card and shift every existing card's
      // scan position by one, while cardResults/allowlistResults kept
      // pointing at the old, now-differently-sized/ordered arrays — a
      // length/order mismatch that `assembleCards` will now reject outright
      // (ready: false) rather than let `cards` zip by index against it.
      // Tolerate a transient refetch failure here: the mint itself already
      // succeeded, and the next natural read will catch up.
      await refetchNextCardId().catch(() => undefined);
      dispatch({ type: "mintDone", cardId: freshCardId });
    } catch (err) {
      dispatch({ type: "fail", message: describeError(err) });
    } finally {
      busyRef.current = false;
    }
  }

  async function payAndSubscribe(): Promise<void> {
    if (state.step !== "pick" || state.selectedCardId === undefined || !plan || !address || !publicClient) return;
    if (busyRef.current) return;
    busyRef.current = true;
    const cardId = state.selectedCardId;
    // I3: check/raise allowance on this plan's actual token, not a
    // hardcoded USDC address — see the matching comment in mintAndUse.
    const token = planRaw?.token ?? addresses.usdc;
    try {
      const allowance = await publicClient.readContract({
        address: token,
        abi: USDC_ABI,
        functionName: "allowance",
        args: [address, addresses.subscriptionManager],
      });
      const required = approveAmountFor(plan.amount);
      if (allowance < required) {
        dispatch({ type: "approveStart" });
        const approveHash = await writeContractAsync({
          address: token,
          abi: USDC_ABI,
          functionName: "approve",
          args: [addresses.subscriptionManager, required],
          chainId: ARC_CHAIN_ID,
        });
        await awaitSuccess(publicClient, approveHash, "USDC approve");
        dispatch({ type: "approveDone" });
      }

      dispatch({ type: "subscribeStart" });
      // Read nextSubId BEFORE sending subscribe — that pre-value IS the new
      // subscription's id. This only holds because nothing else on this
      // single-user demo chain can subscribe between the read and this
      // wallet's own write landing; a multi-user deployment would need to
      // parse the subId from the subscribe receipt's logs instead.
      const subId = await publicClient.readContract({
        address: addresses.subscriptionManager,
        abi: SUBSCRIPTION_MANAGER_ABI,
        functionName: "nextSubId",
      });
      const subscribeHash = await writeContractAsync({
        address: addresses.subscriptionManager,
        abi: SUBSCRIPTION_MANAGER_ABI,
        functionName: "subscribe",
        args: [opts.planId, cardId],
        chainId: ARC_CHAIN_ID,
      });
      await awaitSuccess(publicClient, subscribeHash, "Subscribe");
      dispatch({ type: "subscribeDone", subId });
    } catch (err) {
      dispatch({ type: "fail", message: describeError(err) });
    } finally {
      busyRef.current = false;
    }
  }

  return {
    state,
    plan,
    cards,
    initialLoading,
    initialError,
    retryInitial,
    connectWith,
    walletChoices,
    isReconnecting,
    isConnected,
    address,
    select,
    mintAndUse,
    payAndSubscribe,
    reset,
  };
}
