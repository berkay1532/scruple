import { describe, expect, it, vi } from "vitest";
import { createRpcForwarder } from "../lib/rpc-forwarder";

const RATE_LIMITED_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  error: { code: -32011, message: "request limit reached" },
});

const OK_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" });

function jsonResponse(status: number, text: string): Response {
  return {
    status,
    text: async () => text,
  } as unknown as Response;
}

// Deterministic fake clock: sleep() advances the clock by exactly the
// requested amount (instead of waiting in real time) and logs every call,
// so tests can assert on gap/backoff timing without slowing down the suite.
function fakeClock() {
  let t = 0;
  const sleepLog: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleepLog.push(ms);
      t += ms;
    },
    sleepLog,
  };
}

describe("createRpcForwarder", () => {
  it("passes through a successful upstream response untouched", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    const clock = fakeClock();
    const forwarder = createRpcForwarder({
      upstream: "https://example.invalid/rpc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
    });

    const result = await forwarder.forward('{"method":"eth_blockNumber"}');

    expect(result).toEqual({ status: 200, body: OK_BODY });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a -32011 rate-limit error and returns the eventual success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, RATE_LIMITED_BODY))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    const clock = fakeClock();
    const forwarder = createRpcForwarder({
      upstream: "https://example.invalid/rpc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minGapMs: 0,
      backoffMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });

    const result = await forwarder.forward('{"method":"eth_blockNumber"}');

    expect(result).toEqual({ status: 200, body: OK_BODY });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // backoffMs * attempt(1) between the first and second attempt
    expect(clock.sleepLog).toContain(100);
  });

  it("gives up after maxAttempts and returns the last rate-limited body (status passthrough)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, RATE_LIMITED_BODY));
    const clock = fakeClock();
    const forwarder = createRpcForwarder({
      upstream: "https://example.invalid/rpc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minGapMs: 0,
      maxAttempts: 3,
      backoffMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });

    const result = await forwarder.forward('{"method":"eth_blockNumber"}');

    expect(result).toEqual({ status: 200, body: RATE_LIMITED_BODY });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // backoffMs * 1, then backoffMs * 2 (no sleep after the final attempt)
    expect(clock.sleepLog).toEqual([50, 100]);
  });

  it("passes other JSON-RPC errors (e.g. reverts) through untouched, without retrying", async () => {
    const revertBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "execution reverted" },
    });
    const fetchImpl = vi.fn(async () => jsonResponse(200, revertBody));
    const clock = fakeClock();
    const forwarder = createRpcForwarder({
      upstream: "https://example.invalid/rpc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
    });

    const result = await forwarder.forward('{"method":"eth_call"}');

    expect(result).toEqual({ status: 200, body: revertBody });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serializes two concurrent forwards with at least minGapMs between upstream requests", async () => {
    const calls: number[] = [];
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => {
      calls.push(clock.now());
      return jsonResponse(200, OK_BODY);
    });
    const forwarder = createRpcForwarder({
      upstream: "https://example.invalid/rpc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minGapMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    });

    const [first, second] = await Promise.all([
      forwarder.forward('{"method":"a"}'),
      forwarder.forward('{"method":"b"}'),
    ]);

    expect(first).toEqual({ status: 200, body: OK_BODY });
    expect(second).toEqual({ status: 200, body: OK_BODY });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // First request goes out immediately; the second waits out the gap.
    expect(calls[0]).toBe(0);
    expect(calls[1]).toBe(250);
    expect(clock.sleepLog).toEqual([250]);
  });

  it("returns a 502 when the fetch call rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const clock = fakeClock();
    const forwarder = createRpcForwarder({
      upstream: "https://example.invalid/rpc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
    });

    const result = await forwarder.forward('{"method":"eth_blockNumber"}');

    expect(result).toEqual({ status: 502, body: '{"error":"rpc upstream unavailable"}' });
  });

  it("returns a 502 when the upstream body is not valid JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, "<html>not json</html>"));
    const clock = fakeClock();
    const forwarder = createRpcForwarder({
      upstream: "https://example.invalid/rpc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
    });

    const result = await forwarder.forward('{"method":"eth_blockNumber"}');

    expect(result).toEqual({ status: 502, body: '{"error":"rpc upstream unavailable"}' });
  });
});
