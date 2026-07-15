"use client";

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

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const { user, quota, features } = useApp();
  const plan = PLANS[quota.plan];

  // Photo avatars are circles (matching the Avatar primitive app-wide); the
  // DotIdenticon fallback keeps its signature squircle, which a circular crop
  // would clip.
  const avatar = user.image ? (
    <Image src={user.image} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-full object-cover" />
  ) : (
    <DotIdenticon seed={user.id} className="h-8 w-8 shrink-0" />
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            className="pressable flex h-9 w-9 items-center justify-center rounded-md hover:bg-sidebar-accent coarse:h-11 coarse:w-11"
            aria-label="Account menu"
            title={user.name ?? user.email ?? "Account"}
          >
            {avatar}
          </button>
        ) : (
          <button className="pressable flex w-full items-center gap-2.5 rounded-md p-2 text-left hover:bg-sidebar-accent">
            {avatar}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{user.name ?? user.email}</span>
              <span className="block truncate text-xs text-muted-foreground">{plan.name} plan</span>
            </span>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-64">
        <div className="flex items-center gap-2.5 px-2 pb-2.5 pt-2">
          {avatar}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {user.name ?? user.email?.split("@")[0]}
              </span>
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.14em] text-primary">
                {plan.name}
              </span>
            </div>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{user.email}</span>
          </div>
        </div>
        <div className="rounded-[10px] bg-muted/40 px-2 py-2">
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
        <DropdownMenuItem asChild className="h-9">
          <Link href="/profile" className="flex w-full items-center gap-2">
            <User className="h-4 w-4 opacity-70" />
            <span>Profile</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="h-9">
          <Link href="/settings" className="flex w-full items-center gap-2">
            <Settings className="h-4 w-4 opacity-70" />
            <span>Settings</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="h-9">
          <Link href="/memory" className="flex w-full items-center gap-2">
            <NotebookPen className="h-4 w-4 opacity-70" />
            <span>Memory</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="h-9">
          <Link href="/roadmap" className="flex w-full items-center gap-2">
            <MapIcon className="h-4 w-4 opacity-70" />
            <span>Roadmap & requests</span>
          </Link>
        </DropdownMenuItem>
        {features.isOwner && (
          <DropdownMenuItem asChild className="h-9">
            <Link href="/admin/users" className="flex w-full items-center gap-2">
              <Shield className="h-4 w-4 opacity-70" />
              <span>Admin</span>
            </Link>
          </DropdownMenuItem>
        )}
        {features.billing && planRank(quota.plan) < planRank("MAX20") && (
          <DropdownMenuItem asChild className="h-9">
            <Link href="/upgrade" className="flex w-full items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <span>Upgrade plan</span>
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="h-9"
          onSelect={() => window.dispatchEvent(new CustomEvent("juno:command-palette"))}
        >
          <Command className="h-4 w-4 opacity-70" />
          <span className="flex-1">Command palette</span>
          <span className="font-mono text-[11px] tracking-wide text-muted-foreground">⌘K</span>
        </DropdownMenuItem>
        <DropdownMenuItem className="h-9" onSelect={() => window.dispatchEvent(new CustomEvent("juno:shortcuts"))}>
          <Keyboard className="h-4 w-4 opacity-70" />
          <span className="flex-1">Keyboard shortcuts</span>
          <span className="font-mono text-[11px] tracking-wide text-muted-foreground">⌘/</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="h-9 text-destructive focus:text-destructive"
          onSelect={() => void signOutToSignIn()}
        >
          <LogOut className="h-4 w-4 opacity-70" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
