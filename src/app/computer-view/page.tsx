import type { Metadata } from "next";
import { findAgent } from "@/lib/agents/store";
import { verifyHandoffCode } from "@/lib/computer/live-view";
import { openComputerViewSession } from "@/lib/computer/store";
import { ComputerViewer } from "@/components/agents/computer-viewer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Computer View · Juno",
  robots: {
    index: false,
    follow: false,
  },
  referrer: "no-referrer",
};

const EXPIRED_MESSAGE = "This link has expired. Open the computer again from the app.";

export default async function ComputerViewPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const { c } = await searchParams;
  const grant = verifyHandoffCode(c);
  if (!grant) {
    return (
      <main className="flex h-dvh w-screen items-center justify-center bg-neutral-950 px-6 text-center text-body text-neutral-300">
        <p>{EXPIRED_MESSAGE}</p>
      </main>
    );
  }

  const agent = await findAgent(grant.userId, grant.agentId);
  if (!agent) {
    return (
      <main className="flex h-dvh w-screen items-center justify-center bg-neutral-950 px-6 text-center text-body text-neutral-300">
        <p>{EXPIRED_MESSAGE}</p>
      </main>
    );
  }

  try {
    const session = await openComputerViewSession(grant.userId, grant.agentId, grant.mode);
    if (session.kind !== "direct") {
      throw new Error("Unexpected session mode");
    }

    return (
      <ComputerViewer
        agentId={grant.agentId}
        agentName={agent.name}
        initialMode={session.mode}
        initialRelayUrl={session.relayUrl}
        initialToken={session.token}
        initialPassword={session.password}
        fullBleed
      />
    );
  } catch {
    return (
      <main className="flex h-dvh w-screen items-center justify-center bg-neutral-950 px-6 text-center text-body text-neutral-300">
        <p>{EXPIRED_MESSAGE}</p>
      </main>
    );
  }
}
