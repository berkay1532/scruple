import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DeliveryStatus, Store } from "./db";
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

function genSecret(): string {
  return `whsec_${randomBytes(16).toString("hex")}`;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const DELIVERY_STATUSES: readonly DeliveryStatus[] = ["delivered", "retrying", "pending", "dead"];

const DELIVERIES_RESEND_PREFIX = "/admin/deliveries/";
const RESEND_SUFFIX = "/resend";

/**
 * `/admin/deliveries/:endpointId/:eventId/resend` — eventIds may contain `:` (e.g.
 * `0xdead:7`) but never `/`, so split on the FIRST `/` after the prefix to get
 * endpointId, and take the rest (minus the trailing `/resend`) as the raw eventId.
 */
function parseResendPath(pathname: string): { endpointId: number; eventId: string } | null {
  if (!pathname.startsWith(DELIVERIES_RESEND_PREFIX) || !pathname.endsWith(RESEND_SUFFIX)) return null;
  const rest = pathname.slice(DELIVERIES_RESEND_PREFIX.length, pathname.length - RESEND_SUFFIX.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0) return null;
  const endpointIdStr = rest.slice(0, slashIdx);
  const eventId = rest.slice(slashIdx + 1);
  if (!/^\d+$/.test(endpointIdStr) || eventId.length === 0) return null;
  return { endpointId: Number(endpointIdStr), eventId };
}

/** HTTP surface: POST /ingest (HMAC, metered payments) + GET /events (bearer, dashboard) + /admin/* (bearer adminSecret, endpoint/delivery management). */
export function createIngestServer(opts: { store: Store; secret: string; adminSecret: string; now?: () => number }): Server {
  const { store, secret, adminSecret } = opts;
  const now = () => opts.now?.() ?? Date.now();

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
            // Carries the merchant this settlement belongs to (see
            // packages/server/src/middleware.ts's PaymentEvent.seller) so the
            // dashboard can scope metered revenue to the right merchant
            // instead of showing it to every connected wallet. Defaulted to
            // "" for callers on an older SDK version that doesn't send it —
            // the dashboard treats an unset seller as unattributable, not
            // "mine".
            seller: typeof payload.seller === "string" ? payload.seller : "",
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

      if (url.pathname.startsWith("/admin/")) {
        const auth = req.headers.authorization;
        if (typeof auth !== "string" || !safeEqual(auth, `Bearer ${adminSecret}`)) {
          return json(res, 401, { error: "unauthorized" });
        }

        if (req.method === "GET" && url.pathname === "/admin/endpoints") {
          return json(res, 200, { endpoints: store.listEndpointsAdmin() });
        }

        if (req.method === "POST" && url.pathname === "/admin/endpoints") {
          let bodyBuf: Buffer;
          try {
            bodyBuf = await readBody(req);
          } catch (err) {
            if (err instanceof BodyTooLargeError) {
              return json(res, 413, { error: "body too large" }, { connection: "close" });
            }
            throw err;
          }
          let p: unknown;
          try {
            p = JSON.parse(bodyBuf.toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "bad payload" });
          }
          if (p === null || typeof p !== "object" || Array.isArray(p)) {
            return json(res, 400, { error: "bad payload" });
          }
          const body = p as Record<string, unknown>;
          if (typeof body.url !== "string" || !isValidHttpUrl(body.url)) {
            return json(res, 400, { error: "bad url" });
          }
          const secretVal = typeof body.secret === "string" && body.secret.length > 0 ? body.secret : genSecret();
          const id = store.createEndpoint(body.url, secretVal);
          return json(res, 200, { id, url: body.url, secret: secretVal });
        }

        const idMatch = url.pathname.match(/^\/admin\/endpoints\/(\d+)$/);
        if (req.method === "DELETE" && idMatch) {
          const ok = store.deleteEndpoint(Number(idMatch[1]));
          return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "not found" });
        }

        const actionMatch = url.pathname.match(/^\/admin\/endpoints\/(\d+)\/(pause|resume|rotate)$/);
        if (req.method === "POST" && actionMatch) {
          const id = Number(actionMatch[1]);
          const action = actionMatch[2];
          if (action === "pause" || action === "resume") {
            const ok = store.setEndpointPaused(id, action === "pause");
            return ok ? json(res, 200, { ok: true, paused: action === "pause" }) : json(res, 404, { error: "not found" });
          }
          const newSecret = genSecret();
          const ok = store.rotateEndpointSecret(id, newSecret);
          return ok ? json(res, 200, { ok: true, secret: newSecret }) : json(res, 404, { error: "not found" });
        }

        if (req.method === "GET" && url.pathname === "/admin/deliveries") {
          const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
          const statusParam = url.searchParams.get("status");
          const status =
            statusParam && (DELIVERY_STATUSES as string[]).includes(statusParam) ? (statusParam as DeliveryStatus) : undefined;
          return json(res, 200, { deliveries: store.listDeliveries({ limit, status }) });
        }

        const resend = req.method === "POST" ? parseResendPath(url.pathname) : null;
        if (resend) {
          const ok = store.reviveDelivery(resend.eventId, resend.endpointId, now());
          return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "not found" });
        }

        const nudgeMatch = url.pathname.match(/^\/admin\/nudge\/([0-9]+)$/);
        if (req.method === "POST" && nudgeMatch) {
          const subId = nudgeMatch[1];
          const period = store.latestAttentionPeriod(subId);
          if (period === null) {
            return json(res, 404, { error: "nothing to nudge" });
          }
          const emitted = store.insertEvent({
            id: `nudge:${subId}:${period}`,
            type: "nudge.requested",
            blockNumber: null,
            payload: { subId, nextChargeAt: period },
            at: now(),
          });
          return json(res, 200, { ok: true, emitted });
        }

        return json(res, 404, { error: "not found" });
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[scruple-service] ingest request failed:", err);
      return json(res, 500, { error: "internal" });
    }
  });
}
