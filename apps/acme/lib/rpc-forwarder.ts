// Copy of apps/dashboard/lib/rpc-forwarder.ts — third consumer; extract to a
// shared package post-hackathon.
//
// Smooths bursts of JSON-RPC forwards against a rate-limited upstream (the
// public Arc RPC rejects bursts with `{code:-32011,"request limit reached"}`
// when several page-load reads land in parallel). All forwards share one
// serial queue with a minimum gap between upstream requests, and retry
// rate-limited responses with backoff before giving up. Kept separate from
// the route handler so it's testable with an injected fetch/sleep/clock and
// without a live network.
export interface RpcForwarderOptions {
  /** Upstream JSON-RPC endpoint. Never logged or echoed back — may embed an auth token. */
  upstream: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Minimum time between consecutive upstream requests, in ms. */
  minGapMs?: number;
  /** Max attempts (including the first) for a rate-limited request. */
  maxAttempts?: number;
  /** Base backoff, in ms; delay before attempt N is backoffMs * N. */
  backoffMs?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /** Injectable delay, for deterministic tests (avoid real timers). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RpcForwarder {
  forward(body: string): Promise<{ status: number; body: string }>;
}

const RATE_LIMIT_CODE = -32011;
const UPSTREAM_UNAVAILABLE = { status: 502, body: '{"error":"rpc upstream unavailable"}' } as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if a single JSON-RPC response object carries the "request limit
 * reached" error code. */
function objectIsRateLimited(parsed: unknown): boolean {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const err = (parsed as { error?: unknown }).error;
    if (err && typeof err === "object" && "code" in err) {
      return (err as { code?: unknown }).code === RATE_LIMIT_CODE;
    }
  }
  return false;
}

/** True if a JSON-RPC error body carries the "request limit reached" code,
 * or the transport-level status is 429. Batch requests (wagmi/viem's
 * `http(url, { batch })` transport) send a JSON array of requests and get
 * back a JSON array of responses — the upstream can rate-limit just one
 * element of the batch while the rest succeed, so an array response is
 * treated as rate-limited when ANY element carries the -32011 code (a
 * per-object `.error.code` check alone would silently miss this, since a
 * top-level array has no `.error` of its own). */
function isRateLimited(status: number, parsed: unknown): boolean {
  if (status === 429) return true;
  if (Array.isArray(parsed)) {
    return parsed.some((item) => objectIsRateLimited(item));
  }
  return objectIsRateLimited(parsed);
}

export function createRpcForwarder(opts: RpcForwarderOptions): RpcForwarder {
  const {
    upstream,
    fetchImpl = fetch,
    minGapMs = 75,
    maxAttempts = 4,
    backoffMs = 400,
    now = Date.now,
    sleep = defaultSleep,
  } = opts;

  // Serial promise-chain queue: every forward() call is appended here so
  // concurrent callers never race each other to the upstream. lastRequestAt
  // tracks when the last upstream request actually went out, so we can wait
  // out the remainder of minGapMs before the next one.
  let queue: Promise<void> = Promise.resolve();
  let lastRequestAt = -Infinity;

  async function waitForGap(): Promise<void> {
    const elapsed = now() - lastRequestAt;
    if (elapsed < minGapMs) {
      await sleep(minGapMs - elapsed);
    }
  }

  type Attempt =
    | { ok: true; status: number; body: string; parsed: unknown }
    | { ok: false };

  async function attemptOnce(body: string): Promise<Attempt> {
    await waitForGap();
    lastRequestAt = now();

    let res: Response;
    try {
      res = await fetchImpl(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch {
      return { ok: false };
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      return { ok: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false };
    }

    return { ok: true, status: res.status, body: text, parsed };
  }

  async function doForward(body: string): Promise<{ status: number; body: string }> {
    let last: { status: number; body: string } = UPSTREAM_UNAVAILABLE;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await attemptOnce(body);
      if (!result.ok) {
        return UPSTREAM_UNAVAILABLE;
      }

      last = { status: result.status, body: result.body };

      if (!isRateLimited(result.status, result.parsed)) {
        return last;
      }

      // Rate-limited: retry with backoff unless this was the last attempt.
      // Other JSON-RPC errors (e.g. reverts) are legitimate and fall through
      // the branch above untouched.
      if (attempt < maxAttempts) {
        await sleep(backoffMs * attempt);
      }
    }

    // Exhausted retries — hand back the last rate-limited response as-is
    // (upstream's own status, typically 200 with a JSON-RPC error body) and
    // let the client's own retry / last-good-value handling take over.
    return last;
  }

  function forward(body: string): Promise<{ status: number; body: string }> {
    const task = queue.then(() => doForward(body));
    // Keep the queue alive even if this task rejects/errors, so later
    // forwards aren't blocked by an earlier failure.
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  return { forward };
}
