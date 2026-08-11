/**
 * Voice for Juno Work — two conversations, one shape.
 *
 * There is no launcher in here on purpose. The way into a spoken conversation is
 * a composer's own primary button — empty field, wave bars; anything typed,
 * Send — exactly as in `chat/composer.tsx`. What this folder exports is the two
 * live sessions (about a running task, and about a task you are still writing),
 * the open/closed state in the shape that button expects (`useWorkVoice`), and
 * the build-and-plan gate that makes a deployment or an account without voice
 * draw no voice affordance at all.
 *
 * The two panels differ only in what the model is told and what a sent line
 * does; everything they look like is `WorkVoiceSurface`. The briefings are
 * exported beside them so what the voice model is told can be inspected and
 * tested without opening a microphone.
 */

export {
  WorkVoicePanel,
  useWorkVoice,
  isWorkVoiceConfigured,
  type WorkVoicePanelProps,
} from "@/components/work/voice/work-voice-panel";

export { WorkComposerVoicePanel } from "@/components/work/voice/work-composer-voice-panel";

export {
  WorkVoiceSurface,
  type WorkVoiceSend,
  type WorkVoiceSendIntent,
} from "@/components/work/voice/work-voice-surface";

export {
  buildWorkVoiceBriefing,
  buildWorkComposerVoiceBriefing,
  workVoiceCatchUp,
  type WorkVoiceBriefing,
  type WorkVoiceBriefingInput,
  type WorkComposerVoiceBriefingInput,
} from "@/components/work/voice/work-voice-briefing";
