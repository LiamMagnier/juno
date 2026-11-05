import { notFound } from "next/navigation";
import { PageRoot } from "@/components/app/page-root";
import { MemoryGallery } from "./gallery";

/**
 * Dev-only gallery for the memory page. Renders the REAL page composition
 * (`MemoryManagerView`) against fixture state, so every state of the page can
 * be seen without an account: `?state=full` (the default), `paused`, `empty`,
 * `loading`, `project`, `activity` (the sheet open) and `chat` (the in-chat notice and answer receipt). The fixture's actions
 * mutate local state, so delete with Undo, applying a proposal and adding a
 * memory all play for real. Not linked from anywhere and 404s outside
 * development.
 */
export default async function MemoryDevPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  return (
    <PageRoot>
      <MemoryGallery state={state ?? "full"} />
    </PageRoot>
  );
}
