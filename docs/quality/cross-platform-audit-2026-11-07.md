# Cross-platform audit: initial findings

This is a focused repository review, not a complete product, security, visual, or performance audit. It does not establish feature parity or compare answer quality. No authenticated services, physical devices, provider calls, or production latency were measured.

## Reference points

- [Codex](https://openai.com/index/introducing-the-codex-app/) documents isolated worktrees and scheduled automations; its [mobile remote workflow](https://developers.openai.com/blog/mastering-codex-remote-for-engineering) describes steering, review, and worktree selection. Juno has worktree and automation implementations and a remote session interface; their end-to-end parity and reliability need device testing.
- [Claude projects](https://support.anthropic.com/en/articles/9517075-what-are-projects) provide shared project context, and [artifacts](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) support targeted edits. Juno has project, knowledge, and artifact surfaces; depth and behavior have not been compared through live use.
- [T3 Code](https://github.com/pingdotgg/t3code) describes itself as a control surface for coding agents. Juno has its own Code runtime and remote control; support for particular third-party installed agents needs a separate compatibility inventory.
- [DeepSeek Harness](https://www.deepseek.com/harness/en/) describes composable plugins and desktop and web interfaces. Juno has tools, skills, and MCP integrations; this does not establish equivalent runtime extensibility.

The generated [native parity ledger](../native/PARITY_MATRIX.md) reports 9 partial and 9 planned iOS pages, and 2 partial and 3 planned Mac pages, alongside intentional web-only surfaces. These are implementation inventory categories, not independent functional verification. In particular, it marks iOS Code pages as partial.

| Workflow | Repository evidence | Remaining gap |
| --- | --- | --- |
| Remote coding | The phone can supervise sessions; the Mac has worktree and session controls. | The ledger marks phone Code pages partial and cloud environment settings planned; compare review, workspace creation, and recovery against a real paired host. |
| Skills | Both apps list and import skills. | The ledger marks phone editing and creation as partial or planned, and the teaching workflow as planned on both native platforms. |
| Automations | Both apps list and run routines. | The phone editor supports a narrower schedule configuration; event triggers, budgets, and policies remain Mac/web workflows according to the ledger. |
| Chat, projects, memory, voice and artifacts | Web and native implementations exist; the earlier [competitor review](../audit-2026-10-29/COMPETITORS.md) maps their source files to ChatGPT, Claude, Gemini, Grok, and Perplexity. | End-to-end quality, accessibility, and cross-device continuity need live comparison; presence in source is not parity. |

## Findings addressed in this change

1. The Mac remote monitor followed the event stream only once, although the relay deliberately rotates streams. It now reconnects and polls the cursor after a disconnect. Both clients resume quickly after a normal rotation and retain a longer delay after an error; no live latency measurement was made.
2. A pending journal poll could return after switching sessions or signing out and apply stale events. Session generation invalidates stale polls and streams.
3. A refused or unavailable command could be mistaken for a queued follow-up or successful session creation. Command admission now returns an explicit result; both native composers restore a failed typed follow-up. A repeated prompt stays queued until a later host echo, and duplicate journal entries in a page are accepted only when identical.
4. The general evaluation harness labelled token-priced estimates as measured costs and treated absent usage as zero. It now marks the estimate's provenance, counts missing estimates, and labels its citation metric as metadata shape rather than factual support. This does not supply an independent quality benchmark or a complete provider bill.
5. The remote thread projection is cached between journal or queue changes, avoiding repeated full folds when the view reads it several times. This does not eliminate a full fold for each new journal page, and its device-level impact has not been measured.
6. Swarm tasks left their timeout timers active after finishing, keeping the process alive unnecessarily. Those timers are now cleared on completion or failure, with a process-exit regression and the existing timeout test passing.

## Priority follow-up

1. Exercise pairing, revoke, approvals, interruption, network transitions, sign-out, and session switching on real Mac and iPhone devices with the actual relay. Measure command acknowledgement and event delivery percentiles under Wi-Fi, cellular, and packet loss; do not infer latency improvements from code changes alone.
2. Inventory the iOS partial Code and task flows against concrete remote workflows, including review, worktree selection, and recovery. Implement missing actions with the same authorization and durable journal semantics as the Mac host.
3. Benchmark long remote transcripts: the cached projection still folds the entire journal when a page changes. Profile before designing incremental reduction, and prove rewind and duplicate-event behavior remains correct.
4. Run authenticated web journeys and visual/accessibility reviews at desktop and mobile sizes, including reduced motion, keyboard navigation, long conversations, and error states. Establish web performance baselines before changing global UI or animation.
5. Evaluate agent quality on a reproducible task set, with isolated workspaces, tool traces, cost, success rate, and recovery measures. A feature inventory cannot establish that one harness is more reliable than another.

## Validation limits

The production build and 14 authenticated Chromium tests passed against the repository's isolated database and simulated provider, covering chat, composer submission, reduced motion, and conversation search. The development composer fixture was also rendered at desktop and phone sizes. The 135 Code environment-server tests, focused evaluation tests, and 16 native synchronization gates passed in Linux. A broad unit run reported 9,669 passes, 208 skips and two QA teardown failures: the stopped child processes remained unreaped zombies under this container's PID 1. The test now recognizes a zombie as stopped, and all 26 QA runner tests passed on rerun; the full suite was not rerun. Its remaining auth, crypto, moderation, skill-package and custom-MCP checks passed separately. The swarm timer fix was made after the production build and passed its targeted tests. These checks do not validate live providers or real remote devices. Swift/Xcode and Apple simulators are unavailable in this environment, so the native regression tests and app builds must run on macOS before release. No website redesign or broad feature-parity implementation is claimed by this initial pass.
