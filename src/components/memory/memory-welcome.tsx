"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { EmptyState } from "@/components/ui/empty-state";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * An account with nothing remembered yet: the page's empty state, in the
 * shape every app page's empty list takes (EmptyState, as Routines and
 * Skills draw it), carrying the page's primary action, so the header does
 * not repeat it.
 *
 * It offers the three ways memory starts, most direct first:
 *
 *   Tell Alevr something   one sentence, kept exactly as typed;
 *   Learn from past chats  read the chats already here, when there are some
 *                          unread (it used to hide in the header's menu,
 *                          where a new account never looks);
 *   Import                 bring over what ChatGPT or Claude knows.
 *
 * "Tell Alevr something" unfolds the same field the full page's Add memory
 * opens (`children`), in place, so the first memory and every later one are
 * added the same way. A change drafted in words and still waiting (rare on an
 * empty page) shows here too (`pending`), so it is never stranded.
 */

const TITLE = `${PRODUCT_NAME} hasn’t remembered anything yet`;
const DESCRIPTION = `As you chat, ${PRODUCT_NAME} keeps the details worth carrying over, like your work, your preferences and how you like answers. Each one shows up here, where you can correct it or forget it.`;

interface MemoryWelcomeProps {
  paused: boolean;
  /** Unread chats Alevr could learn from; the action only exists when there are some. */
  unread: number | null;
  learning: boolean;
  onImport: () => void;
  onLearn: () => void;
  /** The add field is open (children). */
  composing: boolean;
  onCompose: () => void;
  /** The add field. */
  children: React.ReactNode;
  /** A drafted change still waiting for a decision: the prompt dock, shown open. */
  pending?: React.ReactNode;
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
  pending,
}: MemoryWelcomeProps) {
  const unreadCount = unread ?? 0;
  return (
    <section aria-label="Get started with memory" data-memory-welcome="">
      <EmptyState
        title={TITLE}
        description={DESCRIPTION}
        className="pb-8"
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={onCompose} disabled={paused} aria-expanded={composing}>
              {`Tell ${PRODUCT_NAME} something`}
            </Button>
            {unreadCount > 0 && (
              <Button variant="outline" onClick={onLearn} disabled={paused} loading={learning}>
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
            <Button variant="outline" onClick={onImport} disabled={paused}>
              Import from ChatGPT or Claude
            </Button>
          </div>
        }
      />
      <Collapse open={composing && !paused} innerClassName="mx-auto max-w-xl pb-8">
        {children}
      </Collapse>
      {pending ? <div className="mx-auto max-w-xl pb-8">{pending}</div> : null}
    </section>
  );
}
