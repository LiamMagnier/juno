import { requireUser } from "@/lib/session";
import { getAppBootstrap } from "@/lib/app-data";
import { AppProvider } from "@/components/app/app-provider";
import { AppShell } from "@/components/app/app-shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const bootstrap = await getAppBootstrap(user);

  return (
    <AppProvider bootstrap={bootstrap}>
      <AppShell>{children}</AppShell>
    </AppProvider>
  );
}
