"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { requiresViewerCredentials } from "@/lib/image-source";
import { signOutToSignIn } from "@/lib/sign-out";
import { LogOut, ShieldCheck, User } from "@/components/ui/icons";
import { AppIcons } from "@/lib/app-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/components/app/app-provider";
import { PLANS } from "@/lib/plans";
import { DotIdenticon, DotFillBar } from "@/components/signature/dot-matrix";
import { cn } from "@/lib/utils";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/*
 * Account menu — the menu recipe's row, unaltered, so every item lines up with
 * every other menu in the product: [16px muted glyph] · gap-2.5 · label ·
 * (right-aligned mono shortcut), 32px tall (44 on a coarse pointer), at the
 * row's `rounded-control` inside the shell's `rounded-menu` at `p-1`
 * (14 − 4 = 10). No radius, height or padding override here: the rows used to
 * be 36px, the one menu in the shell a size taller than the kebab beside it.
 *
 * Each glyph makes its own one gesture when its row is highlighted — the gear
 * turns, the door-arrow leaves — played by globals.css on Radix's
 * `data-highlighted`, so the keyboard gets the same life as the pointer. The
 * hand-rolled `scale-110` on every glyph and the separate nudge on Sign out
 * that used to sit here were two motions on one mark; they are gone.
 */

function MenuRow({
  href,
  onSelect,
  icon,
  label,
  shortcut,
  accent,
}: {
  href?: string;
  onSelect?: () => void;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  accent?: boolean;
}) {
  const iconCls = cn(
    "flex size-4 shrink-0 items-center justify-center",
    accent ? "text-primary" : "text-muted-foreground"
  );
  const inner = (
    <>
      <span className={iconCls}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && (
        <span className="shrink-0 font-mono text-caption text-muted-foreground">{shortcut}</span>
      )}
    </>
  );
  if (href) {
    return (
      <DropdownMenuItem asChild>
        <Link href={href} className="flex w-full items-center gap-2.5">
          {inner}
        </Link>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem onSelect={onSelect}>
      {inner}
    </DropdownMenuItem>
  );
}

/**
 * The signed-in user's one face.
 *
 * Exported because the sidebar footer used to draw its own — MONO INITIALS in a
 * bordered disc — beside a menu that drew a DotIdenticon for the same person.
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
}: {
  compact?: boolean;
  /** A caller-drawn trigger (the sidebar footer's account row). */
  trigger?: React.ReactNode;
}) {
  const { user, quota, features } = useApp();
  const plan = PLANS[quota.plan];

  const menuTrigger = (
    <DropdownMenuTrigger asChild>
      {trigger ? (
        trigger
      ) : compact ? (
        <Pressable
          kind="icon"
          size="lg"
          // The collapsed rail: a 44px target like every other icon on it,
          // squared off to `rounded-control` so it belongs to the same
          // family as the rows above it rather than being the one circle.
          // No hover scale: nothing else in the retuned sidebar grows under
          // the pointer, and a face that swells is the loudest thing in a
          // quiet column. Open, it wears the panel's one selected recipe —
          // the same bounded fill the expanded footer's account row takes.
          // Keyed off `aria-expanded`, not `data-state`: this trigger sits
          // inside the tooltip's Slot, and TooltipTrigger's own `data-state`
          // (closed / delayed-open) overrides the dropdown's, so a
          // `[data-state=open]` recipe never matched here. `aria-expanded` is
          // written by DropdownMenuTrigger alone.
          className="group size-11 rounded-control hover:bg-sidebar-hover aria-expanded:sidebar-row-selected"
          aria-label="Account menu"
        >
          <UserAvatar className="size-6" />
        </Pressable>
      ) : (
        <Pressable kind="row" className="group gap-2.5 p-2 hover:bg-sidebar-hover">
          <UserAvatar className="size-8" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui font-medium">{user.name ?? user.email}</span>
            <span className="block truncate text-caption text-muted-foreground">{plan.name} plan</span>
          </span>
        </Pressable>
      )}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {/* The rail's avatar is an icon-only control, so it names itself in a
          tooltip like every other mark on the rail — it used to be a native
          `title`, the one label at that width that arrived late, unstyled
          and in the OS's font. */}
      {compact && !trigger ? (
        <Tooltip>
          <TooltipTrigger asChild>{menuTrigger}</TooltipTrigger>
          <TooltipContent side="right">{`${user.name ?? user.email ?? "Account"} · ${plan.name}`}</TooltipContent>
        </Tooltip>
      ) : (
        menuTrigger
      )}

      {/* Expanded: `align="start"` so the 288px menu's left edge lines up with
          the 24px avatar in the footer trigger rather than with the far side of
          a full-width row. The rail has no width to align to, so it opens
          sideways like every other rail flyout. */}
      <DropdownMenuContent
        align={compact ? "end" : "start"}
        side={compact ? "right" : "top"}
        sideOffset={8}
        className={MENU_W_WIDE}
      >
        {/* Identity header — who you are, on what plan, reachable where. */}
        <div className="flex items-center gap-3 px-2.5 pb-3 pt-2.5">
          <UserAvatar className="size-8" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate text-ui font-medium text-foreground">
                {user.name ?? user.email?.split("@")[0]}
              </span>
              {/* Neutral, not the accent. The accent is for state and the
                  primary action (FLAT_UI.md §2.4); a plan is a fact about the
                  account, and a coral capsule was the loudest thing in a menu
                  whose only coloured object should be what you are about to
                  press. */}
              <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 font-mono text-caption font-medium leading-none text-muted-foreground">
                {plan.name}
              </span>
            </div>
            <span className="mt-0.5 block truncate text-caption text-muted-foreground">{user.email}</span>
          </div>
        </div>

        {/* Usage — the ONE place the quota is drawn. The sidebar footer used to
            carry a second read of the same number (a `Progress` bar under a
            "Free · 3 / 15 messages" line), so the panel spent a whole row on a
            meter that is furniture until it is nearly spent; the footer now
            says nothing about usage below 80% and one word above it.
            `bg-secondary`, the popover's recessed rung, not `bg-muted/40`: that
            composited to ~11.6% inside a 13% menu, which is under the ~2 points
            where a fill begins to exist, so the quota block had no block. */}
        <div className="mx-1 rounded-control bg-secondary px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-caption text-muted-foreground">Messages</span>
            {/* tabular-nums: this counter changes in place as messages are sent,
                and proportional digits make the whole readout shuffle sideways
                when 9 becomes 10. */}
            <span className="truncate font-mono text-caption tabular-nums text-foreground">
              {quota.limit == null ? "No cap" : `${quota.used} / ${quota.limit}`}
            </span>
          </div>
          {quota.limit != null ? (
            <DotFillBar value={quota.used} max={quota.limit} dots={18} className="mt-2" />
          ) : (
            <p className="mt-1.5 text-caption leading-4 text-muted-foreground">
              {quota.plan === "OWNER"
                ? "Everything unlocked, with no usage cap."
                : "All models, with a monthly token limit."}
            </p>
          )}
        </div>

        <DropdownMenuSeparator />

        {/* Account */}
        <MenuRow
          onSelect={() => window.dispatchEvent(new CustomEvent("juno:settings", { detail: "profile" }))}
          icon={<User className="size-4" />}
          label="Profile"
        />
        <MenuRow
          onSelect={() => window.dispatchEvent(new CustomEvent("juno:settings", { detail: "general" }))}
          icon={<AppIcons.settings className="size-4" />}
          label="Settings"
        />
        {features.isOwner && (
          <MenuRow
            href="/admin"
            icon={<ShieldCheck className="size-4" />}
            label="Admin Panel"
          />
        )}

        {/* Sign out — the one row that ends something, drawn the way every
            destructive row in the product is (`variant="destructive"`): red
            ink at rest and a red TINT under the pointer or the keyboard. It was
            the one row in the shell that filled solid red with white type on
            hover — louder than Delete, which cannot be undone, for an action
            that can. The glyph leaves through its own door on highlight
            (`LogOut`'s nudge), once. */}
        <DropdownMenuItem variant="destructive" onSelect={() => void signOutToSignIn()}>
          <LogOut className="size-4 shrink-0" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
