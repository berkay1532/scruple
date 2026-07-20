import { createHmac } from "node:crypto";
import type { PaymentEvent } from "./middleware";

/**
 * Returns an onPayment handler that forwards metered payments to the
 * Scruple service ingest endpoint (which turns them into settlement.batched
 * events + merchant webhooks). Fire-and-forget: failures are logged, never
 * thrown — a dead service must not affect payment serving.
 */
export function createServiceForwarder(opts: {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (e: PaymentEvent) => Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return async (e: PaymentEvent) => {
    const body = JSON.stringify({ ...e, atomic: e.atomic.toString() });
    const signature = createHmac("sha256", opts.secret).update(body).digest("hex");
    try {
      const res = await fetchImpl(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", "scruple-signature": `sha256=${signature}` },
        body,
        // A hang is treated exactly like a failure: the abort rejects the fetch, which the catch below routes to logging.
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status < 200 || res.status >= 300) {
        console.error("[scruple] service forward failed:", res.status);
      }
    } catch (err) {
      console.error("[scruple] service forward failed:", err);
    }
  };
}
