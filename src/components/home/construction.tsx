/**
 * The construction: Alevr's mathematical drawing. Nested orbits grow by a
 * constant ratio (each one holds the last; the set keeps expanding), read on a
 * number line marked with the alephs. One presence trajectory travels the
 * fourth orbit and ends on a node. Hairlines only, drawn once on arrival; no
 * loop. Decorative: hidden from assistive technology.
 */

const CX = 750;
const CY = 500;
const BASE = 132;
const RATIO = 1.5;
const FLAT = 0.34;
const COUNT = 7;

const ORBITS = Array.from({ length: COUNT }, (_, k) => {
  const rx = BASE * RATIO ** k;
  return { rx, ry: rx * FLAT };
});

function arc(rx: number, ry: number, from: number, to: number, steps = 72) {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    pts.push(`${(CX + rx * Math.cos(t)).toFixed(2)} ${(CY + ry * Math.sin(t)).toFixed(2)}`);
  }
  return `M${pts.join("L")}`;
}

function at(rx: number, ry: number, deg: number) {
  const t = (deg * Math.PI) / 180;
  return { x: CX + rx * Math.cos(t), y: CY + ry * Math.sin(t) };
}

/** Default trajectory: the right flank of the fourth orbit, ending past ℵ₃, clear of the hero's type. */
const TRAJ = { orbit: 3, from: 305, to: 376 };

export function Construction({ ticks = true, trajectory = true, axis = true, animate = true }: { ticks?: boolean; trajectory?: boolean; axis?: boolean; animate?: boolean }) {
  const orbit = ORBITS[TRAJ.orbit];
  const end = at(orbit.rx, orbit.ry, TRAJ.to);
  const draw = animate ? "alv-draw" : undefined;
  const late = animate ? "alv-fade-late" : undefined;
  return (
    <svg viewBox="0 0 1500 1000" aria-hidden focusable="false" preserveAspectRatio="xMidYMid meet">
      {axis && <line x1="0" x2="1500" y1={CY} y2={CY} className={`alv-axis ${draw ?? ""}`} pathLength={1} style={{ ["--i" as string]: 0 }} />}
      {ORBITS.map(({ rx, ry }, k) => (
        <ellipse
          key={k}
          cx={CX}
          cy={CY}
          rx={rx}
          ry={ry}
          pathLength={1}
          className={`alv-orbit ${k >= 5 ? "alv-orbit-faint" : ""} ${draw ?? ""}`}
          style={{ ["--i" as string]: k + 1 }}
        />
      ))}
      {ticks &&
        ORBITS.slice(0, 5).map(({ rx }, k) => (
          <g key={k} className={late} style={{ ["--i" as string]: k }}>
            <line x1={CX + rx} x2={CX + rx} y1={CY - 5} y2={CY + 5} className="alv-orbit" />
            <text x={CX + rx + 8} y={CY - 10} className="alv-tick">
              ℵ<tspan fontSize="8" dy="3">{k}</tspan>
            </text>
          </g>
        ))}
      {trajectory && (
        <g>
          <path d={arc(orbit.rx, orbit.ry, TRAJ.from, TRAJ.to, 40)} pathLength={1} className={`alv-trajectory ${draw ?? ""}`} style={{ ["--i" as string]: 6 }} />
          <g className={late} style={{ ["--i" as string]: 7 }}>
            <circle cx={end.x} cy={end.y} r={10} className="alv-node-ring" />
            <circle cx={end.x} cy={end.y} r={3.5} className="alv-node" />
          </g>
        </g>
      )}
    </svg>
  );
}
