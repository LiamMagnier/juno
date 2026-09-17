import { requireUser } from "@/lib/session";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { CodeCustomize } from "@/components/code/code-customize";

export const dynamic = "force-dynamic";

/**
 * `/code/customize` — where Code's page-sized configuration lives.
 *
 * Code has configuration that does not fit in a composer popover: the
 * repositories a cloud run can clone, the Macs and folders a device run can
 * reach, what a run may do without asking, and what the cloud machine actually
 * is. All of it existed before this page and none of it was readable — the two
 * lists were visible only while a target popover was open, as rows you were
 * choosing between rather than an inventory you could check, and the
 * environment was undocumented outside a workflow file.
 *
 * Chat gets no equivalent page, and that asymmetry is the decision rather than
 * an omission: Chat's configuration is already destinations (Projects,
 * Connections) or account settings (docs/design/TWO_PRODUCTS.md §2.2).
 *
 * WHAT THIS PAGE DELIBERATELY DOES NOT DO. It does not draw an editor. There is
 * no `CodeEnvironment` model to edit, no column on `CodeTask` carrying a
 * permission choice, and no runner that reads one — so a form here would be a
 * set of controls that persist nothing, which is a more expensive lie than a
 * page that states facts and says where each one is actually changed. When
 * those models exist this page is where their editors go.
 */
export default async function CodeCustomizePage() {
  await requireUser();

  return (
    <AppPage measure="wide">
      <AppPageHeader
        eyebrow="Code"
        heading="Customize"
        lede="The repositories, Macs and machine your runs use — and what each of them lets a run do."
      />
      <CodeCustomize />
    </AppPage>
  );
}
