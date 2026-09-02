#if DEBUG
import Foundation
import JunoAPI

/// Synthetic **remote** Juno Code fixtures: the sessions a paired Mac holds and
/// the event journal of each, in the exact wire shape the relay serves.
///
/// These are separate from ``PreviewCodeFixtures`` because they model a
/// different product surface. The task fixtures are the server-run "tasks" API
/// (`/api/code/tasks`), which the phone dispatches and watches. These are the
/// **host's own sessions** (`/api/code/devices/{id}/sessions`), which the Mac
/// mirrors up to the relay and the phone browses, steers and approves — the
/// ChatGPT-Remote-class surface. The phone's Code screen had never drawn either
/// of these before the remote browser was built.
///
/// Four sessions, on two hosts, covering what the thread has to be able to
/// show: a run streaming prose and tool activity; a run stopped on an approval;
/// a finished run with a real unified diff and passing tests; and a failed run.
public enum PreviewCodeRemoteFixtures {
    public static let runningSessionID = "rs-composer"
    public static let awaitingSessionID = "rs-migration"
    public static let doneSessionID = "rs-diff"
    public static let failedSessionID = "rs-webhook"
    public static let idleSessionID = "rs-readme"

    /// Answers a `/api/code/devices/<id>/…` request, or nil for a path this
    /// fixture does not model.
    static func body(path: String, method: HTTPMethod) -> Data? {
        guard path.hasPrefix("/api/code/devices/") else { return nil }
        let parts = path.split(separator: "?", maxSplits: 1)
        let route = String(parts[0])
        let query = parts.count > 1 ? String(parts[1]) : ""
        let segments = route.split(separator: "/").map(String.init)
        // ["api", "code", "devices", "<id>", ...]
        guard segments.count >= 4 else { return nil }
        let deviceID = segments[3]

        if segments.count == 5, segments[4] == "commands" {
            return method == .post ? commandBody : json(["command": .null])
        }
        if segments.count == 5, segments[4] == "sessions" {
            return json(["sessions": .array(sessions(for: deviceID))])
        }
        if segments.count >= 6, segments[4] == "sessions" {
            let sessionID = segments[5]
            if segments.count == 7, segments[6] == "events" {
                let after = Int(query.split(separator: "=").last.map(String.init) ?? "0") ?? 0
                let events = events(for: sessionID).filter { event in
                    guard case .object(let object) = event, case .number(let seq)? = object["seq"] else {
                        return false
                    }
                    return Int(seq) > after
                }
                return json([
                    "events": .array(events),
                    "lastSeq": .number(Double(self.events(for: sessionID).count)),
                ])
            }
            if segments.count == 6 {
                if let session = sessions(for: deviceID).first(where: { value in
                    guard case .object(let object) = value, case .string(let id)? = object["sessionID"] else {
                        return false
                    }
                    return id == sessionID
                }) {
                    return json(["session": session, "live": .bool(true), "stale": .bool(false)])
                }
            }
        }
        return nil
    }

    /// The relay's record of a command the phone enqueued.
    private static var commandBody: Data {
        json([
            "command": .object([
                "id": .string("cmd-\(Int(Date().timeIntervalSince1970))"),
                "sessionID": .string(runningSessionID),
                "kind": .string("message"),
                "payload": .object([:]),
                "status": .string("pending"),
            ])
        ])
    }

    // MARK: - Sessions

    static func sessions(for deviceID: String) -> [JunoPreviewJSON] {
        switch deviceID {
        case "dev-mbp":
            return [
                session(
                    id: awaitingSessionID, device: deviceID,
                    title: "Migrate the settings store to the new schema",
                    workspace: ("ws-juno", "juno"), branch: "feat/settings-schema",
                    model: "anthropic:claude-opus-4-8", effort: "high",
                    permission: "approvalRequired", status: "awaiting_approval",
                    pendingChanges: 3, lastSeq: 9,
                    updated: ago(seconds: 40), lastMessage: ago(minutes: 6)
                ),
                session(
                    id: runningSessionID, device: deviceID,
                    title: "Composer: morph the + into its menu",
                    workspace: ("ws-juno", "juno"), branch: "redesign/soft-ui-2026",
                    model: "openai:gpt-5-6", effort: "medium",
                    permission: "auto", status: "running",
                    pendingChanges: 1, lastSeq: 8,
                    updated: ago(seconds: 4), lastMessage: ago(minutes: 2)
                ),
                session(
                    id: doneSessionID, device: deviceID,
                    title: "Fix the flaky sync reconnect test",
                    workspace: ("ws-juno", "juno"), branch: "fix/sync-reconnect",
                    model: "anthropic:claude-opus-4-8", effort: "medium",
                    permission: "approvalRequired", status: "completed",
                    pendingChanges: 2, lastSeq: 12,
                    updated: ago(hours: 1, minutes: 12), lastMessage: ago(hours: 1, minutes: 30)
                ),
                session(
                    id: idleSessionID, device: deviceID,
                    title: "Rewrite the packages README",
                    workspace: ("ws-docs", "juno-docs"), branch: "main",
                    model: "google:gemini-3-flash", effort: nil,
                    permission: "auto", status: "idle",
                    pendingChanges: 0, lastSeq: 3,
                    updated: ago(days: 1, hours: 2), lastMessage: ago(days: 1, hours: 2)
                ),
            ]
        case "dev-studio":
            return [
                session(
                    id: failedSessionID, device: deviceID,
                    title: "Add a webhook for finished cloud runs",
                    workspace: ("ws-infra", "infra"), branch: "main",
                    model: "anthropic:claude-haiku-4-5", effort: nil,
                    permission: "auto", status: "failed",
                    pendingChanges: 0, lastSeq: 5,
                    updated: ago(hours: 5), lastMessage: ago(hours: 5, minutes: 10)
                ),
            ]
        default:
            return []
        }
    }

    // swiftlint:disable:next function_parameter_count
    private static func session(
        id: String, device: String, title: String,
        workspace: (key: String, name: String), branch: String,
        model: String, effort: String?, permission: String, status: String,
        pendingChanges: Int, lastSeq: Int, updated: Date, lastMessage: Date
    ) -> JunoPreviewJSON {
        .object([
            "sessionID": .string(id),
            "deviceID": .string(device),
            "workspaceKey": .string(workspace.key),
            "workspaceName": .string(workspace.name),
            "title": .string(title),
            "modelID": .string(model),
            "reasoningEffort": effort.map { .string($0) } ?? .null,
            "permissionMode": .string(permission),
            "origin": .string("local"),
            "pinned": .bool(false),
            "archived": .bool(false),
            "createdAt": .string(iso(ago(hours: 3))),
            "updatedAt": .string(iso(updated)),
            "lastMessageAt": .string(iso(lastMessage)),
            "currentStatus": .string(status),
            "isRunning": .bool(status == "running"),
            "isAwaitingApproval": .bool(status == "awaiting_approval"),
            "pendingChangeCount": .number(Double(pendingChanges)),
            "activeBranch": .string(branch),
            "lastError": status == "failed"
                ? .string("npm test exited with code 1: 2 failing") : .null,
            "lastEventSequence": .number(Double(lastSeq)),
            "fresh": .bool(true),
        ])
    }

    // MARK: - Events

    static func events(for sessionID: String) -> [JunoPreviewJSON] {
        switch sessionID {
        case runningSessionID: return composerEvents
        case awaitingSessionID: return migrationEvents
        case doneSessionID: return diffEvents
        case failedSessionID: return webhookEvents
        case idleSessionID: return readmeEvents
        default: return []
        }
    }

    private static var composerEvents: [JunoPreviewJSON] {
        let start = ago(minutes: 2)
        return [
            event(1, "status_update", start, ["status": .string("running")]),
            event(2, "user_message", start, [
                "text": .string(
                    "Make the composer's + button morph into its menu with a glassEffectID "
                        + "on iOS 26, keeping the pre-26 fallback."
                ),
            ]),
            event(3, "reasoning_delta", start.addingTimeInterval(4), [
                "text": .string("The menu is a SwiftUI Menu; a morph needs both ends in one GlassEffectContainer."),
            ]),
            event(4, "tool_start", start.addingTimeInterval(8), [
                "toolCallId": .string("c1"), "name": .string("read_file"),
                "summary": .string("Read JunoMobileAttachmentMenu.swift"),
                "input": .string("native/iOS/JunoMobile/App/JunoMobileAttachmentMenu.swift"),
            ]),
            event(5, "tool_result", start.addingTimeInterval(9), [
                "toolCallId": .string("c1"), "output": .string("395 lines"),
            ]),
            event(6, "tool_start", start.addingTimeInterval(11), [
                "toolCallId": .string("c2"), "name": .string("shell"),
                "summary": .string("rg glassEffectID native/iOS"),
                "command": .string("rg -n glassEffectID native/iOS"),
            ]),
            event(7, "command_output", start.addingTimeInterval(12), [
                "toolCallId": .string("c2"),
                "text": .string("App/JunoMobileChrome.swift:281:    func junoGlassID(_ id: some Hashable & Sendable, in namespace: Namespace.ID)"),
            ]),
            event(8, "text_delta", start.addingTimeInterval(15), [
                "text": .string(
                    "The helper already exists but has no call sites. I'll add a namespace to "
                        + "the composer, tag the + and the menu's leading edge with the same id, and "
                        + "wrap both in the existing `JunoGlass` container. Building now…"
                ),
            ]),
        ]
    }

    private static var migrationEvents: [JunoPreviewJSON] {
        let start = ago(minutes: 6)
        return [
            event(1, "status_update", start, ["status": .string("running")]),
            event(2, "user_message", start, [
                "text": .string("Move JunoSettingsStore onto the versioned schema and write the migration."),
            ]),
            event(3, "tool_start", start.addingTimeInterval(3), [
                "toolCallId": .string("m1"), "name": .string("read_file"),
                "summary": .string("Read JunoSettingsStore.swift"),
            ]),
            event(4, "tool_result", start.addingTimeInterval(4), ["toolCallId": .string("m1"), "output": .string("212 lines")]),
            event(5, "file_change", start.addingTimeInterval(40), [
                "path": .string("Sources/JunoStorage/SettingsSchemaV2.swift"),
                "changeKind": .string("create"), "linesAdded": .number(64), "linesRemoved": .number(0),
                "diff": .string(schemaDiff),
            ]),
            event(6, "text_delta", start.addingTimeInterval(45), [
                "text": .string("The migration rewrites the settings table in place. Before I run it against the local database, I need your go-ahead:"),
            ]),
            event(7, "approval_request", start.addingTimeInterval(46), [
                "requestId": .string("appr-1"),
                "summary": .string("Run `sqlite3 accounts.sqlite3 < migrate-v2.sql` in the workspace"),
                "detail": .string("Rewrites the `settings` table. A backup is written to `accounts.sqlite3.bak` first."),
                "risk": .string("high"),
            ]),
            event(8, "status_update", start.addingTimeInterval(46), ["status": .string("awaiting_approval")]),
            event(9, "test_update", start.addingTimeInterval(20), [
                "status": .string("passed"), "passed": .number(31), "failed": .number(0), "total": .number(31),
            ]),
        ]
    }

    private static var diffEvents: [JunoPreviewJSON] {
        let start = ago(hours: 1, minutes: 30)
        return [
            event(1, "status_update", start, ["status": .string("running")]),
            event(2, "user_message", start, [
                "text": .string("NativeSyncMonitorTests.testReconnectsAfterDrop fails about one run in twelve on CI. Make it deterministic."),
            ]),
            event(3, "tool_start", start.addingTimeInterval(5), [
                "toolCallId": .string("d1"), "name": .string("shell"),
                "summary": .string("swift test --filter NativeSyncMonitorTests"),
                "command": .string("swift test --filter NativeSyncMonitorTests"),
            ]),
            event(4, "command_output", start.addingTimeInterval(20), [
                "toolCallId": .string("d1"),
                "text": .string("Test Suite 'NativeSyncMonitorTests' started\nTest Case 'testReconnectsAfterDrop' failed (0.412 seconds).\nXCTAssertEqual failed: (\"reconnecting\") is not equal to (\"live\")\nExecuted 6 tests, with 1 failure"),
            ]),
            event(5, "tool_result", start.addingTimeInterval(21), ["toolCallId": .string("d1"), "exitCode": .number(1)]),
            event(6, "text_delta", start.addingTimeInterval(30), [
                "text": .string("The test races the monitor's backoff timer against the assertion. Injecting the clock makes the reconnect deterministic."),
            ]),
            event(7, "file_change", start.addingTimeInterval(60), [
                "path": .string("Sources/JunoSync/NativeSyncMonitor.swift"),
                "changeKind": .string("edit"), "linesAdded": .number(6), "linesRemoved": .number(3),
                "diff": .string(monitorDiff),
            ]),
            event(8, "file_change", start.addingTimeInterval(70), [
                "path": .string("Tests/JunoSyncTests/NativeSyncMonitorTests.swift"),
                "changeKind": .string("edit"), "linesAdded": .number(9), "linesRemoved": .number(4),
                "diff": .string(testDiff),
            ]),
            event(9, "tool_start", start.addingTimeInterval(80), [
                "toolCallId": .string("d2"), "name": .string("shell"),
                "summary": .string("swift test --filter NativeSyncMonitorTests"),
                "command": .string("swift test --filter NativeSyncMonitorTests"),
            ]),
            event(10, "command_output", start.addingTimeInterval(95), [
                "toolCallId": .string("d2"),
                "text": .string("Executed 6 tests, with 0 failures (0 unexpected) in 0.081 seconds"),
            ]),
            event(11, "test_update", start.addingTimeInterval(96), [
                "status": .string("passed"), "passed": .number(6), "failed": .number(0), "total": .number(6),
            ]),
            event(12, "completed", start.addingTimeInterval(100), [
                "summary": .string("Reconnect timing is now injected; the suite passed 50 runs in a row."),
            ]),
        ]
    }

    private static var webhookEvents: [JunoPreviewJSON] {
        let start = ago(hours: 5, minutes: 10)
        return [
            event(1, "status_update", start, ["status": .string("running")]),
            event(2, "user_message", start, ["text": .string("Post to the relay when a cloud run finishes.")]),
            event(3, "tool_start", start.addingTimeInterval(30), [
                "toolCallId": .string("w1"), "name": .string("shell"), "summary": .string("npm test"),
                "command": .string("npm test"),
            ]),
            event(4, "command_output", start.addingTimeInterval(60), [
                "toolCallId": .string("w1"), "text": .string("2 failing\n  1) webhook signs the payload\n  2) webhook retries on 503"),
            ]),
            event(5, "error", start.addingTimeInterval(61), ["message": .string("npm test exited with code 1: 2 failing")]),
        ]
    }

    private static var readmeEvents: [JunoPreviewJSON] {
        let start = ago(days: 1, hours: 2)
        return [
            event(1, "user_message", start, ["text": .string("The README still describes the pre-split package layout.")]),
            event(2, "text_delta", start.addingTimeInterval(20), [
                "text": .string("Updated the layout section and the build commands. Nothing else in the file referenced the old paths."),
            ]),
            event(3, "status_update", start.addingTimeInterval(21), ["status": .string("idle")]),
        ]
    }

    // MARK: - Diffs

    private static let schemaDiff = """
    diff --git a/Sources/JunoStorage/SettingsSchemaV2.swift b/Sources/JunoStorage/SettingsSchemaV2.swift
    new file mode 100644
    --- /dev/null
    +++ b/Sources/JunoStorage/SettingsSchemaV2.swift
    @@ -0,0 +1,12 @@
    +import Foundation
    +
    +/// Version 2 of the settings table: one row per key, revisioned.
    +enum SettingsSchemaV2 {
    +    static let version = 2
    +
    +    static let migration = \"\"\"
    +    CREATE TABLE settings_v2 (key TEXT PRIMARY KEY, value BLOB, revision INTEGER NOT NULL);
    +    INSERT INTO settings_v2 SELECT key, value, 1 FROM settings;
    +    DROP TABLE settings;
    +    \"\"\"
    +}
    """

    private static let monitorDiff = """
    diff --git a/Sources/JunoSync/NativeSyncMonitor.swift b/Sources/JunoSync/NativeSyncMonitor.swift
    --- a/Sources/JunoSync/NativeSyncMonitor.swift
    +++ b/Sources/JunoSync/NativeSyncMonitor.swift
    @@ -41,9 +41,12 @@ public actor NativeSyncMonitor {
         private let coordinator: NativeSyncCoordinator
         private let streamer: any NativeAuthenticatedByteStreaming
    -    private var backoff: TimeInterval = 0.2
    +    private let clock: any Clock<Duration>
    +    private var backoff: Duration = .milliseconds(200)

    -    public init(coordinator: NativeSyncCoordinator, streamer: any NativeAuthenticatedByteStreaming) {
    +    public init(
    +        coordinator: NativeSyncCoordinator,
    +        streamer: any NativeAuthenticatedByteStreaming,
    +        clock: any Clock<Duration> = ContinuousClock()
    +    ) {
             self.coordinator = coordinator
             self.streamer = streamer
    -        try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
    +        try? await clock.sleep(for: backoff)
    """

    private static let testDiff = """
    diff --git a/Tests/JunoSyncTests/NativeSyncMonitorTests.swift b/Tests/JunoSyncTests/NativeSyncMonitorTests.swift
    --- a/Tests/JunoSyncTests/NativeSyncMonitorTests.swift
    +++ b/Tests/JunoSyncTests/NativeSyncMonitorTests.swift
    @@ -12,10 +12,15 @@ final class NativeSyncMonitorTests: XCTestCase {
         func testReconnectsAfterDrop() async throws {
    -        let monitor = NativeSyncMonitor(coordinator: coordinator, streamer: streamer)
    +        let clock = TestClock()
    +        let monitor = NativeSyncMonitor(
    +            coordinator: coordinator, streamer: streamer, clock: clock
    +        )
             await monitor.start(for: account)
             streamer.drop()
    -        try await Task.sleep(nanoseconds: 300_000_000)
    -        XCTAssertEqual(await monitor.phase, .live)
    +        await clock.advance(by: .milliseconds(200))
    +        await monitor.awaitReconnect()
    +        XCTAssertEqual(await monitor.phase, .live)
    +        XCTAssertEqual(streamer.openCount, 2)
         }
    """

    // MARK: - Helpers

    private static func event(
        _ seq: Int, _ kind: String, _ createdAt: Date, _ payload: [String: JunoPreviewJSON]
    ) -> JunoPreviewJSON {
        .object([
            "seq": .number(Double(seq)),
            "kind": .string(kind),
            "payload": .object(payload),
            "createdAt": .string(iso(createdAt)),
        ])
    }

    private static func ago(days: Int = 0, hours: Int = 0, minutes: Int = 0, seconds: Int = 0) -> Date {
        let interval =
            TimeInterval(days) * 86_400 + TimeInterval(hours) * 3_600
            + TimeInterval(minutes) * 60 + TimeInterval(seconds)
        return Date().addingTimeInterval(-interval)
    }

    private static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func json(_ root: [String: JunoPreviewJSON]) -> Data {
        Data(JunoPreviewJSON.object(root).encoded.utf8)
    }
}
#endif
