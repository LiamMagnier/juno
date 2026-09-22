"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, Play, Square } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { useApp } from "@/components/app/app-provider";
import { IconSwap } from "@/components/ui/icon-swap";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingBlock, SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { PLANS } from "@/lib/plans";
import { cn } from "@/lib/utils";
import { VOICES, DEFAULT_VOICE } from "@/lib/voices";

// Short on purpose: a preview is billed per character and the user may audition
// a dozen voices in a row. Long enough to hear timbre, not a paragraph.
const VOICE_PREVIEW_TEXT = "Hi, I'm Juno. This is how I sound when I read an answer aloud.";

export function VoiceSection() {
  const { settings, quota, features } = useApp();
  const save = useSettingsSave();
  const plan = PLANS[quota.plan];
  const activeVoice = settings.voiceId ?? DEFAULT_VOICE;

  // Voice preview: at most one audition at a time — a new click cancels whatever
  // is loading or playing. `previewSeq` is the ownership token; every stop mints
  // a fresh one so a slow fetch that lands after its click was superseded can
  // neither start playing nor touch the UI.
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

  const voiceOption = useRadioGroup(
    VOICES,
    VOICES.findIndex((v) => v.id === activeVoice),
    (v) => void save({ voiceId: v.id })
  );

  // Every clause removes a way this could be a control that looks alive and
  // does nothing: serverTts (else the browser fallback speaks in the OS voice),
  // ttsProvider (the list is OpenAI's), plan.voice (the route 403s without it).
  const pickerAvailable = features.serverTts && features.ttsProvider === "openai" && plan.voice;

  return (
    <>
      <SettingsGroup title="Read aloud" description="The voice Juno reads answers in. Press play to hear one.">
        {pickerAvailable ? (
          <SettingBlock label="Voice">
            <div className="grid grid-cols-1 gap-2 @[28rem]/pane:grid-cols-2" role="radiogroup" aria-label="Read-aloud voice">
              {VOICES.map((v, i) => {
                const selected = activeVoice === v.id;
                const active = preview?.id === v.id;
                const loading = active && preview.loading;
                return (
                  <div key={v.id} className="group relative hover:z-10">
                    <Pressable
                      kind="tile"
                      role="radio"
                      selected={selected}
                      aria-checked={selected}
                      aria-label={`Read aloud in the ${v.label} voice`}
                      onClick={() => void save({ voiceId: v.id })}
                      className="w-full pr-12"
                      {...voiceOption(i)}
                    >
                      <span className="flex items-center gap-1.5 text-body font-medium">
                        {v.label}
                        {selected && <StatusIcons.success className="check-morph size-3.5 shrink-0 text-primary" />}
                      </span>
                      <span className="text-ui text-muted-foreground">{v.description}</span>
                    </Pressable>
                    {/* Play, stop and the spinner share one cell and cross-fade:
                        one control changing state, not three glyphs taking
                        turns. The spinner turns only while it is showing.

                        Centred with `inset-y-0 my-auto`, not a -50% translate:
                        `.pressable:active` sets `transform: scale(.97)`, which
                        replaced the translate and dropped the button by half its
                        height for as long as it was held. */}
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      className="absolute inset-y-0 right-3 z-10 my-auto"
                      onClick={() => void playPreview(v.id)}
                      aria-label={active ? `Stop the ${v.label} preview` : `Preview the ${v.label} voice`}
                      title={active ? "Stop preview" : "Preview voice"}
                    >
                      {/* Three faces from two swaps: play ⇄ stop inside,
                          and that pair ⇄ the spinner outside. */}
                      <IconSwap
                        swapped={loading}
                        from={<IconSwap swapped={active} from={<Play className="size-4" />} to={<Square className="size-4" />} />}
                        to={<Loader2 className={cn("size-4", loading && "motion-safe:animate-spin")} />}
                      />
                    </Button>
                  </div>
                );
              })}
            </div>
          </SettingBlock>
        ) : (
          <SettingRow
            label="Voice"
            description={
              !plan.voice
                ? "Voice mode is not on your plan."
                : !features.serverTts
                  ? "Read-aloud uses your browser's built-in voice on this server."
                  : "This server's speech provider brings its own voice."
            }
            control={<Badge variant="secondary">{plan.voice ? "Provider default" : "Unavailable"}</Badge>}
          />
        )}
      </SettingsGroup>

      <SettingsGroup title="Dictation" description="Talking to Juno from the composer's microphone button.">
        <SettingRow
          label="Transcription"
          description={
            features.serverStt
              ? "Speech is transcribed server-side with a real model, in any language."
              : "Speech is transcribed by your browser. Accuracy depends on it."
          }
          control={<Badge variant="secondary">{features.serverStt ? "Server" : "Browser"}</Badge>}
        />
        <SettingRow
          label="Voice mode"
          description="Hands-free conversation with a live transcript."
          control={<Badge variant="secondary">{plan.voice ? "Included" : "Upgrade to unlock"}</Badge>}
        />
      </SettingsGroup>
    </>
  );
}
