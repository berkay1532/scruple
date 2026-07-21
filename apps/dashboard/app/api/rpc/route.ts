// Server-side proxy in front of the Arc RPC endpoint, mirroring
// app/api/events/route.ts: the authenticated canteen RPC blocks
// cross-origin browser requests (CORS) and the public RPC rate-limits, so
// the browser talks to this same-origin endpoint instead and never sees
// ARC_RPC_URL (which may embed an auth token). Never statically optimized —
// every chain read is a fresh JSON-RPC round trip.
//
// Parallel page-load reads land on the public RPC as a burst, which trips
// its rate limit (`{code:-32011,"request limit reached"}`) and renders
// tables empty. A single module-level forwarder serializes every request
// through one queue with a minimum gap between upstream calls, and retries
// rate-limited responses with backoff — see lib/rpc-forwarder.ts.
import { NextResponse } from "next/server";
import { createRpcForwarder } from "../../../lib/rpc-forwarder";

export const dynamic = "force-dynamic";

const rpcUrl = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";

// Module-level singleton: every request in this server process shares one
// queue, so the min-gap spacing applies across concurrent requests, not
// just within a single one. Never log or echo `rpcUrl` — it may embed an
// auth token.
const forwarder = createRpcForwarder({ upstream: rpcUrl });

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const { status, body: responseBody } = await forwarder.forward(JSON.stringify(body));

  return new NextResponse(responseBody, {
    status,
    headers: { "content-type": "application/json" },
  });
}
