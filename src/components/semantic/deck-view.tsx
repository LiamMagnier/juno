"use client";

import * as React from "react";
import { SemanticChart } from "@/components/semantic/semantic-chart";
import {
  DECK_LAYOUTS,
  FOOTER_BAND_Y,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  elementBox,
  titleBox,
  type Box,
  type DeckElement,
  type DeckModel,
  type DeckSlide,
} from "@/lib/work/deliverables/semantic/deck/model";
import { validateDeckFit } from "@/lib/work/deliverables/semantic/deck/fit";
import { EMBEDDABLE_IMAGE } from "@/lib/work/deliverables/semantic/shared";
import type { SemanticOpsHandler } from "@/components/semantic/semantic-artifact-view";

/**
 * The deck as slides at their true proportions, drawn from the same layout
 * geometry the .pptx exporter uses, in the deck's own theme. A thumbnail strip
 * to move between slides, speaker notes under the slide, and what the fit
 * check found as plain annotations. The slide an edit changed draws its edge
 * once in presence blue.
 */

/** Points -> a font size relative to the slide's width (10 in = 100cqi). */
const pt = (points: number) => `${(points / 72 / SLIDE_WIDTH) * 100}cqi`;

function place(box: Box): React.CSSProperties {
  return {
    left: `${(box.x / SLIDE_WIDTH) * 100}%`,
    top: `${(box.y / SLIDE_HEIGHT) * 100}%`,
    width: `${(box.w / SLIDE_WIDTH) * 100}%`,
    height: `${(box.h / SLIDE_HEIGHT) * 100}%`,
  };
}

function Element({ slide, element, theme }: { slide: DeckSlide; element: DeckElement; theme: DeckModel["theme"] }) {
  const box = elementBox(slide, element);
  const style = place(box);
  switch (element.type) {
    case "text":
      return (
        <div data-el={element.id} style={{ ...style, fontFamily: theme.bodyFont, color: theme.text, fontSize: pt(element.fontSize ?? 18), lineHeight: 1.2 }}>
          {element.paragraphs.map((p, i) => (
            <p
              key={i}
              style={{ margin: `0 0 ${pt(6)} ${pt(p.level * 22)}`, fontWeight: p.bold ? 700 : 400, display: "flex", gap: pt(6) }}
            >
              {p.bullet && <span style={{ color: theme.accent }}>•</span>}
              <span>{p.text}</span>
            </p>
          ))}
        </div>
      );
    case "image":
      return EMBEDDABLE_IMAGE.test(element.src) ? (
        // eslint-disable-next-line @next/next/no-img-element -- an embedded data URI
        <img data-el={element.id} src={element.src} alt={element.alt} style={{ ...style, objectFit: "contain" }} />
      ) : (
        <div data-el={element.id} className="sx-placeholder sx-annot" style={{ ...style, aspectRatio: "auto" }}>
          Image: {element.alt}
        </div>
      );
    case "shape": {
      const radius = element.shape === "ellipse" ? "50%" : element.shape === "roundRect" ? pt(10) : 0;
      if (element.shape === "line" || element.shape === "arrow") {
        return (
          <svg data-el={element.id} style={{ ...style, overflow: "visible" }} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <line x1="0" y1="0" x2="100" y2="100" stroke={element.line ?? theme.muted} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        );
      }
      return (
        <div
          data-el={element.id}
          style={{
            ...style,
            background: element.fill ?? "transparent",
            border: element.line ? `1px solid ${element.line}` : undefined,
            borderRadius: radius,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: theme.text,
            fontFamily: theme.bodyFont,
            fontSize: pt(16),
          }}
        >
          {element.text}
        </div>
      );
    }
    case "chart":
      return (
        <div data-el={element.id} style={{ ...style, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {element.title && <div style={{ fontFamily: theme.headingFont, color: theme.text, fontSize: pt(14), marginBottom: pt(4) }}>{element.title}</div>}
          <SemanticChart
            type={element.chartType}
            categories={element.categories}
            series={element.series.map((s) => ({ name: s.name, values: s.values }))}
            ink={theme.text}
            accent={theme.accent}
            muted={theme.muted}
            height={Math.round((box.h / box.w) * 480)}
            compact
          />
        </div>
      );
    case "table":
      return (
        <div data-el={element.id} style={{ ...style, fontFamily: theme.bodyFont, color: theme.text, fontSize: pt(13) }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {element.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: "left", borderBottom: `1px solid ${theme.text}`, padding: `${pt(4)} ${pt(6)} ${pt(4)} 0` }}>
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {element.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ borderBottom: `1px solid ${theme.muted}33`, padding: `${pt(4)} ${pt(6)} ${pt(4)} 0` }}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function Slide({ deck, slide, index, changed }: { deck: DeckModel; slide: DeckSlide; index: number; changed?: boolean }) {
  const layout = DECK_LAYOUTS[slide.layout];
  const titleSpec = layout.placeholders.title;
  const subtitleSpec = layout.placeholders.subtitle;
  const { theme, master } = deck;
  return (
    <div className="sx-slide" style={{ background: theme.background }} data-changed={changed || undefined} aria-label={`Slide ${index + 1}${slide.title ? `: ${slide.title}` : ""}`} role="img">
      {slide.title && titleSpec && (
        <div
          data-el="title"
          style={{
            ...place(titleBox(slide.layout)!),
            fontFamily: theme.headingFont,
            color: theme.text,
            fontSize: pt(titleSpec.defaultPt),
            fontWeight: titleSpec.bold ? 700 : 400,
            textAlign: titleSpec.align,
            display: "flex",
            alignItems: slide.layout === "title" || slide.layout === "section" ? "flex-end" : "center",
            justifyContent: titleSpec.align === "center" ? "center" : "flex-start",
            lineHeight: 1.1,
          }}
        >
          {slide.title}
        </div>
      )}
      {slide.subtitle && subtitleSpec && (
        <div data-el="subtitle" style={{ ...place(titleBox(slide.layout, "subtitle")!), fontFamily: theme.bodyFont, color: theme.muted, fontSize: pt(subtitleSpec.defaultPt), textAlign: subtitleSpec.align }}>
          {slide.subtitle}
        </div>
      )}
      {slide.elements.map((element) => (
        <Element key={element.id} slide={slide} element={element} theme={theme} />
      ))}
      {(master.footer || master.slideNumbers || master.logoText) && (
        <div
          style={{
            position: "absolute",
            left: "5%",
            right: "5%",
            top: `${(FOOTER_BAND_Y / SLIDE_HEIGHT) * 100}%`,
            display: "flex",
            justifyContent: "space-between",
            color: theme.muted,
            fontFamily: theme.bodyFont,
            fontSize: pt(10),
          }}
        >
          <span>{master.logoText ?? master.footer ?? ""}</span>
          <span>{master.logoText && master.footer ? master.footer : ""}</span>
          <span>{master.slideNumbers ? index + 1 : ""}</span>
        </div>
      )}
    </div>
  );
}

export function DeckView({
  model,
  readOnly,
  onApplyOps,
}: {
  model: DeckModel;
  readOnly: boolean;
  onApplyOps?: SemanticOpsHandler;
}) {
  const [current, setCurrent] = React.useState(0);
  const index = Math.min(current, model.slides.length - 1);
  const slide = model.slides[index];
  const fit = React.useMemo(() => validateDeckFit(model), [model]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const previous = React.useRef<Map<string, string> | null>(null);
  const [changed, setChanged] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    const now = new Map(model.slides.map((s) => [s.id, JSON.stringify(s)]));
    const before = previous.current;
    previous.current = now;
    if (!before) return;
    const diff = [...now].filter(([id, json]) => before.get(id) !== json).map(([id]) => id);
    setChanged(new Set(diff));
    const first = model.slides.findIndex((s) => diff.includes(s.id));
    if (first >= 0) setCurrent(first);
  }, [model.slides]);

  const run = async (ops: Record<string, unknown>[]) => {
    if (!onApplyOps) return;
    setBusy(true);
    setError(null);
    const result = await onApplyOps(ops);
    setBusy(false);
    if (!result.ok) setError(result.error);
  };
  const canAct = !readOnly && !!onApplyOps && !busy;
  const slideIssues = fit.filter((issue) => issue.slideId === slide.id);

  return (
    <div className="sx" data-kind="presentation">
      <div className="sx-bar">
        <span className="sx-annot">
          Slide {index + 1} of {model.slides.length} · {DECK_LAYOUTS[slide.layout].label}
        </span>
        <span className="sx-annot ml-auto" aria-live="polite" data-tone={error || fit.length ? "attention" : undefined}>
          {error ?? (busy ? "Saving…" : fit.length ? `${fit.length} fit note${fit.length === 1 ? "" : "s"}` : "Every slide fits")}
        </span>
      </div>
      <div className="sx-deck">
        <nav className="sx-strip" aria-label="Slides">
          {model.slides.map((s, i) => (
            <button key={s.id} type="button" className="sx-thumb" aria-current={i === index} onClick={() => setCurrent(i)} aria-label={`Slide ${i + 1}`}>
              <Slide deck={model} slide={s} index={i} changed={changed.has(s.id)} />
              <span className="sx-annot">{i + 1}</span>
            </button>
          ))}
        </nav>
        <div
          className="sx-stage"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "PageDown") setCurrent(Math.min(model.slides.length - 1, index + 1));
            if (event.key === "ArrowLeft" || event.key === "PageUp") setCurrent(Math.max(0, index - 1));
          }}
        >
          <Slide deck={model} slide={slide} index={index} changed={changed.has(slide.id)} />
          {slideIssues.length > 0 && (
            <ul className="m-0 grid list-none gap-1 p-0">
              {slideIssues.map((issue, i) => (
                <li key={i} className="sx-annot" data-tone="attention">
                  {issue.kind} · {issue.message}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-baseline gap-4">
            <span className="sx-annot">Notes</span>
            {canAct && index > 0 && (
              <button type="button" className="sx-action sx-annot" onClick={() => void run([{ op: "moveSlide", id: slide.id, after: model.slides[index - 2]?.id ?? null }])}>
                Move earlier
              </button>
            )}
            {canAct && (
              <button type="button" className="sx-action sx-annot" onClick={() => void run([{ op: "duplicateSlide", id: slide.id }])}>
                Duplicate
              </button>
            )}
          </div>
          <p className="sx-notes m-0">{slide.notes || "No speaker notes."}</p>
        </div>
      </div>
    </div>
  );
}
