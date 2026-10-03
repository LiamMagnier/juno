"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Monitor } from "@/components/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerMenuClass, MenuGlide } from "@/components/chat/composer-menu";
import type { PlusMenuLayer } from "@/components/chat/composer-plus-menu";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { AppIcons } from "@/lib/app-icons";
import { DESKTOP_APP_DOWNLOAD_PATH, isDesktopShell, openDesktopApp } from "@/lib/desktop-app-link";
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
 * doors), outside the composer so it never covers the draft: below the tray
 * when there is room, otherwise above the whole composer (`layer`, the
 * composer's own placement), never flipped by Radix onto it. Landing frame only: in
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
  layer,
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
  /** The composer's placement: which side of its box a panel opens on, and how far out. */
  layer?: PlusMenuLayer;
}) {
  const [open, setOpen] = React.useState<Panel | null>(null);
  // The desktop link is for the browser only; inside the Mac app it would point at itself.
  const [inDesktopApp, setInDesktopApp] = React.useState(true);
  React.useEffect(() => {
    setInDesktopApp(isDesktopShell(navigator.userAgent));
  }, []);
  const router = useRouter();
  const cancelProbe = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => cancelProbe.current?.(), []);
  // Open the installed app; the download page only when nothing answers
  // (src/lib/desktop-app-link.ts). A modified click keeps the plain link, so
  // ⌘-click still opens the download page in a new tab.
  const openMacApp = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    cancelProbe.current?.();
    cancelProbe.current = openDesktopApp({ fallback: () => router.push(DESKTOP_APP_DOWNLOAD_PATH) });
  };

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
              layer={layer}
              render={projectPanel}
              disabled={disabled}
              className="composer-tray__item--project"
              label={projectName ? `Project: ${projectName}` : "Select project"}
              tooltip
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

  return (
    <div className="composer-tray" data-disabled={disabled ? "" : undefined}>
      <div className="composer-tray__row">
        <TrayMenu panel="project" open={open} onChange={change} layer={layer} render={projectPanel} disabled={disabled}>
          <AppIcons.projects aria-hidden="true" className="size-4" motion="none" />
          <span className="truncate">{projectName ?? "Select project"}</span>
        </TrayMenu>

        {appsPanel ? (
          <TrayMenu panel="apps" open={open} onChange={change} layer={layer} render={appsPanel} disabled={disabled}>
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
          <TrayMenu panel="skills" open={open} onChange={change} layer={layer} render={skillsPanel} disabled={disabled}>
            <AppIcons.skills aria-hidden="true" className="size-4" motion="none" />
            <span>Skills</span>
          </TrayMenu>
        ) : null}

        {!inDesktopApp ? (
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

/** The height a tray panel asks for before it scrolls: a filter, a list and its last row. */
const TRAY_PANEL_NEED = 380;
/** The panels' width (MENU_W_WIDE). */
const TRAY_PANEL_WIDTH = 288;

function TrayMenu({
  panel,
  open,
  onChange,
  layer,
  render,
  disabled,
  className,
  label,
  tooltip,
  children,
}: {
  panel: Panel;
  open: Panel | null;
  onChange: (panel: Panel, open: boolean) => void;
  layer?: PlusMenuLayer;
  render: () => React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** The accessible name, when the visible label may be hidden (the compact Project control). */
  label?: string;
  /** Wrapped in a Tooltip by the caller: the trigger doubles as its tooltip trigger. */
  tooltip?: boolean;
  children: React.ReactNode;
}) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [placed, setPlaced] = React.useState<{ side: "top" | "bottom"; sideOffset: number; alignOffset: number }>({
    side: "bottom",
    sideOffset: 8,
    alignOffset: 0,
  });
  const align = tooltip ? "end" : "start";
  const isOpen = open === panel;
  const onSide = layer?.onSide;
  React.useEffect(() => {
    if (!onSide || !isOpen) return;
    onSide(placed.side);
    return () => onSide(null);
  }, [onSide, isOpen, placed.side]);
  const openChange = (next: boolean) => {
    const trigger = triggerRef.current;
    if (next && layer && trigger) {
      // With the side fixed, Radix's shift is off along with its flip, so a
      // panel that would run past the window's edge is pulled back here.
      const at = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const width = Math.min(TRAY_PANEL_WIDTH, vw - 24);
      const alignOffset =
        align === "start"
          ? Math.min(0, Math.round(vw - 12 - at.left - width))
          : Math.min(0, Math.round(at.right - 12 - width));
      setPlaced({ ...layer.pick(trigger, TRAY_PANEL_NEED), alignOffset });
    }
    onChange(panel, next);
  };
  const trigger = (
    <DropdownMenuTrigger asChild disabled={disabled}>
      <button ref={triggerRef} type="button" className={cn("composer-tray__item", className)} aria-label={label}>
        {children}
        <ChevronDown aria-hidden="true" className="composer-tray__chevron size-3.5" motion="none" />
      </button>
    </DropdownMenuTrigger>
  );
  return (
    <DropdownMenu open={isOpen} onOpenChange={openChange}>
      {tooltip ? <TooltipTrigger asChild>{trigger}</TooltipTrigger> : trigger}
      <DropdownMenuContent
        align={align}
        side={layer ? placed.side : "bottom"}
        sideOffset={layer ? placed.sideOffset : 8}
        alignOffset={layer ? placed.alignOffset : 0}
        // The composer chose a side that clears its own box; letting Radix
        // flip would put the panel back over the draft (it did: Skills opened
        // upward across the composer whenever the window was short).
        avoidCollisions={!layer}
        collisionPadding={16}
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
