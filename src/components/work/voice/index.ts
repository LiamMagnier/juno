/**
 * Voice for a Work task.
 *
 * One entry point on purpose: `WorkVoiceButton` is the whole surface, and the
 * briefing helpers are exported beside it only so the thing the voice model is
 * told can be inspected and tested without opening a microphone.
 */

export {
  WorkVoiceButton,
  isWorkVoiceConfigured,
  type WorkVoiceButtonProps,
  type WorkVoiceSend,
  type WorkVoiceSendIntent,
} from "@/components/work/voice/work-voice-button";

export {
  buildWorkVoiceBriefing,
  workVoiceCatchUp,
  type WorkVoiceBriefing,
  type WorkVoiceBriefingInput,
} from "@/components/work/voice/work-voice-briefing";
