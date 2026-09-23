import Foundation
import JunoCodeCore

/// Executes normalized hooks, with authorization and containment checked
/// immediately before each process launch. It deliberately does not expose
/// environment interpolation or a second shell wrapper: a hook receives
/// exactly the command string the parser validated, its event as JSON on
/// standard input, and the project folder in `JUNO_PROJECT_DIR` and
/// `CLAUDE_PROJECT_DIR`.
public struct HookRunner: Sendable {
    private let executor: any HookCommandExecuting
    private let policy: HookExecutionPolicy
    private let approvalAuthorizer: (any HookAuthorizing)?
    private let projectDirectory: String?

    /// - Parameters:
    ///   - executor: In production, a `CommandExecutionService` created with
    ///     `CommandExecutionService.contained(workspaceRootURL:)`.
    ///   - policy: Defaults to deny-all. An allowlist is never inferred from a
    ///     repository file.
    ///   - approvalAuthorizer: An optional adapter for a UI/runtime approval
    ///     coordinator. It is only consulted after the local allowlist/trust
    ///     checks pass and the policy asks for the reader.
    ///   - projectDirectory: The project root hooks are told about. Defaults
    ///     to the invocation's `cwd`.
    public init(
        executor: any HookCommandExecuting,
        policy: HookExecutionPolicy = .denyAll,
        approvalAuthorizer: (any HookAuthorizing)? = nil,
        projectDirectory: String? = nil
    ) {
        self.executor = executor
        self.policy = policy
        self.approvalAuthorizer = approvalAuthorizer
        self.projectDirectory = projectDirectory
    }

    /// Runs every hook that matches one event, all at once, and folds their
    /// answers into one outcome.
    ///
    /// Parallel because that is what Claude Code does and what hook authors
    /// expect: three `PostToolUse` formatters should cost the slowest one,
    /// not the sum. An identical command listed twice runs once. A hook that
    /// is denied does not prevent the others from running, and the batch is
    /// capped.
    public func run(
        hooks: [HookDefinition],
        context: HookInvocationContext
    ) async -> HookEventOutcome {
        var seenCommands = Set<String>()
        let matching = hooks.filter {
            $0.event == context.event
                && $0.matcher.matches(context)
                && seenCommands.insert($0.command).inserted
        }
        let bounded = Array(matching.prefix(HookExecutionLimits.maximumHooksPerRun))
        let input = Self.standardInput(for: context, projectDirectory: projectDirectory)

        var results = await withTaskGroup(
            of: (Int, HookExecutionResult).self,
            returning: [HookExecutionResult].self
        ) { group in
            for (index, hook) in bounded.enumerated() {
                group.addTask {
                    (index, await execute(hook: hook, context: context, standardInput: input))
                }
            }
            var collected: [(Int, HookExecutionResult)] = []
            for await result in group {
                collected.append(result)
            }
            return collected.sorted { $0.0 < $1.0 }.map(\.1)
        }
        if matching.count > bounded.count {
            let omitted = matching.count - bounded.count
            results.append(
                HookExecutionResult(
                    hookID: "hook-batch",
                    event: context.event,
                    status: .skipped(
                        reason: String(omitted) + " matching hooks were skipped after Juno's per-event limit."
                    )
                )
            )
        }
        return HookEventOutcome(event: context.event, results: results)
    }

    /// Executes one hook after re-checking its event, matcher, command policy,
    /// allowlist, trust, permission, and executor containment.
    public func execute(
        hook: HookDefinition,
        context: HookInvocationContext
    ) async -> HookExecutionResult {
        await execute(
            hook: hook,
            context: context,
            standardInput: Self.standardInput(for: context, projectDirectory: projectDirectory)
        )
    }

    private func execute(
        hook: HookDefinition,
        context: HookInvocationContext,
        standardInput: Data
    ) async -> HookExecutionResult {
        let invocation = HookInvocation(hook: hook, context: context)
        guard executor.isContained else {
            return denied(hook: hook, reason: "The hook executor is not kernel-contained.")
        }

        let decision: HookAuthorizationDecision
        switch await policy.authorize(invocation) {
        case .allowed:
            decision = .allowed
        case let .denied(reason):
            decision = .denied(reason: reason)
        case .requiresPermission:
            guard let approvalAuthorizer else {
                return denied(
                    hook: hook,
                    reason: "This hook requires explicit permission, but no approval authorizer is attached."
                )
            }
            decision = await approvalAuthorizer.authorize(invocation)
        }

        switch decision {
        case .allowed:
            break
        case let .requiresPermission(reason):
            return denied(hook: hook, reason: reason)
        case let .denied(reason):
            return denied(hook: hook, reason: reason)
        }

        // The policy classifies the command too, but this second check stays
        // here so a manually constructed HookDefinition cannot weaken the
        // parser's command gate.
        switch CommandClassifier().classify(hook.command) {
        case let .forbidden(reason):
            return denied(hook: hook, reason: "The hook command is forbidden: " + reason)
        case .permitted:
            break
        }

        let root = projectDirectory ?? context.cwd ?? ""
        do {
            let outcome = try await executor.runHook(
                hook.command,
                standardInput: standardInput,
                environment: ["JUNO_PROJECT_DIR": root, "CLAUDE_PROJECT_DIR": root],
                timeoutSeconds: hook.timeoutSeconds,
                outputLimit: OutputLimit(maximumBytes: HookExecutionLimits.maximumOutputBytes)
            )
            let stdout = OutputLimiter.apply(
                OutputLimit(maximumBytes: HookExecutionLimits.maximumOutputBytes),
                to: outcome.stdout
            ).text
            let stderr = OutputLimiter.apply(
                OutputLimit(maximumBytes: HookExecutionLimits.maximumOutputBytes),
                to: outcome.stderr
            ).text
            let result = outcome.result
            let status: HookExecutionStatus
            if result.wasTimeout {
                status = .failed(
                    exitCode: result.exitCode,
                    reason: "The hook timed out after \(Self.seconds(hook.timeoutSeconds))."
                )
            } else if result.wasCancelled {
                status = .failed(exitCode: result.exitCode, reason: "The hook was cancelled.")
            } else if result.exitCode == 0 {
                status = .succeeded(exitCode: 0)
            } else if result.exitCode == 2 {
                let reason = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                status = .blocked(reason: reason.isEmpty ? "The hook exited with status 2." : reason)
            } else {
                var reason = "The hook exited with status \(result.exitCode)."
                if result.wasTruncated {
                    reason += " Its output passed Juno's limit and was cut off."
                }
                status = .failed(exitCode: result.exitCode, reason: reason)
            }
            return HookExecutionResult(
                hookID: hook.id,
                hookName: hook.displayName,
                event: context.event,
                status: status,
                stdout: stdout,
                stderr: stderr,
                output: status == .succeeded(exitCode: 0)
                    ? HookOutput(stdout: stdout, event: context.event)
                    : nil
            )
        } catch let error as CommandExecutionError {
            let reason: String
            switch error {
            case let .forbidden(reason: value): reason = value
            case let .launchFailed(message): reason = message
            }
            return denied(hook: hook, reason: reason)
        } catch {
            return HookExecutionResult(
                hookID: hook.id,
                hookName: hook.displayName,
                event: context.event,
                status: .failed(exitCode: -1, reason: "The hook could not be executed."),
                stderr: "The hook could not be executed."
            )
        }
    }

    /// The event as one line of JSON. Built once per event and shared by every
    /// hook that runs for it.
    static func standardInput(for context: HookInvocationContext, projectDirectory: String?) -> Data {
        Data((context.payload(projectDirectory: projectDirectory).canonicalJSONString() + "\n").utf8)
    }

    private static func seconds(_ value: Double) -> String {
        value == value.rounded() ? "\(Int(value))s" : String(format: "%.1fs", value)
    }

    private func denied(hook: HookDefinition, reason: String) -> HookExecutionResult {
        HookExecutionResult(
            hookID: hook.id,
            hookName: hook.displayName,
            event: hook.event,
            status: .denied(reason: reason)
        )
    }
}

/// One hook's part in an outcome: who said it, and what.
public struct HookVerdict: Equatable, Sendable {
    public let hookID: String
    public let hookName: String
    public let reason: String

    public init(hookID: String, hookName: String, reason: String) {
        self.hookID = hookID
        self.hookName = hookName
        self.reason = reason
    }
}

/// A `PreToolUse` hook's answer about the approval prompt, and who gave it.
public struct HookPermissionVerdict: Equatable, Sendable {
    public let decision: HookPermissionDecision
    public let verdict: HookVerdict
}

/// Every hook's answer for one event, read the way Claude Code documents it.
///
/// - Exit 0 is success. For `UserPromptSubmit` and `SessionStart`, plain
///   standard output is context for the model; JSON on standard output is
///   read for `decision`, `continue`, `systemMessage` and the event's
///   `hookSpecificOutput`.
/// - Exit 2 blocks, with standard error as the reason, for the events that
///   can be blocked. For the others it is shown to the reader and nothing
///   else happens.
/// - Any other exit, a timeout, or a hook Juno refused to run is a
///   non-blocking error: the reader is told, and the run carries on.
public struct HookEventOutcome: Equatable, Sendable {
    public let event: HookLifecycleEvent
    public let results: [HookExecutionResult]
    /// The first hook, in configuration order, that blocked. For
    /// `PreToolUse` that includes `"permissionDecision": "deny"`.
    public private(set) var block: HookVerdict?
    /// A hook that answered `"continue": false`, which ends the run.
    public private(set) var halt: HookVerdict?
    /// `PreToolUse`: the strongest non-blocking permission answer, `ask`
    /// over `allow`, and the hook that gave it.
    public private(set) var permission: HookPermissionVerdict?
    /// Text for the model's context, bounded as Claude Code bounds it.
    public private(set) var additionalContext: [String] = []
    /// Non-blocking failures, for the reader.
    public private(set) var errors: [HookVerdict] = []
    /// `systemMessage`s, for the reader.
    public private(set) var messages: [HookVerdict] = []

    public init(event: HookLifecycleEvent, results: [HookExecutionResult]) {
        self.event = event
        self.results = results
        var contextBudget = HookExecutionLimits.maximumContextCharacters

        func verdict(_ result: HookExecutionResult, _ reason: String) -> HookVerdict {
            HookVerdict(
                hookID: result.hookID,
                hookName: result.hookName,
                reason: Self.bounded(reason, HookExecutionLimits.maximumReasonCharacters)
            )
        }

        for result in results {
            switch result.status {
            case let .blocked(reason):
                if event.canBlock {
                    if block == nil { block = verdict(result, reason) }
                } else {
                    errors.append(verdict(result, reason))
                }

            case .succeeded:
                if let output = result.output {
                    if !output.continueRun, halt == nil {
                        halt = verdict(result, output.stopReason ?? "A hook ended the run.")
                    }
                    if let message = output.systemMessage, !message.isEmpty {
                        messages.append(verdict(result, message))
                    }
                    if output.decision == "block", event.canBlock, block == nil {
                        block = verdict(result, output.reason ?? "A hook blocked this.")
                    }
                    if event == .preToolUse {
                        // `"decision": "approve"` is the older spelling of
                        // `"permissionDecision": "allow"`.
                        let decision = output.permissionDecision
                            ?? (output.decision == "approve" ? .allow : nil)
                        let reason = output.permissionDecisionReason ?? output.reason
                        switch decision {
                        case .deny?:
                            if block == nil {
                                block = verdict(result, reason ?? "A hook denied this tool call.")
                            }
                        case .ask?:
                            if permission?.decision != .ask {
                                permission = HookPermissionVerdict(
                                    decision: .ask,
                                    verdict: verdict(result, reason ?? "")
                                )
                            }
                        case .allow?:
                            if permission == nil {
                                permission = HookPermissionVerdict(
                                    decision: .allow,
                                    verdict: verdict(result, reason ?? "")
                                )
                            }
                        case nil:
                            break
                        }
                    }
                    if let context = output.additionalContext {
                        Self.append(context, to: &additionalContext, budget: &contextBudget)
                    }
                } else if event.addsStandardOutputToContext {
                    Self.append(result.stdout, to: &additionalContext, budget: &contextBudget)
                }

            case let .failed(_, reason):
                let detail = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                let summary = reason ?? "The hook failed."
                errors.append(verdict(result, detail.isEmpty ? summary : summary + " " + detail))

            case let .denied(reason), let .skipped(reason):
                errors.append(verdict(result, reason))
            }
        }
    }

    private static func append(_ text: String, to context: inout [String], budget: inout Int) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, budget > 0 else { return }
        let kept = bounded(trimmed, budget)
        budget -= kept.count
        context.append(kept)
    }

    private static func bounded(_ text: String, _ limit: Int) -> String {
        text.count <= limit ? text : String(text.prefix(max(limit - 1, 0))) + "…"
    }
}
