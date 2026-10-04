# Alevr foundation milestone — 2026-10-04

This is a tested local increment in the product rework, not a claim that the full program or production acceptance is complete. The existing canonical capability registry is `src/lib/capabilities.ts`; status in this document is explanatory, not a second source of truth.

## Implemented

- Migrated the existing registry from 14 marketing labels to 31 capabilities with explicit backend, web, macOS, iOS and iPadOS maturity, repository source evidence, acceptance blockers and recorded local verification where available. Existing IDs remain compatible. Unsupported or unaudited client paths are explicitly planned; implementation alone never implies enabled deployment.
- Added `capabilityReleaseBlockers` and `isCapabilityProductionAccepted`. A legacy `stable` label cannot satisfy these functions. Both backend and requested client need acceptance evidence; blockers, unsupported clients and absent production evidence fail the gate. Every entry remains production unaccepted.
- Removed false availability implications for the SAML validator that always throws and the unwired canvas CRDT user experience. The CRDT algorithm and generic DAG coordinator exist, but source inspection found no product transport/UI integration for either (`rg` references lead to the registry, tests and explanatory comments).
- Generated `JunoProductCapabilityRegistry.swift` from the same TypeScript registry. `npm run capabilities:check` now checks both this projection and the existing per-turn model/tool capability contract. The latter remains a separate domain contract, not a duplicate product registry. `npx tsx scripts/generate-capability-maturity.ts --json` emits the entire canonical registry for machine consumption.
- Fixed a concrete authorization downgrade in the existing `classifyExternalAction`: external action tokens now outrank reversible object tokens. Before the change, remote `send_draft`, `share_branch`, `publish_draft` and even a `send` argument on a draft operation could receive `reversible_write`. Under the important-actions policy this auto-allowed the action; under selected-low-risk it could use a standing grant. They now classify as `external_write`, ask or block under every policy, and cannot become standing approvals.

The remote `create_draft` combination is deliberately conservative. A known private-draft tool can receive an audited first-party exact rule; an unknown remote tool combining create and draft does not establish a safe scope merely by its name. Existing exact rules continue to describe trusted application code.

## Design and current competitor evidence

Claude Code's current primary documentation describes deny-before-ask-before-allow rules enforced by the runtime rather than by the model, and granular prompt-generated rules that cover only what the reader approved. The useful principle is a trusted policy boundary plus narrow grants. Alevr already implements that in Code and an exact-action receipt broker for connectors; replacing these with a new engine would duplicate established security infrastructure. [Claude Code permissions](https://code.claude.com/docs/en/permissions).

The MCP specification treats tool annotations as hints and requires user control/confirmation around tools. Metadata alone is insufficient authorization; Alevr's independent maintained rules and conservative unknown classification remain necessary. The chosen improvement prevents a remote low-risk noun from weakening stronger write evidence. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Security audit: preserve existing boundaries

| Boundary | Current source evidence | Local result / limit |
| --- | --- | --- |
| Connector action permissions | `src/lib/action-approval.ts`, `src/lib/action-approval-store.ts` | Existing risk classes, policy modes, argument/policy/receipt digests and reversible-only standing grants retained; downgrade fixed. |
| Work policy enforcement | `src/lib/work/domain.ts`, `runner/agent-core/src/work/types.ts` | Existing risk/mode vocabulary and hard confirmation floor exist. Complete product-wide semantic migration remains a follow-up, not a second taxonomy here. |
| Code permission rules | `runner/agent-core/src/permissions.ts`, `contracts/agent/permission-rules.fixtures.json` | Untrusted project settings may narrow access but cannot widen it. Cloud runner does not trust repository settings or read user settings. |
| Takeover privacy | `src/lib/computer/takeover.ts`, `src/lib/computer/store.ts` | Computer actions/screenshots and browser operations stop during takeover. Tests include discarding an in-flight screenshot after control changes. Real host/process race acceptance remains outstanding. |
| Native computer links | `src/lib/computer/handoff.ts`, `src/lib/computer/live-view.ts` | One-use hashed codes, expiration, revocation/identity checks, second tickets and relay secrets outside URLs; tests pass locally. |
| Stored computer credentials | `src/lib/computer/store.ts`, `src/lib/crypto.ts`, `prisma/schema.prisma` | Encrypted container handles and CDP/VNC secrets exist. This is not a task/domain/scope-restricted credential broker. |
| Provider isolation | `src/lib/computer/provider.ts` | Fake provider refuses production. Real container/network/volume acceptance requires infrastructure. |
| Dormant computer scaffold | `src/lib/agent/computer.ts`, `tests/unified-agent-runtime.test.ts` | The unused scaffold emits success without dispatch. Hosted registry excludes it; preserve that exclusion until a real adapter and approval boundary exist. |
| Safe retrieval | `src/lib/search/fetch-safe.ts`, `tests/search-ssrf.test.ts` | Private-host redirect and bounded response handling tested; provider/key availability still external. |

Read/write hints in `src/lib/tool-access.ts` describe tool metadata. The authorization authority is `src/lib/action-approval.ts`, whose independently verified classification must remain the execution gate. A future caller must not use a metadata read label to bypass the broker.

## Verification completed locally

- `npx tsx --test tests/capabilities-registry.test.ts tests/action-approval.test.ts tests/action-approval-enforcement.test.ts tests/tool-registry.test.ts`: **41 passed**. Includes the new downgrade regression, standing-grant policy matrix, unresolved evidence paths, false production acceptance and client/backend gate checks.
- `npx tsx --test tests/agent-computer-takeover.test.ts tests/agents-computer-handback.test.ts tests/search-ssrf.test.ts tests/cloud-runner-permissions.test.ts tests/unified-agent-runtime.test.ts`: **41 passed**.
- `npm run capabilities:check`: **passed**; model negotiation contract v4 and all 31 product maturity projections match.
- `swiftc -typecheck native/Packages/JunoNativeKit/Sources/JunoCore/Generated/JunoProductCapabilityRegistry.swift`: **passed**. This verifies the standalone generated source, not a full native application build.
- `git diff --check`: **passed** at the foundation checkpoint.

The parent worker owns full-repository typecheck and integration verification. No authenticated workflow, deployed release, signed binary or real credential-injection run was accepted by this milestone.

## Owner and infrastructure blockers

- **Credential broker:** account-scoped encrypted credential storage exists; task-scoped opaque references, allowed host/domain/scope, expiration/revocation, access receipts and boundary-only secret injection need an actual vertical implementation and adversarial tests. Persistent browser profiles must not be treated as unrestricted vaults.
- **Computer acceptance:** a real configured provider, process interruption/restart, takeover race conditions, retained browser secret exposure, isolation and live native/web takeover must be exercised before production acceptance.
- **Client parity:** legacy platform lists express intended support, not demonstrated parity. Native integrations not inspected in this milestone remain planned in surface maturity until checked. Run shared contracts and real platform workflows before promotion.
- **Desktop ownership:** Swift packages and Electron both remain. No third implementation is needed. Source evidence alone does not establish which has stronger operational parity; a workflow-by-workflow inventory and measured resource/security comparison must precede a controlled retirement decision. Neither implementation was deleted.
- **Release evidence:** feature enablement/deployment, authenticated end-to-end acceptance, full native build/signing and release owner receipts are outstanding. Apple signing and production infrastructure require configured external access.
- **Business/privacy:** provider commercial/resale terms, Alevr name/trademark clearance, data-processing/residency and provider retention/training policies, and App Store acceptance require owner review. No code change in this milestone resolves them.

## Next locally achievable milestones

1. Record a platform workflow receipt for each promoted capability; use the current registry and generated gate, never add a competing status document.
2. Extend exact-action approvals into one vertical credential injection path with opaque capability references and deny-first host/task/scope checks.
3. Migrate remaining Work/Code outcome semantics through their existing contracts behind parity fixtures; preserve their current hard confirmation floors.
4. Validate the real takeover workflow under concurrent tool calls and process restart before marking computer security accepted.
