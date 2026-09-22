/**
 * Alerts, security, feedback and alignment.
 *
 * Every "something is wrong" mark is the same container with the same bar and
 * dot inside it, at the same two y-positions, so a warning and an error differ
 * only by the shape around them — which is the distinction that has to survive
 * at 14px, and the only one that does.
 */
import { createIcon as icon, p, c, rect, dot, dashed, type IconElement } from "./create-icon";

/** The bang: one bar, one dot, at the same height in every container. */
const BANG: IconElement[] = [p("M12 8.2v4.2"), dot(12, 15.7, 1.05)];
const RING = c(12, 12, 7.8);

export const AlertCircle = icon("alert-circle", [RING, ...BANG]);
export const TriangleAlert = icon("triangle-alert", [
  p("M10.3 4.5 3 16.9a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.5a2 2 0 0 0-3.4 0"),
  p("M12 9.8v3.8"),
  dot(12, 16.8, 1.05),
]);
export const AlertTriangle = TriangleAlert;
export const Info = icon("info", [RING, p("M12 16.2v-4.6"), dot(12, 8.3, 1.05)]);
export const HelpCircle = icon("help-circle", [
  RING,
  p("M9.8 9.6a2.3 2.3 0 0 1 4.47.77c0 1.53-2.27 2.3-2.27 2.3v1"),
  dot(12, 16.2, 1.05),
]);
export const CheckCircle2 = icon("check-circle-2", [RING, p("M8.4 12.2 10.9 14.7l4.7-5.4")]);
export const CircleCheck = CheckCircle2;
export const XCircle = icon("x-circle", [RING, p("M9.2 9.2 14.8 14.8"), p("M14.8 9.2 9.2 14.8")]);
/**
 * The same ring carrying a direction rather than a verdict — "this one is
 * moving" in a column where its neighbours are a dashed ring and a check.
 * The head is a `arrow-right` part, so it inherits the travel gesture.
 */
export const CircleArrowRight = icon("circle-arrow-right", [
  RING,
  p("M8.6 12h6.3"),
  p("M12.5 9.2 15.3 12l-2.8 2.8", "arrow-right"),
]);
/**
 * Done, stated solidly.
 *
 * Drawn as ONE even-odd path — disc with the check cut out of it — rather than
 * a filled disc under a stroked tick. A two-element version has to paint the
 * tick in the surface colour to read, which is a lie the moment the badge sits
 * on a card, a hover row or a selection tint instead of the page. Cutting the
 * hole means whatever is behind it shows through and it is right everywhere.
 */
export const CheckCircleSolid = icon("check-circle-solid", [
  [
    "path",
    {
      d: "M12 3.6a8.4 8.4 0 1 1 0 16.8 8.4 8.4 0 0 1 0-16.8Z M7.86 12.99 11.07 16.19 16.3 9.82 14.9 8.68 10.93 13.51 9.14 11.71Z",
      fill: "currentColor",
      fillRule: "evenodd",
      clipRule: "evenodd",
      stroke: "none",
    },
  ],
]);
export const BadgeCheck = icon("badge-check", [
  p("M12 2.6 14 4.3l2.6-.3.9 2.5 2.5.9-.3 2.6 1.7 2-1.7 2 .3 2.6-2.5.9-.9 2.5-2.6-.3-2 1.7-2-1.7-2.6.3-.9-2.5-2.5-.9.3-2.6-1.7-2 1.7-2-.3-2.6 2.5-.9.9-2.5 2.6.3z"),
  p("M9.2 12.1 11.2 14.1l3.8-4.2"),
]);

/* — Security ———————————————————————————————————————————————————————— */

const SHIELD = p(
  "M12 20.8c4.53-1.74 6.8-5.2 6.8-9.4V6.68a1 1 0 0 0-.66-.94l-6.14-2.2a1 1 0 0 0-.68 0L5.2 5.74a1 1 0 0 0-.66.94v4.72c0 4.2 2.27 7.66 6.8 9.4"
);

export const ShieldCheck = icon("shield-check", [SHIELD, p("M9.2 11.9 11.2 13.9l3.8-4.2")]);
export const ShieldAlert = icon("shield-alert", [SHIELD, p("M12 8v3.8"), dot(12, 15, 1.05)]);
export const ShieldOff = icon("shield-off", [
  p("M8.6 4.6 11.32 3.6a1 1 0 0 1 .68 0l6.14 2.2a1 1 0 0 1 .66.94v4.72a10 10 0 0 1-.94 4.3"),
  p("M4.54 8.4v3a10 10 0 0 0 6.8 9.4 10.6 10.6 0 0 0 4.3-2.86"),
  p("M4.4 4.4 19.6 19.6"),
]);
export const Lock = icon("lock", [
  rect(4.6, 10.4, 14.8, 9.6, 3),
  p("M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6", "lid"),
]);
export const LockOpen = icon("lock-open", [
  rect(4.6, 10.4, 14.8, 9.6, 3),
  p("M8.2 10.4V7.8a3.8 3.8 0 0 1 7.1-1.86", "lid"),
]);
export const KeyRound = icon("key-round", [
  c(8, 16, 4.2),
  p("M10.97 13.03 20.4 3.6"),
  p("M17.2 6.8 19.4 9"),
  p("M14.6 9.4 16.8 11.6"),
]);

/* — Feedback ———————————————————————————————————————————————————————— */

export const ThumbsUp = icon("thumbs-up", [
  rect(3.4, 10.6, 3.9, 9, 1.4),
  p("M7.3 11.6 10.6 4.2a1.9 1.9 0 0 1 3.63.77V9.4h4.13a2.2 2.2 0 0 1 2.15 2.66l-1.28 6a2.2 2.2 0 0 1-2.15 1.74H9.3a2 2 0 0 1-2-2z"),
]);
export const ThumbsDown = icon("thumbs-down", [
  rect(3.4, 4.4, 3.9, 9, 1.4),
  p("M7.3 12.4 10.6 19.8a1.9 1.9 0 0 0 3.63-.77V14.6h4.13a2.2 2.2 0 0 0 2.15-2.66l-1.28-6A2.2 2.2 0 0 0 16.38 4.2H9.3a2 2 0 0 0-2 2z"),
]);
export const PartyPopper = icon("party-popper", [
  p("M3.4 20.6 8 9.6l6.4 6.4z"),
  p("M14.2 4.6v.02"),
  p("M16.4 8.4a2.4 2.4 0 0 1 2.2-3.4h2"),
  p("M12.6 7.6a2.4 2.4 0 0 0 1.2-3.2l-.6-1.2"),
  dot(19.4, 12.6, 1.1, "accent"),
  dot(20.4, 8.2, 1.1, "accent"),
]);

/* — Cloud transfer —————————————————————————————————————————————————— */

export const UploadCloud = icon("upload-cloud", [
  p("M7.4 17.4a4.4 4.4 0 0 1-.6-8.76 5.6 5.6 0 0 1 10.74 1.16A3.8 3.8 0 0 1 17 17.4"),
  p("M12 20.6v-7.4"),
  p("M9.6 15.6 12 13.2l2.4 2.4", "arrow-up"),
]);

/* — Alignment ——————————————————————————————————————————————————————— */

export const AlignStartHorizontal = icon("align-start-horizontal", [
  p("M3.4 3.6h17.2"),
  rect(5.2, 6.4, 5, 13.6, 1.8),
  rect(13.8, 6.4, 5, 8, 1.8),
]);
export const AlignEndHorizontal = icon("align-end-horizontal", [
  p("M3.4 20.4h17.2"),
  rect(5.2, 4, 5, 13.6, 1.8),
  rect(13.8, 9.6, 5, 8, 1.8),
]);
export const AlignCenterHorizontal = icon("align-center-horizontal", [
  p("M3.4 12h17.2"),
  rect(5.2, 5.2, 5, 13.6, 1.8),
  rect(13.8, 8, 5, 8, 1.8),
]);
export const AlignStartVertical = icon("align-start-vertical", [
  p("M3.6 3.4v17.2"),
  rect(6.4, 5.2, 13.6, 5, 1.8),
  rect(6.4, 13.8, 8, 5, 1.8),
]);
export const AlignEndVertical = icon("align-end-vertical", [
  p("M20.4 3.4v17.2"),
  rect(4, 5.2, 13.6, 5, 1.8),
  rect(9.6, 13.8, 8, 5, 1.8),
]);
export const AlignCenterVertical = icon("align-center-vertical", [
  p("M12 3.4v17.2"),
  rect(5.2, 5.2, 13.6, 5, 1.8),
  rect(8, 13.8, 8, 5, 1.8),
]);
export const AlignHorizontalDistributeCenter = icon("align-horizontal-distribute-center", [
  rect(3.4, 6.6, 4.6, 10.8, 1.8),
  rect(16, 6.6, 4.6, 10.8, 1.8),
  p("M12 3.6v4.2"),
  p("M12 16.2v4.2"),
  dashed("M12 9.4v5.2", "2.4 2.6"),
]);
export const AlignVerticalDistributeCenter = icon("align-vertical-distribute-center", [
  rect(6.6, 3.4, 10.8, 4.6, 1.8),
  rect(6.6, 16, 10.8, 4.6, 1.8),
  p("M3.6 12h4.2"),
  p("M16.2 12h4.2"),
  dashed("M9.4 12h5.2", "2.4 2.6"),
]);
