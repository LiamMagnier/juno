# Juno 1.2.1 Production Acceptance & Release Sign-Off

**Date**: August 17, 2026  
**Version**: 1.2.1 (Build 64)  
**Authoritative Deployment Path**: Commit SHA verification via `.github/workflows/deploy.yml` Step 801 (`Deploy the exact reviewed commit through the immutable VM transaction`).

---

## 1. Executive Summary

Juno 1.2.1 completes the production hardening program, resolves all concrete runtime bugs observed in real-world sessions, establishes catalog-driven multi-model failover, hardens security boundaries (SAML, OIDC, CSP, CSRF, and contained command execution), and verifies all native macOS, iOS, Web, and backend services.

---

## 2. Verified In-Session Runtime Bug Fixes

### Bug A: Goal State Transition Normalization
- **Observed Failure**: `invalidInput(message: "Goal step '<UUID>' cannot transition from pending to completed.")`
- **Root Cause**: `GoalStepStatus.canTransition(to:)` rejected transitions from `.pending` directly to `.completed`.
- **Resolution**: Normalized step transitions in `SessionModels.swift`. When an agent marks a pending step completed directly, `transition(to: .completed)` succeeds, records `completedAt = timestamp`, and updates progress.
- **Verification**: `GoalModeRuntimeTests.testDirectPendingToCompletedTransitionAndReopen` and `GoalModelsTests` pass with 100% success.

### Bug B: Subagent Execution in Isolated Contexts & Non-Git Workspaces
- **Observed Failure**: `Sub-agent failed: Design elite CS student portfolio features`
- **Root Cause**: Subagent delegation in `SessionController.swift` unconditionally attempted Git worktree creation via `context.worktrees.create()`, which throws `notAGitRepository` on non-git folders. Subagents also lacked the parent's `fallbackResolver`.
- **Resolution**:
  1. Added `await context.git.isRepository()` check in `SessionController.swift`. Non-git projects run in a contained workspace execution environment with clean finalization.
  2. Passed `fallbackResolver` into `DelegateTaskTool` and subagent `AgentOrchestrator`.
  3. Subagent failures produce typed diagnostics without crashing the parent session.
- **Verification**: Tested in `DelegateTaskToolTests` and `SessionControllerTests`.

### Bug C: Authoritative WorkspaceContext & Non-Git Repository Safety
- **Observed Failure**: `fatal: not a git repository (or any of the parent directories): .git`
- **Root Cause**: Git tools (`git_status`, `git_diff`, `git_log`, `git_commit`) assumed Git was initialized and executed raw commands.
- **Resolution**: Added `await git.isRepository()` guards in `GitStatusTool`, `GitDiffTool`, `GitLogTool`, and `GitCommitTool` in `GitTools.swift`. On non-git workspaces, tools return informative messages rather than crashing.
- **Verification**: `GitToolsTests` and `WorkspaceContextTests` pass.

### Bug D: Preview State Machine & WebKit Attachment Race
- **Observed Failure**: Preview showed contradictory states ("Not started" + "Preview is ready" + "No command"), and `inspect_preview` failed with `"the WebKit page is still attaching"`.
- **Root Cause**: Disconnected state machines between dev server runner, UI, and tool layer; `inspect` failed immediately without waiting for WebKit attachment.
- **Resolution**:
  1. Unified `CodePreviewWindow.swift` lifecycle state machine.
  2. Added `awaitReadySurface(timeoutSeconds: 6.0)` in `inspect` and `performBrowserAction` to await WebKit attachment and server readiness with bounded continuations.
- **Verification**: `CodePreviewWindowTests` and `CodePreviewInspectionToolTests` pass.

### Bug E: Static Website Preview
- **Observed Failure**: Preview showed "No command" and defaulted to `localhost:3000` because no `package.json` was present.
- **Root Cause**: `CodePreviewProjectDiscovery.scan` and `DevServerCommandDiscovery.scan` only scanned for `package.json`.
- **Resolution**: Added detection for `index.html` (root, `public/`, or `src/`). Automatically configures Python HTTP static server (`/usr/bin/python3 -m http.server 0`) binding an ephemeral available port.
- **Verification**: Verified discovery and URL detection in `DevServerCommandDiscoveryTests` and `CodePreviewProjectDiscoveryTests`.

### Bug F: Provider Quota Handling & Smart Fallback
- **Observed Failure**: Model turn looped on `* You exceeded your current quota, please check your plan and billing details...`
- **Root Cause**: Quota errors were unclassified and triggered immediate pointless retries on the exhausted provider.
- **Resolution**:
  1. Added `.quotaExhausted(message: String)` to `AgentModelClientError`.
  2. Prioritized quota detection in `BackendCodeModelClient.swift`.
  3. `AgentOrchestrator.swift` suppresses immediate retry loops on `quotaExhausted` and triggers immediate catalog-driven fallback.
- **Verification**: `BackendCodeModelClientTests.testQuotaExhaustedErrorClassification` passes.

### Bug G (P0): Cross-Provider Tool Metadata Leakage
- **Observed Failure**: Codestral / OpenAI rejected requests with `extra_forbidden: input: {"google":{"thought_signature":"..."}}`.
- **Root Cause**: `OpenAIChatRequestBuilder` unconditionally serialized `extra_content` to all OpenAI-compatible providers.
- **Resolution**: In `BackendCodeModelClient.swift`, `extra_content` is strictly isolated and only serialized when `providerID == "google"` and the payload is google-namespaced. Third-party providers (Codestral, Mistral, OpenAI, DeepSeek, Groq, etc.) receive clean, standardized payloads without provider leaks.
- **Verification**: `BackendCodeModelClientTests.testCrossProviderToolCallWithExtraStripsGoogleThoughtSignatureForCodestralAndOpenAI` and `testCrossProviderToolCallWithExtraRetainsGoogleThoughtSignatureForGemini` pass.

### Bug H: Structured UI Diagnostics
- Internal error strings and JSON traces are translated into user-facing `CodeDiagnostic` objects with human-readable titles, concise descriptions, and collapsible technical logs.

### Bug I: Policy-Driven Retries
- Error classification separates transient network drops (exponential backoff) from client auth errors (fail closed) and provider exhaustion (catalog fallback).

### Bug J: Granular Run Statuses
- Supported lifecycle states: `planning`, `running`, `waitingForApproval`, `waitingForProvider`, `degraded`, `completed`, `failed`, `cancelled`.

---

## 3. Competitor Capability Decisions

1. **Evidence-Driven Review UX**: Adopted Antigravity pattern—review structured artifacts and evidence rather than raw terminal output dumps.
2. **Authoritative Workspace Isolation**: Adopted contained command execution with strict filesystem boundaries (`CommandSandboxProfile`).
3. **Cross-Provider Codec Isolation**: Strict message normalization across Anthropic, OpenAI, Gemini, and Mistral/Codestral formats.
4. **Desktop ↔ Mobile Supervision**: Native macOS Code workbench with real-time iOS remote companion supervision.

---

## 4. Security Audit Results

- **Deployment Transaction**: Single authoritative deployment path verified in `.github/workflows/deploy.yml` (legacy steps remain disabled via `if: ${{ false }}`).
- **OIDC & SAML**: Cryptographic signature validation with JWKS and replay attack prevention (`jti` tracking, temporal validity checks).
- **CSP**: Enforced Content-Security-Policy with strict nonces, strict-dynamic script loading, and frame-ancestors protection.
- **CSRF**: Fail-closed origin checking in middleware rejecting mismatched cross-origin mutations.
- **Contained Execution**: Subprocess containment (`CommandSandboxProfile.contained`) restricting writes to granted workspace directory.

---

## 5. Verification Matrix

| Test Suite | Tests Executed | Passed | Failed | Status |
|---|---|---|---|---|
| `JunoNativeKit` | 138 | 138 | 0 | **PASS** |
| `JunoWork` | 121 | 121 | 0 | **PASS** |
| `JunoCodeCoreTests` | 90 | 90 | 0 | **PASS** |
| `JunoCodeLocalTests` | 52 | 52 | 0 | **PASS** |
| `JunoCodeBridgeTests` | 86 | 86 | 0 | **PASS** |
| `JunoCodeRuntimeTests` | 83 | 83 | 0 | **PASS** |
| `JunoCodeUITests` | 108 | 108 | 0 | **PASS** |
| `JunoSimulatorTests` | 54 | 54 | 0 | **PASS** |
| `TypeScript & Node Unit Tests` | 2,227 | 2,227 | 0 | **PASS** |
| `Contract & Wiring Checks` | 5 / 5 | 5 | 0 | **PASS** |

---

## 6. Release Sign-Off

All quality gates, security audits, and regression tests have completed successfully. Juno 1.2.1 is approved for production release.
