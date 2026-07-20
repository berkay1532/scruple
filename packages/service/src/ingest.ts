import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "./db";
import { signBody } from "./webhooks";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function json(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };
    const onData = (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        cleanup();
        // Stop consuming but don't destroy the socket — destroying it here races
        // with the 413 response write, so clients can see a connection reset
        // instead of the response. Let the caller respond normally; the
        // `connection: close` header on the 413 tells Node to tear the socket
        // down cleanly once the response has flushed.
        req.removeAllListeners("data");
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** HTTP surface: POST /ingest (HMAC, metered payments) + GET /events (bearer, dashboard). */
export function createIngestServer(opts: { store: Store; secret: string; now?: () => number }): Server {
  const { store, secret } = opts;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "POST" && url.pathname === "/ingest") {
        let bodyBuf: Buffer;
        try {
          bodyBuf = await readBody(req);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            // The client may still be mid-send; tell it to stop and close the
            // socket only after this response has flushed, so it observes the
            // 413 rather than an abrupt reset.
            return json(res, 413, { error: "body too large" }, { connection: "close" });
          }
          throw err;
        }
        const body = bodyBuf.toString("utf8");
        const sig = req.headers["scruple-signature"];
        if (typeof sig !== "string" || !safeEqual(sig, `sha256=${signBody(secret, body)}`)) {
          return json(res, 401, { error: "bad signature" });
        }
        let p: unknown;
        try {
          p = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "bad payload" });
        }
        if (p === null || typeof p !== "object" || Array.isArray(p)) {
          return json(res, 400, { error: "bad payload" });
        }
        const payload = p as Record<string, unknown>;
        if (
          typeof payload.id !== "string" || typeof payload.endpoint !== "string" || typeof payload.price !== "string" ||
          !Number.isFinite(payload.at) || typeof payload.atomic !== "string" || !/^\d+$/.test(payload.atomic)
        ) {
          return json(res, 400, { error: "bad payload" });
        }
        const inserted = store.insertEvent({
          id: `metered:${payload.id}`,
          type: "settlement.batched",
          blockNumber: null,
          payload: {
            endpoint: payload.endpoint,
            payer: typeof payload.payer === "string" ? payload.payer : "",
            atomic: payload.atomic,
            price: payload.price,
            transaction: typeof payload.transaction === "string" ? payload.transaction : "",
          },
          at: payload.at as number,
        });
        return json(res, 200, { ok: true, inserted });
      }

      if (req.method === "GET" && url.pathname === "/events") {
        const auth = req.headers.authorization;
        if (typeof auth !== "string" || !safeEqual(auth, `Bearer ${secret}`)) {
          return json(res, 401, { error: "unauthorized" });
        }
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        const type = url.searchParams.get("type") ?? undefined;
        const events = store.listRecentEvents({ limit, type }).map((e) => ({
          ...e,
          blockNumber: e.blockNumber === null ? null : e.blockNumber.toString(),
        }));
        return json(res, 200, { events });
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[scruple-service] ingest request failed:", err);
      return json(res, 500, { error: "internal" });
    }
  });
}
