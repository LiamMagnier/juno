import Foundation
import JunoCodeCore

/// Executes normalized hooks one at a time, with authorization and containment
/// checked immediately before each process launch. It deliberately does not
/// expose environment interpolation or a second shell wrapper: a hook receives
/// exactly the command string the parser validated.
public struct HookRunner: Sendable {
    private let executor: any HookCommandExecuting
    private let policy: HookExecutionPolicy
    private let approvalAuthorizer: (any HookAuthorizing)?

    /// - Parameters:
    ///   - executor: In production, a `CommandExecutionService` created with
    ///     `CommandExecutionService.contained(workspaceRootURL:)`.
    ///   - policy: Defaults to deny-all. An allowlist is never inferred from a
    ///     repository file.
    ///   - approvalAuthorizer: An optional adapter for a UI/runtime approval
    ///     coordinator. It is only consulted after the local allowlist/trust
    ///     checks pass and the selected permission mode requires approval.
    public init(
        executor: any HookCommandExecuting,
        policy: HookExecutionPolicy = .denyAll,
        approvalAuthorizer: (any HookAuthorizing)? = nil
    ) {
        self.executor = executor
        self.policy = policy
        self.approvalAuthorizer = approvalAuthorizer
    }

    /// Executes every matching hook in stable configuration order. A hook that
    /// is denied does not prevent later hooks from being reported, but no hook
    /// is run concurrently and the batch is capped.
    public func run(
        hooks: [HookDefinition],
        context: HookInvocationContext
    ) async -> [HookExecutionResult] {
        let matching = hooks.filter {
            $0.event == context.event && $0.matcher.matches(context)
        }
        let bounded = Array(matching.prefix(HookExecutionLimits.maximumHooksPerRun))
        var results: [HookExecutionResult] = []
        results.reserveCapacity(bounded.count + (matching.count > bounded.count ? 1 : 0))

        for hook in bounded {
            results.append(await execute(hook: hook, context: context))
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
        return results
    }

    /// Executes one hook after re-checking its event, matcher, command policy,
    /// allowlist, trust, permission, and executor containment.
    public func execute(
        hook: HookDefinition,
        context: HookInvocationContext
    ) async -> HookExecutionResult {
        let invocation = HookInvocation(hook: hook, context: context)
        guard executor.isContained else {
            return denied(hook: hook, reason: "The hook executor is not kernel-contained.")
        }

        let baseDecision = await policy.authorize(invocation)
        let decision: HookAuthorizationDecision
        switch baseDecision {
        case .allowed, .denied:
            decision = baseDecision
        case .requiresPermission:
            guard let approvalAuthorizer else {
                decision = .denied(
                    reason: "This hook requires explicit permission, but no approval authorizer is attached."
                )
                return denied(hook: hook, reason: decision.reason)
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

        do {
            let outcome = try await executor.run(
                hook.command,
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
            if outcome.result.succeeded {
                return HookExecutionResult(
                    hookID: hook.id,
                    event: context.event,
                    status: .succeeded(exitCode: outcome.result.exitCode),
                    stdout: stdout,
                    stderr: stderr
                )
            }
            var reason: String?
            if outcome.result.wasTimeout { reason = "The hook timed out." }
            if outcome.result.wasCancelled { reason = "The hook was cancelled." }
            if outcome.result.wasTruncated {
                reason = [reason, "Hook output was truncated."].compactMap { $0 }.joined(separator: " ")
            }
            return HookExecutionResult(
                hookID: hook.id,
                event: context.event,
                status: .failed(exitCode: outcome.result.exitCode, reason: reason),
                stdout: stdout,
                stderr: stderr
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
                event: context.event,
                status: .failed(exitCode: -1, reason: "The hook could not be executed."),
                stderr: "The hook could not be executed."
            )
        }
    }

    private func denied(hook: HookDefinition, reason: String) -> HookExecutionResult {
        HookExecutionResult(
            hookID: hook.id,
            event: hook.event,
            status: .denied(reason: reason)
        )
    }
}

private extension HookAuthorizationDecision {
    var reason: String {
        switch self {
        case .allowed:
            return ""
        case let .requiresPermission(reason), let .denied(reason):
            return reason
        }
    }
}
