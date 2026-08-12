/**
 * Screen-reader announcements.
 *
 * A desktop shell changes state for reasons the user did not just click: the
 * agent host crashes, the session is signed out from another device, a menu
 * command arrives from main. Sighted users get those from a status bar they can
 * glance at. Everyone else gets them from here or not at all.
 *
 * Two regions, not one. `polite` waits for a gap in speech and is right for
 * almost everything; `assertive` interrupts and is reserved for state the user
 * would otherwise act on wrongly — being signed out, losing the agent host.
 * Interrupting for a sidebar toggle is how users learn to turn a live region off.
 *
 * The regions are always mounted and only their text changes. A live region
 * that is inserted at the same moment as its content is frequently missed:
 * assistive technology has to observe the region *before* the mutation for the
 * mutation to be announced.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type AnnouncementPriority = 'polite' | 'assertive';

interface AnnouncerApi {
  announce: (message: string, priority?: AnnouncementPriority) => void;
}

const AnnouncerContext = createContext<AnnouncerApi | null>(null);

export function AnnouncerProvider({ children }: { children: ReactNode }): ReactNode {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  /* Identical consecutive text is not re-announced, because the DOM did not
     change. Alternating an invisible non-breaking space makes the mutation real
     without changing what is spoken — "Host stopped" twice in a row is a thing
     that genuinely happens and genuinely matters. */
  const parity = useRef(0);

  const announce = useCallback((message: string, priority: AnnouncementPriority = 'polite') => {
    const trimmed = message.trim();
    if (trimmed.length === 0) return;
    parity.current += 1;
    const text = parity.current % 2 === 0 ? `${trimmed}\u00A0` : trimmed;
    if (priority === 'assertive') setAssertive(text);
    else setPolite(text);
  }, []);

  const api = useMemo<AnnouncerApi>(() => ({ announce }), [announce]);

  return (
    <AnnouncerContext.Provider value={api}>
      {children}
      <div className="sr-only" aria-live="polite" aria-atomic="true" role="status">
        {polite}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true" role="alert">
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
}

/**
 * Returns a stable `announce`. Safe to call outside the provider — it degrades
 * to a no-op rather than throwing, because an announcement is never the point
 * of the code path it sits in and should not be able to take that path down.
 */
export function useAnnounce(): (message: string, priority?: AnnouncementPriority) => void {
  const context = useContext(AnnouncerContext);
  const fallback = useCallback(() => {
    /* no announcer mounted */
  }, []);
  return context?.announce ?? fallback;
}
