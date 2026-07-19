import { describe, it, expect } from "vitest";
import {
  buildPaymentRequirements, buildPaymentRequiredHeader,
  decodePaymentSignature, MalformedPaymentError,
} from "../src/x402";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC, ARC_TESTNET_GATEWAY_WALLET } from "../src/constants";

const SELLER = "0x00000000000000000000000000000000000SE11e" as const;

describe("buildPaymentRequirements", () => {
  it("produces the exact Circle Gateway shape", () => {
    expect(buildPaymentRequirements({ atomic: 1000n, payTo: SELLER })).toEqual({
      scheme: "exact",
      network: ARC_TESTNET_NETWORK,
      asset: ARC_TESTNET_USDC,
      amount: "1000",
      payTo: SELLER,
      maxTimeoutSeconds: 345600,
      extra: {
        name: "GatewayWalletBatched",
        version: "1",
        verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
      },
    });
  });
});

describe("buildPaymentRequiredHeader / decode roundtrip", () => {
  it("base64-encodes the x402 v2 payment-required envelope", () => {
    const requirements = buildPaymentRequirements({ atomic: 1000n, payTo: SELLER });
    const header = buildPaymentRequiredHeader({ endpoint: "/api/quote", price: "$0.001", requirements });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe("/api/quote");
    expect(decoded.resource.description).toBe("Paid resource ($0.001 USDC)");
    expect(decoded.accepts).toEqual([requirements]);
  });
});

describe("decodePaymentSignature", () => {
  it("decodes a base64 payment payload", () => {
    const payload = { x402Version: 2, payload: { signature: "0xabc" } };
    const header = Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(decodePaymentSignature(header)).toEqual(payload);
  });
  it("throws MalformedPaymentError on garbage", () => {
    expect(() => decodePaymentSignature("!!!not-base64-json!!!")).toThrow(MalformedPaymentError);
    expect(() => decodePaymentSignature(Buffer.from("[1,2,3]").toString("base64"))).toThrow(MalformedPaymentError);
  });
});
