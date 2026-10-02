import { notFound } from "next/navigation";
import { ShellFixture } from "./shell-fixture";

/**
 * Dev-only fixture for the app sidebar: the real `AppSidebar`, fed a fixture
 * account, at the widths it ships at (Chat expanded, the rail, Code
 * expanded), in whichever theme the browser asks for.
 *
 * The sidebar is only ever seen signed in, and its look is a claim about
 * alignment and rhythm down a whole column, which a unit test cannot see.
 * `?quota=near` puts the account near its message cap so the footer's usage
 * note shows. `?many=1` adds a hundred older chats, enough for Recent to page.
 * `?shell=1` mounts the real `AppShell` around the column instead of the
 * three frames, so the phone drawer and the docked frame can be checked as
 * they ship. `?w=224` (or any width the shell allows, 224 to 336) sets the
 * two expanded frames, for the column's alignment at its resize limits.
 *
 * Not linked from anywhere and 404s outside development, the same contract as
 * /dev/controls.
 */
export default async function ShellDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { quota, many, shell, w } = await searchParams;
  const width = Math.min(336, Math.max(224, Number(w) || 260));
  return <ShellFixture nearCap={quota === "near"} many={many === "1"} shell={shell === "1"} width={width} />;
}
