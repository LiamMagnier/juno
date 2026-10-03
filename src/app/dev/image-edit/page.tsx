import { notFound } from "next/navigation";
import { ImageEditGallery } from "./gallery";

/**
 * Dev-only gallery for the image editor (src/components/chat/image-edit-overlay.tsx):
 * a generated picture in a transcript column with its real Edit button, opening
 * the real editor out of the thumbnail. The picture is painted locally, so no
 * network or binary fixture is needed.
 *
 * `?theme=dark` starts dark; `?model=` picks the edit model (`google:…` takes a
 * mask, `minimax:…` takes the area as guidance, anything else cannot edit);
 * `?open=1` opens the editor on load. 404s outside development.
 */
export default async function ImageEditDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { theme, model, open } = await searchParams;
  return (
    <ImageEditGallery
      dark={theme === "dark"}
      model={typeof model === "string" ? model : undefined}
      startOpen={open === "1"}
    />
  );
}
