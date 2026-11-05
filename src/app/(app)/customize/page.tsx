import ConnectionsPage from "../connections/page";
import { PageRoot } from "@/components/app/page-root";

/** The Apps destination uses the existing authenticated connection flows. */
export default function CustomizePage() {
  return (
    <PageRoot>
      <ConnectionsPage />
    </PageRoot>
  );
}
