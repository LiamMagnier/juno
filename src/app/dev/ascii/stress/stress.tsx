"use client";

import * as React from "react";
import { DotConstruction, DotRings } from "@/components/home/dot-construction";
import type { ArcSpec, RingSpec } from "@/components/home/dot-scenes";
import { EmptyMark } from "@/components/ui/empty-mark";
import { DotField } from "@/components/signature/dot-field";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { FIELD_RINGS } from "@/components/research/deep-field-model";

/* The product switch's orbit, verbatim (product-switch.tsx). */
const ORBIT_RING: RingSpec[] = [{ cx: 0.5, cy: 0.5, rx: 0.34, ry: 0.17 }];
const REST_CHAT: ArcSpec[] = [{ ring: 0, from: 110, to: 180 }];
const TRAIL_TO_CODE: ArcSpec[] = [{ ring: 0, from: 125, to: 0 }];

function Cell({ id, label, children, className = "" }: { id: string; label: string; children: React.ReactNode; className?: string }) {
  return (
    <figure data-cell={id} className="flex flex-col gap-2">
      <figcaption className="font-mono text-caption text-muted-foreground">{label}</figcaption>
      <div className={`stress-box relative overflow-hidden rounded-lg border border-border ${className}`}>{children}</div>
    </figure>
  );
}

export function CanvasStress() {
  const [mode, setMode] = React.useState<"shown" | "collapsed" | "none">("shown");
  const [wide, setWide] = React.useState(false);
  const [extra, setExtra] = React.useState(0);
  const [code, setCode] = React.useState(false);
  const [turn, setTurn] = React.useState(0);

  const boxStyle: React.CSSProperties =
    mode === "collapsed" ? { width: 0, height: 0 } : mode === "none" ? { display: "none" } : wide ? { width: 520 } : {};

  return (
    <main className="min-h-dvh bg-background p-8 text-foreground">
      <h1 className="mb-4 font-serif text-title font-normal">Dot-matrix canvas stress</h1>
      <div className="mb-6 flex flex-wrap gap-2 text-ui" role="toolbar">
        <button type="button" data-action="theme" className="rounded-full border border-border px-3 py-1" onClick={() => document.documentElement.classList.toggle("dark")}>
          Toggle theme
        </button>
        <button
          type="button"
          data-action="accent"
          className="rounded-full border border-border px-3 py-1"
          onClick={() => document.documentElement.style.setProperty("--stress-accent", String(Math.random()))}
        >
          Style change on html
        </button>
        <button type="button" data-action="collapse" className="rounded-full border border-border px-3 py-1" onClick={() => setMode(mode === "collapsed" ? "shown" : "collapsed")}>
          Collapse to 0×0
        </button>
        <button type="button" data-action="hide" className="rounded-full border border-border px-3 py-1" onClick={() => setMode(mode === "none" ? "shown" : "none")}>
          display:none
        </button>
        <button type="button" data-action="resize" className="rounded-full border border-border px-3 py-1" onClick={() => setWide((v) => !v)}>
          Resize
        </button>
        <button type="button" data-action="switch" className="rounded-full border border-border px-3 py-1" onClick={() => { setCode((v) => !v); setTurn((n) => n + 1); }}>
          Switch product
        </button>
        <button type="button" data-action="many" className="rounded-full border border-border px-3 py-1" onClick={() => setExtra((n) => (n ? 0 : 120))}>
          {extra ? "Remove" : "Add"} 120 canvases
        </button>
      </div>

      <div data-stress-root style={boxStyle} className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-6 overflow-hidden">
        <Cell id="orbit" label="Product switch orbit" className="h-12 w-[84px]">
          <span className="product-orbit absolute inset-0">
            <DotRings rings={ORBIT_RING} animate={false} />
            <span className="product-orbit-trail absolute inset-0">
              <DotRings key={turn} rings={ORBIT_RING} arcs={turn === 0 ? REST_CHAT : code ? TRAIL_TO_CODE : REST_CHAT} animate={turn > 0} delay={0} stagger={0} draw={0.62} />
            </span>
          </span>
        </Cell>
        <Cell id="empty" label="Empty mark" className="flex h-[96px] items-center justify-center">
          <EmptyMark />
        </Cell>
        <Cell id="construction" label="Construction" className="h-[180px]">
          <DotConstruction />
        </Cell>
        <Cell id="deep-field" label="Deep Field rings" className="h-[180px]">
          <DotRings rings={FIELD_RINGS} />
        </Cell>
        <Cell id="dot-field" label="Dot field" className="h-[120px]">
          <DotField spacing={14} />
        </Cell>
        <Cell id="galaxy" label="Galaxy mark" className="flex h-[96px] items-center justify-center">
          <GalaxyMark phase="working" size={48} />
        </Cell>
      </div>

      {extra > 0 && (
        <div data-stress-many className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
          {Array.from({ length: extra }, (_, i) => (
            <div key={i} className="relative h-12 overflow-hidden rounded-sm border border-border">
              <DotRings rings={ORBIT_RING} arcs={REST_CHAT} animate={false} />
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
