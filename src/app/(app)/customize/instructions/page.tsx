import { CustomizeFrame } from "@/components/customize/customize-nav";
import { AppPageHeader } from "@/components/app/app-page";
import { customizeHeaderClass } from "@/components/customize/customize-section";
import { PersonalizationSection } from "@/components/settings/sections/personalization";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { PageRoot } from "@/components/app/page-root";

export default function InstructionsPage() {
  return (
    <PageRoot>
      <CustomizeFrame current="instructions">
        <AppPageHeader
          backdrop
          heading="Instructions"
          lede={`How ${PRODUCT_NAME} responds, and what it should know about you before you say a word.`}
          className={customizeHeaderClass}
        />
        {/* The frame's children are a list (header, section), and the
            section's Radix Select puts useId values in the HTML, so it takes
            PageRoot too (tests/page-root-hydration.test.ts, list items). */}
        <PageRoot>
          <PersonalizationSection variant="page" />
        </PageRoot>
      </CustomizeFrame>
    </PageRoot>
  );
}
