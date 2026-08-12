# ADR-0001 — Juno Desktop is an isolated npm workspace

**Status:** Accepted · 2026-08-12

## Context

The brief (§5) says to respect the existing repository tooling "unless there is
a documented reason for an isolated desktop workspace to differ", and explicitly
warns against converting the whole repository to another package manager.

The Juno repository root is a Next.js 15 app with its own `package.json`,
`package-lock.json` (472 KB), and no `workspaces` field. Its dependency set —
Next, Prisma, Stripe, the AWS SDK — has essentially nothing in common with an
Electron app's.

At the time of writing, the working tree also has **sixty-plus modified files
and staged changes**, including to `prisma/schema.prisma`.

## Decision

`native/desktop-electron` is a **self-contained npm project** with its own
`package.json` and lockfile. It is **not** added to a root `workspaces` array.

It reaches into the repository in exactly two read-only ways:

- TypeScript path aliases to `runner/agent-core` (source of truth for the agent
  protocol — see ADR-0002).
- The token generator reads the web design system (see ADR-0003).

## Consequences

**Good**

- Installing desktop dependencies cannot touch the root lockfile. Given the
  state of the working tree, a root-lockfile change would be very hard to
  review and easy to commit by accident.
- Electron's native-module and ABI concerns stay contained.
- The desktop app can pin Tailwind 3.4 / framer-motion 12 to match the web
  design authority (see ADR-0003) without constraining the root.

**Bad**

- No dependency deduplication with the root. Accepted: the overlap is near zero.
- Two `npm install` invocations. Documented in the README.
- Shared TypeScript across the boundary is consumed as **source** via path
  aliases, not as a built package. This works because the files consumed
  (`runner/agent-core/src/types.ts`) are leaf modules with no imports. If that
  stops being true, this becomes a `file:` dependency plus a build step.

**Neutral**

- Root CI is unaffected; desktop CI is a separate job with its own working
  directory.

## Alternatives rejected

- **Root npm workspace.** Cleanest dependency story, but mutates the root
  lockfile — unacceptable against the current working tree.
- **pnpm/bun for the desktop only.** Adds a second package manager to the repo
  for no benefit the brief asks for, and §5 warns against exactly this.
