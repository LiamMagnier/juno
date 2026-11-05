import { notFound } from "next/navigation";
import { PageRoot } from "@/components/app/page-root";
import { ComposerChipFixture } from "./fixture";

/**
 * Dev-only fixture for the chat composer's model chip on its real row: the
 * label stepping down to fit a 360px phone, and the paid modes (Fast, Ultra
 * fast, Pro) shown on the closed chip. Query parameters are listed in
 * fixture.tsx. Not linked from anywhere and 404s outside development, the
 * same contract as /dev/composer-landing.
 */
export default function ComposerChipDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <PageRoot>
      <ComposerChipFixture />
    </PageRoot>
  );
}
