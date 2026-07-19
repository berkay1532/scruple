import { describe, it, expect } from "vitest";
import { decodeLog, CARD_ISSUER_ABI, SUBSCRIPTION_MANAGER_ABI, type RawLog } from "../src/events";
import { encodeEventLog } from "./helpers";

const ISSUER = "0x1111111111111111111111111111111111111111";
const SUBS = "0x2222222222222222222222222222222222222222";
const ADDRS = { cardIssuer: ISSUER, subscriptionManager: SUBS };

function log(address: string, enc: { data: `0x${string}`; topics: readonly `0x${string}`[] }, idx = 3): RawLog {
  return { address, topics: [...enc.topics], data: enc.data, blockNumber: 100n, transactionHash: "0xdead", logIndex: idx };
}

describe("decodeLog", () => {
  it("maps PaymentSucceeded to payment.succeeded with stringified bigints", () => {
    const enc = encodeEventLog({
      abi: SUBSCRIPTION_MANAGER_ABI,
      eventName: "PaymentSucceeded",
      args: { subId: 7n, version: 2, amount: 29_000_000n, fee: 290_000n },
    });
    const e = decodeLog(log(SUBS, enc), ADDRS, 1234);
    expect(e).toEqual({
      id: "0xdead:3",
      type: "payment.succeeded",
      blockNumber: 100n,
      payload: { subId: "7", version: "2", amount: "29000000", fee: "290000" },
      at: 1234,
    });
  });

  it("maps SubscriptionCreated with all identity fields", () => {
    const enc = encodeEventLog({
      abi: SUBSCRIPTION_MANAGER_ABI,
      eventName: "SubscriptionCreated",
      args: { subId: 7n, planId: 1n, customer: "0x00000000000000000000000000000000000000AA", cardId: 5n },
    });
    const e = decodeLog(log(SUBS, enc), ADDRS, 1);
    expect(e?.type).toBe("subscription.created");
    expect(e?.payload).toEqual({
      subId: "7", planId: "1", customer: "0x00000000000000000000000000000000000000aa", cardId: "5",
    });
  });

  it("maps CardMinted / CardFrozen from the issuer address only", () => {
    const enc = encodeEventLog({
      abi: CARD_ISSUER_ABI,
      eventName: "CardMinted",
      args: { cardId: 5n, owner: "0x00000000000000000000000000000000000000bb", signer: "0x00000000000000000000000000000000000000cc" },
    });
    expect(decodeLog(log(ISSUER, enc), ADDRS, 1)?.type).toBe("card.created");
    expect(decodeLog(log(SUBS, enc), ADDRS, 1)).toBeNull(); // wrong contract for this topic
  });

  it("is case-insensitive on addresses", () => {
    const enc = encodeEventLog({ abi: CARD_ISSUER_ABI, eventName: "CardFrozen", args: { cardId: 5n } });
    expect(decodeLog(log(ISSUER.toUpperCase().replace("0X", "0x"), enc), ADDRS, 1)?.type).toBe("card.frozen");
  });

  it("returns null for unknown events and addresses", () => {
    const enc = encodeEventLog({
      abi: CARD_ISSUER_ABI,
      eventName: "SpendAuthorized",
      args: { cardId: 5n, merchant: "0x00000000000000000000000000000000000000dd", amount: 1n },
    });
    expect(decodeLog(log(ISSUER, enc), ADDRS, 1)).toBeNull();               // unmapped by design
    expect(decodeLog(log("0x9999999999999999999999999999999999999999", enc), ADDRS, 1)).toBeNull();
  });
});
