"use client";

import * as React from "react";
import { Construction } from "@/components/home/construction";
import { PublicBrand } from "@/components/public/public-frame";
import { AsciiConstruction } from "./ascii-construction";
import { IsoAscii } from "./iso-ascii";
import "./ascii.css";

const PANEL = { w: 480, h: 540 };
const COLS = 80;
const ROWS = 45;

function Panel({ title, children, deep = false }: { title: string; children: React.ReactNode; deep?: boolean }) {
  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="font-mono text-caption text-muted-foreground">{title}</figcaption>
      <aside className={deep ? "alv ascii-panel ascii-panel--deep" : "alv ascii-panel"} style={{ width: PANEL.w, height: PANEL.h }}>
        <PublicBrand height={26} tone="current" />
        {children}
        <div className="ascii-promise">
          <p className="alv-display">Go further.</p>
          <p>Chat, agents and code in one calm workspace.</p>
        </div>
      </aside>
    </figure>
  );
}

export function AsciiGallery() {
  const [run, setRun] = React.useState(0);
  return (
    <main className="min-h-dvh bg-background p-10 text-foreground">
      <div className="mb-6 flex items-center gap-4">
        <h1 className="font-serif text-title font-normal">Construction: hairline vs ASCII</h1>
        <button type="button" onClick={() => setRun((n) => n + 1)} className="rounded-full border border-border px-3 py-1 text-ui">
          Replay
        </button>
      </div>
      <div key={run} className="flex flex-wrap gap-8">
        <Panel title="Current (hairlines)">
          <div className="ascii-construction-svg">
            <Construction />
          </div>
        </Panel>
        <Panel title="ASCII · line">
          <AsciiConstruction variant="line" cols={COLS} rows={ROWS} panel={PANEL} />
        </Panel>
        <Panel title="ASCII · density">
          <AsciiConstruction variant="density" cols={COLS} rows={ROWS} panel={PANEL} />
        </Panel>
        <Panel title="Isometric · braille">
          <IsoAscii variant="braille" width={PANEL.w} height={PANEL.h} />
        </Panel>
        <Panel title="Isometric · slope">
          <IsoAscii variant="slope" width={PANEL.w} height={PANEL.h} />
        </Panel>
        <Panel title="Isometric · bold dot matrix, deep background" deep>
          <IsoAscii variant="dots" width={PANEL.w} height={PANEL.h} />
        </Panel>
      </div>
    </main>
  );
}
