"use client";

/**
 * The quiet row under a settled answer in Code: Copy, Good response, Bad
 * response and, on the newest turn, Retry. Claude Code's VS Code panel and
 * Codex reveal the same verbs on hover; here the newest answer keeps them in
 * view (it is the one people act on) and older answers show them while the
 * turn is under the pointer or holds focus, so the thread still reads as prose.
 *
 * Restraint, per the motion direction: no celebration on a thumbs up, nothing
 * loud on a thumbs down, the icons do not articulate on hover (they sit in a
 * list of actions, not on a destination), and Copy confirms itself by swapping
 * its glyph for 1.5 s with the word announced to screen readers.
 */
import * as React from "react";
import { Glyph } from "./primitives";

export type AnswerFeedback = "UP" | "DOWN" | null;

export interface AnswerActionsProps {
  text: string;
  /** The newest settled answer: actions stay visible. */
  latest?: boolean;
  feedback?: AnswerFeedback;
  onFeedback?: (value: AnswerFeedback) => void;
  /** Runs the turn's prompt again (after undoing its changes, when the host can). */
  onRetry?: () => void;
  /** What Retry will do, said in its tooltip. */
  retryTitle?: string;
}

export function AnswerActions({ text, latest, feedback = null, onFeedback, onRetry, retryTitle }: AnswerActionsProps) {
  const [copied, setCopied] = React.useState<"yes" | "failed" | null>(null);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="cv2-answer-actions" role="toolbar" aria-label="Answer actions" data-latest={latest ? "true" : undefined}>
      <button type="button" className="cv2-iconbtn" aria-label={copied === "yes" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy"} title="Copy" onClick={() => void copy()}>
        <Glyph name={copied === "yes" ? "check" : "copy"} size={15} />
      </button>
      {onFeedback && (
        <>
          <button
            type="button"
            className="cv2-iconbtn"
            aria-label="Good response"
            title="Good response"
            aria-pressed={feedback === "UP"}
            onClick={() => onFeedback(feedback === "UP" ? null : "UP")}
          >
            <Glyph name="thumbs-up" size={15} />
          </button>
          <button
            type="button"
            className="cv2-iconbtn"
            aria-label="Bad response"
            title="Bad response"
            aria-pressed={feedback === "DOWN"}
            onClick={() => onFeedback(feedback === "DOWN" ? null : "DOWN")}
          >
            <Glyph name="thumbs-down" size={15} />
          </button>
        </>
      )}
      {onRetry && (
        <button type="button" className="cv2-iconbtn" aria-label="Retry" title={retryTitle ?? "Retry"} onClick={onRetry}>
          <Glyph name="retry" size={15} />
        </button>
      )}
      <span className="cv2-sr" aria-live="polite">
        {copied === "yes" ? "Copied" : copied === "failed" ? "Could not copy" : ""}
      </span>
    </div>
  );
}
