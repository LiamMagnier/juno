"use client";

import * as React from "react";
import { BotAvatar } from "bot-avatars";

import type { ClientAgent } from "@/lib/agents/types";
import { usePrefersReducedMotion } from "@/components/effects/use-effect-theme";
import { cn } from "@/lib/utils";

/**
 * The roster's one-line answer to "is anyone at work?", beside New agent
 * (Libraries.dev Bot avatars, premium brief).
 *
 * WHY A TEAM MARK AND NOT A BOT PER CARD. Each agent already has a face the
 * person chose (shape, tone, eyes, mark; `agent-face.tsx`), drawn the same way
 * on the Mac and the iPhone and held to one vocabulary by
 * `tests/agents-contract.test.ts`, and its eyes are already its status bar.
 * Swapping that for a stock bot would throw away the identity the person
 * picked and break the cross-platform face. The bot is the TEAM here: it
 * hops while any agent is working or thinking, stands idle otherwise, and
 * sits still (paused) when every agent is paused. The words beside it say the
 * same thing, so the canvas is decorative.
 *
 * `ghost`, the one near-neutral body among the free types: every other one
 * is a saturated hue (purple, sky, green, red, yellow), and this product has
 * one accent.
 *
 * The state is the roster's real state, aggregated: waiting beats working
 * beats ready, the order the roster itself sorts in.
 */
export function TeamStatus({ agents, className }: { agents: ClientAgent[]; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const waiting = agents.filter((a) => a.state === "waiting").length;
  const busy = agents.filter((a) => a.state === "working" || a.state === "thinking").length;
  const allPaused = agents.length > 0 && agents.every((a) => a.state === "sleeping");

  const label =
    waiting > 0
      ? `${waiting} ${waiting === 1 ? "needs" : "need"} you`
      : busy > 0
        ? `${busy} at work`
        : allPaused
          ? "All paused"
          : "All ready";

  return (
    <span
      role="status"
      // Plain text beside the bot, no pill: a status is words, not a badge.
      className={cn(
        "inline-flex h-8 items-center gap-2 text-ui text-muted-foreground",
        waiting > 0 && "text-foreground",
        className
      )}
    >
      {/* Room above for the hop: the canvas draws 1.5x its box and a hop
          leaves it, so nothing here clips. */}
      <BotAvatar
        type="ghost"
        state={busy > 0 ? "working" : "default"}
        size={32}
        paused={allPaused || reduced}
        aria-hidden="true"
      />
      <span className="tabular-nums">{label}</span>
    </span>
  );
}
