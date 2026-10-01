"use client";

/**
 * SetupSheet and SetupChangeCard.
 *
 * Setup is the precise editor for a member (PRODUCT_REFOUNDATION §7): its
 * look, mission, skills, apps, routines, notifications and permissions. It is
 * not the main way to configure a member; that is talking to it, which
 * produces setup-change cards in the thread: before and after, what it
 * affects, Apply and Undo. Anything that widens access asks for an explicit
 * approval; narrowing applies at once and can be undone.
 */

import * as React from "react";
import { Icon } from "../icons";
import { describeAvatar, type AvatarConfig } from "./avatar2";
import { CrewFace, useAvatar, type CrewMember } from "./face";
import { getCrewTheme } from "./theme";
import "./crew-ui.css";

/* ——————————————————————————— Setup sheet ——————————————————————————— */

export interface SetupApp {
  id: string;
  name: string;
  /** What it may do, in words ("Read issues, comment"). */
  access: string;
  mark?: React.ReactNode;
}

export interface SetupData {
  mission: string;
  skills: string[];
  apps: SetupApp[];
  routines: { title: string; when: string }[];
  notify: string;
  approvals: string;
  memory: string;
}

export interface SetupSheetProps {
  member: CrewMember & { role?: string };
  data: SetupData;
  onClose?: () => void;
  onCustomize?: () => void;
  className?: string;
}

export function SetupSheet({ member, data, onClose, onCustomize, className }: SetupSheetProps) {
  const cfg = useAvatar(member);
  return (
    <section className={className ? `jcs ${className}` : "jcs"} aria-label={`${member.name} setup`}>
      <header className="jcs__head">
        <div className="jcs__who">
          <CrewFace member={member} size={72} facing="front" label={`${member.name}: ${describeAvatar(cfg)}`} />
          <div>
            <h2 className="jcs__name">{member.name}</h2>
            {member.role ? <p className="jcs__role">{member.role}</p> : null}
          </div>
        </div>
        <span className="jcs__head-actions">
          {onCustomize ? (
            <button type="button" className="jb jb--secondary jb--sm" onClick={onCustomize}>
              Customize look
            </button>
          ) : null}
          {onClose ? (
            <button type="button" className="jib jicon-trigger" aria-label="Close" onClick={onClose}>
              <Icon name="close" size={20} />
            </button>
          ) : null}
        </span>
      </header>

      <dl className="jcs__list">
        <Row title="Mission">
          <p>{data.mission}</p>
        </Row>
        <Row title="Skills">
          <p>{data.skills.join(", ")}</p>
        </Row>
        <Row title="Apps">
          <ul className="jcs__apps">
            {data.apps.map((a) => (
              <li key={a.id}>
                {a.mark ?? <Icon name="app" size={16} />}
                <span className="jcs__app-name">{a.name}</span>
                <span className="jcs__app-access">{a.access}</span>
              </li>
            ))}
          </ul>
        </Row>
        <Row title="Routines">
          <ul className="jcs__routines">
            {data.routines.map((r) => (
              <li key={r.title}>
                <span>{r.title}</span>
                <span className="jcs__when">{r.when}</span>
              </li>
            ))}
          </ul>
        </Row>
        <Row title="Notifications">
          <p>{data.notify}</p>
        </Row>
        <Row title="Approvals">
          <p>{data.approvals}</p>
        </Row>
        <Row title="Memory">
          <p>{data.memory}</p>
        </Row>
      </dl>
    </section>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="jcs__row">
      <dt>{title}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/* ——————————————————————————— Setup change card ——————————————————————————— */

export interface SetupChange {
  /** "Summarise escalations every weekday at 8:00" */
  title: string;
  rows: { label: string; before: string; after: string }[];
  /** What it affects, in one line. */
  affects: string;
  /** Widens access (needs an explicit approval). */
  widens?: boolean;
  /** A look change: before and after characters instead of text rows. */
  look?: { before: AvatarConfig; after: AvatarConfig };
}

export interface SetupChangeCardProps {
  member: CrewMember;
  change: SetupChange;
  /** proposed (buttons), applied (Undo), declined. */
  status?: "proposed" | "applied" | "declined";
  onApply?: () => void;
  onUndo?: () => void;
  onDecline?: () => void;
  className?: string;
}

export function SetupChangeCard({ member, change, status = "proposed", onApply, onUndo, onDecline, className }: SetupChangeCardProps) {
  const cfg = useAvatar(member);
  const theme = getCrewTheme(cfg);
  return (
    <article className={className ? `jcx ${className}` : "jcx"} data-status={status} style={theme.style as React.CSSProperties}>
      <header className="jcx__head">
        <CrewFace member={member} size={20} facing="front" />
        <span className="jcx__kicker">{status === "applied" ? `${member.name} updated their setup` : `${member.name} wants to change their setup`}</span>
      </header>
      <h3 className="jcx__title">{change.title}</h3>
      {change.look ? (
        <div className="jcx__look">
          <figure>
            <CrewFace member={{ ...member, avatar: change.look.before }} size={72} facing="front" live={false} />
            <figcaption>Before</figcaption>
          </figure>
          <Icon name="arrow-right" size={16} />
          <figure>
            <CrewFace member={{ ...member, avatar: change.look.after }} size={72} facing="front" live={false} />
            <figcaption>After</figcaption>
          </figure>
        </div>
      ) : (
        <dl className="jcx__rows">
          {change.rows.map((r) => (
            <div key={r.label} className="jcx__row">
              <dt>{r.label}</dt>
              <dd>
                <span className="jcx__before">{r.before}</span>
                <span className="jcx__arrow" aria-hidden="true">
                  →
                </span>
                <span className="sr">changes to</span>
                <span className="jcx__after">{r.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="jcx__affects">{change.affects}</p>
      <footer className="jcx__foot">
        {status === "proposed" ? (
          <>
            <button type="button" className="jb jb--ghost jb--sm" onClick={onDecline}>
              Not now
            </button>
            <button type="button" className="jb jb--primary jb--sm" onClick={onApply}>
              {change.widens ? "Allow" : "Apply"}
            </button>
          </>
        ) : status === "applied" ? (
          <>
            <span className="jcx__done">
              <Icon name="check" size={16} />
              Applied
            </span>
            <button type="button" className="jb jb--ghost jb--sm" onClick={onUndo}>
              Undo
            </button>
          </>
        ) : (
          <span className="jcx__done">Not changed</span>
        )}
      </footer>
    </article>
  );
}
