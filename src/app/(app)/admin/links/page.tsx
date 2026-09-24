import { requireOwnerPage } from "@/lib/admin";
import { LinksAdmin } from "@/components/admin/links-admin";

export default async function LinksAdminPage() {
  await requireOwnerPage();
  return <LinksAdmin />;
}
