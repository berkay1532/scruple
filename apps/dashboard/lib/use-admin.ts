"use client";

// Typed client for the /api/admin proxy (app/api/admin/[...path]/route.ts →
// the service's /admin/* webhook-management API). Lists poll every 10s in the
// useEvents style; mutations are plain fetch wrappers that throw an Error
// whose message is safe to surface in the UI. Full webhook secrets appear
// only in create/rotate responses — callers must keep them in transient
// component state and never persist them.
import { useCallback, useEffect, useState } from "react";

export type AdminEndpoint = {
  id: number;
  url: string;
  secretPreview: string;
  paused: boolean;
};

export type DeliveryStatus = "delivered" | "retrying" | "pending" | "dead";

export type AdminDelivery = {
  eventId: string;
  endpointId: number;
  url: string;
  type: string;
  attempts: number;
  lastStatus: number | null;
  /** Epoch milliseconds, or null. */
  nextAttemptAt: number | null;
  /** Epoch milliseconds, or null. */
  deliveredAt: number | null;
  status: DeliveryStatus;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin/${path}`, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body — fall through to the status-based error below
  }
  if (!res.ok) {
    const message = (body as { error?: unknown } | null)?.error;
    throw new Error(typeof message === "string" ? message : `request failed (${res.status})`);
  }
  return body as T;
}

/** Creates an endpoint; the response carries the full secret ONCE — show it immediately, never store it. */
export function createEndpoint(url: string): Promise<{ id: number; url: string; secret: string }> {
  return req("endpoints", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function deleteEndpoint(id: number): Promise<{ ok: boolean }> {
  return req(`endpoints/${id}`, { method: "DELETE" });
}

export function setEndpointPaused(id: number, paused: boolean): Promise<{ ok: boolean; paused: boolean }> {
  return req(`endpoints/${id}/${paused ? "pause" : "resume"}`, { method: "POST" });
}

/** Rotates an endpoint's secret; the response carries the new secret ONCE (same rules as createEndpoint). */
export function rotateEndpointSecret(id: number): Promise<{ ok: boolean; secret: string }> {
  return req(`endpoints/${id}/rotate`, { method: "POST" });
}

/**
 * Schedules an immediate re-attempt (revives dead deliveries, keeps the
 * attempt counter). eventId is interpolated RAW — it contains a colon
 * (`txHash:logIndex`), which is legal in a URL path and must NOT be
 * percent-encoded (the proxy and service both take it verbatim).
 */
export function resendDelivery(endpointId: number, eventId: string): Promise<{ ok: boolean }> {
  return req(`deliveries/${endpointId}/${eventId}/resend`, { method: "POST" });
}

/**
 * Emits a `nudge.requested` webhook for a sub the attention list surfaced.
 * `emitted: false` means the sub was already nudged this billing period
 * (idempotent — never an error, never a duplicate delivery). 404 "nothing
 * to nudge" surfaces as a thrown Error like every other action here.
 */
export function nudge(subId: string): Promise<{ ok: boolean; emitted: boolean }> {
  return req(`nudge/${subId}`, { method: "POST" });
}

/**
 * One-shot onboarding signal: true ONLY when the admin endpoints fetch
 * succeeds and returns zero endpoints. Stays false while loading and on any
 * fetch error — dashboards without a configured service must not nag.
 */
export function useEndpointsEmpty(): boolean {
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    let cancelled = false;
    req<{ endpoints?: AdminEndpoint[] }>("endpoints")
      .then((body) => {
        if (!cancelled) setEmpty(Array.isArray(body.endpoints) && body.endpoints.length === 0);
      })
      .catch(() => {
        // fetch error → no hint (leave `empty` false)
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return empty;
}

const POLL_MS = 10_000;
const DELIVERIES_LIMIT = 100;

/** Polls endpoints + deliveries every 10s; `refetch` refreshes immediately after a mutation. */
export function useAdmin(): {
  endpoints: AdminEndpoint[];
  deliveries: AdminDelivery[];
  error: string | null;
  refetch: () => Promise<void>;
} {
  const [endpoints, setEndpoints] = useState<AdminEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<AdminDelivery[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const [ep, dl] = await Promise.all([
        req<{ endpoints?: AdminEndpoint[] }>("endpoints"),
        req<{ deliveries?: AdminDelivery[] }>(`deliveries?limit=${DELIVERIES_LIMIT}`),
      ]);
      setEndpoints(Array.isArray(ep.endpoints) ? ep.endpoints : []);
      setDeliveries(Array.isArray(dl.deliveries) ? dl.deliveries : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    }
  }, []);

  useEffect(() => {
    refetch();
    const id = setInterval(refetch, POLL_MS);
    return () => clearInterval(id);
  }, [refetch]);

  return { endpoints, deliveries, error, refetch };
}
