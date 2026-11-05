import { requireOwnerPage } from "@/lib/admin";
import { AnnouncementsAdmin } from "@/components/admin/announcements-admin";
import { PageRoot } from "@/components/app/page-root";

export default async function AnnouncementsAdminPage() {
  await requireOwnerPage();
  return (
    <PageRoot>
      <AnnouncementsAdmin />
    </PageRoot>
  );
}
