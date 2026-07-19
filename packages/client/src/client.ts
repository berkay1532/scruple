import type { PolicyTracker } from "./policy";

export interface GatewayLike {
  pay(url: string, opts?: { method?: string; body?: unknown }): Promise<{
    status: number; data: unknown; formattedAmount?: string;
  }>;
}

export interface ScrupleResponse {
  status: number;
  data: unknown;
  paid?: { atomic: bigint };
}

export class PolicyExceededError extends Error {
  constructor(public readonly reason: string, public readonly atomic: bigint) {
    super(`Payment of ${atomic} atomic USDC refused by spending policy: ${reason}`);
    this.name = "PolicyExceededError";
  }
}

export class MalformedChallengeError extends Error {
  constructor(detail: string) {
    super(`402 response without a valid PAYMENT-REQUIRED challenge: ${detail}`);
    this.name = "MalformedChallengeError";
  }
}

export class ScrupleClient {
  private readonly gateway: GatewayLike;
  private readonly policy?: PolicyTracker;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { gateway: GatewayLike; policy?: PolicyTracker; fetchImpl?: typeof fetch }) {
    this.gateway = opts.gateway;
    this.policy = opts.policy;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async fetch(url: string, init?: { method?: string; body?: unknown }): Promise<ScrupleResponse> {
    const first = await this.fetchImpl(url, init as RequestInit | undefined);
    if (first.status !== 402) {
      return { status: first.status, data: await safeJson(first) };
    }

    const header = first.headers.get("PAYMENT-REQUIRED");
    if (!header) throw new MalformedChallengeError("missing header");
    let atomic: bigint;
    try {
      const envelope = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
      atomic = BigInt(envelope.accepts[0].amount);
    } catch {
      throw new MalformedChallengeError("undecodable envelope");
    }
    if (atomic <= 0n) throw new MalformedChallengeError("non-positive amount");

    if (this.policy) {
      const decision = this.policy.check(atomic, new URL(url).origin);
      if (!decision.ok) throw new PolicyExceededError(decision.reason, atomic);
      // Reserve the spend synchronously (before the await below) so that
      // concurrent fetch() calls cannot both pass check() against the same
      // pre-spend state (TOCTOU). JS single-threading makes this check+record
      // pair atomic with respect to other fetch() calls.
      this.policy.record(atomic);
    }

    let result: { status: number; data: unknown; formattedAmount?: string };
    try {
      result = await this.gateway.pay(url, init);
    } catch (err) {
      this.policy?.release(atomic);
      throw err;
    }
    return { status: result.status, data: result.data, paid: { atomic } };
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
