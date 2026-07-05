import { requireOwnerPage } from "@/lib/admin";
import { ModerationAdmin } from "@/components/admin/moderation-admin";

export default async function ModerationAdminPage() {
  await requireOwnerPage();
  return <ModerationAdmin />;
}
