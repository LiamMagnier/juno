import { CustomizeFrame } from "@/components/customize/customize-nav";
import { AppPageHeader } from "@/components/app/app-page";
import { customizeHeaderClass } from "@/components/customize/customize-section";
import { PersonalizationSection } from "@/components/settings/sections/personalization";
import { PRODUCT_NAME } from "@/lib/brand/names";

export default function InstructionsPage() {
  return (
    <CustomizeFrame current="instructions">
      <AppPageHeader
        backdrop
        heading="Instructions"
        lede={`How ${PRODUCT_NAME} responds, and what it should know about you before you say a word.`}
        className={customizeHeaderClass}
      />
      <PersonalizationSection variant="page" />
    </CustomizeFrame>
  );
}
