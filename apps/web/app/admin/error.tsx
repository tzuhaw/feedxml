"use client";

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
    <main className="panel">
      <div className="page-head">
        <h1>That action did not go through</h1>
      </div>
      <div className="card">
        <div className="card-body">
          <p className="run-error" style={{ whiteSpace: "pre-wrap" }}>
            {error.message || "The server rejected the action without a message."}
          </p>
          <p className="muted">
            Nothing was applied. Reload to see the current state before trying again.
            {error.digest && <> (reference {error.digest})</>}
          </p>
          <div className="act-row">
            <button onClick={reset} className="act">
              Try again
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
