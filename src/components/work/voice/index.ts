/**
 * Voice for a Work task.
 *
 * There is no launcher here on purpose. The way into a spoken conversation is
 * the thread composer's own primary button — empty field, wave bars; anything
 * typed, Send — exactly as in `chat/composer.tsx`. What this folder exports is
 * the live session (`WorkVoicePanel`), the open/closed state in the shape that
 * button expects (`useWorkVoice`), and the build-time gate that makes a
 * deployment without a relay draw no voice affordance at all.
 *
 * The briefing helpers are exported beside them only so the thing the voice
 * model is told can be inspected and tested without opening a microphone.
 */

export {
  WorkVoicePanel,
  useWorkVoice,
  isWorkVoiceConfigured,
  type WorkVoicePanelProps,
  type WorkVoiceSend,
  type WorkVoiceSendIntent,
} from "@/components/work/voice/work-voice-panel";

export {
  buildWorkVoiceBriefing,
  workVoiceCatchUp,
  type WorkVoiceBriefing,
  type WorkVoiceBriefingInput,
} from "@/components/work/voice/work-voice-briefing";
