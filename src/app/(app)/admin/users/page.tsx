import { requireOwnerPage } from "@/lib/admin";
import { UsersAdmin } from "@/components/admin/users-admin";
import { PageRoot } from "@/components/app/page-root";

export default async function UsersAdminPage() {
  const user = await requireOwnerPage();
  return (
    <PageRoot>
      <UsersAdmin selfId={user.id} />
    </PageRoot>
  );
}
