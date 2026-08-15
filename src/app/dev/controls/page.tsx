import { notFound } from "next/navigation";
import { ControlsGallery } from "./gallery";

/**
 * Dev-only gallery for the control system — <Button>, <Pressable>,
 * <SegmentedControl>, <Badge> — every variant in every state, side by side.
 *
 * The reason this exists rather than a screenshot in a doc: "the buttons don't
 * look like each other" is a claim about controls SEEN TOGETHER, and the
 * product never shows them together. A filter row lives on /artifacts, a
 * dialog footer lives behind a click, and a page action lives in a header — so
 * a variant can drift for months because nothing ever renders it beside the
 * thing it is supposed to match. Here they are all in one column, on the real
 * tokens, in both themes.
 *
 * Not linked from anywhere and 404s outside development — same contract as
 * /dev/learning, /dev/aicss and /dev/voice.
 */
export default function ControlsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ControlsGallery />;
}
