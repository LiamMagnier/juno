"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CrewFace, type CrewMember } from "../crew";
import { DRAFT, READS } from "../fixtures";
import { R, T, useReduced } from "../motion";
import { Answer, Approval, LiveLine, MessageActions, Trace, UserMessage } from "../thread";

/*
 * The call, written down as it happens (C16): the thread is the transcript.
 * Your speech is a turn of your own, arriving word by word, its unstable tail
 * in the third ink until the recogniser settles it. Juno's speech is an
 * ordinary reply, its words appearing as they are spoken (M2's per-word fade,
 * 160 ms, nothing else). Juno's steps keep arriving in their usual forms: the
 * live line while it works, the folded trace after. An approval is a card on
 * screen and nothing else; a spoken "yes" does nothing.
 *
 * Calm on purpose: no avatar per turn, no speaker labels, no bubbles for
 * Juno, no timestamps per line. One quiet mark where the call began and one
 * where it ended.
 */

export const YOU_1 = "Which of these renewals should I actually worry about this week?";
export const JUNO_1 =
  "Just Halvorsen. They moved to monthly billing in August, and that accounts for €23,600 of the gap. Brightline and Oakridge look fine: usage is flat, and the Oakridge invoice is a billing error on our side.";
export const YOU_2 = "Okay. Let the design channel know, and say Mira’s on it.";
export const JUNO_2 = "I’ve drafted the post for #design. It needs your approval on screen.";
export const YOU_CUT = "Wait, which Halvorsen? The group or AS?";

export const MEMBER_YOU = "Mira, where are we on Halvorsen?";
export const MEMBER_SAYS =
  "I’ve read ninety days of seat usage. They’re on 41 of 60 seats, down from 58 in June. I’d offer the annual plan at 45 seats before the renewal.";

const words = (s: string) => s.split(/(?<=\s)/).filter(Boolean);
export const wordCount = (s: string) => words(s).length;

/** Your spoken turn: `heard` words so far, the first `settled` of them final. */
export function SpokenTurn({ text, heard, settled }: { text: string; heard: number; settled: number }) {
  const w = words(text);
  const shown = Math.min(heard, w.length);
  if (shown <= 0) return null;
  const fin = Math.min(settled, shown);
  return (
    <div className="jn-umsg jv-spoken">
      <div className="jn-umsg__bubble">
        <span className="jn-sentence">
          {w.slice(0, fin).join("")}
          {fin < shown ? <span className="jv-provisional">{w.slice(fin, shown).join("")}</span> : null}
        </span>
      </div>
    </div>
  );
}

/** Juno's spoken reply: the words spoken so far, each fading in where it stays. */
export function SpokenReply({ text, shown, cut, className }: { text: string; shown: number; cut?: boolean; className?: string }) {
  const reduced = useReduced();
  const w = words(text);
  const n = Math.min(shown, w.length);
  if (n <= 0) return null;
  return (
    <div className={["jn-answer jv-reply", className].filter(Boolean).join(" ")}>
      <p>
        {n >= w.length
          ? text
          : w.slice(0, n).map((x, i) => (
              <span key={i} className="jn-w">
                {x}
              </span>
            ))}
      </p>
      <AnimatePresence initial={false}>
        {cut ? (
          <motion.p key="cut" className="jv-cut" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? R : T.fast}>
            Stopped when you spoke
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function CallMark({ children }: { children: React.ReactNode }) {
  return <div className="jn-daymark jv-callmark">{children}</div>;
}

/* —————————————————————————— Juno's thread —————————————————————————— */

export interface JunoSnap {
  /** The call has begun (its mark is in the thread). */
  begun: boolean;
  you1?: { heard: number; settled: number };
  live?: string | null;
  seconds?: number;
  trace1?: boolean;
  juno1?: { shown: number; cut?: boolean };
  youCut?: { heard: number; settled: number };
  you2?: boolean;
  juno2?: boolean;
  approval?: boolean;
  /** The call has ended: its closing mark. */
  ended?: string;
}

const VOICE_READS = READS.slice(0, 2);

export function JunoTranscript({ snap }: { snap: JunoSnap }) {
  return (
    <div className="jn-thread jv-thread" role="log" aria-label="Conversation" aria-relevant="additions">
      {/* The thread before the call: the system's own first exchange. */}
      <UserMessage segments={DRAFT} receipt="Q3 Forecast.xlsx and Stripe added." />
      <Trace />
      <Answer />
      <MessageActions />

      {snap.begun ? <CallMark>Voice, 14:02</CallMark> : null}
      {snap.you1 ? <SpokenTurn text={YOU_1} heard={snap.you1.heard} settled={snap.you1.settled} /> : null}
      {snap.live ? <LiveLine text={snap.live} seconds={snap.seconds} /> : null}
      {snap.trace1 ? <Trace label="Read Q3 Forecast.xlsx and the Stripe renewals" items={VOICE_READS} /> : null}
      {snap.juno1 ? <SpokenReply text={JUNO_1} shown={snap.juno1.shown} cut={snap.juno1.cut} /> : null}
      {snap.youCut ? <SpokenTurn text={YOU_CUT} heard={snap.youCut.heard} settled={snap.youCut.settled} /> : null}
      {snap.you2 ? <SpokenTurn text={YOU_2} heard={99} settled={99} /> : null}
      {snap.juno2 ? <SpokenReply text={JUNO_2} shown={99} /> : null}
      {snap.approval ? (
        <div className="jn-thread__card">
          <Approval />
        </div>
      ) : null}
      {snap.ended ? <CallMark>{snap.ended}</CallMark> : null}
    </div>
  );
}

/* —————————————————————————— A member's thread —————————————————————————— */

export interface MemberSnap {
  you?: { heard: number; settled: number };
  says?: number;
}

export function MemberTranscript({ member, snap }: { member: CrewMember; snap: MemberSnap }) {
  return (
    <div className="jn-thread jn-member jv-thread" role="log" aria-label={`${member.name}’s thread`}>
      <div className="jn-daymark">Today</div>
      <div className="jn-cmsg">
        <p className="jn-cmsg__who">
          <CrewFace member={member} state="available" size={20} live={false} facing="front" />
          <b>{member.name}</b> <span className="ink-3 num">13:52</span>
        </p>
        <div className="jn-cmsg__body">
          <p>Brightline and Oakridge look fine. Usage is flat, and the Oakridge invoice is a billing error on our side, not churn.</p>
          <p>Halvorsen has two Stripe customers. Halvorsen AS holds the annual plan; I’m reading its seat usage now.</p>
        </div>
      </div>
      <div className="jn-umsg">
        <div className="jn-umsg__bubble">
          <span className="jn-sentence">Thanks. Call me when you have the numbers.</span>
        </div>
        <p className="jn-receipt">Read 13:58</p>
      </div>
      <CallMark>Voice, 14:20</CallMark>
      {snap.you ? <SpokenTurn text={MEMBER_YOU} heard={snap.you.heard} settled={snap.you.settled} /> : null}
      {snap.says ? (
        <div className="jn-cmsg jv-member-reply">
          <p className="jn-cmsg__who">
            <CrewFace member={member} state="available" size={20} live={false} facing="front" />
            <b>{member.name}</b> <span className="ink-3 num">14:20</span>
          </p>
          <div className="jn-cmsg__body">
            <SpokenReply text={MEMBER_SAYS} shown={snap.says} className="jv-reply--member" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
