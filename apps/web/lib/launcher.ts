/**
 * Kicks the Cloud Run Job for a Run. Deliberately the only Cloud Run-aware
 * code in the app. Until CLOUD_RUN_JOB_URL is configured (deploy step,
 * Sprint 1 infra), launches are logged and the run stays 'pending' — the
 * worker can be started manually with RUN_ID for local/demo flows.
 */
export async function launchWorker(runId: string): Promise<void> {
  const url = process.env.CLOUD_RUN_JOB_URL;
  const token = process.env.CLOUD_RUN_INVOKER_TOKEN;
  if (!url) {
    console.log(`[launcher] CLOUD_RUN_JOB_URL not set; run ${runId} left pending`);
    return;
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
}
