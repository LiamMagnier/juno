import { AppPageHeader } from "@/components/app/app-page";
import { CustomizeFrame } from "@/components/customize/customize-nav";
import { PersonalizationSection } from "@/components/settings/sections/personalization";
import { PRODUCT_NAME } from "@/lib/brand/names";

export default function InstructionsPage() {
  return <CustomizeFrame current="instructions">
    <AppPageHeader heading="Instructions" lede={`How ${PRODUCT_NAME} responds and what it should know about you.`} />
    <PersonalizationSection />
  </CustomizeFrame>;
}
