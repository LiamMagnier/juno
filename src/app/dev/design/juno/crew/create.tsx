"use client";

/**
 * CrewCreate: "Add to crew".
 *
 *   1  Who        a name, what they do, and what they should take care of.
 *                 A character is already standing there, drawn from the name,
 *                 so the person is never facing an empty slot.
 *   2  Look       the editor, the same one as Customize.
 *   3  Ready      the character, its name in the display serif, its job, and
 *                 what it starts with. "Add to crew" plays its arrival.
 *
 * Nothing is connected or allowed by creating a member: apps, routines and
 * permissions are granted later, by asking (setup-change cards) or in Setup.
 */

import * as React from "react";
import { avatarFromSeed, normalizeAvatar, type AvatarConfig } from "./avatar2";
import { AvatarEditor } from "./editor";
import { CrewFace } from "./face";
import { hashSeed } from "./identity";
import "./crew-ui.css";

export interface NewMember {
  id: string;
  name: string;
  role: string;
  mission: string;
  seed: string;
  avatar: AvatarConfig;
}

export type CreateStep = "who" | "look" | "ready";

export interface CrewCreateProps {
  onDone?: (m: NewMember) => void;
  onCancel?: () => void;
  /** Start somewhere else (renders, deep links). */
  step?: CreateStep;
  /** Prefill (renders). */
  initial?: Partial<NewMember>;
  className?: string;
}

const ROLES = ["Research", "Support", "Finance operations", "Recruiting", "Release notes", "Partnerships"];

export function CrewCreate({ onDone, onCancel, step: initialStep = "who", initial, className }: CrewCreateProps) {
  const [step, setStep] = React.useState<CreateStep>(initialStep);
  const [name, setName] = React.useState(initial?.name ?? "");
  const [role, setRole] = React.useState(initial?.role ?? "");
  const [mission, setMission] = React.useState(initial?.mission ?? "");
  const seed = React.useMemo(() => initial?.seed ?? `new-${hashSeed(String(Date.now())).toString(36)}`, [initial?.seed]);
  const [touched, setTouched] = React.useState(!!initial?.avatar);
  const [avatar, setAvatar] = React.useState<AvatarConfig>(() => (initial?.avatar ? normalizeAvatar(initial.avatar, seed) : avatarFromSeed(seed)));
  const [added, setAdded] = React.useState(0);

  // Until the person changes the look, the character follows the name.
  React.useEffect(() => {
    if (touched || !name.trim()) return;
    setAvatar(avatarFromSeed(`${seed}:${name.trim().toLowerCase()}`));
  }, [name, seed, touched]);

  const member = { id: "new", name: name || "New member", seed: avatar.seed, avatar };
  const steps: { id: CreateStep; label: string }[] = [
    { id: "who", label: "Who" },
    { id: "look", label: "Look" },
    { id: "ready", label: "Ready" },
  ];
  const at = steps.findIndex((s) => s.id === step);
  const canNext = step !== "who" || (name.trim().length > 0 && role.trim().length > 0);

  return (
    <div className={className ? `jcc ${className}` : "jcc"} data-step={step}>
      <header className="jcc__head">
        <h2 className="jcc__title">{step === "ready" ? `Meet ${name || "your new member"}` : "Add to crew"}</h2>
        <ol className="jcc__steps" aria-label="Steps">
          {steps.map((s, i) => (
            <li key={s.id} aria-current={s.id === step ? "step" : undefined} data-done={i < at ? "" : undefined}>
              {s.label}
            </li>
          ))}
        </ol>
      </header>

      {step === "who" ? (
        <div className="jcc__who">
          <div className="jcc__form">
            <label className="jcc__field">
              <span className="t-label">Name</span>
              <span className="jfield">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nova" maxLength={24} autoFocus />
              </span>
            </label>
            <label className="jcc__field">
              <span className="t-label">What they do</span>
              <span className="jfield">
                <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Product analytics" maxLength={40} />
              </span>
              <span className="jcc__chips">
                {ROLES.map((r) => (
                  <button key={r} type="button" className="jce-chip" aria-pressed={role === r} onClick={() => setRole(r)}>
                    {r}
                  </button>
                ))}
              </span>
            </label>
            <label className="jcc__field">
              <span className="t-label">What should they take care of?</span>
              <textarea className="jcc__area" value={mission} onChange={(e) => setMission(e.target.value)} placeholder="Every Monday, summarise last week's signups and flag anything unusual." rows={3} />
              <span className="t-meta">You can change this any time by telling them, or in Setup.</span>
            </label>
          </div>
          <div className="jcc__preview" aria-hidden="true">
            <CrewFace member={member} state="available" size={200} facing="front" focused arrive />
            <span className="jcc__hint">{name.trim() ? `This is ${name.trim()}. You can change how they look next.` : "Give them a name to meet them."}</span>
          </div>
        </div>
      ) : null}

      {step === "look" ? (
        <AvatarEditor
          value={avatar}
          onChange={(c) => {
            setTouched(true);
            setAvatar(c);
          }}
          name={name}
          onName={setName}
          bare
        />
      ) : null}

      {step === "ready" ? (
        <div className="jcc__ready">
          <CrewFace key={added} member={member} state="available" size={220} facing="front" focused idle arrive={added > 0} />
          <div className="jcc__card">
            <span className="jcc__name">{name || "New member"}</span>
            <span className="jcc__role">{role}</span>
            {mission ? <p className="jcc__mission">{mission}</p> : null}
            <dl className="jcc__starts">
              <div>
                <dt>Apps</dt>
                <dd>None yet. {name || "They"} will ask before connecting anything.</dd>
              </div>
              <div>
                <dt>Approvals</dt>
                <dd>Asks you before sending, posting or spending.</dd>
              </div>
              <div>
                <dt>Notifications</dt>
                <dd>Only when they need a decision.</dd>
              </div>
            </dl>
          </div>
        </div>
      ) : null}

      <footer className="jcc__foot">
        {step === "who" ? (
          onCancel ? (
            <button type="button" className="jb jb--ghost" onClick={onCancel}>
              Cancel
            </button>
          ) : (
            <span />
          )
        ) : (
          <button type="button" className="jb jb--ghost" onClick={() => setStep(steps[at - 1].id)}>
            Back
          </button>
        )}
        {step === "ready" ? (
          <button
            type="button"
            className="jb jb--primary"
            onClick={() => {
              setAdded((n) => n + 1);
              onDone?.({ id: `m-${seed}`, name: name.trim(), role: role.trim(), mission: mission.trim(), seed: avatar.seed, avatar });
            }}
          >
            Add to crew
          </button>
        ) : (
          <button type="button" className="jb jb--primary" disabled={!canNext} onClick={() => setStep(steps[at + 1].id)}>
            Next
          </button>
        )}
      </footer>
    </div>
  );
}
