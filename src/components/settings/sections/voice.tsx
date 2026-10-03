"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, Play, Square } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { IconSwap } from "@/components/ui/icon-swap";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/components/app/app-provider";
import { ChoiceMenu } from "@/components/settings/choice-menu";
import { useSaveStates } from "@/components/settings/save-status";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { PLANS } from "@/lib/plans";
import { cn } from "@/lib/utils";
import { voicesFor, defaultVoiceFor } from "@/lib/voices";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { Switch } from "@/components/ui/switch";
import { useUiPref } from "@/lib/ui-prefs";
import { playVoiceCue } from "@/components/voice/voice-cue-player";

// Short on purpose: a preview is billed per character and the reader may
// audition a dozen voices in a row. Long enough to hear timbre.
const VOICE_PREVIEW_TEXT = `Hi, I'm ${PRODUCT_NAME}. This is how I sound when I read an answer aloud.`;


/**
 * The voice Juno reads answers in.
 *
 * One row: the voice as a described menu, and a play button that auditions
 * the one chosen. It was thirteen bordered tiles with a play button floated
 * over each, most of the section's height for one choice. The dictation and
 * voice-mode rows that followed were two badges that could not be changed;
 * they are one plain sentence now, because they are facts about this server
 * and plan, not settings.
 */
export function VoiceSection() {
  const { settings, quota, features } = useApp();
  const save = useSettingsSave();
  const saves = useSaveStates();
  const plan = PLANS[quota.plan];
  const [voiceSounds, setVoiceSounds] = useUiPref("voiceSounds");
  // The live provider's voices: Gemini's under Google, OpenAI's under OpenAI.
  // A saved id from the other provider is not sent to this one (the route
  // vets it), so the picker shows what will actually be heard: the default.
  const voices = voicesFor(features.ttsProvider);
  const voiceOptions = React.useMemo(
    () => voices.map((v) => ({ value: v.id, label: v.label, description: v.description })),
    [voices]
  );
  const voice = voices.find((v) => v.id === settings.voiceId) ?? voices.find((v) => v.id === defaultVoiceFor(features.ttsProvider)) ?? voices[0];
  const activeVoice = voice?.id ?? "";

  // At most one audition at a time. `previewSeq` is the ownership token:
  // every stop mints a fresh one, so a slow fetch that lands after its click
  // was superseded can neither start playing nor touch the UI.
  const [preview, setPreview] = React.useState<{ id: string; loading: boolean } | null>(null);
  const previewAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = React.useRef<string | null>(null);
  const previewSeqRef = React.useRef(0);

  const stopPreview = React.useCallback(() => {
    previewSeqRef.current++;
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.onended = null;
      previewAudioRef.current.onerror = null;
      previewAudioRef.current = null;
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreview(null);
  }, []);

  React.useEffect(() => stopPreview, [stopPreview]);

  const playPreview = async (voiceId: string) => {
    const wasActive = preview?.id === voiceId;
    stopPreview();
    if (wasActive) return;
    const seq = previewSeqRef.current;
    setPreview({ id: voiceId, loading: true });
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: VOICE_PREVIEW_TEXT, voiceId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (previewSeqRef.current !== seq) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewUrlRef.current = url;
      previewAudioRef.current = audio;
      const done = () => {
        if (previewSeqRef.current === seq) stopPreview();
      };
      audio.onended = done;
      audio.onerror = done;
      setPreview({ id: voiceId, loading: false });
      await audio.play();
    } catch {
      if (previewSeqRef.current !== seq) return;
      stopPreview();
      toast.error("Couldn’t play that preview.");
    }
  };

  // Every clause removes a way this could be a control that looks alive and
  // does nothing: serverTts (else the browser speaks in the OS voice),
  // voices (ElevenLabs has none to choose), plan.voice (the route refuses without it).
  const pickerAvailable = features.serverTts && voices.length > 0 && Boolean(voice) && plan.voice;
  const playing = preview?.id === activeVoice;
  const loading = playing && preview.loading;

  return (
    <>
      <SettingsGroup title="Read aloud">
        {pickerAvailable ? (
          <SettingRow
            label="Voice"
            description={voice?.description}
            wide
            status={saves.status("voiceId")}
            control={
              <div className="flex w-full items-center gap-2 @[34rem]/pane:w-auto">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      onClick={() => void playPreview(activeVoice)}
                      aria-label={playing ? "Stop the preview" : "Play a preview"}
                    >
                      {/* Three faces from two swaps: play and stop inside, and
                          that pair against the spinner outside. */}
                      <IconSwap
                        swapped={loading}
                        from={<IconSwap swapped={playing} from={<Play className="size-4" />} to={<Square className="size-4" />} />}
                        to={<Loader2 className={cn("size-4", loading && "motion-safe:animate-spin")} />}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{playing ? "Stop" : "Preview"}</TooltipContent>
                </Tooltip>
                <ChoiceMenu
                  label="Read-aloud voice"
                  value={activeVoice}
                  options={voiceOptions}
                  onChange={(voiceId) => {
                    if (voiceId === activeVoice) return;
                    stopPreview();
                    void saves.track("voiceId", () => save({ voiceId }));
                  }}
                  className="flex-1 @[34rem]/pane:w-48 @[34rem]/pane:flex-none"
                />
              </div>
            }
          />
        ) : (
          <SettingRow
            label="Voice"
            description={
              !plan.voice
                ? "Choosing a voice needs a plan with voice."
                : !features.serverTts
                  ? "Answers are read in your browser’s built-in voice on this server."
                  : "This server’s speech provider uses its own voice."
            }
          />
        )}
      </SettingsGroup>

      <SettingsGroup title="Voice conversations">
        <SettingRow
          label="Voice sounds"
          htmlFor="voice-sounds"
          description="A soft chime when a call can hear you, and another when it ends. On this device."
          control={
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  playVoiceCue("start");
                  window.setTimeout(() => playVoiceCue("end"), 700);
                }}
              >
                Preview
              </Button>
              <Switch id="voice-sounds" checked={voiceSounds} onCheckedChange={setVoiceSounds} />
            </div>
          }
        />
      </SettingsGroup>

      <p className="pt-6 text-ui text-muted-foreground">
        <span>
          {features.serverStt
            ? `Dictation is transcribed by ${PRODUCT_NAME}, in any language.`
            : "Dictation uses your browser’s speech recognition."}
        </span>{" "}
        <span>
          {plan.voice ? "Voice conversations are included in your plan." : "Voice conversations need a plan with voice."}
        </span>
      </p>
    </>
  );
}
