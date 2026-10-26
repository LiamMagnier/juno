import { requireOwnerPage } from "@/lib/admin";
import { ModerationAdmin } from "@/components/admin/moderation-admin";
import { PageRoot } from "@/components/app/page-root";

export default async function ModerationAdminPage() {
  await requireOwnerPage();
  return (
    <PageRoot>
      <ModerationAdmin />
    </PageRoot>
  );
}
