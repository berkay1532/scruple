import { decodeEventLog, parseAbi } from "viem";
import type { DomainEvent } from "./db";

export const CARD_ISSUER_ABI = parseAbi([
  "event CardMinted(uint256 indexed cardId, address indexed owner, address signer)",
  "event CardFrozen(uint256 indexed cardId)",
  "event CardUnfrozen(uint256 indexed cardId)",
  "event CardCancelled(uint256 indexed cardId)",
  "event SpendAuthorized(uint256 indexed cardId, address indexed merchant, uint256 amount)",
]);

export const SUBSCRIPTION_MANAGER_ABI = parseAbi([
  "event PlanCreated(uint256 indexed planId, address indexed merchant, uint16 version)",
  "event PlanVersionPushed(uint256 indexed planId, uint16 version)",
  "event SubscriptionCreated(uint256 indexed subId, uint256 indexed planId, address indexed customer, uint256 cardId)",
  "event PaymentSucceeded(uint256 indexed subId, uint16 version, uint256 amount, uint256 fee)",
  "event SubscriptionExpired(uint256 indexed subId)",
  "event SubscriptionCancelled(uint256 indexed subId)",
]);

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

/** eventName → webhook taxonomy type. Unlisted events (SpendAuthorized, …) are not exported. */
const TAXONOMY: Record<string, string> = {
  CardMinted: "card.created",
  CardFrozen: "card.frozen",
  CardUnfrozen: "card.unfrozen",
  CardCancelled: "card.cancelled",
  PlanCreated: "plan.created",
  PlanVersionPushed: "plan.version_pushed",
  SubscriptionCreated: "subscription.created",
  PaymentSucceeded: "payment.succeeded",
  SubscriptionExpired: "subscription.expired",
  SubscriptionCancelled: "subscription.cancelled",
};

function stringifyArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) out[k] = String(v).toLowerCase().startsWith("0x") ? String(v).toLowerCase() : String(v);
  return out;
}

export function decodeLog(
  log: RawLog,
  addresses: { cardIssuer: string; subscriptionManager: string },
  at: number,
): DomainEvent | null {
  const addr = log.address.toLowerCase();
  let abi;
  if (addr === addresses.cardIssuer.toLowerCase()) abi = CARD_ISSUER_ABI;
  else if (addr === addresses.subscriptionManager.toLowerCase()) abi = SUBSCRIPTION_MANAGER_ABI;
  else return null;

  let decoded;
  try {
    decoded = decodeEventLog({
      abi,
      data: log.data as `0x${string}`,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
  } catch {
    return null; // unknown topic for this contract
  }

  const type = TAXONOMY[decoded.eventName];
  if (!type) return null;

  return {
    id: `${log.transactionHash}:${log.logIndex}`,
    type,
    blockNumber: log.blockNumber,
    payload: stringifyArgs(decoded.args as unknown as Record<string, unknown>),
    at,
  };
}
