/**
 * Kicks the Cloud Run Job for a Run. Deliberately the only Cloud Run-aware
 * code in the app. Until CLOUD_RUN_JOB_URL is configured (deploy step), the
 * launch is skipped and the run stays 'pending' — the worker can be started
 * manually with RUN_ID for local/demo flows.
 *
 * Returns true when a launch request was accepted, false when launching is
 * not configured. Throws on a failed launch — callers must treat that as
 * "run registered but not started" (the run stays pending and is re-launched
 * on the next trigger for the same object key, or by the Sprint-3 cron).
 *
 * Sprint-3 deploy note: Cloud Run requires a fresh OIDC identity token per
 * request; mint one via google-auth-library rather than a static env token.
 */
export async function launchWorker(runId: string): Promise<boolean> {
  const url = process.env.CLOUD_RUN_JOB_URL;
  const token = process.env.CLOUD_RUN_INVOKER_TOKEN;
  if (!url) {
    console.log(`[launcher] CLOUD_RUN_JOB_URL not set; run ${runId} left pending`);
    return false;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [{ env: [{ name: "RUN_ID", value: runId }] }],
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Cloud Run launch failed: ${res.status} ${await res.text()}`);
  }
  return true;
}
