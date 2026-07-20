// Human-readable ABI fragments for the two Arc contracts the dashboard reads
// and writes. Struct shapes copied verbatim from contracts/src/CardIssuer.sol
// (Card) and contracts/src/SubscriptionManager.sol (Subscription/Plan/
// PlanVersion) — the latter also mirrors packages/service/bin/service.ts's
// SUBS_READ_ABI so the two ends of the stack decode chain state identically.
import { parseAbi } from "viem";

export const CARD_ISSUER_ABI = parseAbi([
  "struct Card { address owner; address signer; address token; uint256 periodAmount; uint48 periodDuration; uint48 expiry; uint8 state; uint48 periodStart; uint256 spentInPeriod; bool useAllowlist; }",
  "function getCard(uint256 cardId) view returns (Card memory)",
  "function mintCard(address signer, address token, uint256 periodAmount, uint48 periodDuration, uint48 expiry, address[] allowedMerchants) returns (uint256 cardId)",
  "function freeze(uint256 cardId)",
  "function unfreeze(uint256 cardId)",
  "function cancel(uint256 cardId)",
]);

export const SUBSCRIPTION_MANAGER_ABI = parseAbi([
  "struct Subscription { address customer; uint256 planId; uint16 planVersion; uint256 cardId; uint48 nextChargeAt; uint8 state; }",
  "struct Plan { address merchant; address token; uint16 latestVersion; bool active; }",
  "struct PlanVersion { uint256 amount; uint48 period; uint48 trialPeriod; }",
  "function createPlan(address token, uint256 amount, uint48 period, uint48 trialPeriod) returns (uint256 planId)",
  "function subscribe(uint256 planId, uint256 cardId) returns (uint256 subId)",
  "function getSubscription(uint256 subId) view returns (Subscription memory)",
  "function getPlan(uint256 planId) view returns (Plan memory)",
  "function getPlanVersion(uint256 planId, uint16 version) view returns (PlanVersion memory)",
]);
