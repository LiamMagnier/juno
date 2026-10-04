import { requireOwnerPage } from "@/lib/admin";
import { TurnsAdmin } from "@/components/admin/turns-admin";
import { modelPerformance, recentTurnTraces } from "@/lib/chat/turn/trace-sink";

export const dynamic = "force-dynamic";

/**
 * Owner diagnostics for chat turns (BRIEF §47): the per-turn traces this
 * process recorded and the per-model latency they add up to. Behind the
 * Admin layout's owner + two-step gate, and the page guard again.
 */
export default async function TurnsAdminPage() {
  await requireOwnerPage();
  return <TurnsAdmin traces={recentTurnTraces(100)} models={modelPerformance()} />;
}
