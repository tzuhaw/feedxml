/**
 * The catalog domain: everything that decides what a Run does to the catalog,
 * expressed as SQL over a pg Pool. Deliberately free of the ingest machinery
 * (streaming parsers, object storage, transforms) so BOTH the worker and the
 * admin panel can call it — a verdict clicked in the panel runs exactly the
 * same code the worker runs.
 */
export * from "./lifecycle.js";
export * from "./apply.js";
export * from "./preview.js";
export * from "./merge.js";
export * from "./issues.js";
export * from "./validate.js";
export * from "./admin.js";
