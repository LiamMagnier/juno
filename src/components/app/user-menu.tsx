"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { requiresViewerCredentials } from "@/lib/image-source";
import { signOutToSignIn } from "@/lib/sign-out";
import { LogOut, ShieldCheck, User } from "lucide-react";
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
import { Pressable } from "@/components/ui/pressable";

/*
 * Account menu — one shared row anatomy so every item lines up:
 * [16px icon] · gap-2.5 · label · (right-aligned mono shortcut).
 * Rows inherit DropdownMenuItem's rounded-xs (6px), which is concentric with the
 * menu shell: rounded-menu is 12px and the content insets by p-1.5 (6px), so
 * 12 − 6 = 6. They used to override that with rounded-md on the arithmetic
 * "14px shell − 6px inset = 8px" — the same wrong sum dropdown-menu.tsx already
 * unpicked, since the shell is 12px and not 14. It mattered from the moment
 * cn() learned the radius ladder: before that the override was silently
 * discarded, and after it the account menu's rows started drawing 2px rounder
 * than every other menu in the product. Icons carry the sidebar's hover
 * micro-motion (scale, transform only) keyed off Radix's data-highlighted, so
 * keyboard navigation gets the same life as the pointer.
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
  const rowCls = "group h-9 gap-2.5 px-2.5";
  const iconCls = cn(
    "flex size-4 shrink-0 items-center justify-center transition-transform duration-fast ease-out-soft group-data-[highlighted]:scale-110",
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
      <DropdownMenuItem asChild className={rowCls}>
        <Link href={href} className="flex w-full items-center gap-2.5">
          {inner}
        </Link>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem className={rowCls} onSelect={onSelect}>
      {inner}
    </DropdownMenuItem>
  );
}

export function UserMenu({
  compact = false,
  trigger,
}: {
  compact?: boolean;
  /** A caller-drawn trigger (the sidebar footer's avatar + plan meter row). */
  trigger?: React.ReactNode;
}) {
  const { user, quota, features } = useApp();
  const plan = PLANS[quota.plan];

  // Photo avatars are circles (matching the Avatar primitive app-wide); the
  // DotIdenticon fallback keeps its signature squircle, which a circular crop
  // would clip.
  const avatar = (size: string) =>
    user.image ? (
      <Image src={user.image} unoptimized={requiresViewerCredentials(user.image)} alt="" width={36} height={36} className={cn("shrink-0 rounded-full object-cover", size)} />
    ) : (
      <DotIdenticon seed={user.id} className={cn("shrink-0", size)} />
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ? (
          trigger
        ) : compact ? (
          <Pressable
            kind="icon"
            size="lg"
            // The collapsed rail: a 44px target like every other icon on it.
            className="group size-11 hover:bg-sidebar-accent"
            aria-label="Account menu"
            title={user.name ?? user.email ?? "Account"}
          >
            <span className="transition-transform duration-fast ease-out-soft group-hover:scale-105">{avatar("size-8")}</span>
          </Pressable>
        ) : (
          <Pressable kind="row" className="group gap-2.5 p-2 hover:bg-sidebar-accent">
            <span className="shrink-0 transition-transform duration-fast ease-out-soft group-hover:scale-105">
              {avatar("size-8")}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{user.name ?? user.email}</span>
              <span className="block truncate text-xs text-muted-foreground">{plan.name} plan</span>
            </span>
          </Pressable>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-72">
        {/* Identity header — who you are, on what plan, reachable where. */}
        <div className="flex items-center gap-3 px-2.5 pb-3 pt-2.5">
          {avatar("size-9")}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {user.name ?? user.email?.split("@")[0]}
              </span>
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-caption font-medium leading-none text-primary-ink">
                {plan.name}
              </span>
            </div>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{user.email}</span>
          </div>
        </div>

        {/* Usage — a calm read of the same quota data, in the dot signature.
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

        {/* Sign out — the one destructive row: quiet red at rest, full red fill
            with white text/icon on hover (150ms), the icon easing toward the
            door as it goes. */}
        <DropdownMenuItem
          onSelect={() => void signOutToSignIn()}
          className="group h-9 gap-2.5 px-2.5 text-destructive transition-colors duration-fast ease-out-soft focus:bg-destructive focus:text-destructive-foreground data-[highlighted]:bg-destructive data-[highlighted]:text-destructive-foreground"
        >
          <LogOut className="size-4 shrink-0 transition-transform duration-fast ease-out-soft group-data-[highlighted]:translate-x-0.5" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
