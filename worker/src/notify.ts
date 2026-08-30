/**
 * Ops email — exactly two events ever notify: a Run awaiting review and a Run
 * failed after its final attempt (DESIGN.md decision 13/20). One email per
 * event, no reminders, never on success. Unconfigured = log-only, and a
 * notification failure must never fail a Run.
 */
export async function notifyOps(subject: string, body: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.OPS_EMAIL;
  if (!key || !to) {
    console.log(`[notify] (email disabled) ${subject}`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.OPS_EMAIL_FROM ?? "feedxml <onboarding@resend.dev>",
        to,
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      console.error(`[notify] send failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error(`[notify] send error:`, err);
  }
}
