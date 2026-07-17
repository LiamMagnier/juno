"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { signOutToSignIn } from "@/lib/sign-out";
import { NotebookPen, Command, Keyboard, LogOut, Map as MapIcon, Settings, Shield, Sparkles, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/components/app/app-provider";
import { PLANS, planRank } from "@/lib/plans";
import { DotIdenticon, DotFillBar } from "@/components/signature/dot-matrix";
import { cn } from "@/lib/utils";

/*
 * Account menu — one shared row anatomy so every item lines up:
 * [16px icon] · gap-2.5 · label · (right-aligned mono shortcut).
 * Rows are rounded-md (8px), concentric with the popover's 14px shell at its
 * 6px inset. Icons carry the sidebar's hover micro-motion (scale, transform
 * only) keyed off Radix's data-highlighted, so keyboard navigation gets the
 * same life as the pointer.
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
  const rowCls = "group h-9 gap-2.5 rounded-md px-2.5";
  const iconCls = cn(
    "flex h-4 w-4 shrink-0 items-center justify-center transition-transform duration-150 ease-out-soft group-data-[highlighted]:scale-110",
    accent ? "text-primary" : "text-muted-foreground"
  );
  const inner = (
    <>
      <span className={iconCls}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && (
        <span className="shrink-0 font-mono text-caption tracking-wide text-muted-foreground/70">{shortcut}</span>
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

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const { user, quota, features } = useApp();
  const plan = PLANS[quota.plan];

  // Photo avatars are circles (matching the Avatar primitive app-wide); the
  // DotIdenticon fallback keeps its signature squircle, which a circular crop
  // would clip.
  const avatar = (size: string) =>
    user.image ? (
      <Image src={user.image} alt="" width={36} height={36} className={cn("shrink-0 rounded-full object-cover", size)} />
    ) : (
      <DotIdenticon seed={user.id} className={cn("shrink-0", size)} />
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            className="pressable group flex h-9 w-9 items-center justify-center rounded-md hover:bg-sidebar-accent coarse:h-11 coarse:w-11"
            aria-label="Account menu"
            title={user.name ?? user.email ?? "Account"}
          >
            <span className="transition-transform duration-fast ease-out-soft group-hover:scale-105">{avatar("h-8 w-8")}</span>
          </button>
        ) : (
          <button className="pressable group flex w-full items-center gap-2.5 rounded-md p-2 text-left hover:bg-sidebar-accent">
            <span className="shrink-0 transition-transform duration-fast ease-out-soft group-hover:scale-105">
              {avatar("h-8 w-8")}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{user.name ?? user.email}</span>
              <span className="block truncate text-xs text-muted-foreground">{plan.name} plan</span>
            </span>
          </button>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-72">
        {/* Identity header — who you are, on what plan, reachable where. */}
        <div className="flex items-center gap-3 px-2.5 pb-3 pt-2.5">
          {avatar("h-9 w-9")}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {user.name ?? user.email?.split("@")[0]}
              </span>
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.14em] text-primary">
                {plan.name}
              </span>
            </div>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{user.email}</span>
          </div>
        </div>

        {/* Usage — a calm read of the same quota data, in the dot signature. */}
        <div className="mx-1 rounded-[10px] bg-muted/40 px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Messages</span>
            <span className="truncate font-mono text-[11px] tracking-wide text-foreground">
              {quota.limit == null ? "No cap" : `${quota.used} / ${quota.limit}`}
            </span>
          </div>
          {quota.limit != null ? (
            <DotFillBar value={quota.used} max={quota.limit} dots={18} className="mt-2" />
          ) : (
            <>
              <DotFillBar value={1} max={1} dots={18} className="mt-2 opacity-40" />
              <p className="mt-1.5 text-caption text-muted-foreground/75">All models, with a monthly token limit.</p>
            </>
          )}
        </div>

        <DropdownMenuSeparator />

        {/* Account */}
        <MenuRow href="/profile" icon={<User className="h-4 w-4" />} label="Profile" />
        <MenuRow href="/settings" icon={<Settings className="h-4 w-4" />} label="Settings" />
        <MenuRow href="/memory" icon={<NotebookPen className="h-4 w-4" />} label="Memory" />
        <MenuRow href="/roadmap" icon={<MapIcon className="h-4 w-4" />} label="Roadmap & requests" />
        {features.isOwner && <MenuRow href="/admin/users" icon={<Shield className="h-4 w-4" />} label="Admin" />}
        {features.billing && planRank(quota.plan) < planRank("MAX20") && (
          <MenuRow href="/upgrade" icon={<Sparkles className="h-4 w-4" />} label="Upgrade plan" accent />
        )}

        <DropdownMenuSeparator />

        {/* Keyboard */}
        <MenuRow
          onSelect={() => window.dispatchEvent(new CustomEvent("juno:command-palette"))}
          icon={<Command className="h-4 w-4" />}
          label="Command palette"
          shortcut="⌘K"
        />
        <MenuRow
          onSelect={() => window.dispatchEvent(new CustomEvent("juno:shortcuts"))}
          icon={<Keyboard className="h-4 w-4" />}
          label="Keyboard shortcuts"
          shortcut="⌘/"
        />

        <DropdownMenuSeparator />

        {/* Sign out — the one destructive row: quiet red at rest, full red fill
            with white text/icon on hover (150ms), the icon easing toward the
            door as it goes. */}
        <DropdownMenuItem
          onSelect={() => void signOutToSignIn()}
          className="group h-9 gap-2.5 rounded-md px-2.5 text-destructive transition-colors duration-150 ease-out-soft focus:bg-destructive focus:text-destructive-foreground data-[highlighted]:bg-destructive data-[highlighted]:text-destructive-foreground"
        >
          <LogOut className="h-4 w-4 shrink-0 transition-transform duration-150 ease-out-soft group-data-[highlighted]:translate-x-0.5" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
