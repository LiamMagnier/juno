import type { ReactNode } from "react";

import { requireOwnerPage } from "@/lib/admin";

/**
 * One server-side authorization boundary for the complete Admin tree.
 *
 * Individual pages may retain their own guard as defense in depth, but a new
 * Admin page cannot become public merely because its author forgot to copy a
 * check from a sibling route.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireOwnerPage();
  return children;
}
