/**
 * The main column.
 *
 * It is a single `tabpanel` for the whole shell rather than one per surface,
 * because both segmented controls point at it: switching product mode or
 * surface replaces what is in here, and giving each combination its own panel
 * id would mean `aria-controls` targets that do not exist most of the time.
 *
 * Chat and Work have no channels in this IPC contract. They are drawn as what
 * they are — a real surface with a real composer that is switched off and says
 * why — rather than as a mock conversation. A fake transcript is the fastest
 * way to lose the ability to tell whether the app is working.
 */

import type { ReactNode } from 'react';
import { useShell } from '../state/shell-state.js';
import { CodePane } from './CodePane.js';
import { Composer } from './Composer.js';
import { Button } from './primitives/Button.js';
import { EmptyState, Meta, SectionLabel, StatusDot } from './primitives/atoms.js';
import { ChatIcon, WorkIcon } from './icons.js';

const CHAT_UNAVAILABLE = 'Chat runs through the Juno backend, which this desktop build does not call yet.';
const WORK_UNAVAILABLE = 'Work runs through the Juno backend, which this desktop build does not call yet.';

export function MainPane(): ReactNode {
  const { productMode, chatSurface } = useShell();
  const title = productMode === 'code' ? 'Code' : chatSurface === 'work' ? 'Work' : 'Chat';

  return (
    <section
      id="juno-main-pane"
      role="tabpanel"
      aria-label={`${title} workspace`}
      /* Programmatically focusable only. The panel itself does not scroll — its
         children do, and Chromium makes a scroll container that contains no
         focusable element keyboard-reachable on its own. A `tabIndex={0}` here
         would add a tab stop that lands on nothing. */
      tabIndex={-1}
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background outline-none"
    >
      {productMode === 'code' ? <CodePane /> : chatSurface === 'work' ? <WorkPane /> : <ChatPane />}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function ChatPane(): ReactNode {
  return (
    <>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6">
        <div className="max-w-prose py-16">
          <span className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-field border border-border bg-card text-muted-foreground">
            <ChatIcon className="h-4 w-4" />
          </span>
          {/* Serif is reserved for the expressive register: greetings, headings,
              assistant prose. Everything structural stays in the sans face. */}
          <h1 className="font-serif text-title text-foreground">Start a conversation</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Chat is where you think out loud with Juno. Conversations sync with your account, so the one you
            start on the web is the one you continue here.
          </p>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            This build ships the desktop shell. The conversation service is not connected, so the composer
            below is switched off rather than pretending to send.
          </p>
        </div>
      </div>

      <Composer
        label="Message Juno"
        placeholder="Message Juno…"
        disabledReason={CHAT_UNAVAILABLE}
        onSubmit={() => undefined}
      />
    </>
  );
}

function WorkPane(): ReactNode {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <header className="border-b border-border px-6 py-5">
          <div className="flex items-center gap-2">
            <WorkIcon className="h-4 w-4 text-muted-foreground" />
            <h1 className="font-serif text-heading text-foreground">Work</h1>
          </div>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">
            Longer pieces of work Juno carries out on your behalf, with a record of what it did and what it
            changed.
          </p>
        </header>

        <div className="px-4 py-4">
          <div className="flex items-center justify-between gap-2 pr-2">
            <SectionLabel className="px-2">Active</SectionLabel>
            <span className="flex items-center gap-1.5">
              <StatusDot tone="idle" />
              <Meta>Nothing running</Meta>
            </span>
          </div>
          <EmptyState
            className="px-2"
            title="No active work"
            description="When a run is going, its steps, approvals and file changes appear here as they happen."
            action={
              <Button size="sm" variant="secondary" disabledReason={WORK_UNAVAILABLE}>
                New run
              </Button>
            }
          />
        </div>
      </div>

      <Composer
        label="Describe a piece of work"
        placeholder="Describe what you want done…"
        disabledReason={WORK_UNAVAILABLE}
        onSubmit={() => undefined}
      />
    </>
  );
}
