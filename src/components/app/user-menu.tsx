"use client";

import Link from "next/link";
import Image from "next/image";
import { signOut } from "next-auth/react";
import { Brain, Command, Keyboard, LogOut, Map as MapIcon, Megaphone, Settings, Sparkles, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/components/app/app-provider";
import { PLANS } from "@/lib/plans";
import { DotIdenticon, DotFillBar } from "@/components/signature/dot-matrix";

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const { user, quota, features } = useApp();
  const plan = PLANS[quota.plan];

  const avatar = user.image ? (
    <Image src={user.image} alt="" width={32} height={32} className="h-full w-full rounded-md object-cover" />
  ) : (
    <DotIdenticon seed={user.id} className="h-8 w-8" />
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-[10px] transition-colors hover:bg-sidebar-accent"
            aria-label="Account menu"
            title={user.name ?? user.email ?? "Account"}
          >
            <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-md">{avatar}</span>
          </button>
        ) : (
          <button className="flex w-full items-center gap-2 rounded-[16px] p-2 text-left transition-colors hover:bg-sidebar-accent">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md">{avatar}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{user.name ?? user.email}</span>
              <span className="block truncate text-xs text-muted-foreground">{plan.name} plan</span>
            </span>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-60 font-[system-ui,sans-serif] p-1">
        <div className="px-3 py-3 border-b border-border/40">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-foreground leading-none">
              {user.name ?? user.email?.split("@")[0]}
            </span>
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary uppercase tracking-wide">
              {plan.name}
            </span>
          </div>
          <span className="block mt-1.5 truncate text-xs text-muted-foreground font-normal leading-none">
            {user.email}
          </span>
        </div>
        <div className="mx-1.5 my-1.5 rounded-lg bg-muted/40 p-2.5">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            <span>Messages</span>
            <span className="font-semibold text-foreground">
              {quota.limit == null ? "Unlimited" : `${quota.used} / ${quota.limit}`}
            </span>
          </div>
          {quota.limit != null ? (
            <div className="mt-2">
              <DotFillBar value={quota.used} max={quota.limit} dots={18} />
            </div>
          ) : (
            <p className="mt-1.5 text-[10px] text-muted-foreground/75 font-normal normal-case">
              Enjoy unlimited messages on this plan.
            </p>
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/profile" className="flex w-full items-center gap-2">
            <User className="h-4 w-4" />
            <span>Profile</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings" className="flex w-full items-center gap-2">
            <Settings className="h-4 w-4" />
            <span>Settings</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/memory" className="flex w-full items-center gap-2">
            <Brain className="h-4 w-4" />
            <span>Memory</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/roadmap" className="flex w-full items-center gap-2">
            <MapIcon className="h-4 w-4" />
            <span>Roadmap & requests</span>
          </Link>
        </DropdownMenuItem>
        {features.isOwner && (
          <DropdownMenuItem asChild>
            <Link href="/admin/announcements" className="flex w-full items-center gap-2">
              <Megaphone className="h-4 w-4" />
              <span>Announcements</span>
            </Link>
          </DropdownMenuItem>
        )}
        {features.billing && quota.plan !== "MAX" && (
          <DropdownMenuItem asChild>
            <Link href="/upgrade" className="flex w-full items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <span>Upgrade plan</span>
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent("juno:command-palette"))}>
          <Command className="h-4 w-4" />
          <span className="flex-1">Command palette</span>
          <span className="font-mono text-[10px] text-muted-foreground">⌘K</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent("juno:shortcuts"))}>
          <Keyboard className="h-4 w-4" />
          <span className="flex-1">Keyboard shortcuts</span>
          <span className="font-mono text-[10px] text-muted-foreground">⌘/</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOut({ callbackUrl: "/sign-in" })}>
          <LogOut className="h-4 w-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
