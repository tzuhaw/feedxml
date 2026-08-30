import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import FeedStream from "./FeedStream";
import LoginForm from "./LoginForm";
import { SESSION_COOKIE, readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const target = next && next.startsWith("/admin") ? next : "/admin";

  // Already signed in: go straight to the panel rather than showing a login
  // form to someone who is already authenticated. Verified against the
  // database, so an expired or revoked session still lands on the form.
  if (await readSession((await cookies()).get(SESSION_COOKIE)?.value)) {
    redirect(target);
  }

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
        <LoginForm next={target} error={error} />
      </div>
    </main>
  );
}
