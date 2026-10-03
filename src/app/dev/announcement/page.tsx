import { notFound } from "next/navigation";
import { AnnouncementGallery } from "./gallery";

/**
 * Dev-only gallery for the announcement dialog (404s in production). The real
 * popup needs a signed-in session and a live row; this renders the same
 * AnnouncementDialog against fixtures.
 *
 *   /dev/announcement?f=video|image|logo|none|long|broken&theme=light|dark
 */
export const metadata = { title: "Announcement" };

export default async function AnnouncementDevPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const f = typeof sp.f === "string" ? sp.f : "video";
  const theme = sp.theme === "light" || sp.theme === "dark" ? sp.theme : undefined;
  return <AnnouncementGallery initial={f} theme={theme} />;
}
