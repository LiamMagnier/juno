import type { ReactNode } from "react";

import { requireOwnerPageAccess } from "@/lib/admin";
import { adminQueueCounts } from "@/lib/admin-overview";
import { AdminBar } from "@/components/admin/admin-nav";
import "@/components/admin/admin.css";
import { AdminMfaRequired } from "./mfa-required";

/**
 * One server-side authorization boundary for the complete Admin tree.
 *
 * Individual pages may retain their own guard as defense in depth, but a new
 * Admin page cannot become public merely because its author forgot to copy a
 * check from a sibling route.
 *
 * An owner who has not enrolled in two-step verification gets the prompt in
 * place of `children` — returning without rendering them means no page below
 * ever executes, so this is a real gate and not a visual one.
 *
 * Past the gate it draws the Admin bar, once, over every Admin page: a layout
 * persists across navigation between its pages, so the bar's selected pill
 * slides between sections instead of each page drawing its own tabs.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { mfaRequired } = await requireOwnerPageAccess();
  if (mfaRequired) return <AdminMfaRequired />;
  const counts = await adminQueueCounts();
  return (
    <div className="admin-shell flex h-full min-h-0 flex-col">
      <AdminBar reviewCount={counts.flagsToReview} reportCount={counts.openReports} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
