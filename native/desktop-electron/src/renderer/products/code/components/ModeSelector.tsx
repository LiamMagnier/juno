/**
 * Ask / Plan / Code.
 *
 * The mapping onto the host's `PermissionMode` union lives in `lib/modes.ts`,
 * together with the reading of `PermissionEngine.decide` it is derived from.
 * This component's job is to make the *current* policy unmistakable and to make
 * the consequences of switching legible before the switch happens.
 *
 * Three deliberate choices:
 *
 *  • The read-only guarantee is stated on the control itself, not hidden in a
 *    tooltip. In Plan the host refuses writes; that is a stronger promise than
 *    "you will be asked", and it should be visible at a glance.
 *  • Full access is an explicit checkbox inside Code, never a fourth segment.
 *    An escalation that can be reached by arrow-keying along a segmented
 *    control is an escalation that will be reached by accident.
 *  • The capability table is the same one the engine implements, rendered per
 *    risk class, so "what changes if I switch" is answerable without guessing.
 */

import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { cn } from '../lib/cn.js';
import type { PermissionMode } from '../lib/contract.js';
import {
  descriptorFor,
  fromPermissionMode,
  MODE_ORDER,
  MODES,
  permissionModeFor,
  type CapabilityState,
  type CodeMode,
} from '../lib/modes.js';
import { Badge, FOCUS_RING, Mono, Segmented } from './primitives.js';
import { CheckIcon, ChevronDown, CloseIcon, LockIcon, ShieldIcon } from './icons.js';

export interface ModeSelectorProps {
  /** The mode the host has confirmed. Null before `session_started`. */
  mode: PermissionMode | null;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
  disabledReason?: string;
}

function CapabilityGlyph({ state }: { state: CapabilityState }): JSX.Element {
  switch (state) {
    case 'allowed':
      return <CheckIcon className="h-3 w-3 text-foreground" />;
    case 'confirm':
      return <ShieldIcon className="h-3 w-3 text-primary" />;
    case 'blocked':
      return <CloseIcon className="h-3 w-3 text-muted-foreground" />;
  }
}

function capabilityWord(state: CapabilityState): string {
  switch (state) {
    case 'allowed':
      return 'runs';
    case 'confirm':
      return 'asks you';
    case 'blocked':
      return 'refused';
  }
}

export function ModeSelector({
  mode,
  onChange,
  disabled = false,
  disabledReason,
}: ModeSelectorProps): JSX.Element {
  const resolved = mode === null ? null : fromPermissionMode(mode);
  const active: CodeMode = resolved?.mode ?? 'ask';
  const fullAccess = resolved?.fullAccess ?? false;
  const descriptor = descriptorFor(active, fullAccess);

  const [open, setOpen] = useState(false);
  const panelId = useId();
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const options = MODE_ORDER.map((id) => ({
    value: id,
    label: MODES[id].label,
    description: MODES[id].headline,
    disabled,
    disabledReason,
  }));

  return (
    <div ref={container} className="relative flex items-center gap-1.5">
      <Segmented
        label="Permission mode"
        options={options}
        value={active}
        size="sm"
        onChange={(next) => onChange(permissionModeFor(next, next === 'code' ? fullAccess : false))}
      />

      {/* The guarantee, stated inline. */}
      {!descriptor.mutationPossible ? (
        <span
          className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5"
          title="The agent host denies writes in this mode."
        >
          <LockIcon className="h-3 w-3 text-muted-foreground" />
          <Mono className="uppercase tracking-wide text-muted-foreground">read-only</Mono>
        </span>
      ) : descriptor.runsCommandsUnattended ? (
        <Badge tone="danger">full access</Badge>
      ) : !descriptor.mutatesUnattended ? (
        <Mono className="text-muted-foreground">confirms every change</Mono>
      ) : (
        <Mono className="text-muted-foreground">edits apply · commands ask</Mono>
      )}

      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="What this mode allows"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground',
          'transition-colors duration-100 hover:bg-muted hover:text-foreground',
          FOCUS_RING,
        )}
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          id={panelId}
          role="region"
          aria-label={`${descriptor.label} permissions`}
          /* Opaque. A permissions panel read through a blur is a permissions
             panel nobody reads. */
          className="absolute left-0 top-full z-30 mt-1.5 w-[22rem] rounded-lg border border-border bg-card p-3"
        >
          <p className="text-[12.5px] font-medium text-foreground">{descriptor.label}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
            {descriptor.headline}
          </p>

          <ul className="mt-2.5 space-y-1 border-t border-border pt-2">
            {descriptor.capabilities.map((capability) => (
              <li key={capability.risk} className="flex items-center gap-2">
                <CapabilityGlyph state={capability.state} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                  {capability.label}
                </span>
                <Mono
                  className={cn(
                    capability.state === 'blocked' ? 'text-muted-foreground' : 'text-foreground',
                  )}
                >
                  {capabilityWord(capability.state)}
                </Mono>
              </li>
            ))}
          </ul>

          <div className="mt-2.5 border-t border-border pt-2">
            <label
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-muted',
                (active !== 'code' || disabled) && 'cursor-not-allowed opacity-50 hover:bg-transparent',
              )}
            >
              <input
                type="checkbox"
                checked={fullAccess}
                disabled={active !== 'code' || disabled}
                onChange={(event) => onChange(permissionModeFor('code', event.target.checked))}
                className={cn('mt-[3px] h-3 w-3 accent-primary', FOCUS_RING)}
              />
              <span>
                <span className="block text-[12px] text-foreground">
                  Full access — run commands without asking
                </span>
                <span className="block text-[11px] leading-snug text-muted-foreground">
                  {active === 'code'
                    ? 'Destructive commands are still confirmed: the host checks that class before the mode.'
                    : 'Available in Code only.'}
                </span>
              </span>
            </label>
          </div>

          <p className="mt-2 border-t border-border pt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            host mode · {permissionModeFor(active, fullAccess)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
