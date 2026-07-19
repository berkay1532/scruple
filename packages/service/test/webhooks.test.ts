import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { Store, type DomainEvent } from "../src/db";
import { Dispatcher, signBody, RETRY_DELAYS_S } from "../src/webhooks";

function ev(id: string, at = 1000): DomainEvent {
  return { id, type: "payment.succeeded", blockNumber: 1n, payload: { subId: "7" }, at };
}

function setup(fetchImpl: typeof fetch, nowMs = 1000) {
  const store = new Store(":memory:");
  store.addEndpoint("https://hooks.example/a", "s3cr3t");
  store.insertEvent(ev("0xaa:1", nowMs));
  const dispatcher = new Dispatcher({ store, fetchImpl, now: () => nowMs });
  return { store, dispatcher };
}

describe("signBody", () => {
  it("is hex HMAC-SHA256", () => {
    expect(signBody("k", "body")).toBe(createHmac("sha256", "k").update("body").digest("hex"));
  });
});

describe("Dispatcher.dispatchDue", () => {
  it("delivers with signature and id headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const { store, dispatcher } = setup(fetchImpl as unknown as typeof fetch);
    const res = await dispatcher.dispatchDue();
    expect(res).toEqual({ delivered: 1, failed: 0 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example/a");
    const body = init.body as string;
    const headers = init.headers as Record<string, string>;
    expect(headers["scruple-event-id"]).toBe("0xaa:1");
    expect(headers["scruple-signature"]).toBe(`sha256=${signBody("s3cr3t", body)}`);
    expect(JSON.parse(body).id).toBe("0xaa:1");
    expect(store.duePending(9_999_999)).toHaveLength(0); // delivered
  });

  it("schedules the documented retry delays on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const { store, dispatcher } = setup(fetchImpl as unknown as typeof fetch, 1000);
    await dispatcher.dispatchDue();
    expect(store.duePending(1000)).toHaveLength(0);
    expect(store.duePending(1000 + RETRY_DELAYS_S[0] * 1000)).toHaveLength(1);
  });

  it("treats fetch rejection like failure and eventually kills the delivery", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const store = new Store(":memory:");
    store.addEndpoint("https://hooks.example/a", "s");
    store.insertEvent(ev("0xaa:1", 0));
    let t = 0;
    const dispatcher = new Dispatcher({ store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t });
    for (let i = 0; i <= RETRY_DELAYS_S.length; i++) {
      await dispatcher.dispatchDue();
      t += 43_200_000; // jump past any scheduled delay
    }
    expect(store.duePending(t + 1)).toHaveLength(0); // dead, never due again
    expect(fetchImpl).toHaveBeenCalledTimes(RETRY_DELAYS_S.length + 1); // 1 initial + 5 retries
  });

  it("one endpoint failing does not block another", async () => {
    const store = new Store(":memory:");
    store.addEndpoint("https://hooks.example/bad", "s1");
    store.addEndpoint("https://hooks.example/good", "s2");
    store.insertEvent(ev("0xaa:1", 0));
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("bad") ? new Response("x", { status: 500 }) : new Response("ok", { status: 200 }),
    );
    const dispatcher = new Dispatcher({ store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    expect(await dispatcher.dispatchDue()).toEqual({ delivered: 1, failed: 1 });
  });
});
