"use client";

// Chain reads/writes for the connected wallet's own CardIssuer cards.
// useMyCards joins the event feed (for card ownership — the contract has no
// "cards by owner" enumeration) with live getCard reads. useCardActions
// wraps the mint/freeze/unfreeze/cancel writes.
import { useMemo } from "react";
import { useAccount, useReadContracts, useWriteContract } from "wagmi";
import { CARD_ISSUER_ABI } from "./abi";
import { ADDRESSES, arcTestnet } from "./chain";
import { deriveMyCards } from "./cards";
import type { EventRow } from "./events";

export type CardStatus = "active" | "frozen" | "cancelled";

const STATUS_BY_STATE: CardStatus[] = ["active", "frozen", "cancelled"];

export interface MyCard {
  cardId: string;
  label: string;
  status: CardStatus;
  spent: bigint;
  limit: bigint;
  periodDuration: number;
  expiry: number;
  allowlisted: boolean;
}

/** The connected wallet's cards: card.created events (ownership) + live getCard reads (state). */
export function useMyCards(events: EventRow[]): { cards: MyCard[]; isLoading: boolean } {
  const { address } = useAccount();

  const cardIds = useMemo(() => (address ? deriveMyCards(events, address) : []), [events, address]);

  const contracts = useMemo(
    () =>
      cardIds.map(
        (id) =>
          ({
            address: ADDRESSES.cardIssuer,
            abi: CARD_ISSUER_ABI,
            functionName: "getCard",
            args: [BigInt(id)],
          }) as const,
      ),
    [cardIds],
  );

  const { data, isLoading } = useReadContracts({
    contracts,
    query: { enabled: contracts.length > 0 },
  });

  const cards = useMemo<MyCard[]>(() => {
    if (!data) return [];
    return cardIds.flatMap((id, i) => {
      const result = data[i];
      if (!result || result.status !== "success") return [];
      const card = result.result;
      return [
        {
          cardId: id,
          label: `Card #${id}`,
          status: STATUS_BY_STATE[card.state] ?? "active",
          spent: card.spentInPeriod,
          limit: card.periodAmount,
          periodDuration: Number(card.periodDuration),
          expiry: Number(card.expiry),
          allowlisted: card.useAllowlist,
        },
      ];
    });
  }, [data, cardIds]);

  return { cards, isLoading: contracts.length > 0 && isLoading };
}

export interface MintCardOptions {
  periodAmount: bigint;
  periodDurationS: number;
  expiryS: number; // 0 = no expiry
  allowlist: `0x${string}`[];
  signer?: `0x${string}`;
  token?: `0x${string}`;
}

/** Card lifecycle writes for the connected wallet, via wagmi's useWriteContract. */
export function useCardActions() {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();

  async function mint(opts: MintCardOptions) {
    const signer = opts.signer ?? address;
    if (!signer) throw new Error("connect a wallet first");
    return writeContractAsync({
      address: ADDRESSES.cardIssuer,
      abi: CARD_ISSUER_ABI,
      functionName: "mintCard",
      args: [
        signer,
        opts.token ?? ADDRESSES.usdc,
        opts.periodAmount,
        opts.periodDurationS,
        opts.expiryS,
        opts.allowlist,
      ],
      chainId: arcTestnet.id,
    });
  }

  function freeze(cardId: string) {
    return writeContractAsync({
      address: ADDRESSES.cardIssuer,
      abi: CARD_ISSUER_ABI,
      functionName: "freeze",
      args: [BigInt(cardId)],
      chainId: arcTestnet.id,
    });
  }

  function unfreeze(cardId: string) {
    return writeContractAsync({
      address: ADDRESSES.cardIssuer,
      abi: CARD_ISSUER_ABI,
      functionName: "unfreeze",
      args: [BigInt(cardId)],
      chainId: arcTestnet.id,
    });
  }

  function cancel(cardId: string) {
    return writeContractAsync({
      address: ADDRESSES.cardIssuer,
      abi: CARD_ISSUER_ABI,
      functionName: "cancel",
      args: [BigInt(cardId)],
      chainId: arcTestnet.id,
    });
  }

  return { mint, freeze, unfreeze, cancel, pending: isPending };
}
