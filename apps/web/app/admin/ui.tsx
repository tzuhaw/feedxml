import Link from "next/link";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";

/**
 * Primitives for the ops console.
 *
 * Everything here styles through the CSS custom properties in globals.css
 * rather than literal colours, so both themes resolve as a set. An earlier
 * version exported a `palette` object of light-mode hex values and applied it
 * as inline styles — which rendered light-theme greys and blues on the dark
 * ground, because an inline style cannot respond to a media query.
 */

export type NavKey = "overview" | "runs" | "issues" | "products" | "feeds" | "upload";

const NAV: ReadonlyArray<readonly [NavKey, string, string]> = [
  ["overview", "/admin", "Overview"],
  ["runs", "/admin/runs", "Runs"],
  ["issues", "/admin/issues", "Issues"],
  ["products", "/admin/products", "Products"],
  ["feeds", "/admin/feeds", "Feeds"],
  ["upload", "/admin/upload", "Upload"],
];

export function Shell({
  title,
  nav,
  sub,
  children,
}: {
  title: string;
  nav: NavKey;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="panel-shell">
      <header className="topbar">
        <div className="topbar-in">
          <Link href="/admin" className="mark">
            <span>feedxml</span>
          </Link>
          <nav className="topnav">
            {NAV.map(([key, href, label]) => (
              <Link
                key={key}
                href={href}
                className={key === nav ? "navlink is-active" : "navlink"}
                aria-current={key === nav ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="topbar-end">
            <form action="/api/session" method="POST">
              <input type="hidden" name="intent" value="signout" />
              <button type="submit" className="signout">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="panel">
        <div className="page-head">
          <h1>{title}</h1>
          {sub && <div className="page-sub">{sub}</div>}
        </div>
        {children}
      </main>
    </div>
  );
}

/**
 * The one-line answer to "is anything wrong right now". Amber is reserved for
 * the case where something genuinely awaits a human — the band is not
 * decorative, so it must never be amber when the queue is empty.
 */
export function StatusBand({
  tone,
  children,
}: {
  tone: "clear" | "attention";
  children: ReactNode;
}) {
  return (
    <div className={`status is-${tone}`} role="status">
      <span className="status-dot" aria-hidden="true" />
      <span className="status-text">{children}</span>
    </div>
  );
}

export function Tiles({ children }: { children: ReactNode }) {
  return <div className="tiles">{children}</div>;
}

export function Tile({
  label,
  figure,
  note,
  href,
  hot,
}: {
  label: string;
  figure: ReactNode;
  note?: ReactNode;
  href?: string;
  hot?: boolean;
}) {
  const className = hot ? "tile is-hot" : "tile";
  const body = (
    <>
      <span className="tile-label">{label}</span>
      <span className="tile-figure">{figure}</span>
      {note && <span className="tile-note">{note}</span>}
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** `flush` omits the body padding, for a card whose only content is a table. */
export function Card({
  title,
  note,
  actions,
  flush,
  children,
}: {
  title?: string;
  note?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {note && !actions && <span className="card-note">{note}</span>}
          {actions}
        </div>
      )}
      {flush ? children : <div className="card-body">{children}</div>}
    </section>
  );
}

export function Chips({ children }: { children: ReactNode }) {
  return <div className="chips">{children}</div>;
}

export function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={active ? "chip is-active" : "chip"}>
      {children}
    </Link>
  );
}

type Tone = "ok" | "warn" | "danger" | "info" | "muted";

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

const STATE_TONE: Record<string, Tone> = {
  done: "ok",
  failed: "danger",
  awaiting_review: "warn",
  rejected: "muted",
  superseded: "muted",
  pending: "info",
  downloading: "info",
  staging: "info",
  validating: "info",
  merging: "info",
};

export function StateBadge({ state }: { state: string }) {
  return <Pill tone={STATE_TONE[state] ?? "muted"}>{state.replace(/_/g, " ")}</Pill>;
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

/**
 * An empty state says what would fill it, so a new operator can tell "nothing
 * is wrong" apart from "nothing is configured".
 */
export function Empty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint}
    </div>
  );
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

/** Byte sizes for the upload page and object listings. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
