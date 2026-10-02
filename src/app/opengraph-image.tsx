import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The link preview (Discord, Slack, iMessage, X, LinkedIn): the homepage's
 * construction on a charcoal field, the pale lockup and the promise. Built at
 * request/build time from the same geometry and fonts as the site, so it never
 * drifts from the brand again; Next serves it under a content-hashed URL, so
 * any change reaches link unfurlers that cached the previous card.
 */

export const alt = `${PRODUCT_NAME}. Go further. Chat, agents and code in one calm workspace.`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const CX = 830;
const CY = 470;
const ORBITS = Array.from({ length: 7 }, (_, k) => {
  const rx = 92 * 1.5 ** k;
  return { rx, ry: rx * 0.34 };
});

function arc(rx: number, ry: number, from: number, to: number, steps = 48) {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    pts.push(`${(CX + rx * Math.cos(t)).toFixed(1)} ${(CY + ry * Math.sin(t)).toFixed(1)}`);
  }
  return `M${pts.join("L")}`;
}

export default async function OpenGraphImage() {
  const root = process.cwd();
  const [serif, lockup] = await Promise.all([
    readFile(path.join(root, "public/fonts/newsreader-regular.ttf")),
    readFile(path.join(root, "public/brand/lockup-dark.svg"), "utf8"),
  ]);
  const lockupSrc = `data:image/svg+xml;base64,${Buffer.from(lockup).toString("base64")}`;
  const traj = ORBITS[3];
  const endT = (16 * Math.PI) / 180;
  const end = { x: CX + traj.rx * Math.cos(endT), y: CY + traj.ry * Math.sin(endT) };

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          background: "#111213",
          backgroundImage: "radial-gradient(60% 70% at 85% 10%, rgba(151,166,230,0.16), rgba(17,18,19,0) 70%)",
          fontFamily: "Newsreader",
        }}
      >
        <svg width="1200" height="630" viewBox="0 0 1200 630" style={{ position: "absolute", left: 0, top: 0 }}>
          <line x1="0" y1={CY} x2="1200" y2={CY} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
          {ORBITS.map(({ rx, ry }, k) => (
            <ellipse key={k} cx={CX} cy={CY} rx={rx} ry={ry} fill="none" stroke={k >= 5 ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.13)"} strokeWidth="1.2" />
          ))}
          <path d={arc(traj.rx, traj.ry, 300, 376)} fill="none" stroke="#97a6e6" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx={end.x} cy={end.y} r="13" fill="none" stroke="rgba(151,166,230,0.4)" strokeWidth="1.4" />
          <circle cx={end.x} cy={end.y} r="5" fill="#97a6e6" />
        </svg>
        <div style={{ position: "absolute", left: 80, top: 72, display: "flex" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- rendered by satori, not the browser */}
          <img src={lockupSrc} alt="" width={196} height={39} />
        </div>
        <div style={{ position: "absolute", left: 76, top: 236, display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 132, lineHeight: 1, letterSpacing: "-0.035em", color: "#e8e9eb" }}>Go further.</div>
          <div style={{ marginTop: 30, marginLeft: 4, fontSize: 34, lineHeight: 1.25, color: "#b4b6ba", maxWidth: 720 }}>
            Chat, agents and code in one calm workspace.
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: [{ name: "Newsreader", data: serif, weight: 400, style: "normal" }] },
  );
}
