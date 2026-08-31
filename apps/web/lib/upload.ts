/**
 * Operator upload limits, in one place so the page, the API and the docs
 * cannot drift apart. `scripts/upload-check.mjs` reads MAX_UPLOAD_BYTES out of
 * this file rather than repeating the number, so the boundary tests track it
 * automatically.
 *
 * 10 MB is a deliberate ceiling for the BROWSER path only: it is what a person
 * can reasonably push from a laptop over one request without a resumable
 * multipart dance. It is not the system's feed-size limit — the supplier push
 * channel (/api/feeds/upload-url) uses multipart and carries the 5 GB feeds the
 * design targets. This page is for spot checks, re-runs and small suppliers.
 *
 * Raising it is one number: the cap is enforced server-side twice over (bound
 * into the presigned URL's signature as content-length, then re-measured on the
 * stored object), so nothing else has to change.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const MAX_UPLOAD_LABEL = "10 MB";
