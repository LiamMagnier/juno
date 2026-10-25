"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, GraduationCap, Plus } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GitHubMark } from "@/components/connections/connector-logos";
import { ActionIcons } from "@/lib/app-icons";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The page's one way in: every route to a new skill behind a single button.
 *
 * Teaching is first because it is the easiest: show Juno the task once and
 * review the draft (`/skills/teach`). Writing is the skill's own home at
 * `/skills/new`; importing is for the format Claude and Codex already read
 * (there are thousands on GitHub). `onCreateWithJuno` keeps its name for the
 * callers that pass it; it opens Teach.
 */
export function AddSkillMenu({
  onImport,
  onWrite,
  onCreateWithJuno,
}: {
  onImport: () => void;
  onWrite: () => void;
  onCreateWithJuno: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="gap-1.5 pr-2.5">
          <Plus className="size-4" aria-hidden="true" />
          Add
          <ChevronDown className="size-3.5 opacity-80" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={onCreateWithJuno}>
          <GraduationCap aria-hidden="true" />
          {`Teach ${PRODUCT_NAME}…`}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onWrite}>
          <ActionIcons.edit aria-hidden="true" />
          Write a skill
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onImport}>
          <GitHubMark className="size-4 shrink-0" />
          Import from GitHub…
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/skills/new?import=file">Import SKILL.md…</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The first message of a conversation that teaches a skill.
 *
 * Left open at the end on purpose: it lands in the composer as a draft, not as
 * a sent message, and the reader finishes the sentence with the job they have
 * in mind. "Teach you" is what switches on the chat's `draft_skill` tool
 * (`detectTeachIntent`), so the conversation ends in a reviewable draft card
 * rather than a SKILL.md to copy by hand.
 */
export const CREATE_SKILL_PROMPT =
  `I want to teach you how I do something, so you can save it as a skill for me to review. Ask me one question at a time until you know the steps, then draft it. The task is: `;

/** The composer's field, by its fixed id (see CHAT_COMPOSER_FIELD_ID in composer.tsx). */
const COMPOSER_FIELD_ID = "juno-composer-textarea";

/**
 * Opens a fresh chat and seeds its composer with `CREATE_SKILL_PROMPT`.
 *
 * Through the composer's own `juno:composer-seed` event, the mechanism the
 * empty state's suggestion chips use, rather than `/chat?q=`, which SENDS: the
 * reader still has the job to describe. The event only reaches a composer that
 * is mounted, and this runs from a page that has none, so it waits for the
 * field to exist after the navigation (a few frames, or up to a few seconds on
 * a cold chat bundle) and gives up quietly after that rather than seeding a
 * composer the reader has already moved away from.
 */
export function openSkillDraftingChat(navigate: (href: string) => void): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("juno:new-chat"));
  navigate("/chat");
  const started = Date.now();
  const seed = () => {
    if (document.getElementById(COMPOSER_FIELD_ID)) {
      // One more frame so the new-chat reset has run before the draft lands.
      window.requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent("juno:composer-seed", { detail: CREATE_SKILL_PROMPT }))
      );
      return;
    }
    if (Date.now() - started < 6000) window.setTimeout(seed, 80);
  };
  window.setTimeout(seed, 80);
}
