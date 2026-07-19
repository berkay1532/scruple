import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { scruple, type PaidRequest } from "../src/middleware";
import { buildPaymentRequirements, type Facilitator } from "../src/x402";

const SELLER = "0x00000000000000000000000000000000000SE11e";

function makeApp(facilitator: Facilitator, onPayment?: (e: any) => void) {
  const app = express();
  app.use(scruple({
    rateCard: { "GET /api/quote": "$0.001" },
    sellerAddress: SELLER,
    facilitator,
    onPayment,
  }));
  app.get("/api/quote", (req, res) => {
    res.json({ quote: 42, payer: (req as PaidRequest).payment?.payer });
  });
  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  return app;
}

const okFacilitator: Facilitator = {
  settle: async () => ({ success: true, payer: "0xPAYER", transaction: "0xTX" }),
};

function encodePayload() {
  return Buffer.from(JSON.stringify({ x402Version: 2, payload: { sig: "0xabc" } })).toString("base64");
}

describe("scruple middleware", () => {
  it("passes unpriced routes through untouched", async () => {
    const res = await request(makeApp(okFacilitator)).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["payment-required"]).toBeUndefined();
  });

  it("returns 402 with PAYMENT-REQUIRED header when no payment attached", async () => {
    const res = await request(makeApp(okFacilitator)).get("/api/quote");
    expect(res.status).toBe(402);
    expect(res.body).toEqual({});
    const decoded = JSON.parse(Buffer.from(res.headers["payment-required"], "base64").toString());
    expect(decoded.accepts[0]).toEqual(buildPaymentRequirements({ atomic: 1000n, payTo: SELLER }));
    expect(decoded.resource.url).toBe("/api/quote");
  });

  it("settles and serves when payment-signature is valid", async () => {
    const settle = vi.fn(async () => ({ success: true, payer: "0xPAYER", transaction: "0xTX" }));
    const events: any[] = [];
    const app = makeApp({ settle }, (e) => events.push(e));
    const res = await request(app).get("/api/quote").set("payment-signature", encodePayload());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ quote: 42, payer: "0xPAYER" });
    expect(settle).toHaveBeenCalledOnce();
    const [payload, requirements] = settle.mock.calls[0];
    expect(payload.x402Version).toBe(2);
    expect(requirements.amount).toBe("1000");
    const pr = JSON.parse(Buffer.from(res.headers["payment-response"], "base64").toString());
    expect(pr).toEqual({ success: true, transaction: "0xTX", network: "eip155:5042002", payer: "0xPAYER" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ endpoint: "/api/quote", payer: "0xPAYER", atomic: 1000n, price: "$0.001" });
  });

  it("returns 402 with reason when settlement fails, and does not serve", async () => {
    const app = makeApp({ settle: async () => ({ success: false, errorReason: "insufficient_balance" }) });
    const res = await request(app).get("/api/quote").set("payment-signature", encodePayload());
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: "Payment settlement failed", reason: "insufficient_balance" });
  });

  it("returns 402 for malformed payment-signature without calling settle", async () => {
    const settle = vi.fn();
    const res = await request(makeApp({ settle } as unknown as Facilitator))
      .get("/api/quote").set("payment-signature", "!!!garbage!!!");
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("Malformed payment");
    expect(settle).not.toHaveBeenCalled();
  });
});
