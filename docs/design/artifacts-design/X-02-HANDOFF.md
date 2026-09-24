# X-02 handoff: chat Canvas design editor breaking on its first saved edit

Paused 2026-09-23 on the user's request (usage limit). Defect X-02 is from
`00-AUDIT-OVERVIEW.md` (§6 #2, §7 X-02, §12.4). That file is on branch ref
`wip/artifacts-design-audit`, not on main.

- **Worktree:** `.claude/worktrees/suspicious-borg-f3e3b4`
- **Branch:** `claude/suspicious-borg-f3e3b4`, based on main at `7f92324f`.
  Not pushed.
- **Commits:**
  - `499b6afd` is the fix. It is land-ready: main and origin/main were still at
    `7f92324f` on 2026-09-24, so it fast-forwards.
  - The commit on top only adds this note. It is not for main.
- **State:** the fix is implemented, tested and checked in a `/dev` gallery.
  Still to do: a check while signed in, then landing `499b6afd` through the one
  agreed releaser.

## What was wrong

`canvas-panel.tsx` wrapped `DesignEditor` in `key={selectedVersion}`. When the
editor made a new checkpoint, `onCommitted` added `{ version, content: "" }`
to the artifact envelope. The editor then remounted on an empty body, parsing
failed and the panel showed "This design can't be opened". The undo stack was
lost. Copy, Download and the Code tab read `""` until a reload. A fold (an edit
written into the current version) was never recorded at all. On top of that,
`selectedVersion` was copied from `currentVersion` by an effect, one render
late.

## What changed

| File | Change |
|---|---|
| `src/lib/design/committed-envelope.ts` (new) | `recordCommittedDesign(artifact, version, document)`. Records the stored document, serialized as the store serializes it. A new version is appended; a fold rewrites that version's body. A stale reply is ignored. |
| `src/components/canvas/use-record-design-commit.ts` (new) | The panel's `onCommitted`. Builds each record on the newest envelope, using a ref that is refreshed only when the prop's identity changes. That keeps back-to-back acknowledgements from dropping each other. |
| `src/components/design/use-design-document.ts` | New `version` option, and `onCommitted(version, document)`. The hook remembers the versions it wrote since the last load. While editable, it does not reload on the body of one of those versions, which is its own echo. |
| `src/components/design/design-editor.tsx` | Forwards `version`. The rails now use container queries (`@container/design-editor`): layers from 40rem, inspector from 56rem, replacing `md:` and `lg:`. The `window` surface is unchanged. |
| `src/components/canvas/canvas-panel.tsx` | The design mount is keyed by `artifact.id` and passes `version={selectedVersion}`. `selectedVersion = pinnedVersion ?? artifact.currentVersion` is derived, not copied by an effect. |
| `tests/design-embedded-editor.test.ts` (new) | 7 tests. The envelope helper, plus the real `useDesignDocument` rendered with `react-dom/client` and two `window` stubs. It runs against a fake store that uses `allocatesCheckpoint`. |
| `src/app/dev/design-canvas/` (new) | A dev-only gallery. It shows the real `CanvasPanel` on a generated design, and a fetch shim answers `/api/design/dev-design/transactions` in the page. |

## Verified

- **New test file:** 7 of 7 pass. Mutation checks: reintroducing the reload on
  the editor's own echo, a stale-closure recorder, or an empty body each made
  the tests fail.
- **Full unit suite:** `npx tsx --test tests/*.test.ts` gave 3781 passed, 0
  failed, 12 skipped.
- **Lint:** clean on every touched file.
- **Typecheck:** no errors in touched files. The repo-wide errors come from
  this worktree's stale Prisma client and the missing i18n catalog, and were
  there before this change.
- **`/dev/design-canvas`:**
  - The first edit made v2. The editor stayed up with its selection and
    history, and Undo worked. The undo went to v3 and the editor survived that
    too.
  - Copy source wrote the full document (revision 5).
  - Regenerate loaded the new body and cleared history. The next edit made v5
    cleanly.
  - On a 1440px viewport: no rails at 420 or 560, layers only at 720, both
    rails at 960.

## Next steps

1. Review the diff: `git show 499b6afd`.
2. Check it while signed in: open a DESIGN artifact in a real chat and make
   one edit. The panel should stay open, the header should show the new
   version, and Undo should stay enabled.
3. Land `499b6afd` alone (fast-forward, or cherry-pick if main has moved).
   First coordinate a single releaser.
4. Done by the audit session on 2026-09-24 (`wip/artifacts-design-audit` @
   `c9bfc45f`). `00-README.md` and the Phase 0 table in `05-IMPROVEMENTS.md`
   say "fix ready to land: 499b6afd". `00-AUDIT-OVERVIEW.md` stays unchanged
   as the point-in-time record. The Mac rail-width note is in that branch's
   `HANDOFF.md` for the juno-glass session.

**On hold (2026-09-24):** no session has been named releaser, and pushing to
main is the user's call. Land `499b6afd` only when the user says so.

## Known and out of scope

- Switching to the Code tab, or opening version history, still unmounts the
  editor (Radix `TabsContent`, and `AnimatePresence` swapping out the
  workspace). That drops undo. This is a separate issue that was already there.
- The impeccable hook flags `broken-image` in `design-editor.tsx`. It is
  reacting to a JSDoc comment that mentions `<img>`, so it is a false
  positive. It was left as it is.

## Running the gallery from a worktree

1. Run `npm run i18n:extract`. It writes the gitignored catalog.
2. Start the server on its own port, not 3100: `npx next dev -p 3217`.
3. It runs without `.env.local`. The auth `MissingSecret` log lines are noise.

The browser pane throttles timers while it is hidden, so allow a few seconds
before reading the gallery's ledger.
