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
 * note shows.
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
  const { quota } = await searchParams;
  return <ShellFixture nearCap={quota === "near"} />;
}
