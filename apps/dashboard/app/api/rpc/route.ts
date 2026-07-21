// Server-side proxy in front of the Arc RPC endpoint, mirroring
// app/api/events/route.ts: the authenticated canteen RPC blocks
// cross-origin browser requests (CORS) and the public RPC rate-limits, so
// the browser talks to this same-origin endpoint instead and never sees
// ARC_RPC_URL (which may embed an auth token). Never statically optimized —
// every chain read is a fresh JSON-RPC round trip.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rpcUrl = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Don't log or echo `rpcUrl` — it may embed an auth token.
    return NextResponse.json({ error: "rpc upstream unavailable" }, { status: 502 });
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return NextResponse.json({ error: "rpc upstream unavailable" }, { status: 502 });
  }

  return NextResponse.json(payload, { status: upstream.status });
}
