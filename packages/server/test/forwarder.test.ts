import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createServiceForwarder } from "../src/forwarder";
import type { PaymentEvent } from "../src/middleware";

const EVENT: PaymentEvent = {
  id: "11111111-2222-3333-4444-555555555555",
  endpoint: "/api/quote",
  payer: "0xPAYER",
  atomic: 1000n,
  price: "$0.001",
  transaction: "0xTX",
  at: 1234,
};

describe("createServiceForwarder", () => {
  it("POSTs the event with a valid HMAC signature and stringified atomic", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const forward = createServiceForwarder({ url: "http://svc/ingest", secret: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await forward(EVENT);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://svc/ingest");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({ ...EVENT, atomic: "1000" });
    const expected = createHmac("sha256", "k").update(body).digest("hex");
    expect((init.headers as Record<string, string>)["scruple-signature"]).toBe(`sha256=${expected}`);
  });

  it("never throws — logs on non-2xx and on rejection", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = createServiceForwarder({ url: "http://svc/ingest", secret: "k", fetchImpl: (async () => new Response("x", { status: 500 })) as unknown as typeof fetch });
    await expect(bad(EVENT)).resolves.toBeUndefined();
    const boom = createServiceForwarder({ url: "http://svc/ingest", secret: "k", fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    await expect(boom(EVENT)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
