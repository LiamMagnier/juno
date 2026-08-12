/**
 * The Chat · Work switch.
 *
 * ── The integration contract ────────────────────────────────────────────────
 * THE SHELL OWNS THE SWITCH. `shell-state.tsx` already holds `chatSurface`,
 * persists it, announces changes, and routes the `surface.chat` / `surface.work`
 * menu commands from main into it. None of that belongs to a product surface,
 * and duplicating any of it here would produce two sources of truth for where
 * the user is.
 *
 * So this component is deliberately CONTROLLED and stateless. It takes the
 * current surface and a setter and renders the control; the shell wires it to
 * `useShell()`:
 *
 *     const shell = useShell();
 *     <ChatWorkSwitch surface={shell.chatSurface} onSurfaceChange={shell.setChatSurface} />
 *
 * It is exported from `products/chat` rather than the shell because the two
 * options are two halves of one product and the visual treatment belongs with
 * them — but nothing here reaches into shell state, so it can equally be
 * dropped into a toolbar the shell composes itself. `<ChatProduct>` also takes
 * a `surfaceControl` slot, which is the other half of the same seam: the shell
 * passes its own rendered control down and Chat simply places it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { ReactNode } from 'react';
import { ConversationIcon, ModelIcon } from './icons.js';
import { SegmentedControl } from './primitives.js';

/** Mirrors `CHAT_SURFACES` in `state/shell-state.tsx`, without importing it. */
export const CHAT_SURFACES = ['chat', 'work'] as const;
export type ChatSurface = (typeof CHAT_SURFACES)[number];

export interface ChatWorkSwitchProps {
  readonly surface: ChatSurface;
  readonly onSurfaceChange: (surface: ChatSurface) => void;
  /**
   * Set when Work cannot be entered — no signed-in account, no workspace, a
   * feature flag. The option stays visible and disabled with this as its title,
   * because hiding it makes the product look like it has one surface.
   */
  readonly workDisabledReason?: string | undefined;
  readonly className?: string | undefined;
}

export function ChatWorkSwitch({
  surface,
  onSurfaceChange,
  workDisabledReason,
  className,
}: ChatWorkSwitchProps): ReactNode {
  return (
    <SegmentedControl<ChatSurface>
      value={surface}
      onChange={onSurfaceChange}
      ariaLabel="Surface"
      className={className}
      options={[
        { value: 'chat', label: 'Chat', icon: <ConversationIcon className="size-3.5" /> },
        {
          value: 'work',
          label: 'Work',
          icon: <ModelIcon className="size-3.5" />,
          disabledReason: workDisabledReason,
        },
      ]}
    />
  );
}
