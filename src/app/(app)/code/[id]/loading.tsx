import "@/components/code/v2/code-v2.css";
import { CodeSessionLoading } from "@/components/code/v2/session-shell";

/**
 * `/code/[id]` while the route loads: the session's own frame (header, thread,
 * docked composer), not the parent `/code` skeleton's greeting and centred
 * composer, which used to show here and then jump. When the landing has just
 * sent this thread's first prompt, the frame shows it as the first turn.
 */
export default function CodeSessionRouteLoading() {
  return <CodeSessionLoading />;
}
