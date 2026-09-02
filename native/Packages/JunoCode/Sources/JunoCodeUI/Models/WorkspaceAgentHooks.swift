import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

/// Bridges the local Claude/Juno hook implementation to the provider-neutral
/// agent lifecycle. The adapter is attached only when the user has an explicit
/// private-storage allowlist, so merely committing `.claude/settings.json` to a
/// repository cannot execute code or alter a session.
struct WorkspaceAgentHooks: AgentLifecycleHooks, Sendable {
    private let definitions: [HookDefinition]
    private let executor: CommandExecutionService
    private let permissions: PermissionCoordinator
    private let currentPermissionMode: @Sendable () async -> PermissionMode
    private let allowUntrustedHooks: Bool
    /// Told each hook's identifier after it has run, so Settings can show
    /// "last ran 2 minutes ago" without the hook runner knowing about Settings.
    private let didRun: @Sendable (String) -> Void

    init(
        definitions: [HookDefinition],
        executor: CommandExecutionService,
        permissions: PermissionCoordinator,
        allowUntrustedHooks: Bool,
        currentPermissionMode: @escaping @Sendable () async -> PermissionMode,
        didRun: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.definitions = definitions
        self.executor = executor
        self.permissions = permissions
        self.allowUntrustedHooks = allowUntrustedHooks
        self.currentPermissionMode = currentPermissionMode
        self.didRun = didRun
    }

    func sessionStarted(sessionID: CodeSessionID) async {
        _ = await run(
            event: .sessionStart,
            context: HookInvocationContext(
                event: .sessionStart,
                sessionID: sessionID.value
            )
        )
    }

    func beforeTool(_ invocation: AgentToolHookInvocation) async -> AgentHookDecision {
        let command = invocation.input["command"]?.stringValue
        let results = await run(
            event: .beforeCommand,
            context: HookInvocationContext(
                event: .beforeCommand,
                command: command,
                toolName: invocation.toolName,
                sessionID: invocation.sessionID.value
            )
        )
        guard let failure = results.first(where: { !$0.succeeded }) else {
            return .allow
        }
        return .deny(reason: failure.reason)
    }

    func afterTool(
        _ invocation: AgentToolHookInvocation,
        succeeded: Bool,
        summary: String
    ) async {
        let command = invocation.input["command"]?.stringValue
        _ = await run(
            event: .afterCommand,
            context: HookInvocationContext(
                event: .afterCommand,
                command: command ?? summary,
                toolName: invocation.toolName,
                sessionID: invocation.sessionID.value
            )
        )
    }

    func sessionStopped(sessionID: CodeSessionID, status: SessionStatus) async {
        _ = await run(
            event: .sessionStop,
            context: HookInvocationContext(
                event: .sessionStop,
                command: status.rawValue,
                sessionID: sessionID.value
            )
        )
    }

    private func run(
        event: HookLifecycleEvent,
        context: HookInvocationContext
    ) async -> [HookExecutionResult] {
        let active = definitions.filter { definition in
            definition.event == event
        }
        guard !active.isEmpty, allowUntrustedHooks else { return [] }

        let policy = HookExecutionPolicy(
            allowedHookIDs: Set(active.map(\.id)),
            permissionMode: await currentPermissionMode(),
            allowUntrustedHooks: true
        )
        let runner = HookRunner(
            executor: executor,
            policy: policy,
            approvalAuthorizer: HookPermissionAuthorizer(permissions: permissions)
        )
        let results = await runner.run(hooks: active, context: context)
        for result in results {
            if case .skipped = result.status { continue }
            didRun(result.hookID)
        }
        return results
    }
}

private struct HookPermissionAuthorizer: HookAuthorizing {
    let permissions: PermissionCoordinator

    func authorize(_ invocation: HookInvocation) async -> HookAuthorizationDecision {
        let digest = Digests.sha256Hex(
            JSONValue.object([
                "hook": .string(invocation.hook.id),
                "event": .string(invocation.context.event.rawValue),
                "command": .string(invocation.hook.command),
            ]).canonicalJSONString()
        )
        let outcome = await permissions.authorize(
            toolName: "hook",
            actionDigest: digest,
            risk: invocation.hook.risk,
            summary: "Run (invocation.hook.source.rawValue) hook (invocation.hook.id)",
            approvalPolicy: .alwaysRequiresApproval
        )
        switch outcome {
        case .allowed, .approved:
            return .allowed
        case let .denied(reason):
            return .denied(reason: reason)
        }
    }
}

private extension HookExecutionResult {
    var reason: String {
        switch status {
        case .succeeded:
            return ""
        case let .failed(_, reason):
            return reason ?? "The hook failed."
        case let .denied(reason), let .skipped(reason):
            return reason
        }
    }
}
