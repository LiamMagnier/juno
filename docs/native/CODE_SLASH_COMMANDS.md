# Juno Code — slash commands

Saved prompts, addressed by typing `/name` in the Code composer.

## Why

Every agent Juno Code is compared against has this: Claude Code reads
`.claude/commands/*.md`, Codex keeps a prompt library. It is the feature a team
notices the absence of, because the prompts worth keeping are the repository's
own — "review this the way we review", "run the suite the way CI runs it". Juno
Code had no way to keep one, so every session retyped them.

## Where a command comes from

Two sources, workspace winning:

1. **The workspace** — `.juno/commands/*.md`, and `.claude/commands/*.md` as
   well, so a repository that already carries those does not have to duplicate
   them. `.juno` is read second, so a repository migrating from `.claude` can
   override one command at a time.
2. **The built-ins** — `review`, `explain`, `plan`, `test`, `fix`, `commit`.
   Deliberately few: each is a prompt a reader would otherwise type most days,
   and a long list of speculative commands is just a menu to scroll past.

A workspace command **replaces** a built-in of the same name. The repository
knows more about how it wants to be reviewed than Juno's defaults do.

## File format

The format already in the wild, so the same file works in more than one tool:

```markdown
---
description: Review like we review
behavior: ask
---
Review the diff against our conventions. Quote the lines you are describing.
```

- Frontmatter is optional. `description`/`summary` and `behavior`/`mode`
  (`ask` · `plan` · `code`) are read; **every other key is ignored rather than
  rejected**, because these files are shared with tools that write keys Juno
  does not.
- The body is the prompt. `$ARGUMENTS` is substituted with whatever the reader
  typed after the command name; a command with no placeholder gets the argument
  appended, so their words are never silently dropped.
- With no `description`, the first line of the body becomes the menu summary — an
  undescribed command still has to be tellable apart from its neighbours.
- A file whose body is empty is not loaded. A command that would insert nothing
  is not a command.

## Behaviour in the app

- The menu opens only while the caret is still inside the command word at the
  very start of the composer. `/usr/bin`, `2/3`, `//TODO` and `/2x` are not
  commands — see `CodeSlashTokenTests` for the full rule.
- ↑/↓ move the highlight, Return runs it, Escape closes the menu by appending a
  space (it means "I did not want the menu", not "throw away my sentence").
  The text field keeps focus throughout, so the reader never stops typing.
- Choosing a command puts its prompt **in the composer**, not on the wire. The
  reader sees exactly what will be sent and can edit it first. A saved prompt
  that fired straight into the agent would be a stored instruction nobody read.
- A command's `behavior` is applied as a default the reader can still override.
  It never changes the permission mode — that contract stays theirs.

## Implementation

| Piece | File |
| --- | --- |
| Command, parsing, library, token rule | `JunoCodeUI/Models/SlashCommands.swift` |
| The menu | `JunoCodeUI/Views/SlashCommandMenu.swift` |
| Composer integration | `JunoCodeUI/Views/Composer.swift` |
| Workspace discovery | `WorkspaceContext.slashCommands()` |
| Tests | `JunoCodeUITests/SlashCommandTests.swift` (25) |

The menu is an `.overlay`, never a `.popover`: a popover over a
`NavigationSplitView` negotiates its own size against the window, and an
unconstrained one whose content changes on every keystroke is the intrinsic-size
feedback that has already cost this window a constraint-loop crash.

Commands are read once per session, not per keystroke — the menu is consulted on
every character typed after a slash, and a directory listing in the type-ahead
path would be felt. A workspace whose commands change mid-session picks them up
on the next session, which is the same contract the other agents offer.

## Not done

- No `!command` shell substitution and no `@file` inclusion inside command
  bodies. Both are real parts of the format elsewhere; neither is implemented
  here, and a command using them will insert the literal text.
- Commands are not yet offered in **Chat** — only Juno Code.
- No UI for creating a command from the app; they are files, written by hand.
