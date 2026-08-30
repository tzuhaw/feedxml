"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, adminConfigured, credentialsMatch, issueSession } from "@/lib/session";

/** Sign in. Returns an error message; on success it redirects and never returns. */
export async function signIn(
  _prev: string | null,
  formData: FormData,
): Promise<string | null> {
  if (!adminConfigured()) {
    return "The admin panel is not configured on this deployment.";
  }
  const user = String(formData.get("user") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/admin");

  if (!credentialsMatch(user, password)) {
    // One message for both cases: a wrong username and a wrong password should
    // be indistinguishable.
    return "Those credentials weren't recognised.";
  }

  const session = await issueSession();
  if (!session) return "The admin panel is not configured on this deployment.";

  (await cookies()).set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: session.maxAge,
  });

  // Only ever return to a path inside this app.
  redirect(next.startsWith("/admin") ? next : "/admin");
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/");
}
