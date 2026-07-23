// Server-side proxy in front of the Arc RPC endpoint, mirroring
// apps/dashboard/app/api/rpc/route.ts: the public RPC rate-limits bursts of
// parallel page-load reads, which stalls this embed's checkout ("Loading
// plan…" stuck, "RPC Request failed"). The browser talks to this
// same-origin endpoint instead, which never echoes ARC_RPC_URL (which may
// embed an auth token). Never statically optimized — every chain read is a
// fresh JSON-RPC round trip.
//
// Parallel page-load reads land on the public RPC as a burst, which trips
// its rate limit (`{code:-32011,"request limit reached"}`) and stalls the
// checkout panel. A single module-level forwarder serializes every request
// through one queue with a minimum gap between upstream calls, and retries
// rate-limited responses with backoff — see @scruple/rpc-forwarder.
import { NextResponse } from "next/server";
import { createRpcForwarder } from "@scruple/rpc-forwarder";

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
