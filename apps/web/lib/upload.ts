/**
 * Operator upload limits, in one place so the page, the API and the docs
 * cannot drift apart.
 *
 * 100 MB is a deliberate ceiling for the BROWSER path only: it is what a person
 * can reasonably push from a laptop over one request without a resumable
 * multipart dance. It is not the system's feed-size limit — the supplier push
 * channel (/api/feeds/upload-url) uses multipart and carries the 5 GB feeds the
 * design targets. This page is for spot checks, re-runs and small suppliers.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const MAX_UPLOAD_LABEL = "100 MB";
