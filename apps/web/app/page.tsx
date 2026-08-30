import Link from "next/link";

export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>feedxml</h1>
      <p>
        Product-feed ingestion. <Link href="/admin">Admin panel</Link>.
      </p>
    </main>
  );
}
