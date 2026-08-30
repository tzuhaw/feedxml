import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Spartan-but-functional primitives for the ops panel: readable tables,
 * honest state colours, no design system (DESIGN.md §7).
 */

export const palette = {
  border: "#d6d8dc",
  muted: "#5b6068",
  bg: "#fbfbfc",
  danger: "#a11",
  ok: "#176b3a",
  warn: "#8a5a00",
};

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  const nav = [
    ["/admin", "Overview"],
    ["/admin/runs", "Runs"],
    ["/admin/issues", "Issues"],
    ["/admin/products", "Products"],
    ["/admin/feeds", "Feeds"],
  ] as const;
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 1100,
        margin: "0 auto",
        padding: "1.5rem 1rem 4rem",
        color: "#16181d",
      }}
    >
      <nav
        style={{
          display: "flex",
          gap: "1rem",
          marginBottom: "1.5rem",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {nav.map(([href, label]) => (
          <Link key={href} href={href} style={{ color: "#0b5cad" }}>
            {label}
          </Link>
        ))}
        <form action="/api/session" method="POST" style={{ marginLeft: "auto" }}>
          <input type="hidden" name="intent" value="signout" />
          <button
            type="submit"
            style={{
              background: "none",
              border: "none",
              color: palette.muted,
              cursor: "pointer",
              font: "inherit",
              padding: 0,
            }}
          >
            Sign out
          </button>
        </form>
      </nav>
      <h1 style={{ fontSize: "1.4rem", margin: "0 0 1rem" }}>{title}</h1>
      {children}
    </main>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  borderBottom: `2px solid ${palette.border}`,
                  padding: "0.4rem 0.6rem",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <td
      style={{
        borderBottom: `1px solid ${palette.border}`,
        padding: "0.4rem 0.6rem",
        verticalAlign: "top",
        fontFamily: mono ? "ui-monospace, monospace" : undefined,
        fontSize: mono ? "0.82rem" : undefined,
      }}
    >
      {children}
    </td>
  );
}

const STATE_COLOUR: Record<string, string> = {
  done: palette.ok,
  failed: palette.danger,
  awaiting_review: palette.warn,
  superseded: palette.muted,
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span style={{ color: STATE_COLOUR[state] ?? "#16181d", fontWeight: 600 }}>{state}</span>
  );
}

export function Empty({ what }: { what: string }) {
  return <p style={{ color: palette.muted }}>No {what}.</p>;
}

export function ago(value: string | Date): string {
  const then = new Date(value).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function duration(from: string | Date, to: string | Date): string {
  const secs = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  if (secs < 90) return `${secs}s`;
  return `${Math.round(secs / 60)}m`;
}
