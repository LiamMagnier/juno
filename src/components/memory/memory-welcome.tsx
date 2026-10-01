"use client";

import * as React from "react";
import { MessagesSquare, Upload } from "@/components/ui/icons";
import { ComposerIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * An account with nothing remembered yet.
 *
 * It used to get the whole page anyway: a stats strip reading 0 and 0, an
 * empty summary card, an empty edits card, a toolbar over "No topics yet" and
 * the privacy strip. Six surfaces saying there was nothing, and none of them
 * saying how to get something. Now it is one panel in the place the summary
 * will take, with the three ways memory starts: tell Juno something, bring
 * what another assistant knows, or let Juno read the chats it has not read.
 *
 * "Tell Juno something" unfolds the same prompt bar the full page has, in the
 * same panel, so the first instruction and every later one look alike.
 */

interface MemoryWelcomeProps {
  paused: boolean;
  /** Unread chats Juno could learn from; the third action only exists when there are some. */
  unread: number | null;
  learning: boolean;
  onImport: () => void;
  onLearn: () => void;
  /** Open the prompt dock (children) and focus it. Also true while a proposal waits. */
  composing: boolean;
  onCompose: () => void;
  /** The prompt dock. */
  children: React.ReactNode;
}

export function MemoryWelcome({
  paused,
  unread,
  learning,
  onImport,
  onLearn,
  composing,
  onCompose,
  children,
}: MemoryWelcomeProps) {
  const unreadCount = unread ?? 0;
  return (
    <section aria-labelledby="memory-welcome-heading" className="surface-raised rounded-panel">
      <div className="flex flex-col items-center px-6 pb-7 pt-10 text-center">
        <span
          aria-hidden="true"
          className="grid size-12 place-items-center rounded-field border border-border bg-background text-muted-foreground"
        >
          <ComposerIcons.memory motion="none" className="size-6" />
        </span>
        <h2 id="memory-welcome-heading" className="mt-4 text-heading text-foreground">
          {`${PRODUCT_NAME} hasn’t remembered anything yet`}
        </h2>
        <p className="mt-1.5 max-w-md text-balance text-body text-muted-foreground">
          {`As you chat, ${PRODUCT_NAME} keeps the details worth carrying over, like your work, your preferences and how you like answers. You can also start it off yourself.`}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" onClick={onCompose} disabled={paused} aria-expanded={composing}>
            {`Tell ${PRODUCT_NAME} something`}
          </Button>
          <Button size="sm" variant="outline" onClick={onImport} disabled={paused} className="gap-1.5">
            <Upload className="size-3.5" aria-hidden="true" />
            Import from ChatGPT or Claude
          </Button>
          {unreadCount > 0 && (
            <Button size="sm" variant="outline" onClick={onLearn} disabled={paused} loading={learning} className="gap-1.5">
              <MessagesSquare className="size-3.5" aria-hidden="true" />
              {unreadCount === 1 ? (
                <span>Learn from 1 past chat</span>
              ) : (
                <>
                  <span>Learn from past chats</span>
                  <span className="tabular-nums text-muted-foreground">{unreadCount}</span>
                </>
              )}
            </Button>
          )}
        </div>
      </div>
      <Collapse open={composing} innerClassName="p-2 pt-0">
        {children}
      </Collapse>
    </section>
  );
}
