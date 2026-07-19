import { describe, it, expect, vi } from "vitest";
import { ScrupleClient, PolicyExceededError, MalformedChallengeError } from "../src/client";
import { PolicyTracker } from "../src/policy";

const URL_ = "https://api.example.com/api/quote";

function challenge(atomic: bigint) {
  const envelope = { x402Version: 2, accepts: [{ amount: atomic.toString() }] };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

function fetch402(atomic: bigint) {
  return vi.fn(async () => new Response("{}", {
    status: 402,
    headers: { "PAYMENT-REQUIRED": challenge(atomic) },
  }));
}

describe("ScrupleClient.fetch", () => {
  it("returns non-402 responses without paying", async () => {
    const gateway = { pay: vi.fn() };
    const fetchImpl = vi.fn(async () => Response.json({ free: true }));
    const c = new ScrupleClient({ gateway, fetchImpl });
    const res = await c.fetch(URL_);
    expect(res).toEqual({ status: 200, data: { free: true } });
    expect(gateway.pay).not.toHaveBeenCalled();
  });

  it("pays a 402 within policy and records spend", async () => {
    const gateway = { pay: vi.fn(async () => ({ status: 200, data: { quote: 42 } })) };
    const policy = new PolicyTracker({ periodBudget: 10_000n, periodMs: 1000 });
    const c = new ScrupleClient({ gateway, policy, fetchImpl: fetch402(1000n) });
    const res = await c.fetch(URL_, { method: "GET" });
    expect(res).toEqual({ status: 200, data: { quote: 42 }, paid: { atomic: 1000n } });
    expect(gateway.pay).toHaveBeenCalledWith(URL_, { method: "GET" });
    expect(policy.spentInPeriod()).toBe(1000n);
  });

  it("refuses payment beyond policy without calling pay", async () => {
    const gateway = { pay: vi.fn() };
    const policy = new PolicyTracker({ periodBudget: 500n, periodMs: 1000 });
    const c = new ScrupleClient({ gateway, policy, fetchImpl: fetch402(1000n) });
    await expect(c.fetch(URL_)).rejects.toThrow(PolicyExceededError);
    expect(gateway.pay).not.toHaveBeenCalled();
    expect(policy.spentInPeriod()).toBe(0n);
  });

  it("enforces origin allowlist", async () => {
    const gateway = { pay: vi.fn() };
    const policy = new PolicyTracker({
      periodBudget: 10_000n, periodMs: 1000, allowedOrigins: ["https://other.example"],
    });
    const c = new ScrupleClient({ gateway, policy, fetchImpl: fetch402(1n) });
    await expect(c.fetch(URL_)).rejects.toMatchObject({ reason: "origin_not_allowed" });
  });

  it("pays without limits when no policy given", async () => {
    const gateway = { pay: vi.fn(async () => ({ status: 200, data: "ok" })) };
    const c = new ScrupleClient({ gateway, fetchImpl: fetch402(999_999n) });
    const res = await c.fetch(URL_);
    expect(res.paid).toEqual({ atomic: 999_999n });
  });

  it("throws MalformedChallengeError when 402 lacks a decodable challenge", async () => {
    const gateway = { pay: vi.fn() };
    const bad = vi.fn(async () => new Response("{}", { status: 402 }));
    const c = new ScrupleClient({ gateway, fetchImpl: bad });
    await expect(c.fetch(URL_)).rejects.toThrow(MalformedChallengeError);
  });

  it("throws MalformedChallengeError for a non-positive challenge amount", async () => {
    const gateway = { pay: vi.fn() };
    const c = new ScrupleClient({ gateway, fetchImpl: fetch402(0n) });
    await expect(c.fetch(URL_)).rejects.toThrow(MalformedChallengeError);
    expect(gateway.pay).not.toHaveBeenCalled();
  });

  it("does not keep reserved spend when pay rejects", async () => {
    const gateway = { pay: vi.fn(async () => { throw new Error("network down"); }) };
    const policy = new PolicyTracker({ periodBudget: 10_000n, periodMs: 1000 });
    const c = new ScrupleClient({ gateway, policy, fetchImpl: fetch402(1000n) });
    await expect(c.fetch(URL_)).rejects.toThrow("network down");
    expect(policy.spentInPeriod()).toBe(0n);
  });

  it("reconciles the recorded spend when the gateway pays a different amount than challenged", async () => {
    const gateway = { pay: vi.fn(async () => ({ status: 200, data: "ok", amount: 1200n })) };
    const policy = new PolicyTracker({ periodBudget: 10_000n, periodMs: 1000 });
    const c = new ScrupleClient({ gateway, policy, fetchImpl: fetch402(1000n) });
    const res = await c.fetch(URL_);
    expect(res.paid).toEqual({ atomic: 1200n });
    expect(policy.spentInPeriod()).toBe(1200n);
  });

  it("prevents concurrent overspend", async () => {
    const gateway = {
      pay: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { status: 200, data: { quote: 42 } };
      }),
    };
    const policy = new PolicyTracker({ periodBudget: 1500n, periodMs: 1000 });
    const c = new ScrupleClient({ gateway, policy, fetchImpl: fetch402(1000n) });
    const [a, b] = await Promise.allSettled([c.fetch(URL_), c.fetch(URL_)]);
    const results = [a, b];
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PolicyExceededError);
    expect(policy.spentInPeriod()).toBe(1000n);
  });
});
