import { notFound } from "next/navigation";
import { PremiumGallery } from "./gallery";

/**
 * Dev-only gallery for the premium pass (docs/design/premium-pass/BRIEF.md):
 * every Libraries.dev placement in the web app, rendered by the REAL
 * component in each state its app state can put it in, so the effects can be
 * checked in both themes without an account, a live model or a microphone.
 *
 *   landings   Chat and Code empty states in one display system
 *   composer   the landing bloom and the streaming line on the real Composer
 *   phases     the transcript's live row with a Thinking orb per real phase
 *   image      the pixel mosaic in the generated-image placeholder
 *   voice      the dictation glow (fed a demo level here; the product feeds
 *              the microphone stream)
 *   agents     bot avatars on the roster, idle and working
 *   upgrade    the one liquid-metal CTA
 *
 * `?only=<section>` renders one section. Not linked from anywhere and 404s
 * outside development, the same contract as /dev/controls.
 */
export default async function PremiumDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { only, peak } = await searchParams;
  return <PremiumGallery only={typeof only === "string" ? only : undefined} voicePeak={peak === "1"} />;
}
