"use client";

// Root error boundary for the app segment (Next.js convention: must be a
// Client Component named default-exporting `Error`, receives the thrown
// error + a `reset()` to re-render the segment). Reuses the same Panel/
// button visual language as the rest of the dashboard (see
// docs/design/dashboard-mock.html) rather than an unstyled fallback.
import { useEffect } from "react";
import { Panel } from "@/components/ui";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Errors here don't go through the usual event/service logging path —
    // at least surface them to the console so they're not silently lost.
    console.error(error);
  }, [error]);

  return (
    <div className="content" style={{ maxWidth: 480, margin: "80px auto" }}>
      <Panel>
        <h2 className="serif">Something went wrong</h2>
        <p className="sub" style={{ marginBottom: 14 }}>
          An unexpected error interrupted this view. Nothing on-chain was affected — try again.
        </p>
        <button className="btn primary" onClick={() => reset()}>
          Try again
        </button>
      </Panel>
    </div>
  );
}
