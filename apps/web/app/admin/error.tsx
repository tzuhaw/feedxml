"use client";

import { palette } from "./ui";

/**
 * The panel's refusals are load-bearing: "this halted run is stale", "the
 * catalog changed since this preview was rendered", "only failed runs can be
 * retried". Without a boundary they reach ops as an unstyled 500 with the
 * message stripped in production, which is exactly the audience that needs it.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 700,
        margin: "3rem auto",
        padding: "0 1rem",
      }}
    >
      <h1 style={{ fontSize: "1.2rem" }}>That action did not go through</h1>
      <p
        style={{
          border: `2px solid ${palette.warn}`,
          background: palette.bg,
          padding: "1rem",
          borderRadius: 6,
          whiteSpace: "pre-wrap",
        }}
      >
        {error.message || "The server rejected the action without a message."}
      </p>
      <p style={{ color: palette.muted }}>
        Nothing was applied. Reload to see the current state before trying again.
        {error.digest && <> (reference {error.digest})</>}
      </p>
      <button
        onClick={reset}
        style={{
          border: `1px solid ${palette.border}`,
          borderRadius: 4,
          padding: "0.4rem 0.9rem",
          cursor: "pointer",
          font: "inherit",
          background: "#fff",
        }}
      >
        Try again
      </button>
    </main>
  );
}
