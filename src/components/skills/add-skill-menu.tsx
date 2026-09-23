"use client";

import * as React from "react";
import { ChevronDown, Plus } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GitHubMark } from "@/components/connections/connector-logos";
import { ActionIcons, AppIcons } from "@/lib/app-icons";

/**
 * The page's one way in: every route to a new skill behind a single button.
 *
 * Three doors, in the order they are easiest to walk through. Importing is
 * first because a skill is easier to get than to write (the format is the one
 * Claude and Codex read, and there are thousands on GitHub); writing is for
 * somebody who already has the instructions; and "Create with Juno" hands the
 * blank page to a conversation, which is the easiest way to write one you do
 * not have yet.
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
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onImport}>
          <GitHubMark className="size-4 shrink-0" />
          Import from GitHub…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onWrite}>
          <ActionIcons.edit aria-hidden="true" />
          Write a skill
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCreateWithJuno}>
          <AppIcons.conversation aria-hidden="true" />
          Create with Juno
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The first message of a conversation that writes a skill.
 *
 * Left open at the end on purpose: it lands in the composer as a draft, not as
 * a sent message, and the reader finishes the sentence with the job they have
 * in mind. A prompt that asked for "a skill" with nothing after it would get a
 * question back, which is a round trip the reader could have answered here.
 */
export const CREATE_SKILL_PROMPT =
  "Help me create a skill for Juno. Ask me anything you need, then write the SKILL.md with a name, a one-line description and step-by-step instructions. The job is: ";

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
