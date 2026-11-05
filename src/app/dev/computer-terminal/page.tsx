import { notFound } from "next/navigation";
import { ComputerTerminalStage } from "./stage";

/**
 * Dev-only stage for the agent computer's files and terminal pane
 * (docs/design/agents-v2/COMPUTERS_2026-10.md S5): the real overlay
 * (`AgentComputerOverlay`) fed fixtures through a fetch shim, so the read-only
 * terminal beside the screen, its narrow-screen tab and the files dialog's
 * "Add a file" can be seen without a computer host.
 *
 *   /dev/computer-terminal               a command running, output arriving
 *   /dev/computer-terminal?state=empty   a task with no command yet
 *   /dev/computer-terminal?state=done    a finished command that failed, and a capped one
 *
 * The live view never connects here (no relay): the screen shows its
 * "Connecting…" state. Not linked from anywhere and 404s outside development.
 */
export default async function ComputerTerminalDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const state = params.state === "empty" || params.state === "done" ? params.state : "running";
  return (
    <div>
      <ComputerTerminalStage state={state} />
    </div>
  );
}
