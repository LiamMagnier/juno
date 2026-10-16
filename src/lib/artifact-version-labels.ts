import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * How a version came to be, in words a reader uses.
 *
 * `ArtifactVersion.origin` stores "generated", "edit" or "restore" (and null
 * on rows older than the column). Those are storage words: the artifact page's
 * history used to print them as they are ("generated", "edit"), next to a
 * canvas that already said "Generated" / "Edited" / "Restored". One table now
 * serves both: `short` for the canvas's dense rail, `long` for a history list
 * with room for a sentence. An origin this build does not know is null, and
 * the caller says "Saved" rather than inventing a meaning for it.
 */

export const VERSION_ORIGIN_COPY = {
  generated: "Generated",
  generatedLong: `Written by ${PRODUCT_NAME}`,
  edit: "Edited",
  editLong: "Edited by you",
  restore: "Restored",
  restoreLong: "Restored from an earlier version",
  saved: "Saved",
} as const;

export interface VersionOriginLabel {
  short: string;
  long: string;
}

export function versionOriginLabel(origin: string | null | undefined): VersionOriginLabel | null {
  switch (origin) {
    case "generated":
      return { short: VERSION_ORIGIN_COPY.generated, long: VERSION_ORIGIN_COPY.generatedLong };
    case "edit":
      return { short: VERSION_ORIGIN_COPY.edit, long: VERSION_ORIGIN_COPY.editLong };
    case "restore":
      return { short: VERSION_ORIGIN_COPY.restore, long: VERSION_ORIGIN_COPY.restoreLong };
    default:
      return null;
  }
}
