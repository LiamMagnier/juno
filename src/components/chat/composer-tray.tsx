"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, Monitor } from "@/components/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { COMPOSER_MENU_COLLISION_PADDING, composerMenuClass, MenuGlide } from "@/components/chat/composer-menu";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { AppIcons } from "@/lib/app-icons";
import { DESKTOP_APP_DOWNLOAD_PATH } from "@/lib/desktop-app-link";
import { useMacAppLauncher } from "@/hooks/use-mac-app";
import { cn } from "@/lib/utils";

/*
 * THE HOME COMPOSER'S TRAY: a quiet shelf the composer rests on, tucked under
 * its lower edge, holding where the new chat goes and what it can reach.
 *
 *   [ Project ]  [ Apps ◦◦◦ ]  [ Skills ]                    [ Mac app ]
 *
 * With an image, video or music model it is one line of that model's
 * generation choices and a compact Project control at the end:
 *
 *   [▭ 16:9 ⌄] [720p | 1080p] [8s ⌄] [Sound on]            | [▣ Project ⌄]
 *
 * Each control opens the same panel the + menu flies out (one list, two
 * doors), at the chip that opened it: just above it, over the composer, or
 * below it when there is no room above (composer-menu.tsx, "Where they
 * open"). Landing frame only: in
 * a thread the dock keeps its single line and the + menu is the one door.
 * The shelf itself is a tone, not a card: no border, no shadow, so the
 * composer stays the one elevated object on the page.
 */

type Panel = "project" | "apps" | "skills";

export function ComposerTray({
  projectName,
  connectors,
  onOpenProjects,
  onOpenApps,
  onOpenSkills,
  projectPanel,
  appsPanel,
  skillsPanel,
  disabled,
  params,
}: {
  /** The project a new chat will be filed in, or null. */
  projectName: string | null;
  /** The apps this chat can reach, drawn as a small stack of marks. */
  connectors: { id: string; label: string }[];
  onOpenProjects: () => void;
  onOpenApps: () => void;
  onOpenSkills?: () => void;
  projectPanel: () => React.ReactNode;
  appsPanel: (() => React.ReactNode) | null;
  skillsPanel: (() => React.ReactNode) | null;
  disabled?: boolean;
  /** An image, video or music model's generation row: the tray becomes that row plus a compact Project control. */
  params?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState<Panel | null>(null);
  // The desktop link is for the browser only; inside the Mac app it would point
  // at itself. The app opens when there is evidence it is installed, else the
  // download page (src/hooks/use-mac-app.ts). A modified click keeps the plain
  // link, so ⌘-click still opens the download page in a new tab.
  const macApp = useMacAppLauncher();
  const openMacApp = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    macApp.open(null);
  };

  const rowRef = React.useRef<HTMLDivElement>(null);
  useWholeProjectWord(rowRef, !params && !projectName);

  const change = (panel: Panel, next: boolean) => {
    setOpen(next ? panel : null);
    if (!next) return;
    if (panel === "project") onOpenProjects();
    else if (panel === "apps") onOpenApps();
    else onOpenSkills?.();
  };

  const marks = connectors.slice(0, 3);

  // An image, video or music model: ONE line. Its generation choices first,
  // then where the chat goes as a compact control at the end; Apps, Skills
  // and the Mac app step away (they say nothing about a picture or a song).
  if (params) {
    const projectLabel = projectName ?? "Project";
    return (
      <div className="composer-tray composer-tray--media" data-disabled={disabled ? "" : undefined}>
        <div className="composer-tray__line">
          {params}
          <span className="composer-tray__rule" aria-hidden="true" />
          <Tooltip>
            <TrayMenu
              panel="project"
              open={open}
              onChange={change}
             
              render={projectPanel}
              disabled={disabled}
              className="composer-tray__item--project"
              label={projectName ? `Project: ${projectName}` : "Select project"}
              tooltip
              align="end"
            >
              <AppIcons.projects aria-hidden="true" className="size-4" motion="none" />
              <span className="composer-tray__project-label truncate">{projectLabel}</span>
            </TrayMenu>
            <TooltipContent>{projectName ?? "Select project"}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    );
  }

  // No project yet: the one word, "Project", as the media row says it. The
  // old "Select project" was cut to "Select proj…" on every phone under
  // ~400px (the row is full there), mid-word on the most-seen control; the
  // verb lives on in the accessible name. A chosen project's own name may
  // still run long: it ends on the ellipsis and its tooltip has it whole.
  return (
    <div className="composer-tray" data-disabled={disabled ? "" : undefined}>
      <div ref={rowRef} className="composer-tray__row">
        <Tooltip>
          <TrayMenu
            panel="project"
            open={open}
            onChange={change}
            render={projectPanel}
            disabled={disabled}
            label={projectName ? `Project: ${projectName}` : "Select project"}
            tooltip
            className="composer-tray__item--project-row"
          >
            <AppIcons.projects aria-hidden="true" className="size-4" motion="none" />
            {/* Under 340px (a 320 phone) even the one word was cut to "Pr…":
                the control drops it and keeps its icon and its name, as the
                media row's does (composer.css). Above that the word is
                measured (useWholeProjectWord): whole, or not drawn. */}
            <span className="composer-tray__project-word truncate">{projectName ?? "Project"}</span>
          </TrayMenu>
          {/* Always a tooltip: the word may be dropped (icon only) with no project chosen. */}
          <TooltipContent>{projectName ?? "Select project"}</TooltipContent>
        </Tooltip>

        {appsPanel ? (
          <TrayMenu panel="apps" open={open} onChange={change} render={appsPanel} disabled={disabled}>
            {marks.length > 0 ? (
              <span className="composer-tray__marks" aria-hidden="true">
                {marks.map((connector) => (
                  <span key={connector.id} className="composer-tray__mark">
                    <ConnectorMark id={connector.id} className="size-3.5" />
                  </span>
                ))}
              </span>
            ) : (
              <AppIcons.connections aria-hidden="true" className="size-4" motion="none" />
            )}
            <span>Apps</span>
            {connectors.length > 0 ? <span className="sr-only">{`, ${connectors.length} on`}</span> : null}
          </TrayMenu>
        ) : null}

        {skillsPanel ? (
          <TrayMenu panel="skills" open={open} onChange={change} render={skillsPanel} disabled={disabled}>
            <AppIcons.skills aria-hidden="true" className="size-4" motion="none" />
            <span>Skills</span>
          </TrayMenu>
        ) : null}

        {macApp.visible ? (
          <Link
            href={DESKTOP_APP_DOWNLOAD_PATH}
            onClick={openMacApp}
            className="composer-tray__item composer-tray__item--end"
          >
            <Monitor aria-hidden="true" className="size-4" motion="none" />
            <span>Mac app</span>
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Project" whole or not at all. With no project chosen the row's first
 * control says the one word, and on a narrow phone the row is full: at 340 to
 * 356px the English row with no apps on cut it to "Proj…" (the 344px Fold
 * cover screen among them), three apps' marks still cut it at 375, and a
 * missing Skills or the word as translated move that line again, so no one
 * breakpoint can draw it. The row is measured with the word in, and marked
 * `data-tight` (composer.css) when the word would be cut: the control keeps its icon, its tooltip and its
 * accessible name, as the media row's does (useEdgeFades,
 * composer-media-params.tsx). Measured with the word in every time, so the two
 * states never chase each other. A chosen project's own name is left to its
 * ellipsis; its tooltip has it whole.
 */
function useWholeProjectWord(rowRef: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    const word = row?.querySelector<HTMLElement>(".composer-tray__project-word");
    if (!enabled || !row || !word) return;
    const text = document.createRange();
    const update = () => {
      row.removeAttribute("data-tight");
      // Reading the widths lays the row out with the word in; that frame is
      // never painted. Fractional widths: scrollWidth and clientWidth round,
      // and a word 0.3px too wide still ends on the ellipsis ("Proje…" at
      // 355 and 356px, where both read 43).
      text.selectNodeContents(word);
      if (text.getBoundingClientRect().width > word.getBoundingClientRect().width) row.setAttribute("data-tight", "");
    };
    update();
    if (typeof ResizeObserver === "undefined") return () => row.removeAttribute("data-tight");
    // The row for the window; its controls for a neighbour that grows (the
    // apps' marks, a web font arriving); the text for AutoTranslate's swap.
    const resize = new ResizeObserver(update);
    resize.observe(row);
    for (const el of row.children) resize.observe(el);
    const mutate = new MutationObserver(update);
    mutate.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutate.disconnect();
      row.removeAttribute("data-tight");
    };
  }, [rowRef, enabled]);
}

export function TrayMenu({
  panel,
  open,
  onChange,
  render,
  disabled,
  className,
  label,
  tooltip,
  align = "start",
  children,
}: {
  panel: Panel;
  open: Panel | null;
  onChange: (panel: Panel, open: boolean) => void;
  render: () => React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** The accessible name, when the visible label is shorter than it or may be hidden (the Project controls). */
  label?: string;
  /** Wrapped in a Tooltip by the caller: the trigger doubles as its tooltip trigger. */
  tooltip?: boolean;
  /** Which edge of the chip the panel lines up with: the end for the media row's control pinned at the tray's end. */
  align?: "start" | "end";
  children: React.ReactNode;
}) {
  const isOpen = open === panel;
  const button = (
    <button type="button" className={cn("composer-tray__item", className)} aria-label={label}>
      {children}
      <ChevronDown aria-hidden="true" className="composer-tray__chevron size-3.5" motion="none" />
    </button>
  );
  // The menu's trigger is the OUTER one. Each Radix trigger stamps its own
  // data-state and then spreads the props its parent Slot handed it, so the
  // outer trigger's data-state wins. With the tooltip outside, an open menu
  // read data-state="closed" (aria-expanded="true"): no open fill and no
  // turned chevron on the Project chip, while Apps and Skills showed both.
  // The same order as the + button (composer-plus-menu.tsx).
  return (
    <DropdownMenu open={isOpen} onOpenChange={(next) => onChange(panel, next)}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {tooltip ? <TooltipTrigger asChild>{button}</TooltipTrigger> : button}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // At the chip (owner, 2026-10-04): just above it, over the composer,
        // and below it only when there is no room above. Radix flips and
        // shifts; the max-height caps the panel to the room on its side.
        align={align}
        side="top"
        sideOffset={8}
        avoidCollisions
        collisionPadding={COMPOSER_MENU_COLLISION_PADDING}
        className={cn(
          "flex flex-col overflow-y-auto",
          "max-h-[min(30rem,var(--radix-dropdown-menu-content-available-height))]",
          MENU_W_WIDE,
          composerMenuClass,
        )}
      >
        <MenuGlide />
        {render()}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
