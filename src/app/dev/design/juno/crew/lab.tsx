/**
 * CrewLab: the shape-grammar exploration, light and dark side by side, at the
 * sizes the product uses (16 inline token, 20 sidebar, 28 thread, 40 roster,
 * 96 member page). Static on purpose: grammars are judged as drawings first.
 */
import * as React from "react";
import { CREW, CREW_BY_ID, STATE_ORDER } from "./fixtures";
import { CREW_STATE_LABEL } from "./face";
import { GRAMMARS, LabFace, type Grammar } from "./lab-grammars";

const SIZES = [16, 20, 28, 40, 96];

function Column({ theme, only }: { theme: "light" | "dark"; only?: Grammar }) {
  const grammars = only ? GRAMMARS.filter((g) => g.id === only) : GRAMMARS;
  const mira = CREW_BY_ID.mira;
  return (
    <section className="jc jc-lab__col" data-theme={theme}>
      <header>
        <h1 className="jc-lab__title">Crew shape grammars</h1>
        <p className="jc-lab__sub">{theme === "light" ? "Light" : "Dark"}. Same members, same states, four ways to draw them.</p>
      </header>
      {grammars.map((g) => (
        <div key={g.id} className="jc-lab__grammar">
          <div>
            <div className="jc-lab__gname">{g.name}</div>
            <div className="jc-lab__gidea">{g.idea}</div>
          </div>
          <div className="jc-lab__row">
            {CREW.map((m) => (
              <div key={m.id} className="jc-lab__cell">
                <LabFace grammar={g.id} seed={m.seed} family={m.family} state="available" size={40} />
                {m.name}
              </div>
            ))}
          </div>
          <div className="jc-lab__row">
            {STATE_ORDER.map((s) => (
              <div key={s} className="jc-lab__cell" style={s === "waiting" ? { color: "var(--jc-amber)" } : undefined}>
                <LabFace grammar={g.id} seed={mira.seed} family={mira.family} state={s} size={72} />
                {CREW_STATE_LABEL[s]}
              </div>
            ))}
          </div>
          <div className="jc-lab__row">
            {SIZES.map((px) => (
              <div key={px} className="jc-lab__cell">
                <LabFace grammar={g.id} seed={CREW_BY_ID.otto.seed} family={CREW_BY_ID.otto.family} state="working" size={px} />
                {px}
              </div>
            ))}
            {SIZES.map((px) => (
              <div key={`s${px}`} className="jc-lab__cell">
                <LabFace grammar={g.id} seed={CREW_BY_ID.scout.seed} family={CREW_BY_ID.scout.family} state="thinking" size={px} />
                {px}
              </div>
            ))}
          </div>
          <p className="jc-lab__sentence">
            Ask{" "}
            <span className="jc-token">
              <LabFace grammar={g.id} seed={mira.seed} family={mira.family} state="available" size={16} />
              Mira
            </span>{" "}
            to send the Halvorsen quote, then have{" "}
            <span className="jc-token">
              <LabFace grammar={g.id} seed={CREW_BY_ID.otto.seed} family={CREW_BY_ID.otto.family} state="working" size={16} />
              Otto
            </span>{" "}
            log it with{" "}
            <span className="jc-token">
              <LabFace grammar={g.id} seed={CREW_BY_ID.rhea.seed} family={CREW_BY_ID.rhea.family} state="available" size={16} />
              Rhea
            </span>
            .
          </p>
          <div className="jc-lab__side">
            {CREW.slice(0, 5).map((m) => (
              <div key={m.id} className="jc-lab__siderow" data-waiting={m.state === "waiting" ? "" : undefined}>
                <LabFace grammar={g.id} seed={m.seed} family={m.family} state={m.state} size={20} />
                <span>{m.name}</span>
                <span>{m.state === "waiting" ? "Needs you" : CREW_STATE_LABEL[m.state]}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function CrewLab({ only }: { only?: Grammar }) {
  return (
    <div className="jc-lab">
      <Column theme="light" only={only} />
      <Column theme="dark" only={only} />
    </div>
  );
}
