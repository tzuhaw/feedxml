import Link from "next/link";
import FeedStream from "./FeedStream";

const stages = [
  {
    n: "01",
    title: "The file lands",
    body: "Push, pull or scrape — every channel ends at one immutable object in storage. 5GB never passes through a serverless function.",
  },
  {
    n: "02",
    title: "A run is registered",
    body: "Self-reported and swept for independently, both keyed on the object so no file is ingested twice or missed.",
  },
  {
    n: "03",
    title: "Streamed, never held",
    body: "A container job parses record by record. Peak memory 393MB for a million products, because the parse only ever holds one.",
  },
  {
    n: "04",
    title: "Staged, not applied",
    body: "Rows land in a staging table scoped to the run. The live catalog is untouched until the whole file has been read.",
  },
  {
    n: "05",
    title: "The gate",
    body: "Count drop, missing set, error rate. Breach one and the run halts before applying anything, and asks a human.",
    gate: true,
  },
  {
    n: "06",
    title: "Merge, then sweep",
    body: "Products created, updated, reactivated — then whatever the snapshot never mentioned is deactivated. Never deleted.",
  },
];

export default function Home() {
  return (
    <>
      <div className="hero">
        <FeedStream />
        <div className="wrap hero-inner">
          <span className="eyebrow">Supplier feed ingestion</span>
          <h1>Five gigabytes in, a million products out.</h1>
          <p className="lede">
            An ingestion pipeline that streams a supplier&rsquo;s catalog into the database
            without ever holding it in memory — and stops itself when the file looks wrong,
            rather than quietly deleting a catalog.
          </p>
          <div className="actions">
            <Link className="btn primary" href="/admin">
              Open the admin panel
            </Link>
            <a
              className="btn"
              href="https://github.com/tzuhaw/feedxml"
              target="_blank"
              rel="noreferrer noopener"
            >
              Source and design notes
            </a>
          </div>
        </div>
      </div>

      <dl className="figures wrap">
        <div className="figure">
          <dt>Feed size</dt>
          <dd>5 GB</dd>
        </div>
        <div className="figure">
          <dt>Products</dt>
          <dd>~1,000,000</dd>
        </div>
        <div className="figure">
          <dt>Peak memory</dt>
          <dd>393 MB</dd>
        </div>
        <div className="figure">
          <dt>Freshness target</dt>
          <dd>&lt; 1 hour</dd>
        </div>
      </dl>

      <section className="stages wrap">
        <header>
          <h2>What happens to a file</h2>
          <p>
            Six stages between arrival and a live catalog. The fifth is the one that matters:
            a snapshot that would deactivate half the range stops and waits for a person,
            with the exact consequence shown before anything is applied.
          </p>
        </header>
        <div className="grid">
          {stages.map((s) => (
            <article key={s.n} className={s.gate ? "card gate" : "card"}>
              <span className="n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="docs wrap">
        <h2>Reading further</h2>
        <ul>
          <li>
            <a href="https://github.com/tzuhaw/feedxml/blob/main/WALKTHROUGH.md">Walkthrough</a>{" "}
            — the whole journey, file to catalog, with the safeguard at each step
          </li>
          <li>
            <a href="https://github.com/tzuhaw/feedxml/blob/main/DESIGN.md">Design</a> — the
            architecture and a decision log of every choice and its alternative
          </li>
          <li>
            <a href="https://github.com/tzuhaw/feedxml/blob/main/RUNBOOK.md">Runbook</a> — how
            ops answers an alert, replays a feed, and onboards a supplier
          </li>
        </ul>
      </section>

      <footer className="site">
        <div className="wrap">
          Next.js on Vercel · streaming worker on Cloud Run · Postgres on Supabase · snapshots in R2
        </div>
      </footer>
    </>
  );
}
