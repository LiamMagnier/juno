"use client";

import * as React from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { ArrowUp, AudioLines, ChevronDown, Folder, Mic, Plus, RotateCcw, Search } from "@/components/ui/icons";
import { Face } from "./face";
import { CREW, MIRA, PRESENCE_LABEL, SCOUT, type Presence } from "./fixtures";
import { Orbit } from "./glyphs";
import { AtPalette, Caret, Composer, DraftText, DRAFT, ModelMenu, PALETTE_ITEMS, TOK, Token, TokenPanel } from "./composer";

/*
 * The motion page: each moment of the language on its own loop, with a label,
 * its timing, and a replay button. `?moment=N` plays one moment alone, larger,
 * for recording. Motion explains cause and continuity; nothing decorates.
 *
 * Reduced motion: MotionConfig (stage.tsx) runs with reducedMotion="user", so
 * every transform and layout animation below becomes instant and only the
 * opacity crossfades remain. CSS animations are gated the same way.
 */

const EASE = [0.2, 0, 0, 1] as const;

/** Run a script of cues: `step` is how many cues have passed. Loops after `total`. */
function useScript(times: number[], total: number) {
  const [step, setStep] = React.useState(0);
  const [cycle, setCycle] = React.useState(0);
  React.useEffect(() => {
    setStep(0);
    const ids = times.map((t, i) => window.setTimeout(() => setStep(i + 1), t));
    ids.push(window.setTimeout(() => setCycle((c) => c + 1), total));
    return () => ids.forEach((id) => window.clearTimeout(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle]);
  return step;
}

/* ------------------------------------------------------------------ */
/* 1. Composer focus: tonal                                            */
/* ------------------------------------------------------------------ */
function M1() {
  const step = useScript([700, 2700], 3600);
  const focused = step === 1;
  return (
    <div className="pc-mstage__center">
      <div className="w-[520px] max-w-full">
        <Composer variant="home" focused={focused} action="voice" placeholder="Ask anything. Type @ to bring in files, apps and crew">
          {focused ? <Caret /> : null}
        </Composer>
      </div>
      <p className="pc-small pc-quiet mt-5">{focused ? "Focused" : "At rest"}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. @ palette at the caret, then the mark lands in the sentence      */
/* ------------------------------------------------------------------ */
const M2_ITEMS = PALETTE_ITEMS.filter((i) => ["mira", "forecast", "notes", "atlas", "stripe", "slack"].includes(i.key));
function M2() {
  const step = useScript([500, 1000, 1150, 1650, 1780, 2300, 2360, 2420, 2480, 2540, 2600], 4400);
  const typedAfter = ["", "@", "@q", "@q3", "@q3", "", " ", " w", " wi", " wit", " with", " with "][step];
  const query = typedAfter.startsWith("@") ? typedAfter.slice(1) : "";
  const open = step >= 1 && step <= 4;
  const landed = step >= 5;
  const pressed = step === 4;
  const caretRef = React.useRef<HTMLSpanElement | null>(null);
  const [anchor, setAnchor] = React.useState<{ left: number; top: number } | null>(null);
  React.useLayoutEffect(() => {
    if (step !== 1) return;
    const c = caretRef.current;
    const box = c?.closest(".pc-composer");
    if (!c || !box) return;
    const a = c.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    setAnchor({ left: Math.max(8, a.left - b.left - 26), top: a.bottom - b.top + 8 });
  }, [step]);
  const items = query ? M2_ITEMS.filter((i) => i.tok.label.toLowerCase().includes(query)) : M2_ITEMS;
  return (
    <div className="pc-mstage__top">
      <LayoutGroup id="m2">
        <div className="w-[560px] max-w-full">
          <Composer
            variant="home"
            focused
            overlay={
              <AnimatePresence>
                {open && anchor ? (
                  <motion.div
                    key="pal"
                    className="absolute"
                    style={{ left: anchor.left, top: anchor.top, zIndex: 30, transformOrigin: "0 0" }}
                    initial={{ opacity: 0, y: 4, scale: 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.1, ease: "linear" } }}
                    transition={{ duration: 0.14, ease: EASE }}
                  >
                    <AtPalette
                      query={query}
                      items={items}
                      active={0}
                      markLayoutPrefix="m2"
                      className={`!static ${pressed ? "pc-pal--press" : ""}`}
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            }
          >
            Compare{" "}
            {landed ? (
              <Token tok={TOK.forecast} markLayoutId="m2-forecast" />
            ) : (
              <span className="pc-q">{typedAfter.startsWith("@") ? typedAfter : ""}</span>
            )}
            {landed ? typedAfter : null}
            <Caret caretRef={caretRef} blink={false} />
          </Composer>
        </div>
      </LayoutGroup>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3. An app token opens its page, emerging from the token             */
/* ------------------------------------------------------------------ */
function M3() {
  const step = useScript([700, 3000], 4000);
  const open = step === 1;
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const [anchor, setAnchor] = React.useState<{ left: number; top: number; ox: number } | null>(null);
  React.useLayoutEffect(() => {
    const t = ref.current;
    const box = t?.closest(".pc-composer");
    if (!t || !box) return;
    const a = t.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.left - b.left - 6, b.width - 312 - 8));
    setAnchor({ left, top: a.bottom - b.top + 8, ox: a.left - b.left - left + a.width / 2 });
  }, []);
  return (
    <div className="pc-mstage__top">
      <div className="w-[560px] max-w-full">
        <Composer
          variant="home"
          overlay={
            <AnimatePresence>
              {open && anchor ? (
                <motion.div
                  key="panel"
                  className="absolute"
                  style={{ left: anchor.left, top: anchor.top, zIndex: 30, transformOrigin: `${anchor.ox}px 0px` }}
                  initial={{ opacity: 0, scale: 0.96, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1, ease: "linear" } }}
                  transition={{ duration: 0.18, ease: EASE }}
                >
                  <TokenPanel app="stripe" className="!static" />
                </motion.div>
              ) : null}
            </AnimatePresence>
          }
        >
          Compare <Token tok={TOK.forecast} /> with <Token tok={TOK.stripe} open={open} tokenRef={ref} /> and ask <Token tok={TOK.mira} /> to flag
          renewal risk
        </Composer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Send: the composer docks, the message rises into the thread      */
/* ------------------------------------------------------------------ */
function M4() {
  const step = useScript([1000, 1100, 1650, 4600], 5200);
  const pressed = step === 1;
  const sent = step >= 2 && step < 4;
  const thinking = step === 3;
  const t = { duration: 0.36, ease: EASE };
  return (
    <div className="pc-m4" data-sent={sent ? "" : undefined}>
      <LayoutGroup id="m4">
        <div className="pc-m4__above" />
        <div className="pc-m4__top">
          <AnimatePresence mode="popLayout" initial={false}>
            {!sent ? (
              <motion.div
                key="greet"
                className="flex flex-col items-center"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.12, ease: "linear" } }}
                transition={{ duration: 0.2 }}
              >
                <h2 className="pc-greet !text-[32px]">Good afternoon, Liam</h2>
                <div className="pc-chips !mb-5 !mt-4">
                  <span className="pc-chip">
                    <Face avatar={MIRA.avatar} presence="waiting" size={18} />
                    Answer Mira
                  </span>
                  <span className="pc-chip">
                    <Face avatar={SCOUT.avatar} presence="available" size={18} />
                    Review Scout&apos;s forecast
                  </span>
                  <span className="pc-chip">
                    <Folder />
                    Atlas launch
                  </span>
                </div>
              </motion.div>
            ) : (
              <motion.div key="thread" className="flex w-full flex-col" initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.2 } }}>
                <motion.div layoutId="m4-draft" layout="position" transition={t} className="pc-bubble relative !bg-transparent">
                  <motion.span
                    className="pc-m4__bubblebg"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2, delay: 0.16, ease: "linear" }}
                  />
                  <span className="relative">
                    <DraftText segs={DRAFT} />
                  </span>
                </motion.div>
                <AnimatePresence>
                  {thinking ? (
                    <motion.p
                      className="pc-thinking mt-5"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.22, ease: EASE }}
                    >
                      <Orbit state="thinking" size={16} className="pc-orbit--line" />
                      Reading Q3 Forecast.xlsx
                    </motion.p>
                  ) : null}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <motion.div layout transition={t} className="pc-composer pc-composer--m4" data-focus={!sent ? "" : undefined}>
          <motion.div layout="position" transition={t} className="pc-composer__field">
            {!sent ? (
              <motion.div layoutId="m4-draft" layout="position" transition={t} className="inline">
                <DraftText segs={DRAFT} />
              </motion.div>
            ) : (
              <motion.span className="pc-composer__placeholder" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
                Reply to Juno
              </motion.span>
            )}
          </motion.div>
          <motion.div layout="position" transition={t} className="pc-composer__bar">
            <span className="pc-icon-btn">
              <Plus />
            </span>
            <span className="pc-spacer" />
            <span className="pc-model">
              Auto
              <ChevronDown />
            </span>
            <span className="pc-icon-btn">
              <Mic />
            </span>
            <span className="pc-send" data-force={pressed ? "press" : undefined}>
              {sent ? <AudioLines /> : <ArrowUp />}
            </span>
          </motion.div>
        </motion.div>
        <div className="pc-m4__below" />
      </LayoutGroup>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. Thinking, then a calm streaming reveal                            */
/* ------------------------------------------------------------------ */
const STREAM =
  "Stripe shows €412,000 of the €438,000 the forecast expects from renewals. Three accounts make up the gap: Halvorsen moved to monthly billing in August, Brightline Studio dropped two seats, and Oakridge Health has an unpaid invoice from July.";
const WORDS = STREAM.split(" ");
function M5() {
  const step = useScript([1300, 2500], 7200);
  const [n, setN] = React.useState(0);
  React.useEffect(() => {
    if (step < 2) {
      setN(0);
      return;
    }
    // Runs of three words every 90ms: the pace of reading, not of typing.
    const id = window.setInterval(() => setN((x) => (x >= WORDS.length ? x : x + 3)), 90);
    return () => window.clearInterval(id);
  }, [step]);
  const runs: string[] = [];
  for (let i = 0; i < Math.min(n, WORDS.length); i += 3) runs.push(WORDS.slice(i, Math.min(i + 3, n)).join(" "));
  const label = step === 0 ? "Reading Q3 Forecast.xlsx" : "Comparing with Stripe";
  return (
    <div className="pc-mstage__top !items-start">
      <div className="w-[560px] max-w-full">
        <div className="pc-bubble ml-auto w-fit !text-[15px]">Where is renewal risk this quarter?</div>
        <div className="mt-6 min-h-[180px]">
          <AnimatePresence mode="wait" initial={false}>
            {step < 2 ? (
              <motion.p
                key={label}
                className="pc-thinking"
                role="status"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16, ease: "linear" }}
              >
                <Orbit state="thinking" size={16} className="pc-orbit--line" />
                {label}
              </motion.p>
            ) : (
              <motion.div key="answer" className="pc-prose" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
                <h3>Renewal risk this quarter</h3>
                <p>
                  {runs.map((r, i) => (
                    <span key={i} className="pc-stream-run">
                      {r}{" "}
                    </span>
                  ))}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 6. Menu open, move, close                                            */
/* ------------------------------------------------------------------ */
function M6() {
  const step = useScript([600, 1300, 1800, 2600], 3600);
  const open = step >= 1 && step <= 3;
  const active = step === 2 ? "claude-fable-5-1" : step === 3 ? "gpt-6-sol" : "auto";
  return (
    <div className="pc-mstage__bottom">
      <div className="w-[560px] max-w-full">
        <Composer
          variant="dock"
          modelOpen={open}
          placeholder="Reply to Juno"
          action="voice"
          overlay={
            <AnimatePresence>
              {open ? (
                <motion.div
                  key="menu"
                  className="absolute"
                  style={{ right: 58, bottom: 52, zIndex: 30, transformOrigin: "100% 100%" }}
                  initial={{ opacity: 0, y: 4, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.1, ease: "linear" } }}
                  transition={{ duration: 0.14, ease: EASE }}
                >
                  <ModelMenu className="!static" selected="auto" hover={active} />
                </motion.div>
              ) : null}
            </AnimatePresence>
          }
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 7. Crew presence                                                    */
/* ------------------------------------------------------------------ */
const M7_STATES: Presence[] = ["available", "thinking", "working", "waiting", "available"];
function M7() {
  const step = useScript([1600, 3400, 5400, 8600], 9800);
  const presence = M7_STATES[step];
  const [blink, setBlink] = React.useState(0);
  React.useEffect(() => {
    if (step !== 0) return;
    const id = window.setTimeout(() => setBlink((b) => b + 1), 500);
    return () => window.clearTimeout(id);
  }, [step]);
  return (
    <div className="pc-mstage__center">
      <Face avatar={CREW[0].avatar} presence={presence} size={88} blinkKey={blink} name="Mira" />
      <div className="mt-5 h-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={presence + step}
            className={presence === "waiting" ? "pc-needs !text-[14px]" : "pc-ui pc-muted"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: "linear" }}
          >
            {PRESENCE_LABEL[presence]}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 8. Hover is tonal, press is a tonal step                             */
/* ------------------------------------------------------------------ */
function M8() {
  const step = useScript([500, 1100, 1250, 1800, 2300, 2900, 3050, 3600], 4400);
  const row = step === 1 ? "hover" : step === 2 ? "press" : step === 3 ? "hover" : undefined;
  const btn = step === 5 ? "hover" : step === 6 ? "press" : step === 7 ? "hover" : undefined;
  return (
    <div className="pc-mstage__center">
      <div className="flex items-center gap-10">
        <div className="pc-side !static !h-auto w-[240px] py-2" style={{ borderRadius: 14 }}>
          <span className="pc-row">
            <Search />
            <span className="pc-row__label">Search</span>
          </span>
          <span className="pc-row" data-force={row}>
            <Face avatar={MIRA.avatar} presence="waiting" size={20} />
            <span className="pc-row__label">Mira</span>
            <span className="pc-needs">Needs you</span>
          </span>
          <span className="pc-row pc-row--recent">
            <span className="pc-row__label">Pricing page copy</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="pc-btn pc-btn--secondary" data-force={btn}>
            Deny
          </span>
          <span className="pc-btn pc-btn--primary" data-force={btn}>
            Allow once
          </span>
        </div>
      </div>
      <p className="pc-small pc-quiet mt-6">{row === "press" || btn === "press" ? "Pressed" : row || btn ? "Hover" : "Rest"}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const MOMENTS: { n: number; title: string; spec: string; C: () => React.JSX.Element; tall?: boolean }[] = [
  { n: 1, title: "Composer focus", spec: "220ms ease. The edge darkens a step, the shadow deepens, the caret is celadon.", C: M1 },
  { n: 2, title: "@ at the caret, the mark lands", spec: "Palette 140ms from the caret. The row's mark flies into the token, 240ms.", C: M2, tall: true },
  { n: 3, title: "An app opens from its token", spec: "180ms ease, scaled from the token. Closes in 100ms.", C: M3, tall: true },
  { n: 4, title: "Send: dock and rise", spec: "360ms shared element. The draft becomes the message; the composer docks.", C: M4, tall: true },
  { n: 5, title: "Thinking, then streaming", spec: "Orbit 1.7s with a rest. Runs of words fade in over 260ms, no movement.", C: M5, tall: true },
  { n: 6, title: "Popover open and close", spec: "140ms in from the control, 80ms tonal highlight, 100ms fade out.", C: M6, tall: true },
  { n: 7, title: "Crew presence", spec: "Blink on arrival, settle on change, two lifts when a wait begins. Then still.", C: M7 },
  { n: 8, title: "Hover and press", spec: "120ms tonal. Press is one tonal step deeper. Nothing moves.", C: M8 },
];

function MomentCard({ n, title, spec, C, tall, large }: (typeof MOMENTS)[number] & { large?: boolean }) {
  const [key, setKey] = React.useState(0);
  const reduced = useReducedMotion();
  return (
    <section className="pc-moment" data-large={large ? "" : undefined} aria-label={title}>
      <header className="pc-moment__head">
        <div className="min-w-0">
          <p className="pc-ui-m">
            <span className="pc-quiet">{n}</span>
            {"  "}
            {title}
          </p>
          <p className="pc-small pc-quiet mt-0.5">
            {spec}
            {reduced ? " Reduced motion: crossfades only." : ""}
          </p>
        </div>
        <button type="button" className="pc-btn pc-btn--ghost" onClick={() => setKey((k) => k + 1)} data-replay>
          <RotateCcw />
          Replay
        </button>
      </header>
      <div className="pc-mstage" data-tall={tall ? "" : undefined}>
        <C key={key} />
      </div>
    </section>
  );
}

export function MotionScene({ only }: { only?: number }) {
  const single = MOMENTS.find((m) => m.n === only);
  if (single) {
    return (
      <main className="pc-motion-single">
        <MomentCard {...single} large />
      </main>
    );
  }
  return (
    <main className="mx-auto w-full max-w-[1280px] px-10 pb-20 pt-12">
      <h1 className="pc-title">Motion</h1>
      <p className="pc-ui pc-muted mt-2 max-w-[70ch]">
        Motion explains cause and continuity. Chrome moves in 120 to 240ms; the one spatial move (send) takes 360ms. Every moment loops; replay
        restarts it. With reduced motion, each becomes a crossfade or an instant change.
      </p>
      <div className="mt-8 grid grid-cols-2 gap-6">
        {MOMENTS.map((m) => (
          <MomentCard key={m.n} {...m} />
        ))}
      </div>
    </main>
  );
}

