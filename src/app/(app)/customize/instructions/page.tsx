import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { CustomizeNav } from "@/components/customize/customize-nav";
import { PersonalizationSection } from "@/components/settings/sections/personalization";

export default function InstructionsPage() {
  return <AppPage measure="reading">
    <CustomizeNav current="instructions" />
    <AppPageHeader heading="Instructions" lede="How Juno responds and what it should know about you." />
    <PersonalizationSection />
  </AppPage>;
}
