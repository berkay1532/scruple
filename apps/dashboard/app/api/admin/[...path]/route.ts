// Server-side proxy in front of the service's /admin/* webhook-management API
// (see packages/service/src/ingest.ts): keeps the admin bearer secret out of
// the browser bundle, mirroring app/api/events/route.ts. Never statically
// optimized — the Webhooks screen polls the list routes and every mutation
// wants a fresh round trip.
//
// Path segments are joined RAW (no encodeURIComponent): delivery eventIds are
// `${txHash}:${logIndex}` and the colon must reach the service verbatim —
// the service's resend parser takes the eventId as the raw remainder of the
// path. Colons are legal in URL path segments, so no re-encoding is needed.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function forward(request: Request, ctx: Ctx, method: "GET" | "POST" | "DELETE") {
  const serviceUrl = process.env.SERVICE_URL;
  const secret = process.env.SERVICE_ADMIN_SECRET ?? process.env.SERVICE_EVENTS_SECRET;

  if (!serviceUrl || !secret) {
    return NextResponse.json({ error: "service not configured" }, { status: 503 });
  }

  const { path } = await ctx.params;
  const search = new URL(request.url).search;

  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  const init: RequestInit = { method, headers };
  if (method === "POST") {
    const text = await request.text();
    if (text) {
      init.body = text;
      headers["content-type"] = "application/json";
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${serviceUrl}/admin/${path.join("/")}${search}`, init);
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

export async function GET(request: Request, ctx: Ctx) {
  return forward(request, ctx, "GET");
}

export async function POST(request: Request, ctx: Ctx) {
  return forward(request, ctx, "POST");
}

export async function DELETE(request: Request, ctx: Ctx) {
  return forward(request, ctx, "DELETE");
}
