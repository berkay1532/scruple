import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC, ARC_TESTNET_GATEWAY_WALLET } from "./constants";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; verifyingContract: string };
}

export interface PaymentPayload {
  x402Version: number;
  resource?: unknown;
  accepted?: unknown;
  payload: Record<string, unknown>;
  extensions?: unknown;
}

export interface SettleResult {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string | null;
}

/** Injected settlement boundary — production impl is Circle's BatchFacilitatorClient. */
export interface Facilitator {
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult>;
}

export class MalformedPaymentError extends Error {
  constructor(detail: string) {
    super(`Malformed payment-signature header: ${detail}`);
    this.name = "MalformedPaymentError";
  }
}

export function buildPaymentRequirements(opts: { atomic: bigint; payTo: string }): PaymentRequirements {
  return {
    scheme: "exact",
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: opts.atomic.toString(),
    payTo: opts.payTo,
    maxTimeoutSeconds: 345600,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  };
}

export function buildPaymentRequiredHeader(opts: {
  endpoint: string;
  price: string;
  requirements: PaymentRequirements;
}): string {
  const envelope = {
    x402Version: 2,
    resource: {
      url: opts.endpoint,
      description: `Paid resource (${opts.price} USDC)`,
      mimeType: "application/json",
    },
    accepts: [opts.requirements],
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

export function decodePaymentSignature(header: string): PaymentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    throw new MalformedPaymentError("not base64-encoded JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MalformedPaymentError("payload is not an object");
  }
  return parsed as PaymentPayload;
}
