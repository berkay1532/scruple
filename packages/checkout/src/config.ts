// Chain id, deployed contract defaults, and ABI fragments for the checkout
// embed. Struct/tuple shapes copied verbatim from apps/dashboard/lib/abi.ts
// (itself copied from contracts/src/CardIssuer.sol and
// contracts/src/SubscriptionManager.sol) so the embed decodes chain state
// identically to the dashboard. Adds `nextCardId`/`allowlist` (buyer card
// discovery) and `nextSubId` (pre-read to learn a fresh subscription's id —
// see use-checkout.ts) read fragments that the dashboard's read-only ABI
// doesn't need.
import { erc20Abi, parseAbi } from "viem";

export const ARC_CHAIN_ID = 5042002;

export const DEFAULT_ADDRESSES = {
  subscriptionManager: "0x3d0b19b6B06E568A23AA916270008012Dca55795" as `0x${string}`,
  cardIssuer: "0xE20EB808cF87B73D716C96CBbb1eee62282506d0" as `0x${string}`,
  usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
} as const;

export const SUBSCRIPTION_MANAGER_ABI = parseAbi([
  "struct Plan { address merchant; address token; uint16 latestVersion; bool active; }",
  "struct PlanVersion { uint256 amount; uint48 period; uint48 trialPeriod; }",
  "function getPlan(uint256 planId) view returns (Plan memory)",
  "function getPlanVersion(uint256 planId, uint16 version) view returns (PlanVersion memory)",
  "function subscribe(uint256 planId, uint256 cardId) returns (uint256 subId)",
  "function nextSubId() view returns (uint256)",
  "function getSubscription(uint256) view returns ((address customer, uint256 planId, uint16 planVersion, uint256 cardId, uint48 nextChargeAt, uint8 state))",
]);

export const CARD_ISSUER_ABI = parseAbi([
  "struct Card { address owner; address signer; address token; uint256 periodAmount; uint48 periodDuration; uint48 expiry; uint8 state; uint48 periodStart; uint256 spentInPeriod; bool useAllowlist; }",
  "function nextCardId() view returns (uint256)",
  "function getCard(uint256 cardId) view returns (Card memory)",
  "function allowlist(uint256 cardId, address merchant) view returns (bool)",
  "function mintCard(address signer, address token, uint256 periodAmount, uint48 periodDuration, uint48 expiry, address[] allowedMerchants) returns (uint256 cardId)",
]);

// viem's erc20Abi already covers `allowance`/`approve` with the exact
// standard tuple shapes; no need to hand-roll a subset.
export const USDC_ABI = erc20Abi;
