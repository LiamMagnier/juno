import { redirect } from "next/navigation";

export default async function LegacyArtifactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams({ view: "artifacts" });
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string" && key !== "view") query.set(key, value);
  }
  redirect(`/library?${query}`);
}
