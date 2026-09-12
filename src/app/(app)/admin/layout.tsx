import type { ReactNode } from "react";

import { requireOwnerPageAccess } from "@/lib/admin";
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
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { mfaRequired } = await requireOwnerPageAccess();
  if (mfaRequired) return <AdminMfaRequired />;
  return children;
}
