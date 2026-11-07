import { requireOwnerPage } from "@/lib/admin";
import { adminOverview } from "@/lib/admin-overview";
import { AdminOverviewView } from "@/components/admin/admin-overview";
import { PageRoot } from "@/components/app/page-root";

export const dynamic = "force-dynamic";

/**
 * The Admin entry point (the owner account menu links here): the numbers an
 * owner opens Admin to check — accounts, activity, spend, what needs review —
 * and the newest accounts, before any one section.
 */
export default async function AdminPage() {
  await requireOwnerPage();
  const data = await adminOverview();
  return (
    <PageRoot>
      <AdminOverviewView data={data} />
    </PageRoot>
  );
}
