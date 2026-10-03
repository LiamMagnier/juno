"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { requiresViewerCredentials } from "@/lib/image-source";
import { signOutToSignIn } from "@/lib/sign-out";
import { Archive, ArrowUpCircle, Keyboard, LogOut, ShieldCheck, User } from "@/components/ui/icons";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/components/app/app-provider";
import { PLANS, planRank } from "@/lib/plans";
import { DotIdenticon, DotFillBar } from "@/components/signature/dot-matrix";
import { cn } from "@/lib/utils";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { menuEntranceClass, menuInsetSeparatorClass } from "@/components/chat/composer-plus-menu";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModifierKeyLabel } from "@/components/ui/platform";

/*
 * Account menu: the menu recipe's row, unaltered, so every item lines up with
 * every other menu in the product: [16px muted glyph] · gap-2.5 · label ·
 * (right-aligned mono shortcut), 32px tall (44 on a coarse pointer), at the
 * row's `rounded-inner` inside the shell's `nest-menu` at `nest-p-1.5`
 * (14 − 6 = 8). No radius, height or padding override here.
 *
 * FOUR GROUPS, in the order a person reaches for them: who you are and what
 * you have used; the account itself (Settings, an upgrade when there is one to
 * buy, Admin for the owner); Juno beyond this tab (the apps, the keyboard);
 * and signing out, alone under its own hairline. The sidebar footer used to
 * carry a settings gear and a download button beside this menu's trigger;
 * both live here now, so the footer is one row.
 *
 * Each glyph makes its own one gesture when its row is highlighted (the gear
 * turns, the arrow drops, the door-arrow leaves), played by globals.css on
 * Radix's `data-highlighted`, so the keyboard gets the same life as the
 * pointer.
 */

function MenuRow({
  href,
  onSelect,
  icon,
  label,
  shortcut,
}: {
  href?: string;
  onSelect?: () => void;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
}) {
  const inner = (
    <>
      {/* No ink on the slot: the row's recipe inks the glyph muted at rest
          and brightens it with the row, which a fixed colour here blocked. */}
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && (
        <span className="shrink-0 font-mono text-caption tracking-[0.02em] text-muted-foreground/80">{shortcut}</span>
      )}
    </>
  );
  if (href) {
    return (
      <DropdownMenuItem asChild onSelect={onSelect}>
        {/* asChild: the item's classes land on the Link alongside these, so
            the row height is stated here (min-h-9 outranks the recipe's 8). */}
        <Link href={href} className={cn("flex w-full items-center gap-2.5", rowHeight)}>
          {inner}
        </Link>
      </DropdownMenuItem>
    );
  }
  return <DropdownMenuItem onSelect={onSelect} className={rowHeight}>{inner}</DropdownMenuItem>;
}

/** The brief's menu row: 36px (44 on a coarse pointer, from the recipe). */
const rowHeight = "min-h-9";

function Separator() {
  return <DropdownMenuSeparator className={menuInsetSeparatorClass} />;
}

/**
 * The signed-in user's one face.
 *
 * Exported because the sidebar footer used to draw its own (mono initials in a
 * bordered disc) beside a menu that drew a DotIdenticon for the same person.
 * One click apart, two identities, and nothing else in the product does that.
 * Photo avatars are circles (matching the Avatar primitive app-wide); the
 * DotIdenticon fallback keeps its signature squircle, which a circular crop
 * would clip.
 */
export function UserAvatar({ className }: { className?: string }) {
  const { user } = useApp();
  return user.image ? (
    <Image
      src={user.image}
      unoptimized={requiresViewerCredentials(user.image)}
      alt=""
      width={36}
      height={36}
      className={cn("shrink-0 rounded-full object-cover", className)}
    />
  ) : (
    <DotIdenticon seed={user.id} className={cn("shrink-0", className)} />
  );
}

export function UserMenu({
  compact = false,
  trigger,
  onOpenArchived,
  archivedLabel = "Archived chats",
}: {
  compact?: boolean;
  /** A caller-drawn trigger (the sidebar footer's account row). */
  trigger?: React.ReactNode;
  /** Opens the archive (chats or sessions), which lives in this menu rather than as a row of its own in the sidebar. */
  onOpenArchived?: () => void;
  archivedLabel?: string;
}) {
  const { user, quota, features, setSidebarOpen } = useApp();
  const plan = PLANS[quota.plan];
  const mod = useModifierKeyLabel();
  /* Every row leaves the menu for somewhere else, so every row closes the
     phone drawer this menu sits in, as a row in the column does. The drawer's
     open state lives in the provider, above the routes, so a page reached
     from here (Upgrade plan, Admin) otherwise opened underneath a drawer that
     stayed open, and Settings and the shortcuts sheet opened over it. At a
     desktop width the drawer is already shut and this does nothing. */
  const leave = () => setSidebarOpen(false);
  // Offered only when a plan above this one can actually be bought: a tier
  // whose price is not configured has no checkout behind it (types/app.ts).
  const canUpgrade =
    features.billing && features.purchasablePlans.some((p) => planRank(p) > planRank(quota.plan));

  const menuTrigger = (
    <DropdownMenuTrigger asChild>
      {trigger ? (
        trigger
      ) : compact ? (
        <Pressable
          kind="icon"
          size="lg"
          // The collapsed rail: a 44px target like every other icon on it,
          // squared off to `rounded-control` so it belongs to the same family
          // as the rows above it rather than being the one circle. The face is
          // the expanded footer's 32px one, and it sits on the same 16px edge,
          // so collapsing the panel leaves it where it was. No hover scale:
          // nothing else in the sidebar grows under the pointer. Open, it wears
          // the panel's one selected fill. Keyed off `aria-expanded`, not
          // `data-state`: this trigger sits inside the tooltip's Slot, and
          // TooltipTrigger's own `data-state` (closed / delayed-open) overrides
          // the dropdown's. `aria-expanded` is written by DropdownMenuTrigger
          // alone.
          className="group size-9 rounded-control hover:bg-sidebar-hover aria-expanded:sidebar-row-selected coarse:size-11"
          aria-label="Account menu"
        >
          <UserAvatar className="size-7" />
        </Pressable>
      ) : (
        <Pressable kind="row" className="group gap-2.5 p-2 hover:bg-sidebar-hover">
          <UserAvatar className="size-8" />
          <span className="min-w-0 flex-1">
            <span translate="no" className="block truncate text-ui font-medium">
              {user.name ?? user.email}
            </span>
            <span translate="no" className="block truncate text-caption text-muted-foreground">
              {plan.name}
            </span>
          </span>
        </Pressable>
      )}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {/* The rail's avatar is an icon-only control, so it names itself in a
          tooltip like every other mark on the rail. */}
      {compact && !trigger ? (
        <Tooltip>
          <TooltipTrigger asChild>{menuTrigger}</TooltipTrigger>
          <TooltipContent side="right">{`${user.name ?? user.email ?? "Account"} · ${plan.name}`}</TooltipContent>
        </Tooltip>
      ) : (
        menuTrigger
      )}

      {/* Expanded: above the footer row and exactly as wide as it, so the
          menu reads as the row opening upward rather than as a card that
          overhangs the column (never under 256px, for a narrow column). The
          rail has no width to align to, so it opens sideways like every other
          rail flyout, and `end` keeps its foot on the avatar that opened it. */}
      <DropdownMenuContent
        align={compact ? "end" : "start"}
        side={compact ? "right" : "top"}
        sideOffset={compact ? 12 : 6}
        className={cn(compact ? MENU_W_WIDE : "w-[var(--radix-dropdown-menu-trigger-width)] min-w-64", menuEntranceClass)}
      >
        {/* Identity: who you are, on what plan, reachable where. The avatar
            shares the rows' left edge (px-2.5), and the name and email share
            one text column, so the header and the list below read as one
            object. */}
        <div className="flex items-center gap-3 px-2.5 pb-2.5 pt-2">
          <UserAvatar className="size-9" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span translate="no" className="min-w-0 truncate text-ui font-medium tracking-[-0.005em] text-foreground">
                {user.name ?? user.email?.split("@")[0]}
              </span>
              {/* Words, not a pill: no badges anywhere (owner rule). Neutral,
                  not the accent: a plan is a fact about the account. */}
              <span translate="no" className="ml-auto shrink-0 text-caption text-muted-foreground">
                {`${plan.name} plan`}
              </span>
            </div>
            <span translate="no" className="mt-0.5 block truncate text-caption text-muted-foreground">
              {user.email}
            </span>
          </div>
        </div>

        {/* Usage: the ONE place the quota is drawn. The sidebar footer says
            nothing about usage below 80% and one word above it. A hairline
            block rather than a filled one (the homepage's product windows draw
            structure with 1px lines, not slabs), flush with the rows' edges and
            at their radius, with its text on the rows' text column. */}
        <div className="rounded-control border border-foreground/[0.08] px-[9px] py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-caption text-muted-foreground">Messages</span>
            {/* tabular-nums: this counter changes in place as messages are sent,
                and proportional digits make the readout shuffle sideways when
                9 becomes 10. */}
            {/* A count is a figure (mono, like the menu's key hints); "No cap"
                is a word and stays in the sans. */}
            <span
              className={cn(
                "truncate text-caption tabular-nums text-foreground",
                quota.limit != null && "font-mono tracking-[0.02em]"
              )}
            >
              {quota.limit == null ? "No cap" : `${quota.used} / ${quota.limit}`}
            </span>
          </div>
          {quota.limit != null ? (
            <DotFillBar value={quota.used} max={quota.limit} dots={18} className="mt-2" />
          ) : (
            <p className="mt-1 text-caption leading-4 text-muted-foreground">
              {quota.plan === "OWNER"
                ? "Everything unlocked, with no usage cap."
                : "All models, with a monthly token limit."}
            </p>
          )}
        </div>

        <Separator />

        {/* The account: the profile (a year of tokens and models), then
            Settings, where the name and photo are edited. */}
        <DropdownMenuGroup>
          <MenuRow href="/profile" onSelect={leave} icon={<User className="size-4" />} label="Profile" />
          <MenuRow
            onSelect={() => {
              leave();
              window.dispatchEvent(new CustomEvent("juno:settings", { detail: "general" }));
            }}
            icon={<AppIcons.settings className="size-4" />}
            label="Settings"
          />
          {onOpenArchived && (
            <MenuRow onSelect={onOpenArchived} icon={<Archive className="size-4" />} label={archivedLabel} />
          )}
          {canUpgrade && (
            <MenuRow href="/upgrade" onSelect={leave} icon={<ArrowUpCircle className="size-4" />} label="Upgrade plan" />
          )}
          {features.isOwner && (
            <MenuRow
              href="/admin"
              onSelect={leave}
              icon={<ShieldCheck className="size-4" />}
              label="Admin panel"
            />
          )}
        </DropdownMenuGroup>

        <Separator />

        {/* Juno beyond this tab. "Get the apps" goes to the download page,
            which reads the release feed and lists every platform with its
            version, size and checksum, so the menu fetches nothing to offer
            it (the footer's download menu hit GitHub on first open). */}
        <DropdownMenuGroup>
          <MenuRow
            href="/download"
            onSelect={leave}
            icon={<ActionIcons.download className="size-4" />}
            label="Get the apps"
          />
          <MenuRow
            onSelect={() => {
              leave();
              window.dispatchEvent(new CustomEvent("juno:shortcuts"));
            }}
            icon={<Keyboard className="size-4" />}
            label="Keyboard shortcuts"
            shortcut={`${mod}/`}
          />
        </DropdownMenuGroup>

        <Separator />

        {/* Sign out: alone under its own hairline. Quiet at rest — red at
            rest made the quietest exit in the menu its loudest object — and
            red when highlighted, the destructive row's live state
            (`.danger-hover`): it ends the session, so the moment the pointer
            or the keyboard lands on it says so. The glyph follows the label's
            ink and still leaves through its own door (`LogOut`'s nudge). */}
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void signOutToSignIn()}
          className={cn(rowHeight, "text-muted-foreground")}
        >
          <LogOut className="size-4 shrink-0" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
