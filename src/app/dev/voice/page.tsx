import { notFound } from "next/navigation";
import { VoiceGallery } from "./gallery";

/**
 * Dev-only gallery for the voice aura (see `src/components/voice/voice-aura`).
 *
 * The aura only exists during a live realtime call, which needs a microphone,
 * the relay, and someone talking — so without this the only way to look at it
 * was to hold a conversation with it, and the only way to compare "you talking"
 * against "Juno talking" was to take turns. Here the amplitude is a slider and
 * the speaker is a switch. Not linked from anywhere and 404s outside
 * development — same contract as /dev/aicss.
 */
export default function VoiceDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <VoiceGallery />;
}
