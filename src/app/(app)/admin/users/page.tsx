import { requireOwnerPage } from "@/lib/admin";
import { UsersAdmin } from "@/components/admin/users-admin";

export default async function UsersAdminPage() {
  const user = await requireOwnerPage();
  return <UsersAdmin selfId={user.id} />;
}
