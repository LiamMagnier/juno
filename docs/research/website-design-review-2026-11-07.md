# Website and Orbit design review · 7 November 2026

The workspace now uses a consistent sans-serif hierarchy for app headings, item names, section titles, and supporting labels. The public brand retains Newsreader. Shared page and component changes reach the existing routes without replacing their data flows or introducing new placeholder features.

## Change inventory

| Surface | Changes |
| --- | --- |
| Orbit | Workspace masthead, attention cards, searchable crew, working/needs-you/paused filters, stable agent cards, six task starters, visible computer links, host placement alongside the latest main implementation. |
| Agent computer | Lightweight visible-only status polling, guarded start/wake sequence, startup feedback, retryable errors, access checks, files shortcut, takeover and hand-back preserved. |
| Projects and folders | Sans-serif names, clearer title/metadata hierarchy, unified search with clear and Escape, shorter grid entrance. Existing pin, move, drag, nesting, and delete flows retained. |
| Library | Shared field material and busy indicator, keyboard and touch-friendly clear search. Grid/list, upload, drop, previews, recently deleted and lifecycle actions retained. |
| Apps | Consistent section headings, shared searchable directory, clearer app-detail title. Existing native and custom MCP connections retained. |
| Skills, routines, artifacts, compare and other app pages | Shared page headings and list-title hierarchy; quicker, smaller page and row entrances. |
| Memory | Section type aligned with the workspace hierarchy; metadata at a readable 12px base. Existing review and editing flows retained. |
| Settings | Shorter rail entrance with capped stagger; latest main's window, search, account, permission and devices work integrated. |
| Dialogs and empty states | Stable scroll gutter, better long-title wrapping and footer spacing, quieter sans-serif empty titles, decorative skeletons hidden from accessibility navigation. |
| Public homepage | Product preview appears earlier; scroll presentation shortened from 240vh to 200vh, with smaller copy travel and less preview scaling. Phone/reduced-motion static layout retained. |
| iOS and macOS shared code | Matching agent search/filters and starters; guarded computer actions, access state, visible errors, correct start/viewer sequencing. These require Apple CI and a native runtime review. |

## Review tools

Run a development server, then:

```sh
ORBIT_CHROMIUM=/usr/bin/chromium node scripts/qa/website-review.mjs http://127.0.0.1:3000
ORBIT_CHROMIUM=/usr/bin/chromium node scripts/qa/orbit-workspace.mjs http://127.0.0.1:3000 test-results/orbit-workspace
```

The website review captures 15 real fixture screens at desktop and phone widths in both themes, plus representative loading, empty and error states. It checks document overflow, search reset and focus, and project dialog dismissal/focus return. `test-results/website-review/index.html` is a before/after contact sheet; `review.json` records captures, checks and failures. These artifacts are intentionally ignored by Git.

The Orbit review exercises filters and starter drafts, accessible keyboard navigation, theme and motion preferences, create/start transitions and failure/access states. Both suites use local deterministic fixtures; they do not prove a live account, model run, Linux stream or native binary.

## Product research

See [Orbit competitor review](orbit-product-review-2026-11-07.md) for the primary-source research into Dots, Duet, Grok Bots, Muse and Manus, and the remaining capability boundaries. No claim of full competitor parity is made.
