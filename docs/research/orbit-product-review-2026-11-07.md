# Orbit product review — 7 November 2026

## Direction

Make delegation feel dependable across web, iPhone, and Mac: give an agent a responsibility, see its current work, intervene when necessary, and return to a useful result. The visual identity should make that workflow legible. A more elaborate avatar does not fix an unclear task or an unavailable computer.

This review uses current primary documentation, checked on 7 November 2026. Product access and capabilities can vary by rollout. The observations below concern documented behavior; they are not claims that we tested private competitor applications.

## References and decisions

| Product | Verified behavior | What Orbit should learn |
| --- | --- | --- |
| [ChatGPT dots](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) | A persistent agent can advance goals between conversations, use its own cloud computer, and use connected apps. Its profile exposes ongoing, scheduled, and completed work. Local computer access is optional. | Keep identity stable across devices. Put active work, routines, results, and computer access within reach of the conversation. Clearly distinguish the cloud computer from the person's Mac. |
| [Dots controls](https://learn.chatgpt.com/docs/dots/controls) | Pausing the primary agent, stopping delegated work, and canceling a schedule have different effects. Stopping does not reverse completed actions. | Use precise action labels and explanations. Preserve separate controls for pausing an agent, ending a run, sleeping a computer, and deleting it. |
| [Claude Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet) | A persistent main thread, cloud work, voice messages, connected apps, and additional topic channels share context. Tasks surface requests for input; finished files have a separate destination. | Keep routine tool activity out of the main conversation where possible. Make decisions, blockers, and finished deliverables prominent. On a phone, prioritize reviewing and steering work. |
| [Duet security](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security) | The documented architecture keeps passwords, cookies, and connector tokens separate from the model. Task state and connected-app access remain inspectable. | Preserve Orbit's vault and approval boundaries. Do not turn ordinary chat into a password field. Explain access using actual server state. |
| [Grok Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) | Bots have separate screens on a shared persistent account computer; files, sessions, and command-line credentials are shared. People can watch and take over blocked steps. | Put the computer beside the task with Watch, Take control, and Hand back. Retain Orbit's separate per-agent computers rather than copying shared credentials. Show startup, reconnect, and failure states honestly. |
| [Grok Bot mobile](https://docs.x.ai/grok-bot/mobile) | Mobile reaches the same bots, work, routines, connections, and cloud computer as desktop; cloud work continues after the app closes. | A phone should be a complete companion for decisions and results, with explicit touch controls for computer takeover. Do not imply the phone itself runs the Linux desktop. |
| [Meta Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) | Meta presents an agent that proactively advances personal goals and works with connected services. | Start onboarding with a useful responsibility and a small number of understandable choices. Keep proactivity tied to a concrete job and user controls. |
| [Manus Scheduled Tasks 2.0](https://manus.im/blog/manus-schedules) | Recurring work can continue in an existing task or project, carrying instructions, files, decisions, and results forward. | Preserve context across routine runs. Show the next run and the resulting work together rather than treating each run as unrelated. |

## What this repository already has

The product is not starting from a chat wrapper. The inspected implementation already includes:

- Persistent agent identity, editable instructions, notes, pending note review, goals, budgets, routines, rooms, and task handoffs under `src/lib/agents` and `src/lib/work`.
- Docker and remote Linux computer providers, authenticated watch/control sessions, heartbeat leases, files, streamed shell output, a vault, and teaching by demonstration under `src/lib/computer` and `src/components/agents`.
- Shared SwiftUI agent views and a shared agents client/model under `native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents`, consumed by both iOS and macOS.
- Research, voice, media generation, connected apps, and code execution elsewhere in the app. Their existence does not guarantee that every model or agent configuration can invoke every capability.

These are code findings, not proof that production services are configured or that all paths have been exercised in this environment.

## Gaps addressed by this implementation

1. **Discoverability.** The web roster showed large isolated faces and a creation field, with no search and no visible map of possible work. Add compact, readable cards, task-aware search, state filters, direct computer links, and six practical starters. Starters populate a draft; they do not silently create an agent or grant access.
2. **Startup feedback.** The web overlay read the entire agent profile on a five-second timer, including while the overlay was closed, and discarded computer-action responses. Use the dedicated computer endpoint, apply mutation responses immediately, poll transitional states faster, and retain visible recovery errors. A computer must never appear awake before the server says it is.
3. **Native parity.** Bring the shared iOS/macOS roster into the same task-first structure with matching search/filter semantics and draft starters. Match the shared computer vocabulary, loading states, and recovery behavior using existing native controls.
4. **Material and motion.** Use restrained neutral cards, one accent for actions, consistent corners, fine borders, and short opacity/position transitions. Keep focus, touch targets, dark mode, Dynamic Type, and Reduce Motion working. Motion communicates a change; it does not simulate task progress.

## Deployment and remaining capability work

Real Linux operation requires a configured computer provider, provisioned host/image, relay, rollout entitlement, database, and running workers. Model-backed work also requires working provider credentials. No such credentials are supplied by this chat. Follow the existing [computer host setup](../../deploy/computer-host/README.md) and [production enablement guide](../design/agents-v2/ENABLE_COMPUTERS.md); do not substitute the fake provider for a working production computer.

Full competitor parity is larger than a visual pass. Cross-service messaging channels, payment integrations, enterprise sharing, and every vendor-specific tool require separate supported integrations and validation. Preserve the existing boundary between a discoverable workflow, configured access, and a successfully completed action.

## Validation boundaries

Web validation should exercise desktop and narrow screens, light and dark themes, keyboard search/filtering, starter draft behavior, access refusals, and asynchronous computer startup/failure. Native source checks can run on Linux; Apple SDK builds, SwiftUI rendering, VoiceOver, Dynamic Type, and simulator/device interaction require a Mac. Report those separately rather than calling static checks a native build.

## Recorded validation

- `npm run typecheck`: passed.
- ESLint on the modified web components, fixture, roster helper, test, and QA script: passed.
- Focused agent/computer tests, including the new workspace suite: 129 passed, zero failures or skips.
- `scripts/qa/orbit-workspace.mjs`: passed against the local development fixtures. Checks search, filters, draft starters, Tab navigation, desktop/mobile layout, both themes, OS and in-app reduced motion, startup, host failure, and denied access. These are fixture-backed UI checks, not an end-to-end model or VNC run.
- All nine native design gates and the Swift API/Work contract check: passed. The new Swift unit tests need to run in the Apple build environment.
- A real build of `deploy/agent-computers/Dockerfile` was attempted. Package installation completed, but Docker's VFS storage exhausted the 7.9 GB workspace disk while creating a later COPY layer. Only the build cache belonging to that attempt was removed. A live desktop run was therefore not verified.

Reproduce the UI check with a local development server:

```bash
npm run dev
ORBIT_CHROMIUM=/usr/bin/chromium node scripts/qa/orbit-workspace.mjs http://127.0.0.1:3000 /tmp/orbit-review
```

Omit `ORBIT_CHROMIUM` when using Playwright's installed Chromium. The review workspace is `/dev/agents?view=gallery&g=workspace`; it contains sample agents, is development-only, and is not a production deployment.
