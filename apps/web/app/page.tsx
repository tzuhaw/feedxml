import FeedStream from "./FeedStream";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = next && next.startsWith("/admin") ? next : "/admin";

  return (
    <main className="gate-page">
      <FeedStream />
      <div className="gate-inner">
        <div className="brand">
          <span className="eyebrow">Supplier feed ingestion</span>
          <h1>feedxml</h1>
          <p className="lede">
            Sign in to review runs, answer halted snapshots, and manage the catalog.
          </p>
        </div>
        <LoginForm next={target} />
      </div>
    </main>
  );
}
