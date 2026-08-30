import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, adminConfigured, readSession } from "@/lib/session";

/**
 * Call this as the FIRST await in every admin page.
 *
 * It cannot live only in the layout: Next renders layouts and pages in
 * parallel, so a layout that withholds `children` does not stop the page from
 * running its queries — and the page's output is still serialized into the
 * streaming payload, where anyone can read it in the HTML. Enforcing inside
 * the page means nothing is fetched until the caller is known.
 *
 * The layout keeps its own check as a second line of defense, and every server
 * action re-checks independently.
 */
export async function requireAdmin(): Promise<string> {
  if (!(await adminConfigured())) redirect("/");
  const user = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/");
  return user;
}
