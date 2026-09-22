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

## Session verbs

A few built-ins are verbs on the session rather than prompts, and put nothing
in the composer. A workspace file of the same name turns the verb back into an
ordinary prompt: a repository may not silently take over a session action.

- **`/compact [what to keep]`** summarises the conversation so far to free up
  context. The session's own model writes the summary — requests and intent,
  key decisions, files and code by path, errors and fixes, open tasks, the
  current work and the next step — giving priority to whatever the reader typed
  after the name. If the model cannot (an error, a refusal, an empty or
  truncated reply, 90 seconds without an answer, or Stop), Juno keeps its
  structural notes instead; compaction never fails. Notes written after an
  earlier model summary carry that summary whole, ahead of the notes. The
  newest steps stay verbatim and every tool call keeps its result. The model
  reads tool output as tool output, escaped inside its own element, so a file
  or page that says "User: …" cannot become a request in the summary. The
  thread shows one divider, *Context compacted*, that opens onto the summary.
- Choosing `/compact` from the menu runs it at once. Typing past the name —
  `/compact keep the parser decisions` — hides the menu, and Return or Send runs
  the verb with that focus instead of sending the line to the model.
- While a run is working the row is dimmed with the reason, and a typed
  `/compact …` is refused with an explanation and left in the field.
- The landing composer has no session yet, so it offers no verbs.

## Implementation

| Piece | File |
| --- | --- |
| Command, parsing, library, token rule, typed verbs | `JunoCodeUI/Models/SlashCommands.swift` |
| The menu and composer integration | `JunoCodeUI/Studio/StudioComposer.swift` |
| Verb availability and dispatch | `JunoCodeUI/Studio/StudioSessionView.swift` |
| The model-written summary | `JunoCodeRuntime/CompactionSummarizer.swift` |
| Where compaction cuts, and the structural fallback | `JunoCodeRuntime/ConversationCompactor.swift` |
| Workspace discovery | `WorkspaceContext.slashCommands()` |
| Tests | `JunoCodeUITests/SlashCommandTests.swift`, `JunoCodeRuntimeTests/CompactionSummarizerTests.swift`, `JunoCodeRuntimeTests/ModelCompactionTests.swift` |

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
