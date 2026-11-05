import { requireOwnerPage } from "@/lib/admin";
import { LinksAdmin } from "@/components/admin/links-admin";
import { PageRoot } from "@/components/app/page-root";

export default async function LinksAdminPage() {
  await requireOwnerPage();
  return (
    <PageRoot>
      <LinksAdmin />
    </PageRoot>
  );
}
