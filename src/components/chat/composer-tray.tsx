"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, Monitor } from "@/components/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerMenuClass, MenuGlide } from "@/components/chat/composer-menu";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { AppIcons } from "@/lib/app-icons";
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
 * doors), below the tray so it never covers the draft. Landing frame only: in
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
  // The desktop link is for the browser only; inside the Mac app it would point at itself.
  const [inDesktopApp, setInDesktopApp] = React.useState(true);
  React.useEffect(() => {
    setInDesktopApp(/Electron|Alevr|Juno/i.test(navigator.userAgent));
  }, []);

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
        <TrayMenu panel="project" open={open} onChange={change} render={projectPanel} disabled={disabled}>
          <AppIcons.projects aria-hidden="true" className="size-4" motion="none" />
          <span className="truncate">{projectName ?? "Select project"}</span>
        </TrayMenu>

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

        {!inDesktopApp ? (
          <Link href="/download" className="composer-tray__item composer-tray__item--end">
            <Monitor aria-hidden="true" className="size-4" motion="none" />
            <span>Mac app</span>
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function TrayMenu({
  panel,
  open,
  onChange,
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
  render: () => React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** The accessible name, when the visible label may be hidden (the compact Project control). */
  label?: string;
  /** Wrapped in a Tooltip by the caller: the trigger doubles as its tooltip trigger. */
  tooltip?: boolean;
  children: React.ReactNode;
}) {
  const trigger = (
    <DropdownMenuTrigger asChild disabled={disabled}>
      <button type="button" className={cn("composer-tray__item", className)} aria-label={label}>
        {children}
        <ChevronDown aria-hidden="true" className="composer-tray__chevron size-3.5" motion="none" />
      </button>
    </DropdownMenuTrigger>
  );
  return (
    <DropdownMenu open={open === panel} onOpenChange={(next) => onChange(panel, next)}>
      {tooltip ? <TooltipTrigger asChild>{trigger}</TooltipTrigger> : trigger}
      <DropdownMenuContent
        align={tooltip ? "end" : "start"}
        side="bottom"
        sideOffset={8}
        collisionPadding={16}
        className={cn("flex flex-col", MENU_W_WIDE, composerMenuClass)}
      >
        <MenuGlide />
        {render()}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
