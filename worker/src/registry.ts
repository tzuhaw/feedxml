import type { FeedTransform } from "@feedxml/shared";
import { acmeTransform } from "./transforms/acme.js";

/**
 * Supplier name → transform. The only place a new supplier's code is wired in.
 * Real suppliers are onboarded in Sprint 5 with fixture tests per transform.
 */
const transforms: Record<string, FeedTransform> = {
  acme: acmeTransform,
};

export function transformFor(supplierName: string): FeedTransform {
  const t = transforms[supplierName];
  if (!t) throw new Error(`no transform registered for supplier "${supplierName}"`);
  return t;
}
