import { requireOwnerPage } from "@/lib/admin";
import { AnnouncementsAdmin } from "@/components/admin/announcements-admin";

export default async function AnnouncementsAdminPage() {
  await requireOwnerPage();
  return <AnnouncementsAdmin />;
}
