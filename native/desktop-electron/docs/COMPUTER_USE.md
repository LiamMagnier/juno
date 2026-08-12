# Computer Use

**Status: not implemented.** No screen capture, no input synthesis, no
coordinator, no UI. Nothing in this workspace requests Screen Recording or
Accessibility, and no code path can.

This document exists anyway, because the design constraints are the hard part
and they were established during research. Writing them down now is what stops
the feature being built badly later, under time pressure, by someone who has to
rediscover them.

---

## The finding that should shape the whole feature

**Computer Use is not defended by the rest of this architecture.**

Every other agent capability is constrained by something structural. Filesystem
access is bounded by canonical-path containment. Shell commands go through a
classifier and a permission engine. Subagents write only inside their own git
worktree, enforced by the tool layer. The agent host is a separate process with
a scrubbed environment.

None of that constrains what the user's own applications do when an agent types
into them. A synthesized keystroke into Mail is not a tool call; it does not
pass through the permission engine, and no containment check applies to it. The
real boundaries are exactly three: **macOS TCC, explicit session consent, and
the kill switch.**

The sharpest consequence, and the one that must be solved before anything ships:

> If synthesized input can click Juno's own approval dialogs, the permission
> model contains a cycle.

An agent that can approve its own approvals has no permission model. Making
Juno's consent surfaces unspoofable by synthetic input is a **prerequisite**,
not a refinement. Approaches worth evaluating when the time comes: refusing to
inject while a Juno consent surface has focus; requiring the decision to arrive
over IPC from a real user gesture rather than from a click that could have been
synthesized; and treating any pointer or key event whose provenance cannot be
established as untrusted.

---

## What macOS actually gives you

Verified during research, and worth stating because it is commonly got wrong:

- **Screen Recording and Accessibility are TCC permissions granted at runtime.
  They have no entitlement and no `Info.plist` key.** `NSScreenCaptureUsageDescription`,
  `NSAccessibilityUsageDescription` and `com.apple.security.accessibility` do
  **not exist** — this was checked against Apple's documentation, with controls.
  Adding a fabricated key would imply a control that is not there, which is
  worse than omitting it. `build/entitlements.mac.plist` carries a comment
  saying so, so their absence reads as deliberate rather than as an oversight.
- `NSMicrophoneUsageDescription` **does** exist and is real; it is present for
  voice dictation.
- macOS 26 re-prompts for screen capture periodically. Any design that assumes a
  grant is permanent will break in production, on a schedule.
- A denied or revoked grant must be distinguishable from "capture returned an
  empty frame". The Swift track already hit the failure where `screencapture`
  silently returned black; capture state must be read from the system, never
  modelled as an app-level boolean.

---

## Non-negotiables for any future implementation

Recorded from the brief and from the threat modelling, in priority order:

1. **Off by default.** Consent is explicit, per session, and revocable.
2. **A permanent, visible indicator while control is active** — not a toast, not
   a status line that scrolls away.
3. **An emergency stop that is always reachable**, plus a global keyboard
   shortcut. Stopping must terminate pending actions immediately, not after the
   current one finishes.
4. **An activation-generation counter**, re-checked at every suspension point
   before input is injected. The Swift `ComputerUseCoordinator` does exactly
   this and is the reference: without it, an action authorised before a stop can
   still land after it.
5. **Rate limiting and a local audit journal.** Every action recorded, with
   redaction.
6. **High-risk actions confirmed individually**, and the affected window visible
   where possible.
7. **Screenshots never leave the machine** unless the user has explicitly
   enabled a workflow that requires it. Not "unless configured" — explicitly
   enabled, with the destination named.
8. **Hostile-input assumptions throughout.** Screen contents are untrusted data.
   Text on screen that looks like an instruction is not an instruction, and the
   coordinator must not be built in a way that makes that distinction the
   model's responsibility.

---

## Where it would live

The coordinator belongs in **`runner/agent-core`**, beside the rest of the
runtime, so the policy is shared rather than reimplemented per client — the same
argument as [ADR-0002](adr/0002-agent-host.md). The macOS driver
(ScreenCaptureKit, CGEvent) is necessarily platform code and would live in main,
behind a narrow interface the coordinator calls.

The capability manifest in `src/providers/capabilities.ts` already models this
correctly: `computerUse` is marked **`unavailable`**, and the type distinguishes
that from *host-provided*. **No agent vendor exposes computer use through any
protocol** — not ACP, not any CLI. If Juno ships it, Juno owns all of it.

---

## Deterministic tests to write first

The policy is testable without a single TCC grant, and should be tested before
any driver exists:

- the generation counter invalidates an in-flight action after a stop;
- deny and revoke both fail closed;
- rate limits hold under burst;
- the audit journal records every attempted action, including refused ones;
- redaction removes credential-shaped strings before anything is journaled;
- a consent surface having focus blocks injection.

What genuinely cannot be tested here, and needs a human at a Mac: capture
returning real pixels, input actually landing in another application, the
permission-denial path, and macOS 26's re-authorisation prompt. Those belong in
a manual pre-release checklist — see [RELEASE.md](RELEASE.md).
