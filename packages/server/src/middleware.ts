import type { Request, RequestHandler } from "express";
import { matchRoute, type RateCard } from "./ratecard";
import { ARC_TESTNET_NETWORK } from "./constants";
import {
  buildPaymentRequirements, buildPaymentRequiredHeader,
  decodePaymentSignature, MalformedPaymentError, type Facilitator,
} from "./x402";

export interface PaymentEvent {
  endpoint: string;
  payer?: string;
  atomic: bigint;
  price: string;
  transaction?: string | null;
  at: number;
}

export interface PaidRequest extends Request {
  payment?: { payer?: string; atomic: bigint; transaction?: string | null };
}

export interface ScrupleOptions {
  rateCard: RateCard;
  sellerAddress: string;
  facilitator: Facilitator;
  onPayment?: (e: PaymentEvent) => void;
}

export function scruple(opts: ScrupleOptions): RequestHandler {
  return async (req, res, next) => {
    const match = matchRoute(opts.rateCard, req.method, req.path);
    if (!match) return next();

    const requirements = buildPaymentRequirements({ atomic: match.atomic, payTo: opts.sellerAddress });
    const header = req.headers["payment-signature"];
    if (typeof header !== "string") {
      res.status(402)
        .set("PAYMENT-REQUIRED", buildPaymentRequiredHeader({
          endpoint: req.path, price: match.price, requirements,
        }))
        .json({});
      return;
    }

    let payload;
    try {
      payload = decodePaymentSignature(header);
    } catch (err) {
      if (err instanceof MalformedPaymentError) {
        res.status(402).json({ error: "Malformed payment", reason: err.message });
        return;
      }
      res.status(402).json({ error: "Malformed payment", reason: "unexpected decode error" });
      return;
    }

    let settled;
    try {
      settled = await opts.facilitator.settle(payload, requirements);
    } catch (err) {
      res.status(402).json({ error: "Payment settlement failed", reason: "settlement_unavailable" });
      return;
    }
    if (!settled.success) {
      res.status(402).json({ error: "Payment settlement failed", reason: settled.errorReason });
      return;
    }

    (req as PaidRequest).payment = {
      payer: settled.payer, atomic: match.atomic, transaction: settled.transaction,
    };
    res.set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({
      success: true, transaction: settled.transaction ?? null,
      network: ARC_TESTNET_NETWORK, payer: settled.payer,
    })).toString("base64"));
    try {
      opts.onPayment?.({
        endpoint: req.path, payer: settled.payer, atomic: match.atomic,
        price: match.price, transaction: settled.transaction, at: Date.now(),
      });
    } catch (err) {
      console.error("[scruple] onPayment callback threw:", err);
    }
    next();
  };
}
