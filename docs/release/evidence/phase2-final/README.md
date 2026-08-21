# Phase 2 final evidence

Evidence captured during the final closure run on 2026-08-21. Images in this
directory are current-run hardware or simulator captures; they are not product
mockups.

- 17 iPhone captures cover Chat, sidebar, Projects, Artifacts, Work, Code,
  Library, Settings, model selection, search, tasks, and Voice permission/error
  recovery in light and dark appearances.
- 12 iPad captures cover wide navigation, Projects, Artifacts, Work, Code,
  Library, Settings, model selection, and Voice permission/error recovery.
- `macos-qwen-voice-anti-loop.jpeg` records the real Mac hardware Qwen session
  used to validate that one assistant playback does not become a second user
  utterance or trigger a repeated answer.

The Voice recovery screenshots deliberately use a closed local preview relay;
they validate the real typed failure UI without spending provider credit or
fabricating a successful call.

External exact-SHA evidence for engineering commit
`3fff63852fcada524f6df09127844615de21bf8f`:

- Native CI run `32444491853`: all Swift packages, macOS Debug/Stable builds,
  macOS unit tests, iOS app/unit tests, design rules, and API contract passed.
- Deploy/Phase 2 run `32444491880`: all 22 mechanical suites, aggregate
  blocking checks, exact immutable VM deployment, public health/version, and
  authenticated production Qwen catalog/chat receipt/replay/Voice-policy smoke
  passed.
