"use client";

import * as React from "react";
import { ContextComposerField } from "./context-composer-field";
import { PlusMenu } from "./composer-plus-menu";
import { VoiceComposerFrame } from "@/components/voice/voice-composer-glow";
import type { VoiceCallParts } from "@/components/voice/realtime-voice";
import { Button } from "@/components/ui/button";
import { ComposerPrimaryAction, ComposerShell, composerFieldClass, composerIconButtonClass } from "@/components/ui/composer-shell";
import { Mic } from "@/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type SurfaceProps = Omit<React.ComponentPropsWithoutRef<typeof ComposerShell>, "leading" | "trailing" | "action"> & {
  add?: React.ComponentProps<typeof PlusMenu>;
  model?: React.ReactNode;
  armed?: React.ReactNode;
  context?: React.ReactNode;
  dictate?: { active: boolean; disabled?: boolean; onOpen: () => void };
  primary?: React.ComponentPropsWithoutRef<typeof ComposerPrimaryAction> & { tooltip: string };
  voice?: VoiceCallParts | null;
};

/** Chat and Code supply their own session state to this composer. */
export const ChatComposerSurface = React.forwardRef<HTMLDivElement, SurfaceProps>(function ChatComposerSurface(
  { add, model, armed, context, dictate, primary, voice, className, ...shell },
  ref,
) {
  const { tooltip, ...action } = primary ?? { tooltip: undefined, face: undefined };
  return (
    <VoiceComposerFrame call={voice ?? undefined}>
      <ComposerShell
        {...shell}
        ref={ref}
        className={cn("chat-composer max-h-[min(37.5rem,65dvh)]", voice && "voice-glow-host", className)}
        leading={
          <>
            {add && <PlusMenu {...add} />}
            {!voice && model}
            {armed}
            {voice?.status}
          </>
        }
        trailing={voice ? voice.controls : (
          <>
            {context}
            {dictate && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={dictate.onOpen}
                    disabled={dictate.disabled}
                    aria-label="Dictate"
                    aria-pressed={dictate.active}
                    className={composerIconButtonClass}
                  >
                    <Mic className="size-4" motion="none" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Dictate</TooltipContent>
              </Tooltip>
            )}
          </>
        )}
        action={
          <>
            {action.face && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <ComposerPrimaryAction {...action} face={action.face} />
                </TooltipTrigger>
                <TooltipContent>{tooltip}</TooltipContent>
              </Tooltip>
            )}
            {voice?.end}
          </>
        }
      />
    </VoiceComposerFrame>
  );
});

type FieldProps = React.ComponentPropsWithoutRef<typeof ContextComposerField> & { home?: boolean };

export const ChatComposerField = React.forwardRef<HTMLTextAreaElement, FieldProps>(function ChatComposerField(
  { home, className, ...field },
  ref,
) {
  return (
    <div className="relative">
      <ContextComposerField
        {...field}
        ref={ref}
        className={cn(composerFieldClass, home && "min-h-[3.5rem] max-[760px]:min-h-[3.25rem]", className)}
      />
    </div>
  );
});
