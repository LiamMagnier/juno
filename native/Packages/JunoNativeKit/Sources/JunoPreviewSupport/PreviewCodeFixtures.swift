#if DEBUG
import Foundation
import JunoAPI

/// Synthetic Juno Code fixtures for the UI Preview harness.
///
/// **Why these exist.** The phone's Code surface had never been looked at. The
/// preview call site built `JunoMobileRootView` without a `codeModel`, so
/// `--juno-preview-tab code` rendered the shell's "Something went wrong"
/// placeholder — the same bug Work was fixed for, on the screen next to it. A
/// model with nothing to read would only have moved the failure one layer down,
/// because Code is a relay-backed product with no local store: an empty session
/// list is what a signed-out account looks like, not what the screen is for.
///
/// **Why JSON rather than constructed values.** The same reason
/// ``PreviewWorkFixtures`` gives: going through the wire shape means the harness
/// exercises `NativeCodeTaskClient`'s real decoders, so a screenshot that renders
/// is also evidence the decode path works. A field renamed on the server breaks
/// the preview exactly as it would break the app.
///
/// **The four states worth a screenshot.** A run in flight with tool calls and
/// prose; a run stopped dead waiting for a yes; a finished run with a diff and a
/// pull request; and a run that failed with a reason. Those are the four things
/// the session list and the session log have to be able to say, and until now
/// none of them had ever been drawn.
///
/// **Timestamps are relative to launch**, because the list formats them with
/// `.relative` and a frozen date would render "last month" on every row a week
/// from now.
public enum PreviewCodeFixtures {
    // MARK: - Identifiers

    /// The run in flight: tool calls, a sub-agent, and the agent's own prose.
    public static let runningTaskID = "cd-search"
    /// The run that is blocked on a yes. The densest session state — summary,
    /// log, and a card the agent cannot get past.
    public static let awaitingTaskID = "cd-migrate"
    /// The finished run: a diff, and the pull request it opened.
    public static let doneTaskID = "cd-flake"
    /// The run that failed, with the reason still in the log.
    public static let failedTaskID = "cd-webhook"

    /// Tasks whose event stream must stay open.
    ///
    /// `NativeCodeModel.follow` reconnects the moment a stream ends and only
    /// stops once the task is terminal, so finishing the stream for a live run
    /// puts the model into a 200ms reconnect loop that rebuilds the view under
    /// every screenshot. Holding it open is also the more faithful fixture: a
    /// running task really does have a stream that has not ended.
    static let liveTaskIDs: Set<String> = [
        runningTaskID, awaitingTaskID, "cd-audit", createdTaskID,
    ]

    /// The run a dispatch or a follow-up creates. It has to be a task the rest
    /// of this file knows about: the model opens whatever it is handed and
    /// follows its log, and a stream that answers nothing for a non-terminal
    /// task is reconnected every 200ms for as long as the screen is open.
    static let createdTaskID = "cd-new"

    // MARK: - Routing

    /// Answers any `/api/code/*` request the phone's Code screen makes, or nil
    /// for a path this fixture does not model.
    ///
    /// Method matters here in a way it does not for most of the harness:
    /// `/api/code/tasks` is the session list on GET and creates a run on POST,
    /// and the two responses have different shapes — a list answered to a create
    /// is refused by `TaskWrapperWire`, which is precisely the failure Work's
    /// `/runs` route had to be taught out of.
    static func body(path: String, method: HTTPMethod, empty: Bool) -> Data? {
        guard path.hasPrefix("/api/code/") else { return nil }

        if path == "/api/code/devices" {
            return method == .get ? devicesBody(empty: empty) : registeredDeviceBody
        }
        if path == "/api/code/github/repos" {
            return reposBody(empty: empty)
        }
        if path == "/api/code/tasks" {
            return method == .post ? createdTaskBody() : tasksBody(empty: empty)
        }
        // Every remaining task route is `/api/code/tasks/<id>/<verb>`.
        guard let id = taskID(in: path) else { return json(["tasks": .array([])]) }
        if path.hasSuffix("/respond") {
            return json(["ok": .bool(true)])
        }
        if path.hasSuffix("/cancel") {
            return json(["task": task(id: id, statusOverride: "cancelled") ?? .null])
        }
        return json(["task": task(id: id) ?? .null])
    }

    /// `cd-migrate` out of `/api/code/tasks/cd-migrate/events`.
    static func taskID(in path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count >= 4, parts[0] == "api", parts[1] == "code", parts[2] == "tasks"
        else { return nil }
        return String(parts[3])
    }

    /// One `snapshot` frame, already framed as SSE, for a task's event stream.
    ///
    /// A snapshot rather than a sequence of `events` frames because that is what
    /// the server sends first on every connect, and it is the frame that carries
    /// the task, the whole backlog and any outstanding approval together. The
    /// harness has nothing to replay afterwards — a preview run does not
    /// progress — so one frame is the entire honest fixture.
    static func snapshotFrame(taskID id: String) -> Data? {
        guard let task = task(id: id) else { return nil }
        let payload = JunoPreviewJSON.object([
            "type": .string("snapshot"),
            "task": task,
            "events": .array(events(for: id)),
        ])
        return Data("data: \(payload.encoded)\n\n".utf8)
    }

    // MARK: - Bodies

    /// The computers signed in to Juno Code.
    ///
    /// Two of them, and deliberately not two of the same thing: one Mac that
    /// claims queued work and one that is signed in without serving any. That
    /// second state is the one the picker exists to distinguish — a host can
    /// heartbeat all day and still never pick a task up — and it had no fixture,
    /// so the disabled row and its explanation had never been drawn.
    public static func devicesBody(empty: Bool) -> Data {
        guard !empty else { return json(["devices": .array([])]) }
        return json([
            "devices": .array([
                device(
                    id: "dev-mbp",
                    name: "Liam’s MacBook Pro",
                    platform: "macos",
                    appVersion: "0.9.4",
                    online: true,
                    serves: true,
                    active: 1,
                    lastSeen: ago(seconds: 20),
                    workspaces: [
                        workspace("juno", "/Users/liam/Developer/juno", key: "ws-juno"),
                        workspace("juno-docs", "/Users/liam/Developer/juno-docs", key: "ws-docs"),
                    ]
                ),
                device(
                    id: "dev-studio",
                    name: "Studio Mac mini",
                    platform: "macos",
                    appVersion: "0.9.1",
                    online: true,
                    serves: false,
                    active: 0,
                    lastSeen: ago(seconds: 40),
                    workspaces: [
                        workspace("infra", "/Users/liam/Developer/infra", key: "ws-infra")
                    ]
                ),
            ])
        ])
    }

    /// What a registration POST answers with.
    public static var registeredDeviceBody: Data {
        json(["device": .object(["id": .string("dev-mbp")])])
    }

    /// The repositories the linked GitHub can dispatch a cloud run against.
    public static func reposBody(empty: Bool) -> Data {
        guard !empty else { return json(["repos": .array([])]) }
        return json([
            "repos": .array([
                repo("juno-labs", "juno", private: true, branch: "main", updated: ago(minutes: 8)),
                repo(
                    "juno-labs", "juno-native", private: true, branch: "main",
                    updated: ago(hours: 5)
                ),
                repo(
                    "juno-labs", "juno-relay", private: true, branch: "main",
                    updated: ago(days: 2)
                ),
                repo(
                    "liammagnier", "dotfiles", private: false, branch: "master",
                    updated: ago(days: 26)
                ),
            ])
        ])
    }

    /// The session list, covering every status the rows have to draw.
    public static func tasksBody(empty: Bool) -> Data {
        guard !empty else { return json(["tasks": .array([])]) }
        return json(["tasks": .array(taskIDs.compactMap { task(id: $0) })])
    }

    /// The run a composer dispatch creates: queued, nothing claimed yet.
    ///
    /// Queued rather than running, because that is what the route returns — the
    /// row exists before any runner or Mac has taken it — and the composer's job
    /// in that moment is to say so rather than to imply work has begun.
    public static func createdTaskBody() -> Data {
        json(["task": newTask])
    }

    private static var newTask: JunoPreviewJSON {
        cloudTask(
            id: createdTaskID,
            title: "Queued from the phone",
            prompt: "",
            status: "queued",
            repo: (owner: "juno-labs", name: "juno"),
            conversation: "conv-code-new",
            pullRequest: nil,
            lastSeq: 0,
            created: Date(),
            updated: Date()
        )
    }

    // MARK: - Tasks

    /// Newest first, the order the route returns and the list renders.
    private static let taskIDs = [
        awaitingTaskID, runningTaskID, doneTaskID, "cd-audit", failedTaskID, "cd-readme",
    ]

    private static func task(id: String, statusOverride: String? = nil) -> JunoPreviewJSON? {
        switch id {
        case awaitingTaskID:
            return deviceTask(
                id: id,
                title: "Migrate the settings store to the new schema",
                prompt:
                    "Move JunoSettingsStore onto the versioned schema, write the migration, "
                    + "and leave the old reader in place behind a feature check.",
                status: statusOverride ?? "awaiting_approval",
                workspace: "juno",
                path: "/Users/liam/Developer/juno",
                conversation: "conv-code-migrate",
                lastSeq: 14,
                created: ago(minutes: 9),
                updated: ago(seconds: 25)
            )
        case runningTaskID:
            return cloudTask(
                id: id,
                title: "Make search survive an empty index",
                prompt:
                    "Search throws when the local index has no partition for the account. "
                    + "Find the crash, fix it, and add a test that opens search on a fresh "
                    + "account.",
                status: statusOverride ?? "running",
                repo: ("juno-labs", "juno"),
                conversation: "conv-code-search",
                pullRequest: nil,
                lastSeq: 11,
                created: ago(minutes: 4),
                updated: ago(seconds: 6)
            )
        case doneTaskID:
            return cloudTask(
                id: id,
                title: "Fix the flaky sync reconnect test",
                prompt:
                    "NativeSyncMonitorTests.testReconnectsAfterDrop fails about one run in "
                    + "twelve on CI. Work out why and make it deterministic.",
                status: statusOverride ?? "done",
                repo: ("juno-labs", "juno-native"),
                conversation: "conv-code-flake",
                pullRequest: "https://github.com/juno-labs/juno-native/pull/482",
                lastSeq: 16,
                created: ago(hours: 2, minutes: 10),
                updated: ago(hours: 1, minutes: 51)
            )
        case "cd-audit":
            return deviceTask(
                id: id,
                title: "Audit the design tokens against globals.css",
                prompt: "Compare the generated Swift tokens with the web custom properties.",
                status: statusOverride ?? "queued",
                workspace: "juno-docs",
                path: "/Users/liam/Developer/juno-docs",
                conversation: "conv-code-audit",
                lastSeq: 0,
                created: ago(minutes: 1),
                updated: ago(minutes: 1)
            )
        case failedTaskID:
            return cloudTask(
                id: id,
                title: "Add a webhook for finished cloud runs",
                prompt:
                    "Post to the relay when a cloud run finishes so the phone stops "
                    + "polling for the last update.",
                status: statusOverride ?? "failed",
                repo: ("juno-labs", "juno-relay"),
                conversation: "conv-code-webhook",
                pullRequest: nil,
                lastSeq: 7,
                created: ago(hours: 6),
                updated: ago(hours: 5, minutes: 47)
            )
        case createdTaskID:
            return newTask
        case "cd-readme":
            return deviceTask(
                id: id,
                title: "Rewrite the packages README",
                prompt: "The README still describes the pre-split package layout.",
                status: statusOverride ?? "cancelled",
                workspace: "juno",
                path: "/Users/liam/Developer/juno",
                conversation: "conv-code-readme",
                lastSeq: 3,
                created: ago(days: 1, hours: 3),
                updated: ago(days: 1, hours: 2)
            )
        default:
            return nil
        }
    }

    // MARK: - Events

    private static func events(for id: String) -> [JunoPreviewJSON] {
        switch id {
        case runningTaskID: return searchEvents
        case awaitingTaskID: return migrateEvents
        case doneTaskID: return flakeEvents
        case failedTaskID: return webhookEvents
        case createdTaskID:
            // One line, because that is all a task queued a second ago honestly
            // has: it exists and nothing has claimed it.
            return [
                event(1, "status", Date(), ["status": .string("Queued — waiting for a runner")])
            ]
        default: return []
        }
    }

    /// A run in flight: the reader's ask, tools, a sub-agent, and prose that
    /// stops mid-thought because the run has not finished writing it.
    private static var searchEvents: [JunoPreviewJSON] {
        [
            event(1, "status", ago(minutes: 4), ["status": .string("Claimed by a cloud runner")]),
            event(
                2, "user", ago(minutes: 4),
                [
                    "text": .string(
                        "Search throws when the local index has no partition for the account. "
                        + "Find the crash, fix it, and add a test."
                    )
                ]
            ),
            event(
                3, "tool", ago(minutes: 3, seconds: 40),
                [
                    "summary": .string("grep NativeSearchModel"),
                    "detail": .string("18 matches in 6 files"),
                ]
            ),
            event(
                4, "tool", ago(minutes: 3, seconds: 20),
                [
                    "summary": .string("read Sources/JunoSearch/NativeSearchModel.swift"),
                    "detail": .string("412 lines"),
                ]
            ),
            event(
                5, "text", ago(minutes: 3),
                [
                    "text": .string(
                        "`start(for:)` opens the partition and force-unwraps the handle. On a "
                        + "fresh account there is no partition yet, so the unwrap traps rather "
                        + "than returning an empty result set."
                    )
                ]
            ),
            event(
                6, "agent", ago(minutes: 2, seconds: 30),
                [
                    "agent": .object([
                        "role": .string("reviewer"),
                        "title": .string("Check the other index callers"),
                        "status": .string("finished"),
                        "summary": .string("Two more force-unwraps on the same handle."),
                    ])
                ]
            ),
            event(
                7, "file_change", ago(minutes: 2),
                [
                    "path": .string("Sources/JunoSearch/NativeSearchModel.swift"),
                    "changeKind": .string("edit"),
                    "added": .number(14),
                    "removed": .number(6),
                ]
            ),
            event(
                8, "tool", ago(minutes: 1, seconds: 30),
                [
                    "summary": .string("swift test --filter NativeSearchModelTests"),
                    "detail": .string("running"),
                ]
            ),
            event(
                9, "text", ago(seconds: 20),
                [
                    "text": .string(
                        "Adding a test that opens search on an account with no indexed "
                        + "documents, so the empty case is covered before"
                    )
                ]
            ),
        ]
    }

    /// A run stopped dead. Everything before the card reads as ordinary work,
    /// which is the point: the reason it is stopped has to be legible from the
    /// card alone, not inferred from the log going quiet.
    private static var migrateEvents: [JunoPreviewJSON] {
        [
            event(1, "status", ago(minutes: 9), ["status": .string("Claimed by Liam’s MacBook Pro")]),
            event(
                2, "user", ago(minutes: 9),
                [
                    "text": .string(
                        "Move JunoSettingsStore onto the versioned schema and write the "
                        + "migration."
                    )
                ]
            ),
            event(
                3, "tool", ago(minutes: 8),
                [
                    "summary": .string("read Sources/JunoStorage/JunoSettingsStore.swift"),
                    "detail": .string("286 lines"),
                ]
            ),
            event(
                4, "text", ago(minutes: 7),
                [
                    "text": .string(
                        "The store writes an unversioned plist. I will add a `schemaVersion` "
                        + "key, read the old shape when it is missing, and leave the old "
                        + "reader in place."
                    )
                ]
            ),
            event(
                5, "file_change", ago(minutes: 5),
                [
                    "path": .string("Sources/JunoStorage/JunoSettingsStore.swift"),
                    "changeKind": .string("edit"),
                    "added": .number(63),
                    "removed": .number(11),
                ]
            ),
            event(
                6, "file_change", ago(minutes: 4),
                [
                    "path": .string("Sources/JunoStorage/JunoSettingsMigration.swift"),
                    "changeKind": .string("created"),
                    "added": .number(97),
                    "removed": .number(0),
                ]
            ),
            event(
                7, "approval_request", ago(seconds: 25),
                [
                    "requestId": .string("apr-migrate-1"),
                    "risk": .string("elevated"),
                    "summary": .string("Rewrite every settings file in ~/Library/Application Support/Juno"),
                    "detail": .string(
                        "The migration rewrites 4 files in place. There is no backup, and a "
                        + "downgrade after this point reads the new shape as empty."
                    ),
                ]
            ),
        ]
    }

    /// A finished run: the diff it left, the checks it ran, and the pull request
    /// it opened. The three things somebody reviewing a finished run asks for.
    private static var flakeEvents: [JunoPreviewJSON] {
        [
            event(1, "status", ago(hours: 2, minutes: 10), ["status": .string("Claimed by a cloud runner")]),
            event(
                2, "user", ago(hours: 2, minutes: 10),
                ["text": .string("Work out why the sync reconnect test is flaky and fix it.")]
            ),
            event(
                3, "tool", ago(hours: 2, minutes: 6),
                [
                    "summary": .string("swift test --filter NativeSyncMonitorTests -c 40"),
                    "detail": .string("3 of 40 runs failed"),
                ]
            ),
            event(
                4, "text", ago(hours: 2, minutes: 2),
                [
                    "text": .string(
                        "The test asserts on the reconnect count immediately after dropping "
                        + "the stream, so it races the monitor's 200ms backoff. It passes "
                        + "whenever the scheduler happens to run the retry first."
                    )
                ]
            ),
            event(
                5, "file_change", ago(hours: 1, minutes: 58),
                [
                    "path": .string("Tests/JunoSyncTests/NativeSyncMonitorTests.swift"),
                    "changeKind": .string("edit"),
                    "added": .number(21),
                    "removed": .number(9),
                ]
            ),
            event(
                6, "file_change", ago(hours: 1, minutes: 57),
                [
                    "path": .string("Sources/JunoSync/NativeSyncMonitor.swift"),
                    "changeKind": .string("edit"),
                    "added": .number(8),
                    "removed": .number(2),
                ]
            ),
            event(
                7, "tool", ago(hours: 1, minutes: 53),
                [
                    "summary": .string("swift test --filter NativeSyncMonitorTests -c 200"),
                    "detail": .string("200 passed"),
                ]
            ),
            event(
                8, "text", ago(hours: 1, minutes: 52),
                [
                    "text": .string(
                        "The monitor now publishes the attempt before it sleeps, so the test "
                        + "observes the reconnect rather than the timing of it. 200 runs, no "
                        + "failures."
                    )
                ]
            ),
            event(9, "done", ago(hours: 1, minutes: 51), [:]),
        ]
    }

    /// A run that failed, with the reason still readable. A failed session whose
    /// log stops without saying why is the state this fixture exists to prevent
    /// shipping.
    private static var webhookEvents: [JunoPreviewJSON] {
        [
            event(1, "status", ago(hours: 6), ["status": .string("Claimed by a cloud runner")]),
            event(
                2, "user", ago(hours: 6),
                ["text": .string("Post to the relay when a cloud run finishes.")]
            ),
            event(
                3, "tool", ago(hours: 5, minutes: 55),
                [
                    "summary": .string("read src/app/api/code/tasks/[id]/route.ts"),
                    "detail": .string("204 lines"),
                ]
            ),
            event(
                4, "file_change", ago(hours: 5, minutes: 50),
                [
                    "path": .string("src/lib/relay-webhook.ts"),
                    "changeKind": .string("created"),
                    "added": .number(48),
                    "removed": .number(0),
                ]
            ),
            event(
                5, "tool", ago(hours: 5, minutes: 48),
                ["summary": .string("pnpm typecheck"), "detail": .string("failed")]
            ),
            event(
                6, "error", ago(hours: 5, minutes: 47),
                [
                    "message": .string(
                        "RELAY_WEBHOOK_SECRET is not declared in the environment schema, so "
                        + "the build cannot read it. Add it to env.server.ts and re-run."
                    )
                ]
            ),
        ]
    }

    // MARK: - Builders

    private static func cloudTask(
        id: String,
        title: String,
        prompt: String,
        status: String,
        repo: (owner: String, name: String),
        conversation: String,
        pullRequest: String?,
        lastSeq: Int,
        created: Date,
        updated: Date
    ) -> JunoPreviewJSON {
        var object: [String: JunoPreviewJSON] = [
            "id": .string(id),
            "title": .string(title),
            "prompt": .string(prompt),
            "status": .string(status),
            "target": .string("cloud"),
            "repoOwner": .string(repo.owner),
            "repoName": .string(repo.name),
            "baseRef": .string("main"),
            "conversationId": .string(conversation),
            "lastSeq": .number(Double(lastSeq)),
            "createdAt": .string(iso(created)),
            "updatedAt": .string(iso(updated)),
        ]
        object["prUrl"] = pullRequest.map { .string($0) } ?? .null
        return .object(object)
    }

    private static func deviceTask(
        id: String,
        title: String,
        prompt: String,
        status: String,
        workspace: String,
        path: String,
        conversation: String,
        lastSeq: Int,
        created: Date,
        updated: Date
    ) -> JunoPreviewJSON {
        .object([
            "id": .string(id),
            "title": .string(title),
            "prompt": .string(prompt),
            "status": .string(status),
            "target": .string("device"),
            "deviceId": .string("dev-mbp"),
            "workspaceName": .string(workspace),
            "workspacePath": .string(path),
            "conversationId": .string(conversation),
            "lastSeq": .number(Double(lastSeq)),
            "createdAt": .string(iso(created)),
            "updatedAt": .string(iso(updated)),
        ])
    }

    private static func event(
        _ seq: Int,
        _ kind: String,
        _ createdAt: Date,
        _ payload: [String: JunoPreviewJSON]
    ) -> JunoPreviewJSON {
        .object([
            "seq": .number(Double(seq)),
            "kind": .string(kind),
            "payload": .object(payload),
            "createdAt": .string(iso(createdAt)),
        ])
    }

    // swiftlint:disable:next function_parameter_count
    private static func device(
        id: String,
        name: String,
        platform: String,
        appVersion: String,
        online: Bool,
        serves: Bool,
        active: Int,
        lastSeen: Date,
        workspaces: [JunoPreviewJSON]
    ) -> JunoPreviewJSON {
        .object([
            "id": .string(id),
            "name": .string(name),
            "platform": .string(platform),
            "appVersion": .string(appVersion),
            "online": .bool(online),
            "servesQueuedTasks": .bool(serves),
            "activeCount": .number(Double(active)),
            "lastSeenAt": .string(iso(lastSeen)),
            "workspaces": .array(workspaces),
        ])
    }

    private static func workspace(_ name: String, _ path: String, key: String) -> JunoPreviewJSON {
        .object(["name": .string(name), "path": .string(path), "key": .string(key)])
    }

    private static func repo(
        _ owner: String,
        _ name: String,
        private isPrivate: Bool,
        branch: String,
        updated: Date
    ) -> JunoPreviewJSON {
        .object([
            "owner": .string(owner),
            "name": .string(name),
            "fullName": .string("\(owner)/\(name)"),
            "private": .bool(isPrivate),
            "defaultBranch": .string(branch),
            "updatedAt": .string(iso(updated)),
        ])
    }

    // MARK: - Time

    private static func ago(
        days: Int = 0,
        hours: Int = 0,
        minutes: Int = 0,
        seconds: Int = 0
    ) -> Date {
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
