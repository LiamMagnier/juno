import { notFound } from "next/navigation";
import { ModelPickerFixture } from "./fixture";

/**
 * Dev-only fixture for the composer's model control: the chip, the effort
 * panel it opens first, and the catalogue behind it, over the bundled
 * catalogue for a Pro account. The Mac app's snapshot tests render the same
 * catalogue (scripts/export-model-picker-fixture.mts) so the two can be read
 * side by side.
 *
 *   /dev/model-picker?model=anthropic:claude-opus-5-5&effort=high&fast=1
 *   /dev/model-picker?model=google:gemini-3.1-flash-image
 *
 * Not linked from anywhere and 404s outside development, the same contract as
 * /dev/controls.
 */
export default function ModelPickerDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ModelPickerFixture />;
}
