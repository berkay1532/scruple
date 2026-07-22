"use client";

// The chain-side flow driver for the checkout embed: reads the plan and the
// connected buyer's cards, then drives inline mint / approve / subscribe
// writes through the `checkoutReducer` state machine (see logic.ts for the
// transition table this hook must obey exactly).
import { useEffect, useMemo, useReducer, useRef } from "react";
import {
  useAccount,
  useConnect,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWriteContract,
} from "wagmi";
import type { Hash } from "viem";
import { injected } from "wagmi/connectors";
import { BaseError, UserRejectedRequestError } from "viem";
import { ARC_CHAIN_ID, CARD_ISSUER_ABI, DEFAULT_ADDRESSES, SUBSCRIPTION_MANAGER_ABI, USDC_ABI } from "./config.js";
import {
  approveAmountFor,
  checkoutReducer,
  isCardEligible,
  type CandidateCard,
  type CheckoutState,
} from "./logic.js";

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
  connect(): void;
  isConnected: boolean;
  address?: string;
  select(cardId: bigint): void;
  mintAndUse(): Promise<void>;
  payAndSubscribe(): Promise<void>;
}

export function useCheckoutFlow(opts: UseCheckoutFlowOptions): UseCheckoutFlowReturn {
  const addresses = useMemo(
    () => ({ ...DEFAULT_ADDRESSES, ...opts.addresses }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.addresses?.subscriptionManager, opts.addresses?.cardIssuer, opts.addresses?.usdc],
  );

  const [state, dispatch] = useReducer(checkoutReducer, { step: "connect" });

  const { address, isConnected } = useAccount();
  const { connect: wagmiConnect } = useConnect();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });

  // Guards mintAndUse/payAndSubscribe against a double-fire (e.g. a fast
  // double-click on the CTA before React re-renders the disabled state):
  // both handlers bail out immediately if a call is already in flight.
  const busyRef = useRef(false);

  function connect() {
    // Plain injected connector for now — the EIP-6963 multi-wallet picker
    // arrives in 5d as a shared component; this embed doesn't depend on
    // whatever connectors the host app happened to configure.
    wagmiConnect({ connector: injected(), chainId: ARC_CHAIN_ID });
  }

  useEffect(() => {
    if (isConnected) dispatch({ type: "connected" });
  }, [isConnected]);

  // --- Plan reads: getPlan, then getPlanVersion(latestVersion) once the
  // plan is known (the version number isn't available until the first read
  // resolves, so this can't be a single multicall — same two-step pattern as
  // apps/dashboard/lib/use-merchant.ts).
  const { data: planRaw } = useReadContract({
    address: addresses.subscriptionManager,
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName: "getPlan",
    args: [opts.planId],
    chainId: ARC_CHAIN_ID,
    query: { retry: 2 },
  });

  const { data: versionRaw } = useReadContract({
    address: addresses.subscriptionManager,
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName: "getPlanVersion",
    args: [opts.planId, planRaw?.latestVersion ?? 0],
    chainId: ARC_CHAIN_ID,
    query: { enabled: planRaw !== undefined, retry: 2 },
  });

  const plan = useMemo<CheckoutPlan | undefined>(() => {
    if (!planRaw || !versionRaw) return undefined;
    return {
      amount: versionRaw.amount,
      periodS: Number(versionRaw.period),
      trialS: Number(versionRaw.trialPeriod),
      merchant: planRaw.merchant,
    };
  }, [planRaw, versionRaw]);

  useEffect(() => {
    if (plan) dispatch({ type: "planLoaded" });
  }, [plan]);

  // --- Card scan: nextCardId, then getCard + allowlist(cardId, merchant)
  // multicall over the most-recent CARD_SCAN_LIMIT ids (see the constant's
  // doc-comment for the tradeoff), filtered down to cards this buyer owns.
  const { data: nextCardId } = useReadContract({
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
  const getCardContracts = useMemo(() => {
    if (!plan || scanIds.length === 0) return [];
    return scanIds.map(
      (id) => ({ address: addresses.cardIssuer, abi: CARD_ISSUER_ABI, functionName: "getCard", args: [id] }) as const,
    );
  }, [scanIds, plan, addresses.cardIssuer]);

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

  const { data: cardResults } = useReadContracts({
    contracts: getCardContracts,
    allowFailure: true,
    chainId: ARC_CHAIN_ID,
    query: { enabled: getCardContracts.length > 0, retry: 2 },
  });

  const { data: allowlistResults } = useReadContracts({
    contracts: allowlistContracts,
    allowFailure: true,
    chainId: ARC_CHAIN_ID,
    query: { enabled: allowlistContracts.length > 0, retry: 2 },
  });

  const cards = useMemo<CheckoutCard[]>(() => {
    if (!cardResults || !plan || !address) return [];
    const out: CheckoutCard[] = [];
    for (let i = 0; i < scanIds.length; i++) {
      const cardResult = cardResults[i];
      if (!cardResult || cardResult.status !== "success") continue;
      const card = cardResult.result;
      if (card.owner.toLowerCase() !== address.toLowerCase()) continue;
      const allowlistResult = allowlistResults?.[i];
      const merchantAllowed = allowlistResult?.status === "success" ? allowlistResult.result : false;
      const candidate: CandidateCard = {
        cardId: scanIds[i],
        state: card.state,
        periodAmount: card.periodAmount,
        useAllowlist: card.useAllowlist,
        merchantAllowed,
      };
      out.push({
        cardId: scanIds[i],
        label: `Card #${scanIds[i]}`,
        eligible: isCardEligible(candidate, plan.amount),
      });
    }
    return out;
  }, [cardResults, allowlistResults, scanIds, plan, address]);

  function select(cardId: bigint) {
    dispatch({ type: "select", cardId });
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
      const hash = await writeContractAsync({
        address: addresses.cardIssuer,
        abi: CARD_ISSUER_ABI,
        functionName: "mintCard",
        args: [address, addresses.usdc, plan.amount, plan.periodS, 0, [plan.merchant as `0x${string}`]],
        chainId: ARC_CHAIN_ID,
      });
      await awaitSuccess(publicClient, hash, "Card mint");
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
    try {
      const allowance = await publicClient.readContract({
        address: addresses.usdc,
        abi: USDC_ABI,
        functionName: "allowance",
        args: [address, addresses.subscriptionManager],
      });
      const required = approveAmountFor(plan.amount);
      if (allowance < required) {
        dispatch({ type: "approveStart" });
        const approveHash = await writeContractAsync({
          address: addresses.usdc,
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
    connect,
    isConnected,
    address,
    select,
    mintAndUse,
    payAndSubscribe,
  };
}
