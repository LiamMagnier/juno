"use client";

import * as React from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  Calculator,
  Clock,
  Code2,
  FileText,
  Globe,
  ImageIcon,
  Link2,
  MessageSquare,
  PanelRight,
  Plug,
  Plus,
  Search,
  X,
  type IconComponent,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TEACHABLE_TOOLS, type TaughtApp } from "@/lib/skills/teach";
import { useReducedMotion } from "@/lib/motion-preference";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { permissionRows, type TeachPermissionRow } from "@/components/skills/teach/teach-model";

/*
 * What a taught skill may use, as rows the person can read and take away.
 *
 *   [⌕] Search the web                         Used in your chat     ×
 *       Look things up and cite what it finds.
 *   [⧉] Gmail                                    Connected            ×
 *       Use this connected app, asking you first before anything…
 *   + Allow something else
 *
 * The rule the footnote states is the runtime's (`scopeTurnToSkill`,
 * `narrowRuntimeToolsForSkill` and `skillKeepsUnlistedSurfaces` in
 * src/lib/chat/skills.ts), not a promise: when the person runs the skill in a
 * chat and this list names anything, the turn keeps to it — tools, apps, web
 * search, deep research and the canvas — and runs without what no skill can
 * list (the Mac folder, the agent setup, room and cross-conversation tools),
 * never with more than that chat already has on; an app action that needs
 * approval still asks. The skill's own tools (`use_skill`, `read_skill_file`)
 * stay, so it can read itself. An empty list narrows nothing, and the page says
 * that plainly rather than "uses nothing". The footnote says "when you run it"
 * because a skill the model picks for itself (automatic use, off for every
 * taught skill) narrows nothing.
 */

const TOOL_ICON: Record<string, IconComponent> = {
  web_search: Search,
  web_fetch: Globe,
  read_document: FileText,
  inspect_image: ImageIcon,
  canvas: PanelRight,
  run_code: Code2,
  search_chats: MessageSquare,
  current_time: Clock,
  calculate: Calculator,
};

function RowIcon({ row }: { row: TeachPermissionRow }) {
  const Icon = row.kind === "tool" ? (TOOL_ICON[row.id] ?? Plug) : row.kind === "app" ? Plug : Link2;
  return (
    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-muted text-muted-on-fill">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

export function TeachPermissions({
  tools,
  connectors,
  domains,
  apps,
  observed,
  onChange,
  disabled = false,
}: {
  tools: readonly string[];
  connectors: readonly string[];
  domains: readonly string[];
  apps: readonly TaughtApp[];
  observed?: { tools: readonly string[]; apps: readonly string[] };
  onChange: (next: { tools: string[]; connectors: string[]; domains: string[] }) => void;
  disabled?: boolean;
}) {
  const reduce = useReducedMotion() ?? false;
  const rows = permissionRows({ tools: [...tools], connectors: [...connectors], domains: [...domains] }, { apps, observed });
  const addableTools = TEACHABLE_TOOLS.filter((tool) => !tools.includes(tool.id));
  const addableApps = apps.filter((app) => !connectors.includes(app.id));

  const remove = (row: TeachPermissionRow) => {
    onChange({
      tools: row.kind === "tool" ? tools.filter((id) => id !== row.id) : [...tools],
      connectors: row.kind === "app" ? connectors.filter((id) => id !== row.id) : [...connectors],
      domains: row.kind === "domain" ? domains.filter((id) => id !== row.id) : [...domains],
    });
  };

  return (
    <div>
      {rows.length === 0 ? (
        <p className="rounded-field bg-muted/60 px-3.5 py-3 text-ui leading-relaxed text-muted-foreground">
          Nothing listed. When it runs, {PRODUCT_NAME} can use whatever that chat already has switched on. Add what the
          method needs to keep it to just that.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-field border border-border/70">
          <AnimatePresence initial={false}>
            {rows.map((row) => (
              <motion.li
                key={`${row.kind}:${row.id}`}
                layout={reduce ? false : "position"}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0, transition: transition.base }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, transition: transition.exit }}
                className="flex items-start gap-3 bg-background px-3 py-2.5"
              >
                <RowIcon row={row} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui font-medium text-foreground">
                    <span translate={row.kind === "domain" ? "no" : undefined}>{row.label}</span>
                    {row.observed ? (
                      <span className="rounded-full bg-[hsl(var(--success)/0.1)] px-1.5 py-px text-micro font-normal text-[hsl(var(--success-ink))]">
                        Used in your chat
                      </span>
                    ) : null}
                    {row.kind === "app" && !row.connected ? (
                      <span className="text-micro font-normal text-warning-foreground">Not connected</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
                    {row.description}
                    {row.kind === "app" && !row.connected ? (
                      <>
                        {" "}
                        <Link href="/connections" className="underline underline-offset-2 hover:text-foreground">
                          Connect it
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={`Don’t allow ${row.label}`}
                  disabled={disabled}
                  onClick={() => remove(row)}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </IconButton>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {addableTools.length + addableApps.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              className="mt-1.5 gap-1.5 font-normal text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              Allow something else
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            {addableTools.length > 0 ? <DropdownMenuLabel>Tools</DropdownMenuLabel> : null}
            {addableTools.map((tool) => {
              const Icon = TOOL_ICON[tool.id] ?? Plug;
              return (
                <DropdownMenuItem
                  key={tool.id}
                  onSelect={() => onChange({ tools: [...tools, tool.id], connectors: [...connectors], domains: [...domains] })}
                >
                  <Icon aria-hidden="true" />
                  <span className="flex min-w-0 flex-col">
                    <span>{tool.label}</span>
                    <span className="truncate text-caption text-muted-foreground">{tool.description}</span>
                  </span>
                </DropdownMenuItem>
              );
            })}
            {addableApps.length > 0 ? (
              <>
                {addableTools.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel>Connected apps</DropdownMenuLabel>
                {addableApps.map((app) => (
                  <DropdownMenuItem
                    key={app.id}
                    onSelect={() => onChange({ tools: [...tools], connectors: [...connectors, app.id], domains: [...domains] })}
                  >
                    <Plug aria-hidden="true" />
                    {app.label}
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <p className={cn("mt-2 text-caption leading-relaxed text-muted-foreground")}>
        {rows.some((row) => row.kind !== "domain")
          ? `A skill only asks. When you run it, ${PRODUCT_NAME} uses just what’s listed here, and only what that chat already has on. `
          : null}
        Anything that needs your approval still asks you each time.
      </p>
    </div>
  );
}
