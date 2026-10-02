import { CustomizeFrame } from "@/components/customize/customize-nav";
import { PageHero } from "@/components/app/editorial";
import { PersonalizationSection } from "@/components/settings/sections/personalization";
import { PRODUCT_NAME } from "@/lib/brand/names";

export default function InstructionsPage() {
  return (
    <CustomizeFrame current="instructions">
      <PageHero heading="Instructions" lede={`How ${PRODUCT_NAME} responds, and what it should know about you before you say a word.`} />
      <div className="h-14" aria-hidden="true" />
      <PersonalizationSection variant="page" />
    </CustomizeFrame>
  );
}
