import type { Metadata } from "next";
import { findAgent } from "@/lib/agents/store";
import { consumeComputerHandoff } from "@/lib/computer/handoff";
import { isAgentComputerConfigured } from "@/lib/computer/provider";
import { getCurrentUser } from "@/lib/session";
import { ComputerViewer } from "@/components/agents/computer-viewer";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Computer View · ${PRODUCT_NAME}`,
  robots: {
    index: false,
    follow: false,
  },
  referrer: "no-referrer",
};

const EXPIRED_MESSAGE = "This link has expired. Open the computer again from the app.";

function Expired() {
  return (
    <main className="flex h-dvh w-screen items-center justify-center bg-neutral-950 px-6 text-center text-body text-neutral-300">
      <p>{EXPIRED_MESSAGE}</p>
    </main>
  );
}

/**
 * The page the apps open in a web view for a crew member's computer.
 *
 * `?c=` is a single-use code (src/lib/computer/handoff.ts): opening the page
 * spends it, so a second open of the same URL, from anywhere, finds nothing.
 * The page never renders a credential. It hands the viewer a one-time ticket,
 * and the viewer trades that for the relay token and VNC password over a POST
 * (`/api/computer-view/session`), which is also where control begins and is
 * recorded.
 */
export default async function ComputerViewPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const { c } = await searchParams;
  if (!(await isAgentComputerConfigured())) return <Expired />;
  // A browser signed in to another account may not use somebody else's link.
  // The apps' web view has no session, which is the normal case.
  const viewer = await getCurrentUser().catch(() => null);
  const grant = await consumeComputerHandoff(c, { viewerUserId: viewer?.id ?? null });
  if (!grant) return <Expired />;

  const agent = await findAgent(grant.userId, grant.agentId);
  if (!agent) return <Expired />;

  return (
    <ComputerViewer
      agentId={grant.agentId}
      agentName={agent.name}
      initialMode={grant.mode}
      handoffTicket={grant.ticket}
      fullBleed
    />
  );
}
