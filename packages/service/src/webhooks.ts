import { createHmac } from "node:crypto";
import type { Store } from "./db";

/**
 * THE retry schedule (seconds). First attempt is immediate; each failure
 * reschedules by RETRY_DELAYS_S[attemptsSoFar]; after the last entry the
 * delivery is dead. Documented here and nowhere else.
 */
export const RETRY_DELAYS_S = [60, 300, 1800, 7200, 43200] as const;

export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export class Dispatcher {
  private readonly store: Store;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: { store: Store; fetchImpl?: typeof fetch; now?: () => number }) {
    this.store = opts.store;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async dispatchDue(): Promise<{ delivered: number; failed: number }> {
    const now = this.now();
    let delivered = 0;
    let failed = 0;
    for (const d of this.store.duePending(now)) {
      let ok = false;
      let status: number | null = null;
      try {
        const res = await this.fetchImpl(d.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "scruple-event-id": d.eventId,
            "scruple-signature": `sha256=${signBody(d.secret, d.body)}`,
          },
          body: d.body,
        });
        status = res.status;
        ok = res.status >= 200 && res.status < 300;
      } catch {
        ok = false;
      }
      if (ok) {
        delivered += 1;
        this.store.markAttempt(d.eventId, d.endpointId, { ok: true, status, now, nextAttemptAt: null });
      } else {
        failed += 1;
        const delay = d.attempts < RETRY_DELAYS_S.length ? RETRY_DELAYS_S[d.attempts] * 1000 : null;
        this.store.markAttempt(d.eventId, d.endpointId, {
          ok: false,
          status,
          now,
          nextAttemptAt: delay === null ? null : now + delay,
        });
      }
    }
    return { delivered, failed };
  }
}
