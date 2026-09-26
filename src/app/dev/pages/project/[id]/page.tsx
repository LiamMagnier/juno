import { notFound } from "next/navigation";
import { PagesGallery } from "../../gallery";
import { STATES, type PageState } from "../../pages";

/** A project's page under /dev/pages (see ../../page.tsx): it reads its id from the route. */
export default async function ProjectDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  const s = (STATES as readonly string[]).includes(String(state)) ? (state as PageState) : "ready";
  return <PagesGallery key={s} page="project" state={s} />;
}
