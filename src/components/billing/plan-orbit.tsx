"use client";

import * as React from "react";
import type { Plan } from "@prisma/client";
import { DotRings } from "@/components/home/dot-construction";
import { UserAvatar } from "@/components/app/user-menu";
import { PLANS } from "@/lib/plans";

/**
 * The plans as the homepage draws Alevr: you at the centre, every plan on its
 * own orbit around you, a wider orbit for a bigger plan. The orbits are the
 * dot engine's (DotRings), so the page is drawn in the same dots as the
 * homepage's construction and Orbit's map.
 *
 * Picking a plan sends the presence trajectory round its orbit to the plan's
 * point (the arc draws on again each time it moves), lights every orbit
 * inside it, since a bigger plan holds the smaller ones, and leaves the ones
 * outside faint. The nodes are the radiogroup: arrow keys move through it.
 */

/** Where each plan sits on its orbit, by how many plans are shown (checked for collisions at 1100×620). */
const ANGLES: Record<number, number[]> = {
  1: [90],
  2: [90, 225],
  3: [280, 45, 150],
  4: [340, 85, 300, 220],
  5: [215, 115, 255, 10, 40],
  6: [250, 35, 155, 275, 120, 330],
  7: [300, 25, 160, 80, 215, 345, 145],
};

function orbitsFor(count: number) {
  return Array.from({ length: count }, (_, k) => {
    const rx = count === 1 ? 0.3 : 0.11 + k * (0.37 / (count - 1));
    return { rx, ry: rx * 1.25 };
  });
}

export function PlanOrbit({
  plans,
  selected,
  current,
  priceOf,
  onSelect,
  onKeyDown,
}: {
  plans: readonly Plan[];
  selected: Plan;
  current: Plan;
  priceOf: (plan: Plan) => string;
  onSelect: (plan: Plan) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const orbits = React.useMemo(() => orbitsFor(plans.length), [plans.length]);
  const angles = ANGLES[plans.length] ?? ANGLES[7];
  const index = Math.max(0, plans.indexOf(selected));

  // Inside the chosen orbit the rings are drawn full; outside, faint.
  const rings = React.useMemo(() => orbits.map((o, k) => ({ ...o, faint: k > index })), [orbits, index]);
  // The trajectory arrives at the plan's point from a third of a turn back.
  const arcs = React.useMemo(() => [{ ring: index, from: angles[index] - 120, to: angles[index] - 7 }], [index, angles]);

  const point = (k: number) => {
    const t = (angles[k] * Math.PI) / 180;
    return { x: 50 + orbits[k].rx * 100 * Math.cos(t), y: 50 + orbits[k].ry * 100 * Math.sin(t) };
  };
  const at = point(index);

  return (
    <div
      className="alv plans-stage"
      // The presence haze follows the chosen plan's point.
      style={{ ["--haze-x" as string]: `${at.x}%`, ["--haze-y" as string]: `${at.y}%` }}
    >
      <DotRings rings={rings} arcs={arcs} stagger={0.07} draw={1.2} className="plans-stage-dots" />
      <div className="plans-you" aria-hidden>
        <span className="plans-you-disc">
          <UserAvatar className="size-full" />
        </span>
        <span className="plans-you-label">You</span>
      </div>
      <div role="radiogroup" aria-label="Plans" onKeyDown={onKeyDown}>
        {plans.map((plan, k) => {
          const p = point(k);
          const isSelected = plan === selected;
          return (
            <button
              key={plan}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              data-plan={plan}
              data-outside={k > index || undefined}
              onClick={() => onSelect(plan)}
              className="plans-node"
              style={{ left: `${p.x}%`, top: `${p.y}%` }}
            >
              <span className="plans-node-point" aria-hidden />
              <span className="plans-node-name">{PLANS[plan].name}</span>
              <span className="plans-node-meta">{priceOf(plan)}</span>
              {plan === current && <span className="plans-node-you">your plan</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
