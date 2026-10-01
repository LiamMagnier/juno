import { notFound } from "next/navigation";
import {
  Inter_Tight,
  JetBrains_Mono,
  Libre_Franklin,
  Manrope,
  Nata_Sans,
  Noto_Sans_Mono,
  Overpass,
  Overpass_Mono,
  Source_Code_Pro,
  TikTok_Sans,
  Victor_Mono,
  Wix_Madefor_Display,
  Wix_Madefor_Text,
} from "next/font/google";

/*
 * Instrument, the type and signal lab: every candidate face set at the sizes
 * the product uses, in both grounds, so the choice is made on rendered
 * evidence (RATIONALE.md, "Type"). Dev only.
 */

const tiktok = TikTok_Sans({ subsets: ["latin", "cyrillic", "vietnamese"], weight: "variable", axes: ["opsz", "wdth"], display: "swap" });
const nata = Nata_Sans({ subsets: ["latin", "cyrillic", "vietnamese"], weight: "variable", display: "swap" });
const wixD = Wix_Madefor_Display({ subsets: ["latin", "cyrillic", "vietnamese"], weight: "variable", display: "swap" });
const wixT = Wix_Madefor_Text({ subsets: ["latin", "cyrillic", "vietnamese"], weight: "variable", display: "swap" });
const manrope = Manrope({ subsets: ["latin", "cyrillic", "vietnamese"], weight: "variable", display: "swap" });
const franklin = Libre_Franklin({ subsets: ["latin", "cyrillic", "vietnamese"], weight: "variable", display: "swap" });
const overpass = Overpass({ subsets: ["latin", "cyrillic", "vietnamese"], weight: "variable", display: "swap" });
const interTight = Inter_Tight({ subsets: ["latin", "cyrillic", "vietnamese"], weight: "variable", display: "swap" });

const scp = Source_Code_Pro({ subsets: ["latin"], weight: "variable", display: "swap" });
const notoMono = Noto_Sans_Mono({ subsets: ["latin"], weight: "variable", axes: ["wdth"], display: "swap" });
const overpassMono = Overpass_Mono({ subsets: ["latin"], weight: "variable", display: "swap" });
const victor = Victor_Mono({ subsets: ["latin"], weight: "variable", display: "swap" });
const jet = JetBrains_Mono({ subsets: ["latin"], weight: "variable", display: "swap" });

const SANS = [
  { name: "TikTok Sans", cls: tiktok.className },
  { name: "Nata Sans", cls: nata.className },
  { name: "Wix Madefor Display / Text", cls: wixD.className, text: wixT.className },
  { name: "Manrope", cls: manrope.className },
  { name: "Libre Franklin", cls: franklin.className },
  { name: "Overpass", cls: overpass.className },
  { name: "Inter Tight (control)", cls: interTight.className },
];

const MONO = [
  { name: "Source Code Pro", cls: scp.className },
  { name: "Noto Sans Mono 87.5", cls: notoMono.className, style: { fontVariationSettings: '"wdth" 87.5' } },
  { name: "Overpass Mono", cls: overpassMono.className },
  { name: "Victor Mono", cls: victor.className },
  { name: "JetBrains Mono (current)", cls: jet.className },
];

const SIGNALS = [
  { name: "Chartreuse", dark: "oklch(0.91 0.19 118)", light: "oklch(0.91 0.19 118)" },
  { name: "Lime-yellow", dark: "oklch(0.93 0.18 108)", light: "oklch(0.93 0.18 108)" },
  { name: "Phosphor mint", dark: "oklch(0.88 0.15 160)", light: "oklch(0.88 0.15 160)" },
  { name: "Ice", dark: "oklch(0.88 0.11 205)", light: "oklch(0.88 0.11 205)" },
  { name: "Signal magenta", dark: "oklch(0.70 0.22 355)", light: "oklch(0.62 0.23 355)" },
];

function Specimen({ name, cls, text, ground }: { name: string; cls: string; text?: string; ground: "dark" | "light" }) {
  const ink = ground === "dark" ? "#ECECEE" : "#141416";
  const ink2 = ground === "dark" ? "#A3A3A9" : "#5C5C63";
  const bg = ground === "dark" ? "#141415" : "#FBFBFA";
  return (
    <div style={{ background: bg, color: ink, padding: 28, borderRadius: 12 }}>
      <p style={{ fontSize: 11, color: ink2, marginBottom: 14, fontFamily: "ui-monospace" }}>{name}</p>
      <div className={cls}>
        <p style={{ fontSize: 40, lineHeight: 1.1, letterSpacing: "-0.025em", fontWeight: 400 }}>Good afternoon, Liam</p>
        <p style={{ fontSize: 40, lineHeight: 1.1, letterSpacing: "-0.025em", fontWeight: 500, marginTop: 6 }}>Good afternoon, Liam</p>
        <p style={{ fontSize: 13, marginTop: 18, color: ink2 }}>New chat · Search · Projects · Library · Customize · Mira · Scout · Otto</p>
        <p style={{ fontSize: 14, marginTop: 6, fontWeight: 500 }}>Post the summary to #design in Slack · Allow once · Deny</p>
      </div>
      <p className={text ?? cls} style={{ fontSize: 15.5, lineHeight: 1.6, marginTop: 14, maxWidth: "62ch" }}>
        Stripe shows €412,000 of the €438,000 the forecast expects from renewals. Halvorsen moved to monthly billing in August and has not renewed the annual plan.
      </p>
      <p className={text ?? cls} style={{ fontSize: 14, marginTop: 10, fontVariantNumeric: "tabular-nums", color: ink2 }}>
        €96,000 · €72,400 · €23,600 · 1,200 · 0.61 · 11 of 14
      </p>
      <p className={text ?? cls} style={{ fontSize: 14, marginTop: 8, color: ink2 }}>
        Добрый день, Лиам. Прогноз продлений · Chào buổi chiều, Liam. Rủi ro gia hạn
      </p>
    </div>
  );
}

export default function InstrumentLab() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main style={{ background: "#08080A", minHeight: "100dvh", padding: 24, display: "grid", gap: 24 }}>
      {SANS.map((f) => (
        <section key={f.name} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Specimen name={f.name} cls={f.cls} text={f.text} ground="dark" />
          <Specimen name={f.name} cls={f.cls} text={f.text} ground="light" />
        </section>
      ))}
      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {(["dark", "light"] as const).map((g) => (
          <div key={g} style={{ background: g === "dark" ? "#141415" : "#FBFBFA", color: g === "dark" ? "#A3A3A9" : "#5C5C63", padding: 28, borderRadius: 12, display: "grid", gap: 10 }}>
            {MONO.map((m) => (
              <p key={m.name} className={m.cls} style={{ fontSize: 12, ...(m.style ?? {}) }}>
                {m.name.padEnd(26, " ")} 2m 14s · 3 of 5 · src/lib/billing/renewals.ts:118 · €23,600 · 10:42
              </p>
            ))}
          </div>
        ))}
      </section>
      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {(["dark", "light"] as const).map((g) => (
          <div key={g} style={{ background: g === "dark" ? "#141415" : "#FBFBFA", padding: 28, borderRadius: 12, display: "flex", gap: 28, flexWrap: "wrap" }}>
            {SIGNALS.map((s) => {
              const c = g === "dark" ? s.dark : s.light;
              return (
                <div key={s.name} style={{ display: "grid", gap: 10, justifyItems: "center" }}>
                  <span style={{ width: 32, height: 32, borderRadius: 999, background: g === "dark" ? c : "#161618", display: "grid", placeItems: "center" }}>
                    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke={g === "dark" ? "#141415" : c} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                    </svg>
                  </span>
                  <span style={{ width: 22, height: 22, borderRadius: 999, background: "#070708", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)", display: "grid", placeItems: "center" }}>
                    <svg width={22} height={22} viewBox="0 0 22 22">
                      <line x1={11} y1={11} x2={15.6} y2={6.4} stroke={c} strokeWidth={2} strokeLinecap="round" />
                      <circle cx={11} cy={11} r={1.4} fill={c} />
                    </svg>
                  </span>
                  <span style={{ fontSize: 11, color: g === "dark" ? "#A3A3A9" : "#5C5C63", fontFamily: "ui-monospace" }}>{s.name}</span>
                </div>
              );
            })}
          </div>
        ))}
      </section>
    </main>
  );
}
