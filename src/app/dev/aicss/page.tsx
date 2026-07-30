import { notFound } from "next/navigation";
import { AicssGallery } from "./gallery";

/**
 * Dev-only gallery for the AIcss blocks (see `src/components/aicss`).
 *
 * Every block in every state it can actually be in, on the real tokens, so a
 * change to `.aicss-*` in globals.css can be checked in both themes without
 * driving a live model to reproduce a streaming state. Not linked from anywhere
 * and 404s outside development — same contract as /dev/learning.
 */
export default function AicssDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AicssGallery />;
}
