import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "./db";
import { signBody } from "./webhooks";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** HTTP surface: POST /ingest (HMAC, metered payments) + GET /events (bearer, dashboard). */
export function createIngestServer(opts: { store: Store; secret: string; now?: () => number }): Server {
  const { store, secret } = opts;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "POST" && url.pathname === "/ingest") {
        const body = await readBody(req);
        const sig = req.headers["scruple-signature"];
        if (typeof sig !== "string" || !safeEqual(sig, `sha256=${signBody(secret, body)}`)) {
          return json(res, 401, { error: "bad signature" });
        }
        let p: Record<string, unknown>;
        try {
          p = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "bad payload" });
        }
        if (
          typeof p.id !== "string" || typeof p.endpoint !== "string" || typeof p.price !== "string" ||
          typeof p.at !== "number" || typeof p.atomic !== "string" || !/^\d+$/.test(p.atomic)
        ) {
          return json(res, 400, { error: "bad payload" });
        }
        const inserted = store.insertEvent({
          id: `metered:${p.id}`,
          type: "settlement.batched",
          blockNumber: null,
          payload: {
            endpoint: p.endpoint,
            payer: typeof p.payer === "string" ? p.payer : "",
            atomic: p.atomic,
            price: p.price,
            transaction: typeof p.transaction === "string" ? p.transaction : "",
          },
          at: p.at,
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
