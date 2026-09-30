import * as React from "react";

const FACES = [
  { id: "wix", name: "Wix Madefor Display + Text", display: "var(--lab-wix-display)", text: "var(--lab-wix-text)" },
  { id: "inter", name: "Inter (current UI face)", display: "var(--font-sans)", text: "var(--font-sans)" },
  { id: "manrope", name: "Manrope", display: "var(--lab-manrope)", text: "var(--lab-manrope)" },
  { id: "franklin", name: "Libre Franklin", display: "var(--lab-franklin)", text: "var(--lab-franklin)" },
  { id: "source", name: "Source Sans 3", display: "var(--lab-source)", text: "var(--lab-source)" },
  { id: "nunito", name: "Nunito Sans", display: "var(--lab-nunito)", text: "var(--lab-nunito)" },
];

const HUES = [
  { id: "celadon", name: "Celadon", light: "oklch(0.56 0.075 172)", dark: "oklch(0.76 0.075 172)" },
  { id: "jade", name: "Deep jade", light: "oklch(0.52 0.09 160)", dark: "oklch(0.74 0.09 160)" },
  { id: "petrol", name: "Petrol", light: "oklch(0.5 0.07 220)", dark: "oklch(0.74 0.07 220)" },
  { id: "plum", name: "Plum", light: "oklch(0.5 0.1 340)", dark: "oklch(0.74 0.09 340)" },
  { id: "saffron-ink", name: "Verdigris", light: "oklch(0.56 0.07 190)", dark: "oklch(0.76 0.07 190)" },
  { id: "moss", name: "Moss", light: "oklch(0.55 0.08 135)", dark: "oklch(0.76 0.08 135)" },
];

function Orbit({ color, ink, size = 28 }: { color: string; ink: string; size?: number }) {
  // Hairline arc open at the upper right; the dot sits in the gap.
  const r = 9;
  const c = 12;
  const at = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    return [c + r * Math.cos(t), c + r * Math.sin(t)];
  };
  const [sx, sy] = at(-18);
  const [ex, ey] = at(-72);
  const [dx, dy] = at(-45);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d={`M${sx} ${sy} A${r} ${r} 0 1 1 ${ex} ${ey}`} stroke={ink} strokeWidth={1.25} strokeLinecap="round" />
      <circle cx={dx} cy={dy} r={2.6} fill={color} />
    </svg>
  );
}

export function LabStage({ className, theme, part }: { className: string; theme: "light" | "dark"; part: "type" | "color" }) {
  const dark = theme === "dark";
  const bg = dark ? "#141516" : "#F8F9F9";
  const side = dark ? "#101112" : "#F1F2F3";
  const ink = dark ? "#ECEDEE" : "#1A1C1E";
  const ink2 = dark ? "#A3A7AB" : "#5B6065";
  const hair = dark ? "rgba(255,255,255,0.08)" : "rgba(26,28,30,0.08)";
  const surface = dark ? "#1C1D1F" : "#FFFFFF";
  const token = dark ? "#2A2C2F" : "#EEF0F1";

  if (part === "color") {
    return (
      <div className={className} style={{ background: bg, color: ink, minHeight: "100dvh", padding: 48, fontFamily: "var(--lab-wix-text)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 32 }}>
          {HUES.map((h) => {
            const col = dark ? h.dark : h.light;
            return (
              <div key={h.id} style={{ background: surface, border: `1px solid ${hair}`, borderRadius: 16, padding: 24 }}>
                <p style={{ fontSize: 13, color: ink2, margin: 0 }}>{h.name}</p>
                <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 16 }}>
                  <Orbit color={col} ink={ink} size={40} />
                  <Orbit color={col} ink={ink} size={20} />
                  <span style={{ display: "inline-grid", placeItems: "center", width: 36, height: 36, borderRadius: 999, background: ink }}>
                    <Orbit color={dark ? h.light : h.dark} ink={bg} size={20} />
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 15, color: ink2 }}>
                    <Orbit color={col} ink={ink2} size={16} />
                    Thinking about renewals
                  </span>
                </div>
                <div style={{ marginTop: 18, height: 40, borderRadius: 12, border: `1px solid ${hair}`, boxShadow: `0 0 0 3px color-mix(in oklab, ${col} 35%, transparent)`, display: "flex", alignItems: "center", padding: "0 14px", fontSize: 15, caretColor: col }}>
                  Focus ring and caret
                  <span style={{ display: "inline-block", width: 1.5, height: 18, background: col, marginLeft: 2 }} />
                </div>
                <p style={{ marginTop: 14, fontSize: 13, color: col }}>Signature text sample</p>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={className} style={{ background: bg, color: ink, minHeight: "100dvh", fontFeatureSettings: '"tnum" 0' }}>
      {FACES.map((f) => (
        <section key={f.id} style={{ display: "grid", gridTemplateColumns: "220px 1fr 420px", borderBottom: `1px solid ${hair}` }}>
          <div style={{ background: side, padding: "20px 12px", fontFamily: f.text }}>
            <p style={{ fontSize: 12, color: ink2, margin: "0 8px 10px" }}>{f.name}</p>
            {["New chat", "Search", "Projects", "Library", "Customize"].map((r) => (
              <div key={r} style={{ fontSize: 14, height: 30, display: "flex", alignItems: "center", padding: "0 8px", borderRadius: 8, background: r === "Projects" ? (dark ? "#1F2123" : "#E6E8EA") : undefined }}>
                {r}
              </div>
            ))}
            <p style={{ fontSize: 12, color: ink2, margin: "14px 8px 6px", fontWeight: 500 }}>Recent</p>
            <div style={{ fontSize: 14, color: ink2, padding: "0 8px", lineHeight: "30px" }}>Q3 forecast against Stripe</div>
          </div>
          <div style={{ padding: "28px 40px" }}>
            <p style={{ fontFamily: f.display, fontSize: 40, lineHeight: 1.15, letterSpacing: "-0.022em", margin: 0, fontWeight: 400 }}>Good afternoon, Liam</p>
            <p style={{ fontFamily: f.display, fontSize: 40, lineHeight: 1.15, letterSpacing: "-0.024em", margin: "6px 0 0", fontWeight: 500, color: ink2 }}>Good afternoon, Liam</p>
            <div style={{ fontFamily: f.text, marginTop: 20, background: surface, border: `1px solid ${hair}`, borderRadius: 20, padding: "16px 18px", fontSize: 16, lineHeight: 1.6, maxWidth: 620 }}>
              Compare{" "}
              <span style={{ background: token, borderRadius: 7, padding: "3px 8px", fontSize: 15.5 }}>Q3 Forecast.xlsx</span> with{" "}
              <span style={{ background: token, borderRadius: 7, padding: "3px 8px", fontSize: 15.5 }}>Stripe</span> and ask{" "}
              <span style={{ background: token, borderRadius: 7, padding: "3px 8px", fontSize: 15.5 }}>Mira</span> to flag renewal risk
            </div>
          </div>
          <div style={{ padding: "28px 32px 28px 0", fontFamily: f.text }}>
            <p style={{ fontSize: 18, fontWeight: 500, margin: 0, letterSpacing: "-0.01em" }}>Renewal risk this quarter</p>
            <p style={{ fontSize: 16, lineHeight: 1.6, margin: "8px 0 0" }}>
              Stripe shows <span style={{ fontWeight: 500 }}>€412,000</span> of the €438,000 the forecast expects. Three accounts make up the gap.
            </p>
            <div style={{ display: "flex", gap: 24, fontSize: 15, marginTop: 10, fontFeatureSettings: '"tnum" 1' }}>
              <span>€96,000</span>
              <span>€72,400</span>
              <span>€23,600</span>
              <span>1,111</span>
            </div>
            <p style={{ fontSize: 14, color: ink2, margin: "10px 0 0" }}>Добрый день, Лиам · Chào buổi chiều, Liâm · ẩ ố ự</p>
          </div>
        </section>
      ))}
    </div>
  );
}
