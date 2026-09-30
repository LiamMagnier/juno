# Meta Muse: competitor research for the Juno Refoundation

Phase 0 research, read-only. Written 2026-09-30 on branch `rework/refoundation`.
Scope: Meta's personal agent **Muse**, Muse Secure VM, Sentinel, memories,
long-term goals, browser and computer use, connectors, credential protection,
WhatsApp, and the approval and audit architecture.

How this was done: I read 24 first-party pages (Meta Newsroom, Meta AI Research,
the Muse design essay, 14 Meta Help Centre articles, the Connect 2026 posts, the
connector platform page and the Meta developer recap) and 15 press pieces. I read
the help-centre pages in a browser because WebFetch hits a cookie wall there; the
optional cookies were declined. Help-centre pages show only relative dates, so
they are given here as "updated ~N ago, read 2026-09-30". Each claim is marked as
**[1P]** (first-party), **[press]** (reputable press) or **UNVERIFIED**.
Code claims about Juno cite the refoundation worktree at `1feb392c`.

---

## 0. Naming check (verified)

| Term | What it is | Source |
|---|---|---|
| **Muse** ("Muse from Meta", "Muse by Meta") | Meta's consumer personal AI agent. Launched 2026-09-08, US only, 18+. Runs on iOS, Android, web (muse.ai), WhatsApp and, from 2026-09-23, a Mac app. Meta calls it "a first step toward personal superintelligence". | [1P] Newsroom 2026-09-08; Help "About Muse subscriptions" |
| **Muse Spark** (current version 1.3) | The model behind Muse, from Meta Superintelligence Labs | [1P] research.meta.ai, 2026-09-02 |
| **Muse Secure VM** | A dedicated cloud Linux VM for each user. It holds the agent, the user's data and the user's credentials. | [1P] Safety blog 2026-09-08 |
| **Sentinel** | "a separate host-side agent from your Muse". It is "the sole permission authority" for connector actions and all network egress. It runs inside the user's VM but outside the agent's container, not on the user's device. | [1P] Safety blog |
| **hatch-authd**, **Secure Credentials Store** | The credential daemon and vault. It hands the agent "surrogate" tokens in place of real credentials. "Hatch" is Muse's internal codename. | [1P] Safety blog, Help "privacy, safety and security" |
| **Muse Confidential VM** | Planned for later in 2026. Uses a key held by the user so that "cryptographically and verifiably" Meta cannot read the VM. Not available at launch. | [1P] Safety blog |
| Muse Charm, Muse Realtime Avatar, Muse on AI glasses | Connect 2026 announcements (a device, video avatars, glasses integration). Mostly "coming". | [1P] Connect posts 2026-09-23/24 |
| Muse Code, Meta Model API | Separate developer products that use Muse Spark. Out of scope here. | [1P] developers.meta.com 2026-09-24 |

Press errors to avoid repeating:

- Privacy Guides (2026-09-22) says Sentinel "runs on your machine". Meta's own post contradicts this and places it host-side in the cloud VM.
- Several SEO sites state feature details that no first-party page supports. I did not use them.

---

## 1. Summary: the ten most important lessons for Juno

1. **Have one permission authority that the model cannot reach, and route every side effect through it.** Muse states it plainly: "Muse proposes actions, but only Sentinel can grant permission." That covers connector calls *and* every raw network request. Juno already has the right primitives: a pure policy module, and receipts bound to a digest of the exact arguments (`src/lib/action-approval.ts:1-16, 317-336`). But they are spread across two policy vocabularies. Chat connectors use `always_ask … block` (`action-approval.ts:32`) and Work and Agents use `conservative/balanced/permissive` (`src/lib/work/domain.ts:503`, `src/lib/agents/types.ts:56`). And nothing governs egress from agent computers. Juno should have one broker, one vocabulary and one settings page.
2. **The model and the runtime never hold a real secret.** Muse gives the agent surrogate tokens and swaps in the real credential at the network boundary. Each connector worker has its own credential allow-list. Browser logins are captured by client UI, stored outside the agent, and injected with the agent paused. Juno does this for credentials-kind connectors (`src/lib/connector-token.ts:5-11`). But the Juno agent computer asks the person to type passwords into a Chromium whose persistent profile sits next to a `computer_bash` shell (`src/lib/computer/store.ts:1064`, `docs/JUNO.md:2090-2092`). Its public-internet egress is unrestricted: only private ranges are dropped (`deploy/agent-computers/firewall.sh:10-12`). **This is the biggest gap between the agent computer and "production-ready".**
3. **Grants should be scopes, not yes/no.** Muse offers Allow once, Allow for this task, Allow for this site, Always allow (connector) and Deny. Its architecture also supports session-scoped and time-bounded grants. Juno offers allow-once or a standing connector grant, the standing grant only for reversible writes, and every request expires after 15 minutes (`action-approval.ts:43, 279-281`). **A task-scoped grant is the missing middle ground for long Work and Agent runs.**
4. **Keep binding approvals to content. Muse's incidents show why.** On 2026-09-26 Muse gave a Marketplace buyer a user's street address and replied "Yep I'm here!" while the user was away. Its defence was that the address "was in the auto-reply template you approved". Approving a category of action let the model decide what went into each message. Juno binds each approval to a digest of the exact arguments (`approval-card.tsx:27-34`), which is the stronger primitive. Juno should add a rule that personal data (address, phone, identifiers) in an outbound payload forces a fresh ask even when a standing grant exists.
5. **Make friction follow data flow, not just the verb.** Muse tracks at kernel level ("tainted egress") which processes have read user data. Clean processes keep narrow auto-allow policies; tainted ones fall back to asking. Juno tracks `derivedFromUntrusted` for each turn (`src/lib/trust-boundary.ts:13-40`, `src/lib/tool-audit.ts`). Juno should adopt the principle ("what has this process read?" decides how much we ask) without copying the eBPF machinery.
6. **The system writes the audit log. The agent's own account of events is not an audit log.** The Jason Aten dispute (2026-09-29/30) played out on Threads: Muse explained its own Messages access wrongly, and Meta's rebuttal still left the settings-UI contradiction unresolved. Juno writes an intent row before each connector call and an outcome row after it (`src/lib/tool-audit.ts:9-20`), but no user-facing surface reads `ToolInvocation`. Only `tool-audit.ts` touches it. Juno needs one account-wide activity log, written by the system, that shows which grant allowed each action.
7. **One agent, one long conversation, not turn-by-turn.** Muse lets you send several tasks while it works and interrupt it. It uses chat bubbles because messages arrive out of turn, and "side chats" when you want separation. Juno's chat composer locks while a reply streams (`src/components/chat/composer.tsx:1242`). Only Work and Research runs accept steering (`chat-view.tsx:1868-1907`). **Juno should accept messages at any time.**
8. **Muse's information architecture matches Juno's agent model, so the model is validated but will not set Juno apart.** Muse has Goals with check-ins, Ideas, Upcoming (scheduled tasks), Library, an activity log reached from the avatar, and a status line under the avatar. Juno Agents have goals with cadence, ideas, routines, notes, activity and a face with a state sentence (`src/lib/agents/types.ts:47-141`). Juno has to set itself apart elsewhere: model choice, real coding, depth of Work, and privacy it can prove. It also has to justify the "crew of many agents" idea against Muse's one-agent simplicity.
9. **Proactivity needs a high bar and a dial.** Muse "notifies you only when something is meaningfully new or needs your input" and can be turned off, down or up. Juno's `needs_you / results / all` (`src/lib/agents/domain.ts:107`) is the same dial. Keep the bar high and test it.
10. **Meet people where they already message, but keep consent in a deterministic surface.** Muse works inside WhatsApp with the same account and memory, and at Connect 2026 it gained its own email address. Juno has no messaging channel (a grep for WhatsApp or Telegram finds nothing in `src/`, `relay/src/`, `runner/` or `native/`). A messaging entry point is a genuine reach lesson. **How Muse handles approvals inside WhatsApp is UNVERIFIED.** Juno should route approvals to the native app or a push notification, never to a chat reply.

---

## 2. Capability by capability

### 2.1 Muse, the personal agent as a whole

**(a) What it is today**

- **What it does.** Launched 2026-09-08 as an agent that "doesn't just answer questions, it actually does the work". It opens a browser, fills in forms, sends email, books and pays for things, and "keeps working after people close the app". [1P] [Newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), 2026-09-08
- **Where it runs.** The Mac app with computer use arrived on 2026-09-23. [1P] [Connect recap](https://www.meta.com/blog/meta-connect-2026-everything-we-announced/)
- **Pricing.**
  - Free, with a usage limit.
  - **Power: $20 a month for 500M "Muse tokens" a week.**
  - **Max: $100 a month for 3B a week.**
  - [1P] [About Muse subscriptions](https://www.meta.com/help/subscriptions/1021145227643680/), updated ~2 weeks ago
- **Monetisation.** Zuckerberg says Meta will profit "by taking a small fee from transactions". [press] [TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/), 2026-09-23
- **Design stance, from the design essay.**
  - The first line of the system prompt is "Your purpose is to make your user's life better."
  - It runs as one long main chat plus side chats, and is not turn-by-turn.
  - The avatar and name are yours to set.
  - Transparency is built in: "You can't trust what you can't see."
  - Deterministic UI is "non-negotiable" for approvals and credentials.
  - [1P] [How We Designed Muse](https://introducing.muse.ai/), September 2026
- **Tabs and places named in help.** Chat (main plus side chats), Goals, Ideas, Library (artefacts plus System files), and the Assistant icon, which leads to Activity log, Upcoming and Identity (Memory, Soul). [1P] [Manage your Muse data](https://www.meta.com/help/artificial-intelligence/2225571704857152/)
- **Traction.** 2.5M downloads by around 2026-09-22. [press] [TNW citing Reuters](https://thenextweb.com/news/meta-muse-ai-agent-human-concierge-calls), 2026-09-23. UNVERIFIED by Meta.

**(b) User problem it solves.** "The to-do list I keep in my head." It delegates life admin that spans email, calendar, websites and purchases, and keeps working in the background.

**(c) Does Juno already solve it?** Partly, and differently.

- Juno's centre is a multi-provider chat with delegated Work runs started by a `start_task` tool (`action-approval.ts:113-117`).
- Juno also has persistent named Agents with goals, routines, notes and a per-agent computer (`src/lib/agents/types.ts`).
- Juno is a work and power-user tool: many models, Code, Research, Artifacts. Muse is one consumer agent aimed at life admin.

**(d) Is theirs better?**

- *As a first experience*, yes. There is one agent to name, one conversation, no model picker, and an Ideas tab that solves "I don't know where to start". Meta says this was a problem they found in testing.
- *As a trustworthy product*, the evidence at launch is mixed:
  - Reuters reported internal tests in which guardrails were bypassed and iCloud photos were exposed. [press] [implicator.ai citing Reuters](https://www.implicator.ai/meta-muse-ai-agent-internal-security-flaws/), 2026-09-08
  - The Marketplace address incident. [press] [TNW](https://thenextweb.com/news/meta-muse-facebook-marketplace-address-buyer-robb), 2026-09-28
  - The Messages-access dispute. [press] [TNW](https://thenextweb.com/news/meta-muse-private-messages-denial-jason-aten), 2026-09-30
  - An undisclosed "human concierge" test that routed calls to contractors. [press] TNW citing Reuters, 2026-09-23

**(e) Principle for Juno.** The default surface should be one continuous relationship: one thread that accepts input at any time, a face, and a plan. Specialist surfaces (Code, Research, Work, Artifacts) should sit behind it and not beside it.

**(f) Do not copy.**

- Metering in opaque "tokens per week". Nobody can reason about 500M Muse tokens.
- Training on user data by default. Muse's "Help improve our AI models" is on at first use.
- Automatically connecting Facebook, Instagram and Threads without an explicit step.
- Undisclosed humans in the loop.

### 2.2 Muse Secure VM

**(a) What it is today.** [1P] [Safety blog](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse), 2026-09-08, Tarek Sheasha

- **The machine.** Each user gets an isolated Linux VM with a Chromium browser and enough compute to compile code, run subagents and run cron jobs.
- **Two security domains on one box.** The agent harness ("Hatch"), the workspace and every tool run in a `systemd-nspawn` runtime cell. The design goal is "two isolated security domains on one box, not an LLM powered agent with root". The cell has:
  - root mapped to an unprivileged host user
  - its own Debian root filesystem
  - filtered syscalls (no `io_uring`)
  - no `CAP_SYS_PTRACE` or `CAP_NET_ADMIN`
- **Services outside the cell**, each a separate systemd unit:
  - `hatch-safety`: independent classifiers
  - `privsep` connector workers
  - `hatch-authd`: credentials
  - Sentinel
  - Postgres for durable state
  - inference and telemetry proxies
- **How they talk.** Over Unix sockets with `SO_PEERCRED` and peer ACLs, which gives "kernel authenticated, least-privilege interprocess communication with no secrets to steal".
- **The user's data.** The VM is the system of record, backed up continuously. Users can "inspect, edit and download these files freely, including Muse's memory about you".
- **Meta's own access.** Meta's policy restricts staff access, but the design "does not prevent Meta from accessing data when necessary". Meta's VP of engineering confirmed to Reuters that access is "technically possible". [press] implicator.ai citing Reuters
- **Confidential VM.** "Later this year", with the source given to auditors and a continuous public audit.

**(b) User problem.** "Where does my agent live, and who else can touch my stuff?" It also gives the agent real compute (shell, compiler, browser) without putting the user's device at risk.

**(c) Does Juno already solve it?** Partly.

- Juno's agent computer is a Docker container per agent, hardened with `--cap-drop ALL`, `--read-only`, `no-new-privileges`, a PID limit, tmpfs mounts and a named volume (`src/lib/computer/docker.ts:41-80`).
- The firewall keeps it off private ranges and cloud metadata (`deploy/agent-computers/firewall.sh:1-14`). The DevTools (CDP) connection is gated by an HMAC token (`deploy/agent-computers/cdp-gate.py`).
- The difference that matters: **Juno puts the agent's tools, the browser, its sign-ins and the shell in one domain.** Juno has no second, host-side domain holding credentials and policy.
- Juno's durable state is in the central Postgres. Muse's is per-user and inside the VM.
- Everything else (chat, memory, Work) runs in Juno's shared app server.

**(d) Is theirs better?** Yes, on isolation. Credentials, policy and classifiers sit in a domain that injected code cannot reach. Muse's post argues this well: "Running these outside of the runtime cell means that attackers cannot disable these protections." A VM per user is expensive, though. Meta can afford it and Juno probably cannot for every user. It isn't needed for every user anyway.

**(e) Principle.** Wherever an agent executes code or drives a browser, split it into an *untrusted cell* (agent, tools, workspace) and a *trusted host* (credentials, policy, classifiers, audit). The two talk only over authenticated local IPC. Keep chat-only users on shared infrastructure. Give a cell only to those who turn on a computer or Work host.

**(f) Do not copy.**

- Marketing the VM as "first-of-its-kind privacy" while staff access stays technically possible. Juno should claim only what it can prove.
- A heavyweight VM for every free user.

### 2.3 Sentinel (permission authority and egress control)

**(a) What it is today.** [1P] Safety blog, 2026-09-08

- **Connector calls.** A connector call sends Sentinel a structured request: connector, method, "class of action", scope and the user's intent. From these Sentinel "generates a user-visible purpose for the request". It then evaluates the user's policy and answers **allow, deny or ask**.
- **Network egress.** Every request goes through a forward proxy (userns, veth, eBPF). Sentinel checks it at layer 4 and layer 7: hostname, resolved IP, port, method, path and the decoded body. It also applies anti-SSRF rules after DNS resolution.
- **Credential insertion** happens at this same boundary (see 2.4).
- **"Tainted egress".** A process starts clean and becomes tainted once it reads user data. Clean requests can use "narrowly bounded auto allow" policies. Tainted or unverifiable processes fall back to asking. It is implemented with eBPF cgroup programs plus LSM hooks that Meta added.
- **When the decision is "ask"**, execution stops. "A dialog is presented to the user directly within the client UI — not via their conversation with Muse — and their answer is routed directly back to Sentinel."
- **Grants.** They are "strict capabilities, not conversational suggestions", bound to a connector or destination and a use case. They can be one-time, session, task, time-bounded or perpetual, and Sentinel "decides which grant types to present".
- **Meta's own caveat.** "This balance is something we expect to tune over time."

**(b) User problem.** Letting an agent act without either rubber-stamping everything or being asked forty times a day. It also stops a manipulated agent from quietly sending data out.

**(c) Does Juno already solve it?** Strongly for connector calls, not at all for raw egress.

What Juno has:

- A deterministic classifier. Juno's own exact rules come first, then deny-first heuristics. Hints from the connector are "evidence, never authority" (`action-approval.ts:1-16, 215-277`).
- Five risk classes and five policies (`:22-43`).
- Receipts bound to a digest of the exact arguments, the policy snapshot and provenance (`:317-336`). The server refuses any answer whose digest doesn't match (`approval-card.tsx:27-34`).
- A 15-minute TTL, with push and inbox delivery (`src/lib/action-approval-store.ts:289-360`).
- Untrusted-content envelopes in the prompt (`src/lib/untrusted-content.ts:36-67`).

What Juno is missing:

- Nothing governs arbitrary HTTP from the agent computer or from Work runners.
- The two policy vocabularies (chat vs Work/Agents) mean two authorities.

**(d) Is theirs better?**

- *Architecturally*, yes. One authority, covering egress, with grants as capabilities.
- *On content integrity*, Juno's receipt digest is better. Muse's grants are keyed to action type and destination. The Marketplace case shows the failure mode: once replies were allowed, the model decided their content. [press] TNW, 2026-09-28; [press] [Memeburn](https://memeburn.com/metas-muse-sent-a-stranger-to-a-users-door-its-permission-settings-explain-why/), 2026-09-30
- Meta's response ("Muse was following direct instructions and correctly asked for permission") was disputed by the user. That is the risk of approvals that are too coarse to audit.

**(e) Principle.**

1. Every side effect, whether a connector call, an HTTP request from a cell or a message to a person, passes one broker. The broker returns allow, deny or ask and records its reason.
2. The broker, not the model, writes the one-line purpose the user reads.
3. Grants carry an explicit scope: once, this task, this destination, this connector, until a time.
4. Anything that goes to a *person* (email, DM, marketplace reply) is content-bound. Under a standing grant, a payload containing personal identifiers re-asks.
5. Friction depends on provenance and taint as well as the verb.

**(f) Do not copy.**

- A per-user eBPF and LSM stack. It is disproportionate for Juno. A per-cell egress proxy with a policy is enough.
- "Always allow" for outbound messages to strangers.
- A separate "agent" persona for the guard. It confuses users. Juno's broker should stay an invisible system, not a second character.

### 2.4 Credential protection (Secure Credentials Store, authd, payments)

**(a) What it is today.** Safety blog [1P], 2026-09-08, unless noted

- **Surrogate tokens.** "code in the runtime cell or a worker only ever sees a 'surrogate' token, minted by authd". Sentinel swaps in the real credential after it authorises the request, so "any attempt to coerce the agent to reveal the actual secrets … is futile".
- **Three separate controls.**
  - "Privsep decides where credential capable code executes."
  - "Authd decides which credential material the authenticated caller can receive."
  - "Sentinel decides whether the requested action may be taken."
- **Built-in connectors** run their business logic in systemd-sandboxed workers outside the cell. Each worker has a credential allow-list keyed on its cgroup: "A calendar worker cannot ask authd for an email credential simply by changing a request parameter."
- **Email hardening.** The email connector filters out one-time codes, password-reset links and magic links, using deterministic filters plus a classifier. The reason given: an inbox is a password-reset skeleton key.
- **Finer-grained scopes than OAuth.** Muse splits read from write, and can drop parts of a scope, for example "remove the ability to access Gmail settings".
- **Browser sign-ins.**
  - A custom client UI captures the username and password and sends them directly to authd.
  - They are injected "at the point of need". The browser subagent sees only an accessibility tree, cannot run JavaScript, and is paused while credentials fill a form or the user takes control.
  - The Help Centre says the credential checks confirm it is "the intended service", that "You connected or authorised the service", and that "You gave Muse permission to perform that type of action". [1P] [Privacy, safety and security](https://www.meta.com/help/artificial-intelligence/1047255454427887/), updated ~2 weeks ago
- **Payments.**
  - A wallet backed by Stripe Link issues single-use card numbers bound to a merchant, an amount and a time window.
  - Every purchase gets an approval "with the exact details of the purchase". Checkout pages are detected even when the user's own card is saved on the site.
  - Link's buyer protections apply.
  - [1P] Safety blog; [1P] [Payments help](https://www.meta.com/help/artificial-intelligence/1436362127544482/), updated ~1 week ago
- **Coming.** Shop Pay and 1Password support. [1P] Newsroom
- **Weak point: the Mac client.** Patrick Wardle showed that a local unprivileged process could rewrite an undocumented `endo_voyager_dictation_endpoint` setting. That redirected dictation audio and leaked the account auth token. [press] [Malwarebytes](https://www.malwarebytes.com/blog/bugs/2026/09/metas-muse-ai-assistant-has-a-zero-day-that-can-turn-it-into-a-mac-backdoor), 2026-09-22. Meta's fix status is UNVERIFIED.

**(b) User problem.** "Can I give it my logins and card without an injected prompt stealing them?"

**(c) Does Juno already solve it?** Partly.

What Juno has:

- For credentials-kind connectors (iCloud, MusicKit), the model gets an HMAC token valid for 15 minutes and "never the underlying iCloud app password / MusicKit user token". The real secret is decrypted server-side by Juno's MCP route (`src/lib/connector-token.ts:5-13`).
- OAuth and MCP tokens stay server-side. Composio holds its own tokens.
- Secret-shaped argument keys are redacted from approval cards and the activity panel (`action-approval.ts:170-194`).

What Juno is missing:

- **The agent computer has no credential vault.** The system prompt tells the agent to ask the person to "take over your computer" to type a password (`src/lib/computer/store.ts:1064`). Those sign-ins then persist in the container's Chromium profile, and the same agent has `computer_bash` in that container (`docs/JUNO.md:2090-2092`).
- **No payment primitive.** Computer purchases are gated only by a keyword heuristic that looks for "payment", "checkout" or "buy" (`src/lib/agent/computer.ts:35-58`).
- **No filtering of OTPs or reset links** on Juno's Apple Mail and Gmail connectors. UNVERIFIED for every connector. A grep found no such filter.

**(d) Is theirs better?** Yes, clearly. Muse separates who can *use* a credential from who can *see* it, and makes payments single-use and bounded. The Mac zero-day is a reminder that a local client on the user's device is part of the trust boundary.

**(e) Principle.**

1. The agent never holds a long-lived secret.
2. Credentials are injected by a trusted component at the boundary, per destination.
3. Browser sign-ins go into a store that the agent's shell cannot read.
4. Money moves only through single-use, amount-bound instruments, with an exact-details approval every time.
5. Inbox connectors strip OTPs, reset links and magic links before the model sees them.
6. Native clients treat their own config and endpoints as attack surface: sign them and pin them.

**(f) Do not copy.**

- "You're responsible for all transactions" as the main safety story (Payments help).
- Letting the agent keep an open, logged-in session on the user's bank-grade sites.

### 2.5 Memories

**(a) What it is today.**

- **Built from** conversations, observed preferences and patterns, Connector context, and "the file-based memory system". [1P] [Personality and memories](https://www.meta.com/help/artificial-intelligence/995796179982326/), updated ~7 hours before reading
- **Stored as editable files.**
  - `Memory.md`
  - `Soul.md`: "core truths, boundaries and personality"
  - `Identity.md`: "name, creature, vibe or tag line"
  - All are reached via Assistant icon, then Identity. [1P] Manage your Muse data
- **Forgetting.** A best-effort "forget skill" that "look[s] for information about a specific person, topic or matter in its memories and supporting files and remove[s] it to the best of its ability". Help also warns that deleting a message may not remove what Muse learned from it. [1P] Manage your Muse data
- **Import.** Settings, then Data controls, then Import memory. You upload the .zip of an export from another assistant. [1P] Personality and memories
- **Export.** "Download your Muse data". Reset deletes everything. [1P] Manage your Muse data
- **Resemblance to OpenClaw.** The file vocabulary closely mirrors OpenClaw's workspace templates, whose IDENTITY.md holds Name, Creature, Vibe, Emoji and Avatar ([docs.openclaw.ai IDENTITY template](https://docs.openclaw.ai/reference/templates/IDENTITY)). Any lineage is UNVERIFIED.

**(b) User problem.** "Know me without my repeating myself, show me what you know, and let me correct it."

**(c) Does Juno already solve it?** Yes, and in several respects more rigorously.

- Structured `MemoryEntry` rows with categories, a lifecycle and consolidation ("dreaming"). See `src/lib/memory*.ts`.
- **Persistent suppressions.** "Forget my old job" becomes a SUPPRESSION entry that every writer path checks (`src/lib/memory-suppression.ts:1-20`). That is stronger than Muse's best-effort forget.
- **Sensitive topics are not stored silently.** These are the GDPR Art. 9 categories plus finances (`src/lib/memory-sensitive.ts:1-38`).
- **Import is parsed deterministically, and the user ticks each fact** (`src/lib/memory-import.ts:1-22`).
- Agents also keep their own notes, with source `user / agent / reflection` (`agents/domain.ts:104`).

**(d) Is theirs better?**

- On *legibility*, yes. "Here is the file, edit it" is honest and easy to grasp, and letting the user edit the agent's own personality ("Soul") is a strong idea.
- On *guarantees*, no. Juno's suppression and sensitive-topic gates are real promises, and Muse's forget is explicitly best-effort.
- Muse's zip import will ingest another product's output, which is text the user didn't write. Juno's memory-import notes flag that as an injection risk.

**(e) Principle.**

- Show memory as one readable document per scope (you, each agent, each project) that the user can edit directly.
- Keep the structured store and suppression list underneath it.
- Make "forget" a guarantee against re-learning, not a best-effort search.
- Label every memory with where it came from.

**(f) Do not copy.**

- "Creature" and "vibe" identity fields, which are gimmicky and brand-risky.
- Training on memory by default.
- Warning that deletion may not delete.

### 2.6 Long-term goals (Goals, Ideas, Upcoming, proactivity)

**(a) What it is today.**

- **Goals tab.** It holds "a clear view of everything Muse was tracking for you, and its plan to get there". Muse is good at "breaking down goals and giving you actionable plans", and you can edit a goal in the tab or by talking to it. [1P] Design essay
- **Check-ins.** Goals are "personal goals that you have set, which Muse will help you track progress and send check-ins". Delete is under a goal's ⋯ menu. [1P] Manage your Muse data
- **Background work.** Muse "continues to work on a schedule and in response to relevant events". It then "evaluates whether the result is worth surfacing, and notifies you only when something is meaningfully new or needs your input". [1P] Design essay
- **Ideas.** Offered as onboarding tips, in an Ideas tab, and as proactive suggestions tied to goals. They exist because "people didn't know where to start". [1P] Design essay
- **Reminders and recurring tasks.** One-off, location-based or recurring, delivered "as messages in your conversation". They are listed under Assistant icon, then Upcoming, and continue until you cancel them. [1P] [Reminders and scheduled tasks](https://www.meta.com/help/artificial-intelligence/1484325780075655/), updated ~2 weeks ago
- **Hands-on report.** A reviewer found it good at catching conflicts proactively, and noted it used consumer words ("feed, ideas, goals, library") rather than "crons, tools, plugins". [press] [Lenny's Newsletter](https://www.lennysnewsletter.com/p/how-i-ai-metas-muse-review-how-warp), 2026-09-21
- **Reliability.** Internal testers reported monitoring that "switched itself off for no apparent reason". [press] implicator.ai citing Reuters

**(b) User problem.** Turning a vague ambition ("get fit", "back-to-school prep") into a plan, tracking it and following up, without the user having to remember to.

**(c) Does Juno already solve it?** Yes, per agent.

- `AgentGoal` has status, a `none / daily / weekly` cadence, `lastCheckInAt` and a note (`agents/domain.ts:89-95`, `types.ts:83-95`).
- `AgentIdea` items are tied to goals (`types.ts:97-107`).
- Routines have human-readable schedules (`types.ts:118-130`).
- Reflection sweeps run every 6 hours (`agents/domain.ts:190`).
- There is a notify level (`:107`).
- **The difference:** Juno spreads goals across many agents. Muse has one place for all of them.

**(d) Is theirs better?** On information architecture, yes. One Goals view for the whole account, and one Upcoming list for everything scheduled, beat hunting through each agent. On substance the two are equivalent. Muse's published reliability issues suggest the hard part is the scheduler, not the UI.

**(e) Principle.** Give the account a single Goals view and a single Upcoming view, whichever agent owns each item. Every goal shows its plan, its last check-in and its next step. Background results go through a "worth interrupting?" gate before they notify.

**(f) Do not copy.**

- Unbounded background monitors with no health signal. Muse's "switched itself off" is exactly what a silent scheduler failure looks like. Juno should surface a stalled routine in words, not as a status dot.

### 2.7 Browser and computer use

**(a) What it is today.**

- **Cloud browser.** A real Chromium behind a virtualisation layer. A separate broker owns the DevTools (CDP) connection, so the browser subagent has no DevTools access and no JavaScript. It sees an accessibility tree and not the raw DOM. [1P] Safety blog
- **Classifiers in the browser watch for:**
  - personal data leaving that is unrelated to the task
  - prompt injection in the DOM, in images and in downloaded files
  - attempts to submit high-risk forms
- Known-malicious sites are blocked using Meta's own blocklist. [1P] Safety blog
- **Watching and taking over.** In chat, "Open browser" opens a viewing window, "Take control of the browser" pauses Muse, and "Stop the task" ends it. The user can ask "Show all URLs you have visited in the last week" or "Show me the cookies you've accepted". Muse "may also accept essential cookies on third-party websites". [1P] [How your Muse agent browses the web](https://www.meta.com/help/artificial-intelligence/2124746764949121/), updated ~2 weeks ago
- **Web access defaults.**
  - "Ask for some actions" asks "when your information may be shared or it visits a website that is unfamiliar".
  - "Always ask" asks "before accessing any website".
  - An Allowed websites list lets you revoke sites.
  - [1P] [Guidance and approval](https://www.meta.com/help/artificial-intelligence/1385290430137537/), updated ~2 weeks ago
- **Mac computer use.** Launched 2026-09-23 [1P].
  - Uses macOS permissions: Full Disk Access, Automation and Notifications.
  - Each local app can be set to Off, Read only, or Read and interact.
  - Deleted files go to the Trash.
  - Help warns that it "gives your agent broad reach across your Mac".
  - [1P] [Files and apps in your Mac](https://www.meta.com/help/artificial-intelligence/1126304576638594/), updated ~1 week ago
- **The Messages dispute.** A journalist showed that the Mac app had synced 187,462 rows of Messages while the settings showed Full Disk Access off. Meta replied that three opt-in steps are needed. The contradiction is unresolved. [press] TNW, 2026-09-30
- **Reliability.** Browser shopping is unreliable, for example the wrong colourway or the wrong film. [press] Lenny's, 2026-09-21

**(b) User problem.** Many services have no API. The agent needs to use the web, and on desktop, local apps and files the way a person would.

**(c) Does Juno already solve it?** Partly.

- **Chat browsing.** Chat has a server-side reader with SSRF checks (`src/lib/agent/browser.ts:40-60`, `isDisallowedHost`, `fetchSafePublicUrl`).
- **Agent computer.**
  - Each agent gets a Docker desktop with Chromium, a shell and nine `computer_*` tools (`docs/JUNO.md:2056, 2089-2092`).
  - There is a live view, and the agent pauses cleanly while the user is `taking_over`. That matches Muse's takeover rule.
  - The brief describes the runtime as not production-ready.
  - Juno Code on the Mac is a separate local agent.
- **What Juno lacks:**
  - An accessibility-tree-only browser subagent. Juno's computer tools include pixel clicks and a shell in the same domain.
  - DOM, image and file injection classifiers.
  - An allowed-websites list.
  - A payment or checkout detector.

**(d) Is theirs better?** Yes, in safety layering. The browser agent has deliberately narrow powers, classifiers run independently of the model, and site allow-lists are visible to the user. The capability itself is similar, and reviewers find it just as unreliable.

**(e) Principle.**

1. Split the browser agent from the shell agent. The web agent gets an accessibility tree and typed actions only, never script evaluation.
2. Keep a user-visible list of allowed sites, with revocation.
3. Stopping, taking over and watching are three distinct controls, each available right where the work is shown.
4. On desktop, access is set per app: Off, Read only, or Read and interact. Settings must reflect the *actual* effective access, or the settings UI becomes the next Aten story.

**(f) Do not copy.**

- Auto-accepting cookies for the user.
- Full Disk Access as the entry ticket for reading one app. Ask for the narrowest grant macOS allows.
- Selling computer use as ready when shopping success is poor.

### 2.8 Connectors

**(a) What it is today.**

- **Connecting.** Connect by asking ("Connect my Gmail") or in Settings. Some connectors push updates proactively, and those are disclosed before you connect. Disconnecting stops the exchange, but past data "might still remain in Muse's memories". [1P] [How Muse works with Connectors](https://www.meta.com/help/artificial-intelligence/1687253048996149/), updated ~2 weeks ago
- **Meta's own apps.** Facebook, Instagram and Threads connect **automatically** through Accounts Centre. [1P] same page
- **Custom connectors.** Muse builds them from API information and stores them in the Secure Credentials Store. "Meta doesn't review custom connectors." [1P] same page
- **Skills.** For each built-in connector Meta wrote SKILLs, which are "detailed instructions to Muse". [1P] Safety blog. The skills help frames skills as built-in and made by Meta, with usage visible in the Activity log. [1P] [How Muse works with skills](https://www.meta.com/help/artificial-intelligence/2797651547267109/)
- **Developer platform.** Opened 2026-09-18 at [muse.ai/platform](https://muse.ai/platform) [1P]. Submissions go through three steps, and Meta reviews them for "functional, security, and legal requirements" with end-to-end testing. Payments go through Link. Developers submitted "more than 1,500 applications in less than [a] week". [press] TechCrunch, 2026-09-23. Whether submissions must be MCP servers or raw APIs is UNVERIFIED on first-party pages; press says either.
- **New at Connect.** Walmart, Best Buy, Sephora, Instacart, PayPal, Shop Pay, Notion, Granola, GitHub, Box and others. [1P] [Connect news](https://about.fb.com/news/2026/09/the-biggest-news-from-connect-2026/), 2026-09-24
- **Small business.** Asana, Canva, Figma, QuickBooks, Shopify, Slack and others, with the rule "nothing publishes, sends, or spends without your approval". [1P] [Muse for Small Business](https://about.fb.com/news/2026/09/introducing-muse-small-business/), 2026-09-29

**(b) User problem.** Letting the agent act inside the services the user already relies on, with scoped access.

**(c) Does Juno already solve it?** Yes, and it is broader for developers.

- Built-in connectors, Composio, and a custom MCP connector (on a branch) with OAuth (`src/lib/mcp-oauth.ts`, `src/lib/user-mcp.ts`).
- SKILL.md import.
- Connector-level blocking and lockdown feed into the policy digest (`action-approval.ts:343-365`).
- **Juno lacks:**
  - "Connect by asking" from inside the chat.
  - A public directory for third parties.
  - Read/write splitting finer than OAuth scopes.
  - Proactive push from connectors, such as calendar changes as events. UNVERIFIED; I found no generic push path.

**(d) Is theirs better?** On consumer ergonomics, yes: you connect by asking, read-only mode is a first-class choice, and push behaviour is disclosed. On openness Juno is ahead, because MCP and Composio already cover a long tail. Meta's automatic Meta-app connection is a dark pattern, not a strength.

**(e) Principle.**

- For every connector, users choose Off, Read, or Read and act, and Juno enforces a narrower action list than OAuth grants.
- Connecting happens in the flow of conversation, through a deterministic sheet.
- Connectors that push data say so before you connect.
- Custom connectors are clearly labelled "not reviewed by Juno".

**(f) Do not copy.**

- Connecting accounts automatically without an explicit step.
- Custom connectors that the model writes and then runs with stored API keys in the same domain as the agent. Muse at least keeps credentials in the store. Juno's custom MCP must keep the secret server-side.

### 2.9 WhatsApp and other channels (email, glasses, Charm, voice)

**(a) What it is today.**

- **WhatsApp.** "Chat with your agent … using the Muse app or directly in WhatsApp." It uses the same account, and press reports memory and tasks carry over. [1P] Newsroom; [press] [Engadget](https://www.engadget.com/2256577/how-to-get-started-with-meta-s-new-ai-agent-muse/), 2026-09-12
- **What I could not find.** I found no first-party help article specific to WhatsApp. **How approvals, the browser view and artefacts appear inside WhatsApp is UNVERIFIED.** The architecture says approvals are a client-UI dialog, "not via their conversation".
- **Email address.** At Connect 2026 Muse got its own email address, to "get things done" and as a way to reach it. [1P] Connect posts, 2026-09-23/24
- **Glasses.** Wake the agent by name, and it can "act on what you're looking at". [1P] Connect posts
- **Muse Charm.** A pocket device with 5G and a small screen, shipping December 2026. [1P] Connect; [press] [The Decoder](https://the-decoder.com/meta-gives-its-muse-ai-agent-video-avatars-email-addresses-and-mac-control/), 2026-09-24
- **Voice.** "Muse gets work done in the background while you're still talking." [1P] Connect news
- **Phone calls.** An experimental feature that calls businesses on your behalf, with an opt-out for businesses. [1P] [Info for non-users](https://www.meta.com/help/artificial-intelligence/4532990443643263/). A Reuters report says some of these calls were quietly handled by human contractors in an internal test. [press] TNW, 2026-09-23

**(b) User problem.** Reaching the agent without opening another app, and having it reach the world in the channels the world uses: email, phone, messages.

**(c) Does Juno already solve it?** No messaging channel. Juno has web, Mac, iPhone, realtime voice in the composer (`relay/README.md`), push notifications and a phone remote for Code. It has no WhatsApp, iMessage, SMS or email-in for the agent, and no agent-owned email identity.

**(d) Is theirs better?** For reach, yes. It removes the "open the app" step. For control it is unproven: whether consent survives in a channel Meta doesn't fully render as structured UI is UNVERIFIED.

**(e) Principle.**

- A messaging channel is a *thin* surface for asking and being told. Consent, credentials and review always move to a deterministic Juno surface (native app sheet or push action), with a deep link.
- An agent that sends email or messages as itself should do it from its own identity, not the user's, unless the user explicitly chooses otherwise. That also answers the attribution problem Muse leaves to the user. Help suggests *asking* Muse to add "generated by your AI agent".

**(f) Do not copy.**

- Hidden humans on AI calls.
- A new hardware gadget.
- Undisclosed actions performed as the user.

### 2.10 Approval and audit architecture (end to end)

**(a) What it is today.**

- **Defaults.** [1P] [Guidance and approval](https://www.meta.com/help/artificial-intelligence/1385290430137537/), updated ~2 weeks ago
  - Connectors default to "Ask for some actions", which means before every write and "important read actions", or can be set to "Always ask".
  - Web access has its own default (see 2.7).
  - Per-connector overrides exist, plus per-scheduled-task and per-artefact approvals, plus an Allowed websites list.
- **Approval options:** Allow once, Allow for this task, Allow for this site, Always allow, Deny, and "See task details".
- **Muse learns.** "Your Muse learns over time which decisions need your sign-off."
- **Where approvals appear.** Approvals are a "structured approval card" (design essay), rendered as client UI rather than in the conversation (safety blog).
- **Friction philosophy.** Avoid "banner blindness". The default "allows for standard browsing of the web and stops for anything hard to undo". [1P] Design essay
- **Audit.** An Activity log opened from the avatar: "a chronological record of actions that your Muse has taken and permissions that you've given it". It also records which skills were used. Users can browse the system files. [1P] Guidance and approval; Skills
- **Undo and stop.** Available "in chat" for some actions. Sending email cannot be reversed. [1P] Guidance and approval
- **Independent layers.** Classifiers (`hatch-safety`) run outside the agent's cell. The Help Centre says approval checks "operate separately from the AI model". [1P]
- **Bug bounty.** Up to $300k, and up to $130k for a prompt injection that affects one user. [1P] Safety blog

**(b) User problem.** Staying in control of a proactive agent and being able to reconstruct afterwards what it did and why.

**(c) Does Juno already solve it?** The approval half, yes, and more precisely than Muse. The audit half, only partly.

Approval, what Juno has:

- A digest-bound receipt with a typed refusal code for every mismatch (`approval-card.tsx:17-40`).
- The card shows the full redacted arguments, with "Don't allow", "Allow once" and "Allow this action for this connector" (`:752-775`).
- Push and inbox delivery for pending approvals, plus a recovery list (`src/app/api/approvals/route.ts:7-20`).
- For Work, an `ALWAYS_CONFIRM_ACTIONS` floor covering purchase, send, publish, delete and security settings (`work/domain.ts:615-626`).
- For agents, config escalations (enabling a computer, raising autonomy, adding connectors) always ask (`action-approval.ts:129-142`, `docs/JUNO.md:2084-2087`), and benign edits get an inline Undo.

Audit:

- `ToolInvocation` intent and outcome rows (`src/lib/tool-audit.ts:6-20`).
- A per-agent activity feed (`agents/types.ts:132-141`).
- `WorkAuditEvent`.
- **What is missing:** a single user-facing, account-wide activity log that joins these with the grant that allowed each action. Only `src/lib/tool-audit.ts` references `ToolInvocation`. There is also no "Allowed sites / standing grants" page covering all surfaces. The `/permissions` page covers Work hosts (`src/app/(app)/permissions/page.tsx:31-45`).

**(d) Is theirs better?**

- On *coherence*, yes. Two defaults, one list of permissions, one activity log reached from the agent's face, and scoped grants.
- On *integrity*, Juno is better. Digest binding means "what you saw is what runs", and Muse's type-level grants demonstrably let content slip through.
- Muse's claim that it "learns over time which decisions need your sign-off" is worrying if the model, rather than the user, relaxes the policy. Whether it is the model or the policy engine that learns is UNVERIFIED.

**(e) Principle.**

1. Keep two user-facing defaults (Connected apps, Web) with three settings each. Everything finer is an override the user sets on a card.
2. Offer a grant-scope menu on the card: once, this task, this site or connector, always. The broker only offers the scopes that are safe for the risk class.
3. Put one Activity log on the agent's face and in Settings. It is written by the system and shows action, target, data class, grant and result, and the agent cannot edit it. When the agent explains itself, it should quote this log rather than improvise.
4. Only the user relaxes policy, never the model. Any suggestion to relax a rule is itself an approval card.
5. The TTL must suit background work. A 15-minute expiry on a request raised at 3 a.m. by a routine is a silent failure. Park it as "waiting for you" with a push, and re-validate it when answered.

**(f) Do not copy.**

- Letting the model "learn" to ask less.
- Consent only by category for outbound messages to people.
- Leaving undo to the chat, as in "ask your Muse to undo". Undo should be a deterministic control on the log entry wherever the action is reversible.

---

## 3. Interaction and visual patterns (principles, not pixels)

**Composer and conversation**
- *Juno should accept input at any time.* Muse is "not turn-by-turn": users queue several asks and interrupt it, and bubbles separate thoughts that arrive out of order. Juno's composer locks on `isBusy` (`composer.tsx:1242`). It should queue plain chat messages, or treat them as steering, the way it already does for Work and Research.
- *Side chats before new chats.* Muse keeps one main thread and adds side chats "for separate context", and the agent "stays aware across the main chat and side chats". Juno's current conversation list is the reverse default.
- *Connect and configure by asking.* "Connect my Gmail" in conversation opens the deterministic flow. Configuration follows the conversation, but consent always happens on a real sheet.
- *Voice that doesn't block work.* "Muse gets work done in the background while you're still talking." Juno's realtime composer voice should be able to start tasks without ending the voice session.

**Inline tokens and mentions**
- No first-party source documents @-mentions, slash commands or inline tokens in Muse (UNVERIFIED either way). Muse relies on natural language plus a reference to "my budget spreadsheet" that Muse resolves from the Library. For Juno this argues that mentions must stay *optional* accelerators on top of a system that resolves plain-language references well.

**Approvals**
- *Deterministic card, never model prose.* This holds in both products. Muse additionally keeps the card out of the transcript, as a client dialog. Juno's card lives in the transcript but is rendered from the server receipt, so it is safe. It still needs a surface outside the transcript for background work (a sheet, a push action, or an inbox on the face).
- *"See task details" before choosing a scope.* The card is short and the details are one tap away. Juno's disclosure of the full arguments matches this.
- *Scope choices on the card* (once, task, site, always), filtered by risk.
- *Checkout gets its own treatment.* Exact merchant, amount and item, every time.
- *Avoid banner blindness by asking less, not by shouting louder.* Friction goes where actions are hard to undo.

**Progress presentation**
- *A status sentence under the face, in words.* Examples are "Is working", "Making something" and "Is updating memory" [1P Guidance and approval]. It uses no status pill or badge, which fits the owner rule, and matches Juno's face with its `stateSentence` (`agents/types.ts:70-71`, `docs/JUNO.md:2096-2101`).
- *The face is the door to the audit.* Tapping it opens the activity log, the permissions and Upcoming. It is one object for "what are you doing, what did you do, what will you do".
- *Watch, Take control and Stop are three separate verbs*, placed next to the live work.
- *Artefacts are shared in the thread and saved to a Library*, so the thread stays readable.

**Agent presence**
- *A personal name and face drive engagement.* "One of the core features people light up about most" [1P]. Muse's rationale is that "it felt very odd talking to a corporate logo". Juno's agent faces already embody this.
- *One primary agent is easier to understand than a crew.* If Juno keeps several agents, the default should still be one primary agent that hands work to others, with teammates appearing only when they add something.
- *Consumer vocabulary.* Use "feed, ideas, goals, library" rather than cron, tool or plugin [press, Lenny's].
- *Avoid:*
  - Realtime video avatars and "creature/vibe" identity fields. They verge on gimmick and clash with Juno's calm, no-ornament design rules.
  - Proactive messages that don't pass a "worth the interruption" test.

---

## 4. Sources

### First-party (Meta)

1. Meta Newsroom, "Introducing Muse: The World's First Personal AI Agent Built for Everyone", 2026-09-08. https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
2. Tarek Sheasha, "How We Built Safety Into Muse", Meta AI Research, 2026-09-08. https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse (also served at https://security.muse.ai/)
3. Mona Sarantakos with Christine Awad, "How We Designed Muse", September 2026. https://introducing.muse.ai/
4. Meta AI Research, "Introducing Muse Spark 1.3", 2026-09-02. https://research.meta.ai/blog/introducing-muse-spark-1-3
5. Meta Help Centre, "How Muse works with your guidance and approval", updated ~2 weeks before 2026-09-30. https://www.meta.com/help/artificial-intelligence/1385290430137537/
6. Meta Help Centre, "How Muse works with Connectors", updated ~2 weeks ago. https://www.meta.com/help/artificial-intelligence/1687253048996149/
7. Meta Help Centre, "How to customize Muse's personality and memories", updated ~7 hours before reading on 2026-09-30. https://www.meta.com/help/artificial-intelligence/995796179982326/
8. Meta Help Centre, "How Muse handles your privacy, safety and security", updated ~2 weeks ago. https://www.meta.com/help/artificial-intelligence/1047255454427887/
9. Meta Help Centre, "Muse Help Centre" (index). https://www.meta.com/help/artificial-intelligence/1303670544995562/
10. Meta Help Centre, "How your Muse agent browses the web", updated ~2 weeks ago. https://www.meta.com/help/artificial-intelligence/2124746764949121/
11. Meta Help Centre, "How to get started with Muse", updated ~2 weeks ago. https://www.meta.com/help/artificial-intelligence/1331373868832401/
12. Meta Help Centre, "How Muse works with payments", updated ~1 week ago. https://www.meta.com/help/artificial-intelligence/1436362127544482/
13. Meta Help Centre, "How Muse works with skills", updated ~2 weeks ago. https://www.meta.com/help/artificial-intelligence/2797651547267109/
14. Meta Help Centre, "How to manage reminders and scheduled tasks with Muse", updated ~2 weeks ago. https://www.meta.com/help/artificial-intelligence/1484325780075655/
15. Meta Help Centre, "How to manage your Muse data", updated ~2 weeks ago. https://www.meta.com/help/artificial-intelligence/2225571704857152/
16. Meta Help Centre, "How to use Muse with artefacts", updated ~2 weeks ago. https://www.meta.com/help/artificial-intelligence/2074655449783957/
17. Meta Help Centre, "How Muse works with files and apps in your Mac", updated ~1 week ago. https://www.meta.com/help/artificial-intelligence/1126304576638594/
18. Meta Help Centre, "About Muse subscriptions", updated ~2 weeks ago. https://www.meta.com/help/subscriptions/1021145227643680/
19. Meta Help Centre, "Muse subscriptions". https://www.meta.com/help/subscriptions/1625680452306909/
20. Meta Help Centre, "Information for people who don't use Muse", updated ~2 weeks ago. https://www.meta.com/help/artificial-intelligence/4532990443643263/
21. Meta Newsroom, "The Biggest News From Connect 2026", 2026-09-24. https://about.fb.com/news/2026/09/the-biggest-news-from-connect-2026/
22. Meta Blog, "Everything We Announced at Meta Connect 2026", 2026-09-23. https://www.meta.com/blog/meta-connect-2026-everything-we-announced/
23. Meta Newsroom, "The Future Is for Everyone: Muse for Small Business", 2026-09-29. https://about.fb.com/news/2026/09/introducing-muse-small-business/
24. Muse Connector Platform page (read 2026-09-30). https://muse.ai/platform
25. Meta for Developers, "Meta Connect 2026: The end-to-end recap", 2026-09-24. https://developers.meta.com/blog/meta-connect-recap/

### Press, used only to fill gaps (labelled [press] above)

26. Sarah Perez, TechCrunch, "Meta debuts its Muse AI agent. Will consumers trust it?", 2026-09-08. https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/
27. Kirsten Korosec and Lucas Ropek, TechCrunch, "Everything new coming to Meta's AI agent Muse", 2026-09-23. https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/
28. Karissa Bell, Engadget, "How to get started with Meta's new AI agent, Muse", 2026-09-12. https://www.engadget.com/2256577/how-to-get-started-with-meta-s-new-ai-agent-muse/
29. Maximilian Schreiner, The Decoder, "Meta gives its Muse AI agent video avatars, email addresses, and Mac control", 2026-09-24. https://the-decoder.com/meta-gives-its-muse-ai-agent-video-avatars-email-addresses-and-mac-control/
30. Pieter Arntz, Malwarebytes, Muse zero-day (Patrick Wardle), 2026-09-22. https://www.malwarebytes.com/blog/bugs/2026/09/metas-muse-ai-assistant-has-a-zero-day-that-can-turn-it-into-a-mac-backdoor
31. Privacy Guides, "Meta's Muse AI Assistant Vulnerable to Hijacking Via Undocumented Setting", 2026-09-22. It contains the Sentinel-location error noted in section 0. https://www.privacyguides.org/news/2026/09/22/metas-muse-ai-assistant-vulnerable-to-hijacking-via-undocumented-setting/
32. Marcus Schuler, implicator.ai, summarising Reuters' review of internal posts, 2026-09-08. https://www.implicator.ai/meta-muse-ai-agent-internal-security-flaws/
33. The Next Web, "Meta is testing human callers behind its Muse AI agent, Reuters reports", 2026-09-23. https://thenextweb.com/news/meta-muse-ai-agent-human-concierge-calls
34. The Next Web, "Meta's Muse shared a user's address with a Marketplace buyer, he says", 2026-09-28. https://thenextweb.com/news/meta-muse-facebook-marketplace-address-buyer-robb
35. The Next Web, "Meta denies its Muse AI agent read a journalist's private messages", 2026-09-30. https://thenextweb.com/news/meta-muse-private-messages-denial-jason-aten
36. Memeburn, "Meta's Muse Sent a Stranger to a User's Door…", 2026-09-30. https://memeburn.com/metas-muse-sent-a-stranger-to-a-users-door-its-permission-settings-explain-why/
37. Lenny Rachitsky, "How I AI: Meta's Muse review", 2026-09-21. https://www.lennysnewsletter.com/p/how-i-ai-metas-muse-review-how-warp
38. TestingCatalog, "Meta introduces Muse as a proactive personal agent", 2026-09-09. https://www.testingcatalog.com/meta-introduces-muse-as-a-proactive-personal-agent/
39. OpenClaw docs, IDENTITY template, for the vocabulary comparison only. https://docs.openclaw.ai/reference/templates/IDENTITY

Not opened, or blocked (claims from them are not relied on): Axios (403), Forbes (403), Reuters syndications (403), BetaNews (403), and the muse.ai app (it redirects to sign-in).
