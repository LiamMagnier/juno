/**
 * Where glass is allowed, and where it is not.
 *
 * Translucency belongs to *transient* chrome — the composer, menus, popovers,
 * the command palette. Those float over content, and letting a hint of that
 * content through is what tells the eye they are temporary. Reading surfaces,
 * code, diffs and terminal output stay opaque: text over a moving, tinted
 * backdrop is harder to read, drops contrast below the ratio it was designed
 * for, and repaints the blur on every scroll frame underneath it.
 *
 * macOS "Reduce Transparency" is honoured by *becoming opaque*, not by fading:
 * the same surface, the same border, the same lightness step — just no
 * backdrop. That preference exists for legibility, and a 90%-opaque panel with
 * a blur still behind it satisfies nobody.
 */

/** Floating chrome: menus, popovers, the palette, the composer. */
export function glassSurface(reduceTransparency: boolean): string {
  return reduceTransparency ? 'bg-popover' : 'bg-popover/85 backdrop-blur-xl backdrop-saturate-150';
}

/**
 * The scrim behind a modal layer.
 *
 * `bg-scrim` and not `bg-background/70`: the token already carries its own
 * alpha (0.42 on light, 0.66 on dark) and is a *dim*, not a tinted sheet of the
 * page colour — a 70% background over a warm-paper background is very nearly
 * invisible, which is exactly how a palette ends up looking like it is part of
 * the page behind it. Do not add an opacity modifier; `--scrim` is declared with
 * its alpha inside, so `bg-scrim/70` would not compile to what it reads like.
 *
 * Only the blur is dropped under Reduce Transparency. The dim itself stays:
 * that preference is about translucent *materials*, and removing the dim would
 * take the modal layer's separation with it.
 */
export function scrimSurface(reduceTransparency: boolean): string {
  return reduceTransparency ? 'bg-scrim' : 'bg-scrim backdrop-blur-sm';
}
