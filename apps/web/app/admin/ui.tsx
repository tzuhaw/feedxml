import Link from "next/link";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";

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
    <main className="panel">
      <nav className="panel-nav">
        {nav.map(([href, label]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
        <form action="/api/session" method="POST" className="panel-signout">
          <input type="hidden" name="intent" value="signout" />
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <h1 className="panel-title">{title}</h1>
      {children}
    </main>
  );
}

/**
 * On a phone these tables would be a sideways scroll of eight columns, so each
 * row becomes a stacked card instead. The column headings are pushed down to
 * the cells as data-labels automatically — pages keep writing plain rows.
 */
export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  const labelled = Children.map(children, (row) => {
    if (!isValidElement(row)) return row;
    const cells = Children.map(
      (row.props as { children?: ReactNode }).children,
      (cell, i) => (isValidElement(cell) ? cloneElement(cell as never, { label: head[i] }) : cell),
    );
    return cloneElement(row as never, {}, cells);
  });

  return (
    <div className="table-wrap">
      <table className="panel-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{labelled}</tbody>
      </table>
    </div>
  );
}

export function Cell({
  children,
  mono,
  label,
}: {
  children: ReactNode;
  mono?: boolean;
  label?: string;
}) {
  return (
    <td className={mono ? "mono" : undefined} data-label={label}>
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
