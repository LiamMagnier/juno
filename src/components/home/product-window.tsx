"use client";

import * as React from "react";
import { ArrowUp, ChevronDown, FileText, JunoCode, JunoLibrary, JunoOrbit, Layers, Mic, PanelRight, Plus, Search, Share2, SquarePen, Telescope } from "@/components/ui/icons";
import { ThinkingMark, type ThinkingPhase } from "@/components/brand/thinking-mark";

/**
 * The hero's product window: the Alevr desktop layout (frame, sidebar, inset
 * panel, centered composer) playing one example conversation. The script is
 * fixed and labelled as an example under the window. It plays once when the
 * hero asks for it; Replay runs it again. Reduced motion shows the finished
 * conversation without the sequence.
 */

const PROMPT = "Compare these three onboarding studies. What should we fix first?";

type Token = { t: string; kind?: "h" | "cite" | "li" | "p" };

const ANSWER: Token[][] = [
  [{ t: "Fix the first five minutes", kind: "h" }],
  [
    ..."All three studies lose people at the same moment: the empty workspace right after sign-up."
      .split(" ")
      .map((t) => ({ t })),
    { t: "1", kind: "cite" },
    { t: "2", kind: "cite" },
    ..."Make that first screen useful before adding anything new.".split(" ").map((t) => ({ t })),
  ],
  [...("Start new accounts from a template that matches their role.".split(" ").map((t) => ({ t }))), { t: "3", kind: "cite" }],
  "Ask for one real file instead of a product tour.".split(" ").map((t) => ({ t })),
  "Measure time to a first finished task, not sign-ups.".split(" ").map((t) => ({ t })),
];
const TOTAL_WORDS = ANSWER.reduce((n, block) => n + block.length, 0);

const STEPS: { word: string; phase: ThinkingPhase }[] = [
  { word: "Reading 3 files", phase: "working" },
  { word: "Searching 14 sources with Deep Field", phase: "working" },
  { word: "Comparing the evidence", phase: "thinking" },
];

type Stage = { typed: number; sent: boolean; step: number; done: boolean; words: number; folio: boolean };
const START: Stage = { typed: 0, sent: false, step: -1, done: false, words: 0, folio: false };
const END: Stage = { typed: PROMPT.length, sent: true, step: STEPS.length, done: true, words: TOTAL_WORDS, folio: true };

function useScript(play: boolean) {
  const [stage, setStage] = React.useState<Stage>(START);
  const [run, setRun] = React.useState(0);
  React.useEffect(() => {
    if (!play) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStage(END);
      return;
    }
    setStage(START);
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    let t = 500;
    for (let i = 1; i <= PROMPT.length; i++) {
      at(t, () => setStage((s) => ({ ...s, typed: i })));
      t += i % 9 === 0 ? 70 : 26;
    }
    t += 380;
    at(t, () => setStage((s) => ({ ...s, sent: true })));
    t += 520;
    STEPS.forEach((_, i) => {
      at(t, () => setStage((s) => ({ ...s, step: i })));
      t += 1250;
    });
    at(t, () => setStage((s) => ({ ...s, done: true, step: STEPS.length })));
    t += 260;
    for (let w = 1; w <= TOTAL_WORDS; w++) {
      at(t, () => setStage((s) => ({ ...s, words: w })));
      t += 34;
    }
    t += 360;
    at(t, () => setStage((s) => ({ ...s, folio: true })));
    return () => timers.forEach(clearTimeout);
  }, [play, run]);
  return { stage, replay: () => setRun((r) => r + 1) };
}

export function ProductWindow({ play, onReplayRef }: { play: boolean; onReplayRef?: React.MutableRefObject<(() => void) | null> }) {
  const { stage, replay } = useScript(play);
  React.useEffect(() => {
    if (onReplayRef) onReplayRef.current = replay;
  });
  const step = STEPS[Math.max(0, Math.min(stage.step, STEPS.length - 1))];
  let index = 0;
  const words = (block: Token[]) =>
    block.map((tok) => {
      const on = index++ < stage.words;
      if (tok.kind === "cite") return <span key={index} className="alv-word alv-cite" data-on={on || undefined}>{tok.t}</span>;
      return <span key={index} className="alv-word" data-on={on || undefined}>{tok.t} </span>;
    });

  return (
    <div className="alv-window" aria-hidden>
      <aside className="alv-window-side">
        <div className="alv-traffic"><i /><i /><i /></div>
        <div className="alv-side-row"><SquarePen />New chat</div>
        <div className="alv-side-row"><Search />Search</div>
        <div className="alv-side-row"><JunoLibrary />Library</div>
        <div className="alv-side-row"><Layers />Folio</div>
        <div className="alv-side-row"><JunoOrbit />Orbit</div>
        <div className="alv-side-row"><JunoCode />Code</div>
        <div className="alv-side-label">Recent</div>
        <div className="alv-side-recent" data-active>Onboarding research</div>
        <div className="alv-side-recent">Q4 planning notes</div>
        <div className="alv-side-recent">Pricing page copy</div>
        <div className="alv-side-recent">Interview synthesis</div>
        <div className="alv-side-recent">Launch email draft</div>
        <div className="alv-side-user"><span className="alv-avatar">IK</span><span>Inès Kervella</span></div>
      </aside>
      <div className="alv-window-main">
        <div className="alv-window-bar">
          <span className="alv-window-title">Onboarding research</span>
          <span className="alv-window-tools"><span><Share2 /></span><span><PanelRight /></span></span>
        </div>
        <div className="alv-thread">
          <div className="alv-thread-col">
            <div className="alv-pop alv-files" data-on={stage.sent || undefined} hidden={!stage.sent}>
              {["Study A, March", "Study B, June", "Study C, Sept"].map((name) => (
                <span key={name} className="alv-file"><span className="alv-file-icon"><FileText /></span><span><b>{name}</b><br /><small>PDF</small></span></span>
              ))}
            </div>
            <div className="alv-pop alv-user-turn" data-on={stage.sent || undefined} hidden={!stage.sent}>{PROMPT}</div>
            <div className="alv-pop alv-work" data-on={stage.step >= 0 || undefined} hidden={stage.step < 0}>
              <ThinkingMark phase={stage.done ? "finished" : step.phase} eventKey={stage.step} size={18} />
              <span key={stage.done ? "done" : stage.step} className="alv-work-word">{stage.done ? "Researched 14 sources" : step.word}</span>
            </div>
            <div className="alv-answer" hidden={!stage.done}>
              <h4>{words(ANSWER[0])}</h4>
              <p>{words(ANSWER[1])}</p>
              <ol>
                <li><span>{words(ANSWER[2])}</span></li>
                <li><span>{words(ANSWER[3])}</span></li>
                <li><span>{words(ANSWER[4])}</span></li>
              </ol>
            </div>
            <div className="alv-pop alv-folio" data-on={stage.folio || undefined} hidden={!stage.folio}>
              <span className="alv-folio-thumb"><i /><i /><i /><i /><i /></span>
              <span><b>Onboarding brief</b><small>Document in Folio, 2 pages</small></span>
              <span className="alv-folio-open">Open</span>
            </div>
          </div>
        </div>
        <div className="alv-composer-wrap">
          <div className="alv-composer">
            <div className="alv-composer-text">{stage.sent || stage.typed === 0 ? "Ask Alevr" : <span style={{ color: "var(--alv-ink)" }}>{PROMPT.slice(0, stage.typed)}</span>}</div>
            <div className="alv-composer-row">
              <span className="alv-icon-btn"><Plus /></span>
              <span className="alv-icon-btn" style={{ color: "var(--alv-presence)" }}><Telescope /></span>
              <span className="alv-model">Auto<ChevronDown /></span>
              <span className="alv-icon-btn"><Mic /></span>
              <span className="alv-send" data-idle={stage.sent || stage.typed === 0 || undefined}><ArrowUp /></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
