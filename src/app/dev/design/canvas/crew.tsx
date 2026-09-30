"use client";

import * as React from "react";
import { CalendarClock, MoreHorizontal, Plus } from "@/components/ui/icons";
import { CREW, MIRA, PRESENCE_LABEL, PRESENCE_ORDER, type Presence } from "./fixtures";
import { Face } from "./face";
import { SlackColor, StripeTile } from "./marks";
import { AppFrame, ChatSidebar, MobileBar } from "./shell";

/*
 * Crew (PRODUCT_REFOUNDATION §7): a roster of named teammates, each a place
 * with its own thread. The face is the state indicator; the state is always
 * also said in words. Only "needs you" is amber.
 */

function StateWord({ presence }: { presence: Presence }) {
  if (presence === "waiting") return <span className="cv-crew__state amber">Needs you</span>;
  return <span className="cv-crew__state">{PRESENCE_LABEL[presence]}</span>;
}

export function CrewScene() {
  return (
    <AppFrame sidebar={<ChatSidebar />}>
      <MobileBar title="Crew" />
      <div className="cv-page">
        <header className="cv-page__head">
          <div>
            <h1 className="t-title">Crew</h1>
            <p className="cv-page__sub">Six teammates. Each keeps its own thread, standing work and apps.</p>
          </div>
          <button type="button" className="cv-btn cv-btn--secondary">
            <Plus className="cv-i" />
            Add to crew
          </button>
        </header>

        <div className="cv-crew">
          <div className="cv-crew__main">
            <ul className="cv-roster" aria-label="Crew members">
              {CREW.map((m) => (
                <li key={m.id}>
                  <a className="cv-roster__row" href={`#crew-${m.id}`} aria-current={m.id === "mira" ? "true" : undefined}>
                    <Face member={m} presence={m.presence} size={32} />
                    <span className="cv-roster__who">
                      <span className="cv-roster__name">{m.name}</span>
                      <span className="cv-roster__role">{m.role}</span>
                    </span>
                    <span className="cv-roster__now">{m.now}</span>
                    <StateWord presence={m.presence} />
                  </a>
                </li>
              ))}
            </ul>

            <section className="cv-states" aria-labelledby="cv-states-h">
              <h2 id="cv-states-h" className="cv-section-h">
                Presence
              </h2>
              <p className="cv-page__sub">The face is the state. The word beside it says the same thing.</p>
              <div className="cv-states__grid">
                {PRESENCE_ORDER.map((p) => (
                  <figure key={p} className="cv-states__cell" data-face-host="">
                    <Face member={MIRA} presence={p} size={44} label />
                    <figcaption className={p === "waiting" ? "amber" : undefined}>{PRESENCE_LABEL[p]}</figcaption>
                  </figure>
                ))}
              </div>
            </section>
          </div>

          <aside className="cv-member" aria-label="Mira’s thread">
            <div className="cv-member__head" data-face-host="">
              <Face member={MIRA} presence="waiting" size={40} />
              <div className="cv-member__who">
                <p className="cv-member__name">Mira</p>
                <p className="cv-member__role">Accounts</p>
              </div>
              <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm">
                Setup
              </button>
              <button type="button" className="cv-ibtn" aria-label="More">
                <MoreHorizontal className="cv-i" />
              </button>
            </div>
            <p className="cv-member__now">
              <span className="amber">Needs you.</span> Halvorsen has two Stripe customers and Mira wants to know which one holds the annual plan.
            </p>
            <dl className="cv-member__facts">
              <div>
                <dt>Standing work</dt>
                <dd>
                  <CalendarClock className="cv-i ink-3" />
                  Renewal check, Mondays at 9:00
                </dd>
                <dd>
                  <CalendarClock className="cv-i ink-3" />
                  Unpaid invoices over €5,000, daily
                </dd>
              </div>
              <div>
                <dt>Apps</dt>
                <dd>
                  <StripeTile className="cv-mark" />
                  Stripe, reads only
                </dd>
                <dd>
                  <SlackColor className="cv-mark" />
                  Slack, asks before posting
                </dd>
              </div>
            </dl>
            <button type="button" className="cv-btn cv-btn--secondary cv-member__open">
              Open Mira’s thread
            </button>
          </aside>
        </div>
      </div>
    </AppFrame>
  );
}
