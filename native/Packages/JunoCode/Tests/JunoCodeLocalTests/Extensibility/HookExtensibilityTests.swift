import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class HookExtensibilityTests: XCTestCase {
    // MARK: - Parsing

    func testParsesEveryClaudeEventInClaudeShape() throws {
        let events = HookLifecycleEvent.allCases.map(\.rawValue)
        let body = events.map { event in
            "\"\(event)\": [{\"matcher\": \"\", \"hooks\": [{\"type\": \"command\", \"command\": \"echo \(event)\", \"timeout\": 5}]}]"
        }.joined(separator: ",")
        let configuration = try HookConfigurationParser().parse(
            json: "{\"hooks\": {\(body)}}",
            source: .claude,
            path: ".claude/settings.json"
        )

        XCTAssertTrue(configuration.diagnostics.isEmpty, "\(configuration.diagnostics)")
        XCTAssertEqual(Set(configuration.hooks.map(\.event)), Set(HookLifecycleEvent.allCases))
        XCTAssertTrue(configuration.hooks.allSatisfy { $0.timeoutSeconds == 5 })
        XCTAssertTrue(configuration.hooks.allSatisfy { $0.source == .claude && $0.isUntrusted })
    }

    func testParsesJunoAndClaudeHookShapesIntoSupportedLifecycleEvents() throws {
        let claudeJSON = """
        {
          "hooks": {
            "PreToolUse": [
              {
                "matcher": "Bash",
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
        XCTAssertEqual(claude.hooks.first { $0.event == .preToolUse }?.matcher.pattern, "Bash")
        XCTAssertEqual(claude.hooks.first { $0.event == .preToolUse }?.timeoutSeconds, 5)
        XCTAssertEqual(
            claude.hooks.first { $0.event == .postToolUse }?.timeoutSeconds,
            HookExecutionLimits.defaultTimeoutSeconds
        )
        XCTAssertEqual(HookExecutionLimits.defaultTimeoutSeconds, 60)
        XCTAssertNotNil(claude.hooks.first { $0.event == .sessionEnd })

        // Juno's own earlier names still load, onto their Claude equivalents.
        let junoJSON = """
        {
          "before_command": [{"command": "echo juno", "matcher": "npm"}],
          "after_command": "echo after",
          "session_start": "echo hello",
          "session_stop": {"command": "echo done"}
        }
        """
        let juno = try HookConfigurationParser().parse(
            json: junoJSON,
            source: .juno,
            path: ".juno/hooks.json"
        )
        XCTAssertEqual(
            Set(juno.hooks.map(\.event)),
            [.preToolUse, .postToolUse, .sessionStart, .stop]
        )
        XCTAssertEqual(juno.hooks.first { $0.event == .preToolUse }?.matcher.pattern, "npm")
    }

    func testJunoSettingsFileNestsHooksAndIgnoresItsOtherSettings() throws {
        let json = """
        {
          "permissions": {"allow": ["Bash(npm test)"]},
          "env": {"CI": "1"},
          "hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "echo context"}]}]}
        }
        """
        let configuration = try HookConfigurationParser().parse(
            data: Data(json.utf8),
            file: .junoProject
        )
        XCTAssertEqual(configuration.hooks.map(\.event), [.userPromptSubmit])
        XCTAssertEqual(configuration.hooks.first?.path, ".juno/settings.json")
        XCTAssertTrue(configuration.diagnostics.isEmpty)

        // A settings file is not the compact hooks file: a top-level key that
        // happens to be an event name is not a hook.
        let bare = try HookConfigurationParser().parse(
            data: Data("{\"Stop\": \"echo no\"}".utf8),
            file: .junoProject
        )
        XCTAssertTrue(bare.hooks.isEmpty)

        let user = try HookConfigurationParser().parse(
            data: Data("{\"hooks\": {\"Notification\": [\"echo ping\"]}}".utf8),
            file: .junoUser
        )
        XCTAssertEqual(user.hooks.first?.trust, .readerConfiguration)
        XCTAssertFalse(user.hooks.first?.isUntrusted ?? true)
    }

    func testParserRejectsUnsupportedAndForbiddenCommandsWithoutMakingThemRunnable() throws {
        let json = """
        {
          "hooks": {
            "PreToolUse": [{"matcher": "[", "hooks": [{"type": "command", "command": "echo bad matcher"}]}],
            "PostToolUse": [{"type": "prompt", "command": "echo unsupported"}],
            "SessionStart": [{"type": "command", "command": "sudo id"}],
            "PreCompact": [{"type": "command", "command": "echo compact"}]
          }
        }
        """
        let configuration = try HookConfigurationParser().parse(
            json: json,
            source: .claude,
            path: ".claude/settings.json"
        )

        XCTAssertTrue(configuration.hooks.isEmpty)
        XCTAssertEqual(configuration.diagnostics.count, 4)
        XCTAssertTrue(configuration.diagnostics.contains { $0.message.contains("regular expression") })
        XCTAssertTrue(configuration.diagnostics.contains { $0.message.contains("Only command hooks") })
        XCTAssertTrue(configuration.diagnostics.contains { $0.message.contains("forbidden") })
        XCTAssertTrue(configuration.diagnostics.contains {
            $0.location == "PreCompact" && $0.message.contains("Unsupported hook event")
        })
    }

    func testLongTimeoutIsClampedAndIfFilterIsDiagnosed() throws {
        let json = """
        {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
          {"type": "command", "command": "echo slow", "timeout": 900, "if": "Bash(rm *)"}
        ]}]}}
        """
        let configuration = try HookConfigurationParser().parse(
            json: json,
            source: .claude,
            path: ".claude/settings.json"
        )
        XCTAssertEqual(configuration.hooks.first?.timeoutSeconds, HookExecutionLimits.maximumTimeoutSeconds)
        XCTAssertTrue(configuration.diagnostics.contains { $0.message.contains("shortened") })
        XCTAssertTrue(configuration.diagnostics.contains { $0.message.contains("`if` filter") })
    }

    func testClaudeWildcardAndStopAliasAreSupportedAndDisableAllHooksWins() throws {
        let active = try HookConfigurationParser().parse(
            json: "{\"hooks\":{\"Stop\":[{\"matcher\":\"*\",\"hooks\":[{\"command\":\"echo stop\"}]}]}}",
            source: .claude,
            path: ".claude/settings.json"
        )
        XCTAssertEqual(active.hooks.count, 1)
        XCTAssertEqual(active.hooks.first?.event, .stop)
        XCTAssertTrue(active.hooks.first?.matcher.isAny == true)

        let disabled = try HookConfigurationParser().parse(
            json: "{\"disableAllHooks\":true,\"hooks\":{\"SessionStart\":[\"echo no\"]}}",
            source: .claude,
            path: ".claude/settings.json"
        )
        XCTAssertTrue(disabled.hooks.isEmpty)
        XCTAssertTrue(disabled.disablesAllHooks)
        XCTAssertTrue(disabled.diagnostics.contains { $0.message.contains("disabled") })
    }

    func testDisplayNameIsTheScriptTheHookRuns() {
        func name(_ command: String) -> String {
            HookDefinition(event: .preToolUse, command: command, source: .claude, path: ".claude/settings.json")
                .displayName
        }
        XCTAssertEqual(name("\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard.sh"), ".claude/hooks/guard.sh")
        XCTAssertEqual(name("python3 hooks/lint.py --strict"), "hooks/lint.py")
        XCTAssertEqual(name("echo hello"), "echo hello")
    }

    // MARK: - Matching

    func testMatcherFollowsClaudeCodeRulesForExactNamesListsAndRegex() {
        func matches(_ pattern: String?, _ tool: String) -> Bool {
            HookMatcher(pattern: pattern).matches(
                HookInvocationContext(event: .preToolUse, toolName: tool)
            )
        }
        // Empty, missing and `*` match everything.
        XCTAssertTrue(matches(nil, "run_command"))
        XCTAssertTrue(matches("", "read_file"))
        XCTAssertTrue(matches("*", "mcp__github__create_issue"))

        // Plain names are exact, against Claude's name or Juno's own.
        XCTAssertTrue(matches("Bash", "run_command"))
        XCTAssertTrue(matches("Bash", "run_tests"))
        XCTAssertTrue(matches("run_command", "run_command"))
        XCTAssertFalse(matches("Bash", "read_file"))
        XCTAssertTrue(matches("Edit|Write", "apply_patch"))
        XCTAssertTrue(matches("Edit|Write", "create_file"))
        XCTAssertFalse(matches("Edit", "multi_edit"), "a plain name must not match MultiEdit")
        XCTAssertTrue(matches("Read", "read_file"))
        XCTAssertTrue(matches("WebFetch", "web_fetch"))

        // Anything else is a regular expression searched for in the name.
        XCTAssertTrue(matches("mcp__.*", "mcp__github__create_issue"))
        XCTAssertTrue(matches("Bash|Edit|mcp__.*", "mcp__memory__store"))
        XCTAssertTrue(matches("Bash|Edit|mcp__.*", "run_command"))
        XCTAssertFalse(matches("mcp__github__.*", "mcp__memory__store"))
        XCTAssertTrue(matches("^Bash$", "run_command"))
        XCTAssertTrue(matches("Notebook.*|Multi.*", "multi_edit"))
    }

    func testMatchersApplyToSourceReasonAndNotificationTypeAndAreIgnoredElsewhere() {
        let startup = HookInvocationContext(event: .sessionStart, source: "startup")
        XCTAssertTrue(HookMatcher(pattern: "startup").matches(startup))
        XCTAssertFalse(HookMatcher(pattern: "resume").matches(startup))

        let notification = HookInvocationContext(event: .notification, notificationType: "permission_prompt")
        XCTAssertTrue(HookMatcher(pattern: "permission_prompt").matches(notification))
        XCTAssertFalse(HookMatcher(pattern: "idle_prompt").matches(notification))

        // Claude Code ignores a matcher on these, and so does Juno.
        for event in [HookLifecycleEvent.userPromptSubmit, .stop, .subagentStop] {
            XCTAssertTrue(HookMatcher(pattern: "Bash").matches(HookInvocationContext(event: event)))
        }
    }

    func testDiscoveryResultSelectsByEventAndMatcher() throws {
        let json = """
        {"hooks": {"PreToolUse": [
          {"matcher": "Bash", "hooks": [{"command": "echo tool"}]},
          {"matcher": "Read", "hooks": [{"command": "echo read"}]},
          {"hooks": [{"command": "echo all"}]}
        ], "SessionStart": [{"matcher": "startup", "hooks": [{"command": "echo session"}]}]}}
        """
        let configuration = try HookConfigurationParser().parse(
            json: json,
            source: .claude,
            path: ".claude/settings.json"
        )
        let result = HookDiscoveryResult(hooks: configuration.hooks)

        let command = HookInvocationContext(event: .preToolUse, toolName: "run_command")
        XCTAssertEqual(
            result.matchingHooks(for: .preToolUse, context: command).map(\.command),
            ["echo tool", "echo all"]
        )
        let session = HookInvocationContext(event: .sessionStart, source: "startup")
        XCTAssertEqual(result.matchingHooks(for: .sessionStart, context: session).count, 1)
        XCTAssertTrue(result.matchingHooks(for: .stop, context: command).isEmpty)
        XCTAssertEqual(result.hooks(for: .preToolUse).count, 3)
    }

    // MARK: - Discovery

    func testDiscoveryReadsEveryKnownFileInOrderWithTheirProvenance() throws {
        let root = try makeWorkspace()
        let home = try makeWorkspace()
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: home)
        }
        try write("{\"hooks\":{\"Stop\":[\"echo claude\"]}}", to: root, ".claude/settings.json")
        try write("{\"hooks\":{\"Stop\":[\"echo claude-local\"]}}", to: root, ".claude/settings.local.json")
        try write("{\"Stop\":[\"echo juno-hooks\"]}", to: root, ".juno/hooks.json")
        try write("{\"hooks\":{\"Stop\":[\"echo juno\"]}}", to: root, ".juno/settings.json")
        try write("{\"hooks\":{\"Stop\":[\"echo juno-local\"]}}", to: root, ".juno/settings.local.json")
        try write("{\"hooks\":{\"Stop\":[\"echo mine\"]}}", to: home, "settings.json")

        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: root)
        let result = HookDiscovery(access: access, userSettingsDirectory: home).discover()

        XCTAssertEqual(
            result.hooks.map(\.command),
            ["echo mine", "echo claude", "echo claude-local", "echo juno-hooks", "echo juno", "echo juno-local"]
        )
        XCTAssertEqual(result.hooks.first?.trust, .readerConfiguration)
        XCTAssertEqual(result.repositoryHooks.count, 5)
        XCTAssertTrue(result.diagnostics.isEmpty, "\(result.diagnostics)")

        // Without a user folder, only the repository speaks.
        let repositoryOnly = HookDiscovery(access: access).discover()
        XCTAssertEqual(repositoryOnly.hooks.count, 5)
    }

    func testDisableAllHooksInAnyFileTurnsEveryHookOff() throws {
        let root = try makeWorkspace()
        let home = try makeWorkspace()
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: home)
        }
        try write("{\"hooks\":{\"Stop\":[\"echo mine\"]}}", to: home, "settings.json")
        try write("{\"disableAllHooks\": true}", to: root, ".claude/settings.local.json")

        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: root)
        let result = HookDiscovery(access: access, userSettingsDirectory: home).discover()
        XCTAssertTrue(result.hooks.isEmpty)
        XCTAssertEqual(result.disabledBy, ".claude/settings.local.json")
    }

    func testSavingSettingsFromTheSettingsWindowKeepsTheFilesHooks() throws {
        let root = try makeWorkspace()
        let home = try makeWorkspace()
        defer {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: home)
        }
        try write("""
        {"git": {"branchPrefix": "juno/"},
         "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo guard", "timeout": 5}]}]}}
        """, to: root, ".juno/settings.json")

        // An unrelated change, the way the Settings window makes one: read,
        // modify, write the whole file back.
        let store = CodeSettingsStore(userDirectory: home)
        try store.update(.project, projectRoot: root) { $0.git?.branchPrefix = "team/" }

        let data = try Data(contentsOf: root.appendingPathComponent(".juno/settings.json"))
        let configuration = try HookConfigurationParser().parse(data: data, file: .junoProject)
        XCTAssertEqual(configuration.hooks.map(\.command), ["echo guard"])
        XCTAssertEqual(configuration.hooks.first?.matcher.pattern, "Bash")
        XCTAssertEqual(configuration.hooks.first?.timeoutSeconds, 5)
        XCTAssertEqual(store.load(.project, projectRoot: root).git?.branchPrefix, "team/")
    }

    func testHookActivityRoundTripsThroughTheTranscript() throws {
        let event = SessionEvent(
            sessionID: CodeSessionID(),
            sequence: 1,
            timestamp: Date(timeIntervalSince1970: 0),
            payload: .hookActivity(HookActivityEvent(
                hookEvent: "PreToolUse",
                hookName: ".claude/hooks/guard.sh",
                outcome: .blocked,
                message: "No.",
                toolCallID: "call-1"
            ))
        )
        let decoded = try JSONDecoder().decode(SessionEvent.self, from: JSONEncoder().encode(event))
        XCTAssertEqual(decoded, event)
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

    // MARK: - Policy

    func testFreshRepositoryHooksDoNotRunUntilTheReaderAllowsThem() async throws {
        // A freshly cloned repository: its hooks are discovered, nothing is
        // allowed, so nothing runs — not even with every mode wide open.
        let hook = makeHook(command: "echo should-not-run")
        let executor = RecordingExecutor(isContained: true)
        let outcome = await HookRunner(
            executor: executor,
            policy: HookExecutionPolicy(permissionMode: .fullAccess)
        ).run(hooks: [hook], context: HookInvocationContext(event: .sessionStart))

        guard case let .denied(reason) = outcome.results[0].status else {
            return XCTFail("expected a denial")
        }
        XCTAssertTrue(reason.contains("allowlisted"))
        XCTAssertTrue(executor.commands.isEmpty)
        XCTAssertEqual(outcome.errors.count, 1, "a refused hook is reported to the reader")
    }

    func testAllowlistedUntrustedHookStillNeedsExplicitTrustPermission() async {
        let hook = makeHook(command: "echo should-not-run")
        let executor = RecordingExecutor(isContained: true)
        let policy = HookExecutionPolicy(
            allowedHookIDs: [hook.id],
            permissionMode: .fullAccess,
            allowUntrustedHooks: false
        )
        let outcome = await HookRunner(executor: executor, policy: policy).run(
            hooks: [hook],
            context: HookInvocationContext(event: .sessionStart)
        )

        guard case let .denied(reason) = outcome.results[0].status else {
            return XCTFail("expected an untrusted-hook denial")
        }
        XCTAssertTrue(reason.contains("untrusted"))
        XCTAssertTrue(executor.commands.isEmpty)
    }

    func testAnEditedHookIsANewHookThatWaitsToBeAllowed() {
        let original = makeHook(command: "echo v1")
        let edited = makeHook(command: "echo v2")
        let policy = HookExecutionPolicy(allowedHookIDs: [original.id], allowUntrustedHooks: true)
        XCTAssertTrue(policy.admits(original))
        XCTAssertFalse(policy.admits(edited))
    }

    func testReadersOwnHooksNeedNoAllowlistButStillRespectReadOnly() async {
        let hook = HookDefinition(
            event: .sessionStart,
            command: "echo mine",
            source: .juno,
            path: HookConfigurationFile.junoUser.path,
            trust: .readerConfiguration
        )
        XCTAssertTrue(HookExecutionPolicy.denyAll.admits(hook))

        let executor = RecordingExecutor(isContained: true)
        let running = await HookRunner(
            executor: executor,
            policy: HookExecutionPolicy(permissionMode: .askBeforeChanges)
        ).run(hooks: [hook], context: HookInvocationContext(event: .sessionStart))
        XCTAssertTrue(running.results[0].succeeded)

        let readOnly = await HookRunner(
            executor: executor,
            policy: HookExecutionPolicy(permissionMode: .readOnly)
        ).run(hooks: [hook], context: HookInvocationContext(event: .sessionStart))
        guard case let .denied(reason) = readOnly.results[0].status else {
            return XCTFail("a read-only session runs nothing")
        }
        XCTAssertTrue(reason.contains("read-only"))
        XCTAssertEqual(executor.commands, ["echo mine"])
    }

    func testAnAllowedRepositoryHookAsksWhereverTheModeAsksBeforeACommand() async {
        // Allowing covers the entry, not the script it runs, which the agent
        // can rewrite wherever it edits without asking. So each run goes
        // through the mode, as the same command through `run_command` would.
        let ordinary = makeHook(command: "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/check.sh")
        let escaping = makeHook(command: "cat /etc/hosts")
        XCTAssertNotEqual(ordinary.risk, .destructive)
        XCTAssertEqual(escaping.risk, .destructive)
        func decision(_ hook: HookDefinition, _ mode: PermissionMode) async -> HookAuthorizationDecision {
            await HookExecutionPolicy(
                allowedHookIDs: [ordinary.id, escaping.id],
                permissionMode: mode,
                allowUntrustedHooks: true
            ).authorize(HookInvocation(hook: hook, context: HookInvocationContext(event: .sessionStart)))
        }

        let fullAccess = await decision(ordinary, .fullAccess)
        XCTAssertEqual(fullAccess, .allowed)
        for mode in [PermissionMode.workspaceWrite, .askBeforeChanges] {
            guard case .requiresPermission = await decision(ordinary, mode) else {
                return XCTFail("an allowed hook must still ask in \(mode), where commands ask")
            }
        }
        guard case .requiresPermission = await decision(escaping, .fullAccess) else {
            return XCTFail("a command that leaves the workspace asks even in Full access")
        }
        guard case .denied = await decision(ordinary, .readOnly) else {
            return XCTFail("a read-only session runs nothing")
        }

        // A runner with no one to ask refuses; one whose reader approves runs it.
        let policy = HookExecutionPolicy(
            allowedHookIDs: [ordinary.id],
            permissionMode: .workspaceWrite,
            allowUntrustedHooks: true
        )
        let executor = RecordingExecutor(isContained: true)
        let refused = await HookRunner(executor: executor, policy: policy)
            .run(hooks: [ordinary], context: HookInvocationContext(event: .sessionStart))
        guard case .denied = refused.results[0].status else {
            return XCTFail("expected a denial without an approval authorizer")
        }
        XCTAssertTrue(executor.commands.isEmpty)
        let approved = await HookRunner(
            executor: executor,
            policy: policy,
            approvalAuthorizer: FixedAuthorizer(decision: .allowed)
        ).run(hooks: [ordinary], context: HookInvocationContext(event: .sessionStart))
        XCTAssertTrue(approved.results[0].succeeded)
        XCTAssertEqual(executor.commands, [ordinary.command])

        // The reader's own hooks are theirs: no prompt in any mode that runs.
        let mine = HookDefinition(
            event: .sessionStart,
            command: "cat /etc/hosts",
            source: .juno,
            path: HookConfigurationFile.junoUser.path,
            trust: .readerConfiguration
        )
        let own = await HookExecutionPolicy(permissionMode: .askBeforeChanges)
            .authorize(HookInvocation(hook: mine, context: HookInvocationContext(event: .sessionStart)))
        XCTAssertEqual(own, .allowed)
    }

    func testRunnerRefusesUncontainedExecutorEvenWhenPolicyAllowsHook() async {
        let hook = makeHook(command: "echo should-not-run")
        let executor = RecordingExecutor(isContained: false)
        let policy = HookExecutionPolicy(
            allowedHookIDs: [hook.id],
            permissionMode: .fullAccess,
            allowUntrustedHooks: true
        )
        let outcome = await HookRunner(executor: executor, policy: policy).run(
            hooks: [hook],
            context: HookInvocationContext(event: .sessionStart)
        )

        guard case let .denied(reason) = outcome.results[0].status else {
            return XCTFail("expected containment denial")
        }
        XCTAssertTrue(reason.contains("contained"))
        XCTAssertTrue(executor.commands.isEmpty)
    }

    // MARK: - Running

    func testRunnerHandsTheHookItsEventOnStdinAndTheProjectInItsEnvironment() async throws {
        let hook = makeHook(event: .preToolUse, command: "echo guard")
        let executor = RecordingExecutor(isContained: true)
        let policy = HookExecutionPolicy(
            allowedHookIDs: [hook.id],
            permissionMode: .fullAccess,
            allowUntrustedHooks: true
        )
        _ = await HookRunner(executor: executor, policy: policy, projectDirectory: "/work/app").run(
            hooks: [hook],
            context: HookInvocationContext(
                event: .preToolUse,
                sessionID: "session-1",
                cwd: "/work/app",
                toolName: "run_command",
                toolUseID: "call-1",
                toolInput: ["command": "npm test"]
            )
        )

        let invocation = try XCTUnwrap(executor.invocations.first)
        XCTAssertEqual(invocation.environment["JUNO_PROJECT_DIR"], "/work/app")
        XCTAssertEqual(invocation.environment["CLAUDE_PROJECT_DIR"], "/work/app")
        let payload = try JSONDecoder().decode(JSONValue.self, from: invocation.standardInput)
        XCTAssertEqual(payload["hook_event_name"]?.stringValue, "PreToolUse")
        XCTAssertEqual(payload["tool_name"]?.stringValue, "Bash")
        XCTAssertEqual(payload["tool_input"]?["command"]?.stringValue, "npm test")
        XCTAssertEqual(payload["session_id"]?.stringValue, "session-1")
        XCTAssertEqual(invocation.standardInput.last, UInt8(ascii: "\n"), "one line of JSON")
    }

    func testMatchingHooksRunInParallelAndAnIdenticalCommandRunsOnce() async {
        let hooks = [
            makeHook(event: .postToolUse, command: "echo one", ordinal: 0),
            makeHook(event: .postToolUse, command: "echo two", ordinal: 1),
            makeHook(event: .postToolUse, command: "echo three", ordinal: 2),
            makeHook(event: .postToolUse, command: "echo one", ordinal: 3),
        ]
        let executor = RecordingExecutor(isContained: true, delay: .milliseconds(400))
        let policy = HookExecutionPolicy(
            allowedHookIDs: Set(hooks.map(\.id)),
            permissionMode: .fullAccess,
            allowUntrustedHooks: true
        )
        let started = ContinuousClock.now
        let outcome = await HookRunner(executor: executor, policy: policy).run(
            hooks: hooks,
            context: HookInvocationContext(event: .postToolUse, toolName: "write_file")
        )
        let elapsed = ContinuousClock.now - started

        XCTAssertEqual(outcome.results.count, 3)
        XCTAssertEqual(Set(executor.commands), ["echo one", "echo two", "echo three"])
        XCTAssertLessThan(elapsed, .milliseconds(1_100), "three 400ms hooks must overlap")
        XCTAssertEqual(outcome.results.map(\.hookID), hooks.prefix(3).map(\.id), "results keep configuration order")
    }

    // MARK: - Helpers

    private func makeHook(
        event: HookLifecycleEvent = .sessionStart,
        command: String,
        ordinal: Int = 0
    ) -> HookDefinition {
        HookDefinition(
            event: event,
            command: command,
            source: .juno,
            path: ".juno/settings.json",
            ordinal: ordinal
        )
    }

    private func makeWorkspace() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-hook-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func write(_ text: String, to root: URL, _ path: String) throws {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try text.write(to: url, atomically: true, encoding: .utf8)
    }
}

/// Records what the runner hands a hook, and answers as told.
final class RecordingExecutor: HookCommandExecuting, @unchecked Sendable {
    struct Invocation {
        let command: String
        let standardInput: Data
        let environment: [String: String]
    }

    let isContained: Bool
    private let delay: Duration?
    private let answer: @Sendable (String) -> (exitCode: Int32, stdout: String, stderr: String)
    private let lock = NSLock()
    private var recorded: [Invocation] = []

    init(
        isContained: Bool,
        delay: Duration? = nil,
        answer: @escaping @Sendable (String) -> (exitCode: Int32, stdout: String, stderr: String) = { _ in
            (0, "hook output", "")
        }
    ) {
        self.isContained = isContained
        self.delay = delay
        self.answer = answer
    }

    var invocations: [Invocation] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    var commands: [String] { invocations.map(\.command) }

    func runHook(
        _ commandLine: String,
        standardInput: Data,
        environment: [String: String],
        timeoutSeconds _: Double,
        outputLimit _: OutputLimit
    ) async throws -> (result: CommandResult, stdout: String, stderr: String) {
        lock.withLock {
            recorded.append(Invocation(command: commandLine, standardInput: standardInput, environment: environment))
        }
        if let delay {
            try await Task.sleep(for: delay)
        }
        let reply = answer(commandLine)
        return (
            CommandResult(
                exitCode: reply.exitCode,
                wasTimeout: false,
                wasCancelled: false,
                wasTruncated: false,
                durationSeconds: 0.001
            ),
            reply.stdout,
            reply.stderr
        )
    }
}

struct FixedAuthorizer: HookAuthorizing {
    let decision: HookAuthorizationDecision

    func authorize(_ invocation: HookInvocation) async -> HookAuthorizationDecision {
        decision
    }
}
