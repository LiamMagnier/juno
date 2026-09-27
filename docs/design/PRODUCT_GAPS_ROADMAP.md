# Product roadmap — gaps named in the October 2026 pass

Companion to `PREMIUM_REWORK_PASS.md`. This pass ships connectors/MCP, skills
transparency, voice motion, agents hire and Juno Code transcript quality. The
items below are specified so they are not re-litigated later, and so the
computer runtime is not called production before it is reviewed.

## 0. Runtime honesty (blocks the rest of the computer story)

The per-agent computer (browser, shell, files, take over) exists in
`runner/agent-core` (`computer.ts`, `tools/`, `work/`) and in Work host code,
but:

1. **It is not live for end users** until the server is upgraded and the
   runtime is enabled. Do not market it as shipped.
2. **It is unreviewed.** Treat the container / live-view relay / computer
   tools as untrusted until a human security review and a real multi-user test
   pass land. Gate behind an explicit feature flag after review.
3. Grok Bot and Muse have run similar machines for weeks with real users. Juno
   must not claim parity from a local demo.

**Exit criteria for "computer is production":** threat model note in
`docs/security/`, review of `runner/agent-core/src/computer.ts` + relay
live-view path, abuse tests (SSRF, credential egress, workspace escape), and a
staged rollout.

## 1. Group chats between agents

Grok Bot's model: several named agents in one room divide a job, assign
ownership, message each other, pull the person in for judgment calls.

Juno today: `delegate` / `hand_off_to_teammate` (one task, one teammate, behind
an approval card). `AGENTS.md` §8 deliberately skipped rooms because there is
no **claim model** on the executor.

**Spec:**

- New object `AgentRoom` (or `Conversation.kind = "group"` with many
  `agentId` participants). Keep `kind: "chat"` if phones drop unknown kinds;
  participants carry the agents.
- **Claim model:** a `WorkSession` (or step) has one `ownerAgentId`. Another
  agent may only take it after explicit transfer or timeout. Prevents two
  writers on one file.
- Transcript: agent turns are ordinary assistant turns with face + name;
  agent-to-agent messages are a quieter interleaved style, never fake user
  rows.
- Person is always in the room; approvals remain deterministic cards.
- Budget: one account window; the room cannot outspend the owner.

## 2. Teaching an agent by showing it a task

Grok: watch up to ten minutes of browser use → draft a skill.
Juno refused screen-record capture (`AGENTS.md` §8) for privacy. Re-open with
consent-first design:

**Spec:**

- Explicit start/stop recording chrome; OS-level screen permission; store
  locally encrypted; delete-on-use default.
- Capture is reduced to a **step list + selectors + screenshots the user
  reviews**, then a skill draft (`WorkSkill` `user_authored`).
- Never auto-run from a draft; human edits and enables.
- Alternative lighter path (ship first): "Show me once" as a single
  annotated walkthrough (user narrates + clicks) without continuous recording.

## 3. Password manager / secret card

Muse: vault the agent uses without seeing (Sentinel).
Juno already encrypts connector tokens (`encryptSecret`) and has action
approvals.

**Spec:**

- `SecretCard`: label, kind (password / api key / cookie jar), ciphertext,
  target scope (connector id, domain allowlist).
- Agent tools receive a **capability handle**, never the plaintext. A broker
  injects the secret at the network edge for allowlisted hosts only.
- UI: wallet-style cards in Settings → Secrets; "Use in browser session" is a
  one-time grant with expiry.
- Audit every read with action-approval receipts.

## 4. Safe one-time payment cards

**Spec:**

- Virtual card mint via existing Stripe billing (or a card issuer partner).
  Hard caps: amount, merchant category, expiry, single-use default.
- Purchase is on `ALWAYS_CONFIRM_ACTIONS` floor — never silenced by autonomy.
- Receipt artifact in the agent activity log; refund path documented.

## 5. Messaging an agent (WhatsApp / iMessage)

Muse launched on WhatsApp. Juno has push (APNs, Web Push) but no chat-app
bridge.

**Spec:**

- Inbound webhook → authenticated account link (one-time code in the app).
  Message becomes an ordinary turn in the agent thread.
- Outbound: agent replies only in-thread; notify policy decides push vs
  WhatsApp. Never post to groups without explicit rule.
- iMessage: start with **notifications + rich push** (tap opens thread) before
  full SMS/iMessage send (needs Apple Business Register or Mac relay via
  paired Mac host).
- Rate limits + spend caps on inbound text.

## 6. Reliability track record

Missing: public status, incident history, per-run receipts that survive
replays.

**Spec:**

- Run receipt: every Work/Code run writes a durable summary (inputs hash,
  tools called, files touched, cost, approval decisions).
- Status page + postmortems linked from the product.
- Chaos drills: kill worker mid-run; verify resume from checkpoint
  (`runner/agent-core/src/checkpoints.ts` already exists — prove it).

## Sequencing

| Now (this pass) | Next | Later |
|---|---|---|
| Custom MCP, skills transparency, voice motion, hire chat, Code thinking/writes | Computer runtime review + flag; teach-by-showing lite; secret card | Group rooms with claims; payment cards; WhatsApp bridge; iMessage relay |
