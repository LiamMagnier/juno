import { PublicState } from "@/components/public/public-frame";
import { ReconnectAction } from "./reconnect-action";

export const metadata = { title: "You’re offline", robots: { index: false, follow: false } };

export default function OfflinePage() {
  return <PublicState title="You’re offline" description="Check your internet connection, then try again. Your saved work will be here when you reconnect."><ReconnectAction /></PublicState>;
}
