"use client";

// Client hook polling the /api/events proxy (app/api/events/route.ts) every
// 5s. No React Query dependency here — Task 4 introduces react-query for the
// chain layer, but the event feed is a plain poll against our own API route.
import { useEffect, useState } from "react";
import type { EventRow } from "./events";

const POLL_MS = 5000;

export function useEvents(): { events: EventRow[]; error: string | null } {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/events");
        const body = (await res.json()) as { events?: EventRow[]; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? `request failed (${res.status})`);
          return;
        }
        setEvents(Array.isArray(body.events) ? body.events : []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "request failed");
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { events, error };
}
