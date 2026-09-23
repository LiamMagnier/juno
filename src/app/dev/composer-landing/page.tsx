import { notFound } from "next/navigation";
import { ComposerLandingFixture } from "./fixture";

/**
 * Dev-only fixture for the chat composer's two frames and the in-chat task
 * panel.
 *
 * The composer cannot be seen without an account, and the claim this page
 * checks is a claim about two objects SEEN TOGETHER: that the landing composer
 * and the docked one are the same width, so the first send moves it without
 * resizing it. The task panel is here for the same reason; a model-started task
 * only exists after a real run. Real components, fixture data, no network that
 * matters.
 *
 * Not linked from anywhere and 404s outside development, the same contract as
 * /dev/controls.
 */
export default function ComposerLandingDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ComposerLandingFixture />;
}
