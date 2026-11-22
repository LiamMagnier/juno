---
title: "Orchestration in Alevr Code"
subtitle: "A study of T3 Code Orchestrator V2 and a roadmap for Alevr"
date: "22 November 2026"
lang: en
---

# Abstract

This paper studies how T3 Code Orchestrator V2 tracks a coding session across models, subagents, interruptions, and reconnects. It compares T3's published architecture and release notes with Alevr Code's web client, device runtime, and agent engine. Three changes offer the most immediate benefit to Alevr. Make the orchestration mode visible at send time, give each run its own agent view, and let the user resolve a failed setup without losing the draft. Longer term, Alevr should make delegated work recoverable after a restart and support capability-aware handoff between providers. The paper proposes an evaluation for deciding where teams improve outcomes enough to justify their cost.

# 1. Method and scope

The study uses T3 Code's stable v0.1.0 release, its migration notice, and the public orchestration documentation inspected on 22 November 2026. The source review is pinned to T3 commit `c198f73b3766090e02cace1a8b14f439f9fc63b6`. Alevr's baseline is production commit `706b3f564`. The comparison checks identity, delegation, completion, permissions, recovery, and what the interface can honestly show. It is a document and code review. It makes no measured claims about either product's speed, quality, or costs in real use. [T3 release](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0) · [T3 migration notice](https://github.com/pingdotgg/t3code/issues/14871) · [T3 architecture](https://github.com/pingdotgg/t3code/blob/c198f73b3766090e02cace1a8b14f439f9fc63b6/docs/orchestration-v2/README.md)

T3's release establishes what shipped at v0.1.0. The architecture documents describe a broader design and are cited separately for lifecycle guarantees and follow-up work. For product comparisons, Anthropic's orchestration guidance and OpenAI's subagent documentation offer independent design precedents. They do not establish performance for Alevr. [Anthropic agent workflows](https://www.anthropic.com/research/building-effective-agents) · [OpenAI subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

# 2. What T3 Code V2 changed

## Identity and projections

T3 separates the conversation a person opens, the run started by a request, and the execution nodes that represent work inside the run. Provider session and turn IDs describe what a runtime did. The app's own IDs let a single conversation hold work from different provider sessions and let a child settle while the parent is still working. A conversation projection supplies the visible transcript. Provider diagnostics remain separate. This separation makes it possible to show an approval or tool result in the right place without treating a provider's transport event as a user-facing state change. [Core graph and data model](https://github.com/pingdotgg/t3code/blob/c198f73b3766090e02cace1a8b14f439f9fc63b6/docs/orchestration-v2/core-graph-and-data-model.md)

## Delegation and recovery

The app-owned delegation tool creates a child thread and run. The child gets a self-contained task and optional role instruction. Parent history stays with the parent. The parent thread gets a live record for the child and receives a result when the child settles. A caller-provided request ID lets T3 recognize a retry. Terminal events can be replayed to finalize a child's result after the server restarts. Together, those properties reduce two common failures: starting a second worker after a lost response and losing a result when the coordinator reconnects. The docs also describe how a blocking child question can reach the parent, with approvals kept on their own path. [T3 delegated tasks](https://github.com/pingdotgg/t3code/blob/c198f73b3766090e02cace1a8b14f439f9fc63b6/docs/orchestration-v2/orchestrator-mcp-server.md#delegated-task-lifecycle)

## Completion and capability

Provider events can arrive in an order that surprises a client. A status update can precede a terminal event. An interrupt request can return before the run has stopped. T3 defines a finalization step that waits for the root terminal event, flushes text, settles visible work, and captures the checkpoint before publishing completion. Its capability model also specifies when a feature can fall back. A provider without live steering may require interrupting and restarting, while a provider without native forks can receive portable context if policy permits. Those are observable product differences. The UI needs to describe what will happen before a user chooses one. [T3 completion barriers](https://github.com/pingdotgg/t3code/blob/c198f73b3766090e02cace1a8b14f439f9fc63b6/docs/orchestration-v2/feature-lifecycles.md#completion-barriers) · [T3 capability policy](https://github.com/pingdotgg/t3code/blob/c198f73b3766090e02cace1a8b14f439f9fc63b6/docs/orchestration-v2/provider-capability-system.md#degradation-policies)

## Release lessons

T3's migration copies the old database and preserves conversation messages, metadata, and worktree information. It leaves behind live provider sessions and some old execution detail. That tradeoff protects the transcript while creating a clear boundary between generations of runtime state. For Alevr, the implication is to add recoverable delegation records alongside existing sessions and verify replay before switching readers. A redesign of the transcript and a change to storage can ship independently. T3's architecture document also tracks a durable effect outbox as follow-up work. It would be inaccurate to use that proposal as proof that every provider side effect has exactly-once delivery. [T3 V1-to-V2 migration](https://github.com/pingdotgg/t3code/issues/14871) · [T3 outbox proposal](https://github.com/pingdotgg/t3code/blob/c198f73b3766090e02cace1a8b14f439f9fc63b6/docs/orchestration-v2/README.md#tracked-follow-up-durable-effect-outbox)

# 3. Alevr's position

Alevr already has standalone and delegated execution, role-specific model routing, a worktree workflow, a plan/build/verify pipeline, provider adapters, a persisted session event stream, and owner-scoped agent controls. It also has distinct managed-device, vendor-device, and cloud execution paths. The cloud composer currently starts a single-model task. The web Agents panel can read comparison results, while the tested web route has no callback for keeping a candidate. Device features depend on adapter support, a linked environment, and the configured provider.

The code inspection found four practical problems.

| Finding | Effect | Change in this branch |
|---|---|---|
| Lead + workers was treated as Plan → Build → Verify by the editor. | The visible plan overstated what the engine would do. | Each preset has its own description and role editor. Compatible vendor runtimes get a separate delegation brief. |
| New-session routing failures were ignored. | A team choice could silently become a solo session. | Failed configuration keeps the prompt and attachments available and cleans up the empty session created for the attempt. |
| Agent activity was gathered across the entire thread. | Previous workers could be presented as current. | The Agents panel follows one turn and opens older workers from the transcript in a read-only view. |
| Phone controls competed for one narrow row and panel. | The primary action could be crowded and trace details shared a small panel with the tree. | The composer prioritizes its main controls. Agents has a direct entry and a phone sheet with separate list and detail views. |

The new web controls reuse existing routing, permissions, and device APIs. They do not establish cloud multi-agent execution or provider-independent restart recovery. The baseline code paths for reproducing the review are `src/components/code/v2/live-route.tsx`, `src/lib/code-v2/agent-tree.ts`, `runner/env-server/src/mcp/subagent-tools.ts`, and `runner/agent-core/src/subagents.ts`.

# 4. Product and architecture proposals

## First, make it easy to start and safe to inspect

A person should be able to answer four questions before sending. Where does the work run? Which mode is selected? What can it change? What happens if the connection closes? Keep workspace and environment beside the draft, with the model, access mode, and orchestration available from the same composer as on desktop. Phone should prioritize writing, reviewing, and approving. Terminal and other secondary views open on demand. When opening an agent, show its assignment, state, evidence, and result in that order. A child finishing should update the agent view while the lead remains visibly responsible for the run.

Use Solo as the baseline. Dynamic delegation is suited to independent investigations or implementation slices. A plan/build/verify pipeline makes sense for jobs whose parts can be specified and tested separately. Multiple candidates are expensive and useful mainly when different solutions are plausible and a person can compare them from evidence. Keep the cost estimate distinct from observed spend, and show which provider supplies or bills each role. Anthropic describes both parallel sectioning and dynamic workers. OpenAI's subagent guidance also separates scopes for specialized agents. Neither establishes that delegation helps a tightly coupled edit. [Anthropic orchestrator-worker pattern](https://www.anthropic.com/research/building-effective-agents) · [OpenAI subagent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents)

## Next, make a run recoverable

Keep one stable Alevr run ID, a separate attempt ID, and a stable ID for each delegated task. Store parent, task, role, provider reference, permission mode, and terminal outcome on the host. Record a request receipt before launching child work. On reconnect, replay committed state and reconcile entries whose provider outcome is uncertain. A retry with the same request ID should resume or return the original assignment. A cancelled or failed assignment should carry its actual outcome. Never silently launch a second task to make the view look current.

Define a finalization contract. Persist the parent outcome, flush its transcript and receipts, resolve outstanding owned work, and capture or explicitly mark the checkpoint before reporting completion. To stop a team, record the request, propagate it, and display stopping until confirmation arrives. Expired leases and lost transports should produce recoverable state with enough evidence to decide whether another attempt is safe. A replay test should terminate the process between each of these steps and verify that resuming never creates a second child or a false success.

## Then, connect decisions with evidence

Show an agent's selected files, tests, and patch separately from its narrative. Give each proposed patch an owner, base revision, and stable identifier. Applying a candidate should require an explicit choice, compare the current checkout against the recorded base, and be idempotent. Conflicting slices should stop at a review boundary. Keep unsupported provider actions unavailable with a reason and a practical path, such as opening the device that owns the run. Retain approval and access decisions separately from steering messages. A new provider or subagent should never gain more permission than the run granted.

# 5. Evaluation design

Use a private, rotating task set drawn from representative Alevr work. Include single-file fixes, independent multi-file changes, and tightly coupled refactors. Include mobile review and interrupted-run tasks. Use the same lead, checkout, environment, access mode, and repository checks when comparing Solo, Lead + workers, and Plan → Build → Verify. Record model and tool versions. Randomize the order and have a reviewer who cannot see the mode judge whether each patch satisfies the request and preserves existing behavior.

| Question | Measurement | Proposed acceptance rule |
|---|---|---|
| Does orchestration help? | Accepted patch rate, elapsed time to a reviewed patch, human interventions, total billed cost | Promote a mode only for task classes where it improves accepted outcomes or review time at an acceptable cost. Report sample size and uncertainty. |
| Can people act on a phone? | Time to open the right run, find a request, and return to the draft; failed taps and horizontal overflow | At 320, 390, and 430 px, primary actions stay visible and the draft survives focus and sheet changes. Include reduced motion, zoom, and keyboard navigation. |
| Does recovery work? | Duplicated work after repeated commands, lost receipts, stale child status, and late completion events | No duplicate task start or false completion in fixture replays that corrupt timing, ordering, or connection state. |
| Are boundaries enforced? | Unauthorized actions, cross-run controls, permission escalation, and attempts to apply a stale patch | All negative cases are refused. A refusal appears in the affected run with the next safe action. |

SWE-bench Verified is useful historical context. OpenAI's later audit identifies contamination and task-quality issues that make it a weak sole measure for this product. The proposed task set should be refreshed, use explicit acceptance tests, and publish enough notes for the team to reproduce outcomes. The baseline here is a review of behavior and implementation. This paper does not report comparative experiments. [OpenAI benchmark audit](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)

# Conclusion

Alevr can improve the daily experience with the primitives it already has. The immediate redesign makes run modes visible, keeps the composer usable on a phone, and gives agent activity an explicit home. Further progress should be judged by whether someone can see what happened, recover the same work after failure, and confidently accept the result. Durable delegation, reliable cancellation, and patch provenance bring those properties to the rest of the runtime.
