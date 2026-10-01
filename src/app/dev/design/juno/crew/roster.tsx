"use client";

/**
 * CrewRoster and CrewHeader.
 *
 * The roster is who exists, what each is for and who needs you: a grid of
 * characters with their name, role and a line of what they are doing. The
 * characters are live views (they follow the pointer and blink when you
 * arrive over them) but never idle: a roster of twelve costs nothing while
 * the pointer is elsewhere. Someone waiting for you says so in the attention
 * ink; nothing else on the card is coloured.
 *
 * The header is the compact form of a member over its thread: a 32 px
 * character, the name, and the state in words, with Setup beside it.
 */

import * as React from "react";
import { Icon } from "../icons";
import { CrewFace, type CrewMember, type CrewState } from "./face";
import { SHORT_WORDS, needsYou, stateSentence } from "./words";
import "./crew-ui.css";

export interface RosterMember extends CrewMember {
  role?: string;
  state: CrewState;
  /** What it is doing or waiting for, in its words. */
  now?: string;
}

export interface CrewRosterProps {
  members: RosterMember[];
  onOpen?: (id: string) => void;
  onAdd?: () => void;
  /** A member that just joined: its card plays the arrival. */
  arrivedId?: string;
  /** Character size on the cards. */
  size?: number;
  className?: string;
}

export function CrewRoster({ members, onOpen, onAdd, arrivedId, size = 88, className }: CrewRosterProps) {
  return (
    <ul className={className ? `jcro ${className}` : "jcro"} role="list">
      {members.map((m) => (
        <li key={m.id}>
          <button type="button" className="jcro__card jicon-trigger" onClick={() => onOpen?.(m.id)} aria-label={`${m.name}, ${m.role ?? ""}. ${stateSentence(m.name, m.state, m.now)}`}>
            <span className="jcro__face">
              <CrewFace member={m} state={m.state} size={size} facing="front" arrive={m.id === arrivedId} />
            </span>
            <span className="jcro__name">{m.name}</span>
            {m.role ? <span className="jcro__role">{m.role}</span> : null}
            <span className="jcro__now" data-attn={needsYou(m.state) ? "" : undefined}>
              {stateSentence(m.name, m.state, m.now)}
            </span>
          </button>
        </li>
      ))}
      {onAdd ? (
        <li>
          <button type="button" className="jcro__card jcro__add jicon-trigger" onClick={onAdd}>
            <span className="jcro__plus" style={{ width: size * 0.72, height: size * 0.72 }}>
              <Icon name="plus" size={20} />
            </span>
            <span className="jcro__name">Add to crew</span>
            <span className="jcro__role">Make someone for a job</span>
          </button>
        </li>
      ) : null}
    </ul>
  );
}

export interface CrewHeaderProps {
  member: CrewMember & { role?: string };
  state: CrewState;
  /** The state in words; defaults to the short form. */
  words?: string;
  onSetup?: () => void;
  onOpen?: () => void;
  /** Extra actions on the right (icon buttons). */
  actions?: React.ReactNode;
  className?: string;
}

export function CrewHeader({ member, state, words, onSetup, onOpen, actions, className }: CrewHeaderProps) {
  const said = words ?? SHORT_WORDS[state];
  return (
    <header className={className ? `jch ${className}` : "jch"} data-state={state}>
      <button type="button" className="jch__who" onClick={onOpen} aria-label={`${member.name}, ${said}. Open profile`}>
        <CrewFace member={member} state={state} size={32} facing="front" focused />
        <span className="jch__text">
          <span className="jch__name">{member.name}</span>
          <span className="jch__state" data-attn={needsYou(state) ? "" : undefined}>
            {said}
          </span>
        </span>
      </button>
      <span className="jch__actions">
        {actions}
        {onSetup ? (
          <button type="button" className="jb jb--ghost jb--sm jicon-trigger" onClick={onSetup}>
            <Icon name="settings" size={16} />
            Setup
          </button>
        ) : null}
      </span>
    </header>
  );
}
