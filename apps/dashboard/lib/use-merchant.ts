"use client";

// Chain reads/writes for the connected wallet acting as a merchant: its
// plans (plan.created events for ownership + live getPlan/getPlanVersion
// reads) and the subscriptions against those plans (subscription.created
// events + live getSubscription reads), with an at-risk/overdue status
// overlay sourced from the event feed (the contract has no such concept —
// it's derived purely off-chain by the service's AtRiskMonitor).
import { useMemo } from "react";
import { useAccount, useReadContracts, useWriteContract } from "wagmi";
import { SUBSCRIPTION_MANAGER_ABI } from "./abi";
import { ADDRESSES } from "./chain";
import { needsAttention, type EventRow } from "./events";

export interface MerchantPlan {
  planId: string;
  token: `0x${string}`;
  active: boolean;
  version: number;
  amount: bigint;
  periodS: number;
  trialS: number;
}

export type SubStatus = "active" | "cancelled" | "expired" | "at-risk" | "overdue";

export interface MerchantSub {
  subId: string;
  planId: string;
  customer: `0x${string}`;
  cardId: string;
  nextChargeAt: number;
  status: SubStatus;
}

const SUB_STATE: SubStatus[] = ["active", "cancelled", "expired"];

/** planIds from plan.created events whose payload.merchant matches `address` (case-insensitive). */
function planIdsFor(events: EventRow[], address: string): string[] {
  const target = address.toLowerCase();
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== "plan.created") continue;
    if (e.payload.merchant?.toLowerCase() !== target) continue;
    ids.add(e.payload.planId);
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

/** subIds from subscription.created events whose payload.planId is one of `planIds`. */
function subIdsFor(events: EventRow[], planIds: string[]): string[] {
  const known = new Set(planIds);
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== "subscription.created") continue;
    if (!known.has(e.payload.planId)) continue;
    ids.add(e.payload.subId);
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

export function useMerchant(events: EventRow[]): {
  plans: MerchantPlan[];
  subs: MerchantSub[];
  isLoading: boolean;
  pending: boolean;
  createPlan: (amountAtomic: bigint, periodS: number, trialS: number) => Promise<`0x${string}`>;
} {
  const { address } = useAccount();

  const planIds = useMemo(() => (address ? planIdsFor(events, address) : []), [events, address]);

  const planContracts = useMemo(
    () =>
      planIds.map(
        (id) =>
          ({
            address: ADDRESSES.subscriptionManager,
            abi: SUBSCRIPTION_MANAGER_ABI,
            functionName: "getPlan",
            args: [BigInt(id)],
          }) as const,
      ),
    [planIds],
  );
  const { data: planData, isLoading: plansLoading } = useReadContracts({
    contracts: planContracts,
    query: { enabled: planContracts.length > 0 },
  });

  const versionContracts = useMemo(() => {
    if (!planData) return [];
    return planIds.flatMap((id, i) => {
      const r = planData[i];
      if (!r || r.status !== "success") return [];
      return [
        {
          address: ADDRESSES.subscriptionManager,
          abi: SUBSCRIPTION_MANAGER_ABI,
          functionName: "getPlanVersion",
          args: [BigInt(id), r.result.latestVersion],
        } as const,
      ];
    });
  }, [planIds, planData]);
  const { data: versionData, isLoading: versionsLoading } = useReadContracts({
    contracts: versionContracts,
    query: { enabled: versionContracts.length > 0 },
  });

  const plans = useMemo<MerchantPlan[]>(() => {
    if (!planData) return [];
    const out: MerchantPlan[] = [];
    let vi = 0;
    for (let i = 0; i < planIds.length; i++) {
      const planResult = planData[i];
      if (!planResult || planResult.status !== "success") continue;
      const versionResult = versionData?.[vi];
      vi++;
      if (!versionResult || versionResult.status !== "success") continue;
      out.push({
        planId: planIds[i],
        token: planResult.result.token,
        active: planResult.result.active,
        version: planResult.result.latestVersion,
        amount: versionResult.result.amount,
        periodS: Number(versionResult.result.period),
        trialS: Number(versionResult.result.trialPeriod),
      });
    }
    return out;
  }, [planIds, planData, versionData]);

  const subIds = useMemo(() => subIdsFor(events, planIds), [events, planIds]);

  const subContracts = useMemo(
    () =>
      subIds.map(
        (id) =>
          ({
            address: ADDRESSES.subscriptionManager,
            abi: SUBSCRIPTION_MANAGER_ABI,
            functionName: "getSubscription",
            args: [BigInt(id)],
          }) as const,
      ),
    [subIds],
  );
  const { data: subData, isLoading: subsLoading } = useReadContracts({
    contracts: subContracts,
    query: { enabled: subContracts.length > 0 },
  });

  const attentionBySub = useMemo(() => {
    const map = new Map<string, "at-risk" | "overdue">();
    for (const row of needsAttention(events)) {
      const id = row.title.replace("Sub #", "");
      if (map.has(id)) continue;
      map.set(id, row.kind === "subscription.at_risk" ? "at-risk" : "overdue");
    }
    return map;
  }, [events]);

  const subs = useMemo<MerchantSub[]>(() => {
    if (!subData) return [];
    return subIds.flatMap((id, i) => {
      const r = subData[i];
      if (!r || r.status !== "success") return [];
      const s = r.result;
      const baseStatus = SUB_STATE[s.state] ?? "active";
      const overlay = attentionBySub.get(id);
      const status = baseStatus === "active" && overlay ? overlay : baseStatus;
      return [
        {
          subId: id,
          planId: s.planId.toString(),
          customer: s.customer,
          cardId: s.cardId.toString(),
          nextChargeAt: Number(s.nextChargeAt),
          status,
        },
      ];
    });
  }, [subData, subIds, attentionBySub]);

  const { writeContractAsync, isPending } = useWriteContract();

  function createPlan(amountAtomic: bigint, periodS: number, trialS: number) {
    return writeContractAsync({
      address: ADDRESSES.subscriptionManager,
      abi: SUBSCRIPTION_MANAGER_ABI,
      functionName: "createPlan",
      args: [ADDRESSES.usdc, amountAtomic, periodS, trialS],
    });
  }

  return {
    plans,
    subs,
    isLoading: plansLoading || versionsLoading || subsLoading,
    pending: isPending,
    createPlan,
  };
}
