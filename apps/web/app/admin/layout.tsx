import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/guard";

/**
 * Second line of defense. The authoritative check is inside each page — see
 * lib/guard.ts for why a layout alone is not sufficient — and every server
 * action checks again independently.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}
