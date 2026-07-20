// Server-side proxy in front of the service's GET /events (see
// packages/service/src/ingest.ts): keeps SERVICE_EVENTS_SECRET out of the
// browser bundle. Never statically optimized — the dashboard polls this on
// an interval and always wants a fresh read.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const serviceUrl = process.env.SERVICE_URL;
  const secret = process.env.SERVICE_EVENTS_SECRET;

  if (!serviceUrl || !secret) {
    return NextResponse.json({ error: "service not configured" }, { status: 503 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${serviceUrl}/events?limit=200`, {
      headers: { authorization: `Bearer ${secret}` },
    });
  } catch {
    return NextResponse.json({ error: "upstream request failed" }, { status: 502 });
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return NextResponse.json({ error: "bad upstream response" }, { status: 502 });
  }

  return NextResponse.json(body, { status: upstream.status });
}
