import type { MotionValue } from "framer-motion";
import { DotConstruction } from "./dot-construction";

/**
 * The construction: Alevr's mathematical drawing. Nested orbits grow by a
 * constant ratio (each one holds the last; the set keeps expanding), read on a
 * number line marked with the alephs. One presence trajectory travels the
 * fourth orbit. Drawn as a dot matrix at an isometric diagonal
 * (dot-construction.tsx); every surface places it with CSS
 * (dot-construction.css). Decorative: hidden from assistive technology.
 */
export function Construction(props: {
  ticks?: boolean;
  trajectory?: boolean;
  axis?: boolean;
  animate?: boolean;
  parallax?: boolean;
  zoom?: MotionValue<number>;
  paused?: boolean;
  className?: string;
}) {
  return <DotConstruction {...props} />;
}
