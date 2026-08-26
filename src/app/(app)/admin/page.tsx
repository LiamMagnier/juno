import { redirect } from "next/navigation";

import { requireOwnerPage } from "@/lib/admin";

/** Canonical Admin entry point used by the owner account menu. */
export default async function AdminPage() {
  await requireOwnerPage();
  redirect("/admin/users");
}
