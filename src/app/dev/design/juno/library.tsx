"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CrewMark } from "./crew-bridge";
import { crew, LIB_FILTER_KINDS, LIB_FILTERS, LIB_STORAGE, LIBRARY, type LibItem, type LibKind } from "./fixtures";
import { Icon } from "./icons";
import { Segmented } from "./composer";
import { FileMark } from "./marks";
import { R, SPRING, T, useReduced } from "./motion";
import { AppFrame, ChatSidebar, face, MobileBar } from "./shell";

/*
 * The Library: everything Juno made and everything you gave it, as the things
 * themselves. Each item is its preview (the real first page, slide, frame or
 * sheet) drawn as a true miniature: laid out once on a 320 × 240 canvas and
 * scaled to the tile, so nothing inside can collide at any width. Under it,
 * its name (two lines before it ever truncates), who made it, and the chat it
 * came from, which is the way back. A file with a problem says so in words,
 * with the fix as a verb. The page keeps what today's Library does: Upload,
 * storage, Recently deleted, grid and list.
 */

const KIND_ICON: Record<LibKind, string> = {
  document: "document",
  deck: "deck",
  design: "design",
  sheet: "sheet",
  pdf: "pdf",
  image: "image",
};

const KIND_WORD: Record<LibKind, string> = {
  document: "Document",
  deck: "Deck",
  design: "Design",
  sheet: "Spreadsheet",
  pdf: "PDF",
  image: "Image",
};

/** A miniature: drawn at 320 × 240 and scaled to whatever width its tile has. */
function Mini({ children, kind }: { children: React.ReactNode; kind: string }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [k, setK] = React.useState(0.7);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setK(Math.round((e.contentRect.width / 320) * 1000) / 1000));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="jn-lp" data-kind={kind} aria-hidden="true">
      <div className="jn-lp__canvas" style={{ transform: `scale(${k})` }}>
        {children}
      </div>
    </div>
  );
}

function DocPreview({ title, lines, report }: { title: string; lines?: string[]; report?: { eyebrow: string } }) {
  return (
    <div className="jn-lp__page" data-report={report ? "" : undefined}>
      {report ? <p className="jn-lp__eyebrow">{report.eyebrow}</p> : null}
      <p className={report ? "jn-lp__doctitle jn-lp__doctitle--big" : "jn-lp__doctitle"}>{title}</p>
      {lines?.map((l, i) => (
        <p key={i} className="jn-lp__docline">
          {l}
        </p>
      ))}
    </div>
  );
}

function DeckPreview({ title, sub, bars }: { title: string; sub: string; bars?: number[] }) {
  return (
    <div className="jn-lp__slide">
      <p className="jn-lp__slidetitle">{title}</p>
      <p className="jn-lp__slidesub">{sub}</p>
      {bars ? (
        <div className="jn-lp__bars">
          {bars.map((b, i) => (
            <span key={i} style={{ height: `${b}%` }} data-last={i === bars.length - 1 ? "" : undefined} />
          ))}
        </div>
      ) : (
        <div className="jn-lp__stats">
          <span>
            <b>41</b> tickets
          </span>
          <span>
            <b>6</b> reopened
          </span>
          <span>
            <b>38 min</b> first reply
          </span>
        </div>
      )}
    </div>
  );
}

function DesignPreview() {
  return (
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
  );
}

function PlanPreview() {
  return (
    <svg viewBox="0 0 200 140" className="jn-lp__plan">
      <rect x="16" y="14" width="168" height="112" rx="2" />
      <path d="M16 70h62M78 14v44M78 82v44M120 14v60M120 96v30M120 74h64M150 74v52" />
      <path d="M40 70a12 12 0 0 1 12-12" className="jn-lp__door" />
      <path d="M120 84a10 10 0 0 0 10 10" className="jn-lp__door" />
    </svg>
  );
}

function Preview({ item }: { item: LibItem }) {
  const body = (() => {
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
        return <DocPreview title="Annual report 2026" report={{ eyebrow: "Halvorsen Finance AS" }} />;
      case "l7":
        return <DeckPreview title="Escalations, week 38" sub="Support, Monday to Friday" />;
      default:
        return <PlanPreview />;
    }
  })();
  return <Mini kind={item.kind}>{body}</Mini>;
}

function Mark({ item, size = 16 }: { item: LibItem; size?: number }) {
  return item.kind === "sheet" || item.kind === "pdf" || item.kind === "image" ? (
    <FileMark name={item.title} size={size} className="jn-lib__mark" />
  ) : (
    <Icon name={KIND_ICON[item.kind]} size={size} className="jn-lib__mark jn-lib__mark--ink" />
  );
}

function Byline({ item }: { item: LibItem }) {
  return (
    <span className="jn-lib__meta">
      {item.by ? (
        <span className="jn-lib__by">
          <CrewMark member={face(crew(item.by))} size={16} />
          {crew(item.by).name}
        </span>
      ) : null}
      <span className="jn-lib__when">{item.when}</span>
      {item.chat ? (
        <a href="#" className="jn-lib__chat" title={`Open the chat: ${item.chat}`}>
          <Icon name="chat" size={16} />
          <span>{item.chat}</span>
        </a>
      ) : null}
    </span>
  );
}

function Problem({ item }: { item: LibItem }) {
  if (!item.problem) return null;
  return (
    <span className="jn-lib__problem">
      <Icon name="alert" size={16} />
      <span>
        {item.problem.text}.
        <button type="button" className="jb jb--link">
          {item.problem.fix}
        </button>
      </span>
    </span>
  );
}

function Tile({ item }: { item: LibItem }) {
  return (
    <div className="jn-lib__item">
      <a href="#" className="jn-lib__open" aria-label={`${item.title}, ${item.meta}, ${item.when}`}>
        <Preview item={item} />
      </a>
      <span className="jn-lib__text">
        <a href="#" className="jn-lib__title">
          <Mark item={item} />
          <span className="jn-lib__name">{item.title}</span>
        </a>
        <Byline item={item} />
        <Problem item={item} />
      </span>
    </div>
  );
}

function Row({ item }: { item: LibItem }) {
  return (
    <div className="jn-librow" role="row">
      <span className="jn-librow__name" role="cell">
        <Mark item={item} size={20} />
        <span className="jn-librow__stack">
          <a href="#" className="jn-librow__title">
            {item.title}
          </a>
          <Problem item={item} />
        </span>
      </span>
      <span className="jn-librow__kind" role="cell">
        {KIND_WORD[item.kind]}
      </span>
      <span className="jn-librow__by" role="cell">
        {item.by ? (
          <>
            <CrewMark member={face(crew(item.by))} size={16} />
            {crew(item.by).name}
          </>
        ) : (
          "You"
        )}
      </span>
      <span className="jn-librow__chat" role="cell">
        {item.chat ? (
          <a href="#" className="jn-lib__chat">
            <span>{item.chat}</span>
          </a>
        ) : (
          <span className="ink-3">Uploaded</span>
        )}
      </span>
      <span className="jn-librow__when num" role="cell">
        {item.when}
      </span>
      <span className="jn-librow__size num" role="cell">
        {item.size}
      </span>
    </div>
  );
}

export function LibraryScene({ view: initialView = "grid", query: initialQuery = "", filter: initialFilter = "All" }: { view?: "grid" | "list"; query?: string; filter?: (typeof LIB_FILTERS)[number] }) {
  const reduced = useReduced();
  const [filter, setFilter] = React.useState<(typeof LIB_FILTERS)[number]>(initialFilter);
  const [view, setView] = React.useState<"grid" | "list">(initialView);
  const [query, setQuery] = React.useState(initialQuery);
  const kinds = LIB_FILTER_KINDS[filter];
  const q = query.trim().toLowerCase();
  const items = LIBRARY.filter((i) => (!kinds || kinds.includes(i.kind)) && (!q || i.title.toLowerCase().includes(q)));
  return (
    <AppFrame sidebar={<ChatSidebar current="library" />}>
      <MobileBar title="Library" collapse />
      <div className="jn-page jn-page--library">
        <header className="jn-page__head">
          <div>
            <h1 className="t-title">Library</h1>
            <p className="jn-page__lede">What Alevr made and what you gave it, newest first.</p>
          </div>
          <span className="jn-page__actions jicon-quiet">
            <button type="button" className="jb jb--ghost jicon-trigger">
              <Icon name="trash" size={16} />
              Recently deleted <span className="num ink-3">{LIB_STORAGE.deleted}</span>
            </button>
            <button type="button" className="jb jb--secondary jicon-trigger">
              <Icon name="upload" size={16} />
              Upload
            </button>
          </span>
        </header>

        {/* One row of controls: what to show, then search, who made it, order and view, together. */}
        <div className="jn-libbar">
          <div className="jn-libbar__filters">
            <Segmented options={LIB_FILTERS} value={filter} onChange={setFilter} label="Show" layoutKey="lib-filter" className="jn-lib__filter" />
          </div>
          <span className="jn-libbar__tools jicon-quiet">
            <label className="jfield jn-libbar__search">
              <Icon name="search" size={16} />
              <input placeholder="Search the library" aria-label="Search the library" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <button type="button" className="jn-sort jicon-trigger" aria-haspopup="menu">
              <span className="ink-3">Made by</span> Anyone
              <Icon name="chevron-down" size={16} />
            </button>
            <button type="button" className="jn-sort jicon-trigger" aria-haspopup="menu">
              <span className="ink-3">Sort</span> Recent
              <Icon name="chevron-down" size={16} />
            </button>
            <span className="jn-view" role="radiogroup" aria-label="View">
              <button type="button" role="radio" aria-checked={view === "grid"} className="jn-view__opt jtip" data-tip="Grid" aria-label="Grid" onClick={() => setView("grid")}>
                <Icon name="grid" size={16} />
              </button>
              <button type="button" role="radio" aria-checked={view === "list"} className="jn-view__opt jtip" data-tip="List" data-tip-align="end" aria-label="List" onClick={() => setView("list")}>
                <Icon name="list" size={16} />
              </button>
            </span>
          </span>
        </div>

        {items.length === 0 ? (
          <div className="jn-empty" role="status">
            <p className="t-display">Nothing called “{query}”</p>
            <p className="jn-empty__line">Search looks at names and the text inside documents. Try a client, a month or a number.</p>
            <button type="button" className="jb jb--secondary jb--sm" onClick={() => setQuery("")}>
              Clear search
            </button>
          </div>
        ) : view === "grid" ? (
          <motion.ul className="jn-lib" layout={false}>
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((item) => (
                <motion.li
                  key={item.id}
                  layout={reduced ? false : "position"}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: reduced ? R : { duration: 0.1 } }}
                  transition={reduced ? R : { layout: SPRING.standard, opacity: T.fast }}
                >
                  <Tile item={item} />
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        ) : (
          <div className="jn-librows" role="table" aria-label="Library">
            <div className="jn-librow jn-librow--head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader" className="jn-librow__kind">
                Kind
              </span>
              <span role="columnheader" className="jn-librow__by">
                Made by
              </span>
              <span role="columnheader" className="jn-librow__chat">
                From
              </span>
              <span role="columnheader" className="jn-librow__when">
                Changed
              </span>
              <span role="columnheader" className="jn-librow__size">
                Size
              </span>
            </div>
            {items.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </div>
        )}

        <p className="jn-libfoot num">
          {LIBRARY.length} items, {LIB_STORAGE.used} of {LIB_STORAGE.of} used
        </p>
      </div>
    </AppFrame>
  );
}
