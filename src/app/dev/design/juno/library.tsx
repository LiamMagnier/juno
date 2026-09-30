"use client";

import * as React from "react";
import { CrewFace } from "./crew/face";
import { crew, LIB_FILTERS, LIBRARY, type LibItem, type LibKind } from "./fixtures";
import { Icon } from "./icons";
import { FileMark } from "./marks";
import { AppFrame, ChatSidebar, face, MobileBar } from "./shell";

/*
 * The Library: everything Juno made and everything you gave it, as the things
 * themselves. Each item is its preview (the real first page, slide, frame or
 * sheet, drawn small) with its name and one line under it. No card around the
 * preview, no badge on it; the filter row is words.
 */

const KIND_ICON: Record<LibKind, string> = {
  document: "document",
  deck: "deck",
  design: "design",
  sheet: "sheet",
  pdf: "document",
  image: "image",
};

function DocPreview({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="jn-lp jn-lp--page">
      <div className="jn-lp__page">
        <p className="jn-lp__doctitle">{title}</p>
        {lines.map((l, i) => (
          <p key={i} className="jn-lp__docline">
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

function DeckPreview({ title, sub, bars }: { title: string; sub: string; bars?: number[] }) {
  return (
    <div className="jn-lp jn-lp--deck">
      <div className="jn-lp__slide">
        <p className="jn-lp__slidetitle">{title}</p>
        <p className="jn-lp__slidesub">{sub}</p>
        {bars ? (
          <div className="jn-lp__bars" aria-hidden="true">
            {bars.map((b, i) => (
              <span key={i} style={{ height: `${b}%` }} data-last={i === bars.length - 1 ? "" : undefined} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DesignPreview() {
  return (
    <div className="jn-lp jn-lp--design">
      <div className="jn-lp__frame">
        <p className="jn-lp__frametitle">Pricing that follows what you use</p>
        <div className="jn-lp__tiers">
          {["Free", "Pro", "Team"].map((t, i) => (
            <div key={t} className="jn-lp__tier" data-featured={i === 1 ? "" : undefined}>
              <span>{t}</span>
              <b>{["€0", "€18", "€30"][i]}</b>
              <i />
              <i />
              <i />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SheetPreview() {
  const rows = [
    ["Account", "Q3 forecast", "Stripe"],
    ["Halvorsen", "96,000", "72,400"],
    ["Brightline", "18,000", "16,200"],
    ["Oakridge", "24,000", "23,400"],
    ["Northgate", "61,500", "61,500"],
    ["Aster & Co", "38,200", "38,200"],
    ["Total", "438,000", "412,000"],
  ];
  return (
    <div className="jn-lp jn-lp--sheet">
      <table className="jn-lp__sheet">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="jn-lp__rn">{i + 1}</td>
              {r.map((c, j) => (
                <td key={j} className={j ? "r" : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanPreview() {
  return (
    <div className="jn-lp jn-lp--image">
      <svg viewBox="0 0 200 140" className="jn-lp__plan" aria-hidden="true">
        <rect x="16" y="14" width="168" height="112" rx="2" />
        <path d="M16 70h62M78 14v44M78 82v44M120 14v60M120 96v30M120 74h64M150 74v52" />
        <path d="M40 70a12 12 0 0 1 12-12" className="jn-lp__door" />
        <path d="M120 84a10 10 0 0 0 10 10" className="jn-lp__door" />
      </svg>
    </div>
  );
}

function Preview({ item }: { item: LibItem }) {
  switch (item.id) {
    case "l1":
      return (
        <DocPreview
          title="Q3 renewal risk"
          lines={[
            "Stripe shows €412,000 of the €438,000 the forecast expects from renewals.",
            "Three accounts make up the gap. Halvorsen moved to monthly billing in August and has not renewed the annual plan.",
            "Brightline Studio dropped two seats on 12 September.",
          ]}
        />
      );
    case "l2":
      return <DeckPreview title="October board update" sub="Revenue, renewals and the plan for Q4" bars={[42, 48, 55, 51, 63, 70]} />;
    case "l3":
      return <DesignPreview />;
    case "l4":
      return <SheetPreview />;
    case "l5":
      return (
        <DocPreview
          title="Lisbon offsite, three venues"
          lines={["All three hold 24 people for two nights under €4,000.", "Palácio Chiado has the best rooms but no garden. LX Factory is cheapest and loud after ten."]}
        />
      );
    case "l6":
      return (
        <div className="jn-lp jn-lp--page">
          <div className="jn-lp__page jn-lp__page--report">
            <p className="jn-lp__eyebrow">Halvorsen Finance AS</p>
            <p className="jn-lp__doctitle jn-lp__doctitle--big">Annual report 2026</p>
          </div>
        </div>
      );
    case "l7":
      return <DeckPreview title="Escalations, week 38" sub="41 tickets, 6 reopened, median first reply 38 min" />;
    default:
      return <PlanPreview />;
  }
}

export function LibraryScene() {
  const [filter, setFilter] = React.useState<(typeof LIB_FILTERS)[number]>("All");
  return (
    <AppFrame sidebar={<ChatSidebar current="library" />}>
      <MobileBar title="Library" />
      <div className="jn-page">
        <header className="jn-page__head">
          <div>
            <h1 className="t-title">Library</h1>
            <p className="jn-page__lede">What Juno made and what you gave it, newest first.</p>
          </div>
          <label className="jfield jn-page__search">
            <Icon name="search" size={16} />
            <input placeholder="Search the library" aria-label="Search the library" />
          </label>
        </header>
        <div className="jn-page__bar">
          <div className="jfilter" role="group" aria-label="Show">
            {LIB_FILTERS.map((f) => (
              <button key={f} type="button" className="jfilter__opt" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
          <button type="button" className="jn-sort jicon-trigger">
            Recent
            <Icon name="chevron-down" size={16} />
          </button>
        </div>
        <ul className="jn-lib">
          {LIBRARY.map((item) => (
            <li key={item.id}>
              <a href="#" className="jn-lib__item">
                <Preview item={item} />
                <span className="jn-lib__text">
                  <span className="jn-lib__title">
                    {item.kind === "sheet" || item.kind === "pdf" || item.kind === "image" ? (
                      <FileMark name={item.title} size={16} className="jn-lib__mark" />
                    ) : (
                      <Icon name={KIND_ICON[item.kind]} size={16} className="jn-lib__mark jn-lib__mark--ink" />
                    )}
                    <span className="jn-lib__name">{item.title}</span>
                  </span>
                  <span className="jn-lib__meta">
                    {item.by ? (
                      <>
                        <CrewFace member={face(crew(item.by))} state="available" size={14} live={false} />
                        {crew(item.by).name},{" "}
                      </>
                    ) : null}
                    {item.meta}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </AppFrame>
  );
}
