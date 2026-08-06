import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class HookExtensibilityTests: XCTestCase {
    func testParsesJunoAndClaudeHookShapesIntoSupportedLifecycleEvents() throws {
        let claudeJSON = """
        {
          "hooks": {
            "PreToolUse": [
              {
                "matcher": "^Bash$",
                "hooks": [{"type": "command", "command": "echo before", "timeout": 5}]
              }
            ],
            "PostToolUse": [{"command": "echo after"}],
            "SessionStart": ["echo start"],
            "SessionEnd": [{"type": "command", "command": "echo stop"}]
          }
        }
        """
        let claude = try HookConfigurationParser().parse(
            json: claudeJSON,
            source: .claude,
            path: ".claude/settings.json"
        )

        XCTAssertEqual(claude.hooks.count, 4)
        XCTAssertTrue(claude.diagnostics.isEmpty)
        XCTAssertEqual(claude.hooks[0].source, .claude)
        XCTAssertEqual(claude.hooks.first { $0.event == .beforeCommand }?.matcher.pattern, "^Bash$")
        XCTAssertEqual(claude.hooks.first { $0.event == .beforeCommand }?.timeoutSeconds, 5)

        let junoJSON = """
        {
          "before_command": [{"command": "echo juno", "matcher": "npm"}],
          "session_stop": {"command": "echo done"}
        }
        """
        let juno = try HookConfigurationParser().parse(
            json: junoJSON,
            source: .juno,
            path: ".juno/hooks.json"
        )
        XCTAssertEqual(juno.hooks.map(\.event), [.beforeCommand, .sessionStop])
        XCTAssertEqual(juno.hooks.first?.matcher.pattern, "npm")
    }

    func testParserRejectsUnsupportedAndForbiddenCommandsWithoutMakingThemRunnable() throws {
        let json = """
        {
          "hooks": {
            "PreToolUse": [{"matcher": "[", "hooks": [{"type": "command", "command": "echo bad matcher"}]}],
            "PostToolUse": [{"type": "prompt", "command": "echo unsupported"}],
            "SessionStart": [{"type": "command", "command": "sudo id"}]
          }
        }
        """
        let configuration = try HookConfigurationParser().parse(
            json: json,
            source: .claude,
            path: ".claude/settings.json"
        )

        XCTAssertTrue(configuration.hooks.isEmpty)
        XCTAssertEqual(configuration.diagnostics.count, 3)
        XCTAssertTrue(
            configuration.diagnostics.contains {
                $0.message.contains("regular expression")
            }
        )
        XCTAssertTrue(
            configuration.diagnostics.contains {
                $0.message.contains("Only command hooks")
            }
        )
        XCTAssertTrue(
            configuration.diagnostics.contains {
                $0.message.contains("forbidden")
            }
        )
    }

    func testClaudeWildcardAndStopAliasAreSupportedAndDisableAllHooksWins() throws {
        let active = try HookConfigurationParser().parse(
            json: "{\"hooks\":{\"Stop\":[{\"matcher\":\"*\",\"hooks\":[{\"command\":\"echo stop\"}]}]}}",
            source: .claude,
            path: ".claude/settings.json"
        )
        XCTAssertEqual(active.hooks.count, 1)
        XCTAssertEqual(active.hooks.first?.event, .sessionStop)
        XCTAssertTrue(active.hooks.first?.matcher.isAny == true)

        let disabled = try HookConfigurationParser().parse(
            json: "{\"disableAllHooks\":true,\"hooks\":{\"SessionStart\":[\"echo no\"]}}",
            source: .claude,
            path: ".claude/settings.json"
        )
        XCTAssertTrue(disabled.hooks.isEmpty)
        XCTAssertTrue(disabled.diagnostics.contains { $0.message.contains("disabled") })
    }

    func testMatchingUsesToolNameAndCommandAndKeepsEventsSeparate() throws {
        let json = """
        {"hooks": {"PreToolUse": [
          {"matcher": "^Bash$", "hooks": [{"command": "echo tool"}]},
          {"matcher": "npm", "hooks": [{"command": "echo command"}]},
          {"hooks": [{"command": "echo all"}]}
        ], "SessionStart": [{"matcher": "SessionStart", "command": "echo session"}]}}
        """
        let configuration = try HookConfigurationParser().parse(
            json: json,
            source: .claude,
            path: ".claude/settings.json"
        )

        let context = HookInvocationContext(
            event: .beforeCommand,
            command: "npm test",
            toolName: "run_command"
        )
        let matched = HookDiscoveryResult(hooks: configuration.hooks)
            .matchingHooks(for: .beforeCommand, context: context)
        XCTAssertEqual(matched.count, 3)

        let session = HookInvocationContext(event: .sessionStart)
        let sessionMatches = HookDiscoveryResult(hooks: configuration.hooks)
            .matchingHooks(for: .sessionStart, context: session)
        XCTAssertEqual(sessionMatches.count, 1)
        XCTAssertTrue(
            HookDiscoveryResult(hooks: configuration.hooks)
                .matchingHooks(for: .sessionStop, context: context)
                .isEmpty
        )
    }

    func testHookTrustDecisionPersistsOutsideTheWorkspace() throws {
        let storage = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-hook-policy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: storage) }

        let store = HookPolicyStore(
            storageRoot: storage,
            workspaceID: WorkspaceID(value: "demo")
        )
        let policy = HookExecutionPolicy(
            allowedHookIDs: ["hook-a"],
            permissionMode: .workspaceWrite,
            allowUntrustedHooks: true
        )
        try store.save(policy)

        let loaded = store.load(permissionMode: .fullAccess)
        XCTAssertEqual(loaded.allowedHookIDs, ["hook-a"])
        XCTAssertTrue(loaded.allowUntrustedHooks)
        XCTAssertEqual(loaded.permissionMode, .fullAccess)
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: storage.appendingPathComponent("hook-policies").path
            )
        )
    }

    func testDiscoveryReadsOnlyWorkspaceContainedKnownFiles() throws {
        let root = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }
        let claude = root.appendingPathComponent(".claude", isDirectory: true)
        try FileManager.default.createDirectory(at: claude, withIntermediateDirectories: true)
        let settings = "{\"hooks\":{\"SessionStart\":[\"echo discovered\"]}}"
        try settings.write(
            to: claude.appendingPathComponent("settings.json"),
            atomically: true,
            encoding: .utf8
        )

        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: root)
        let result = HookDiscovery(access: access).discover()
        XCTAssertEqual(result.hooks.count, 1)
        XCTAssertEqual(result.hooks.first?.path, ".claude/settings.json")
        XCTAssertTrue(result.diagnostics.isEmpty)
    }

    func testDefaultPolicyDeniesUnallowlistedUntrustedHookAndDoesNotInvokeExecutor() async throws {
        let hook = makeHook(command: "echo should-not-run")
        let executor = RecordingExecutor(isContained: true)
        let runner = HookRunner(executor: executor)
        let results = await runner.run(
            hooks: [hook],
            context: HookInvocationContext(event: .sessionStart)
        )

        XCTAssertEqual(results.count, 1)
        guard case let .denied(reason) = results[0].status else {
            return XCTFail("expected a denial")
        }
        XCTAssertTrue(reason.contains("allowlisted"))
        XCTAssertTrue(executor.commands.isEmpty)
    }

    func testAllowlistedUntrustedHookStillNeedsExplicitTrustPermission() async {
        let hook = makeHook(command: "echo should-not-run")
        let executor = RecordingExecutor(isContained: true)
        let policy = HookExecutionPolicy(
            allowedHookIDs: [hook.id],
            permissionMode: .fullAccess,
            allowUntrustedHooks: false
        )
        let results = await HookRunner(executor: executor, policy: policy).run(
            hooks: [hook],
            context: HookInvocationContext(event: .sessionStart)
        )

        guard case let .denied(reason) = results[0].status else {
            return XCTFail("expected an untrusted-hook denial")
        }
        XCTAssertTrue(reason.contains("untrusted"))
        XCTAssertTrue(executor.commands.isEmpty)
    }

    func testExplicitAllowlistTrustAndContainedExecutorCanRunHook() async {
        let hook = makeHook(command: "echo allowed")
        let executor = RecordingExecutor(isContained: true)
        let policy = HookExecutionPolicy(
            allowedHookIDs: [hook.id],
            permissionMode: .fullAccess,
            allowUntrustedHooks: true
        )
        let results = await HookRunner(executor: executor, policy: policy).run(
            hooks: [hook],
            context: HookInvocationContext(event: .sessionStart)
        )

        guard case .succeeded = results[0].status else {
            return XCTFail("expected the explicitly authorized hook to run: \(results[0])")
        }
        XCTAssertEqual(executor.commands, ["echo allowed"])
        XCTAssertEqual(results[0].stdout, "hook output")
    }

    func testPermissionModeCanUseAnInjectedApprovalAuthorizer() async {
        let hook = makeHook(command: "echo approval")
        let executor = RecordingExecutor(isContained: true)
        let policy = HookExecutionPolicy(
            allowedHookIDs: [hook.id],
            permissionMode: .askBeforeChanges,
            allowUntrustedHooks: true
        )
        let approval = FixedAuthorizer(decision: .allowed)
        let results = await HookRunner(
            executor: executor,
            policy: policy,
            approvalAuthorizer: approval
        ).run(
            hooks: [hook],
            context: HookInvocationContext(event: .sessionStart)
        )

        guard case .succeeded = results[0].status else {
            return XCTFail("expected injected approval to authorize the hook")
        }
        XCTAssertEqual(executor.commands, ["echo approval"])
    }

    func testProductionCommandExecutionServiceIsTheContainedExecutionSeam() async throws {
        try XCTSkipUnless(
            CommandSandboxProfile.isAvailable,
            "sandbox-exec is unavailable on this machine"
        )
        let root = try makeWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }
        let executor = CommandExecutionService.contained(workspaceRootURL: root)
        XCTAssertTrue(executor.isContained)
        let hook = makeHook(command: "echo contained")
        let policy = HookExecutionPolicy(
            allowedHookIDs: [hook.id],
            permissionMode: .fullAccess,
            allowUntrustedHooks: true
        )

        let results = await HookRunner(executor: executor, policy: policy).run(
            hooks: [hook],
            context: HookInvocationContext(event: .sessionStart)
        )
        guard case .succeeded = results[0].status else {
            return XCTFail("expected the contained command executor to run the hook")
        }
        XCTAssertTrue(results[0].stdout.contains("contained"))
    }

    func testRunnerRefusesUncontainedExecutorEvenWhenPolicyAllowsHook() async {
        let hook = makeHook(command: "echo should-not-run")
        let executor = RecordingExecutor(isContained: false)
        let policy = HookExecutionPolicy(
            allowedHookIDs: [hook.id],
            permissionMode: .fullAccess,
            allowUntrustedHooks: true
        )
        let results = await HookRunner(executor: executor, policy: policy).run(
            hooks: [hook],
            context: HookInvocationContext(event: .sessionStart)
        )

        guard case let .denied(reason) = results[0].status else {
            return XCTFail("expected containment denial")
        }
        XCTAssertTrue(reason.contains("contained"))
        XCTAssertTrue(executor.commands.isEmpty)
    }

    private func makeHook(command: String) -> HookDefinition {
        HookDefinition(
            event: .sessionStart,
            command: command,
            source: .juno,
            path: ".juno/hooks.json"
        )
    }

    private func makeWorkspace() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-hook-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}

private final class RecordingExecutor: HookCommandExecuting, @unchecked Sendable {
    let isContained: Bool
    private let lock = NSLock()
    private var recordedCommands: [String] = []

    init(isContained: Bool) {
        self.isContained = isContained
    }

    var commands: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recordedCommands
    }

    func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        lock.lock()
        recordedCommands.append(commandLine)
        lock.unlock()
        return AsyncThrowingStream { continuation in
            continuation.yield(.stdout("hook output"))
            continuation.yield(
                .completed(
                    CommandResult(
                        exitCode: 0,
                        wasTimeout: false,
                        wasCancelled: false,
                        wasTruncated: false,
                        durationSeconds: 0.001
                    )
                )
            )
            continuation.finish()
        }
    }
}

private struct FixedAuthorizer: HookAuthorizing {
    let decision: HookAuthorizationDecision

    func authorize(_ invocation: HookInvocation) async -> HookAuthorizationDecision {
        decision
    }
}
