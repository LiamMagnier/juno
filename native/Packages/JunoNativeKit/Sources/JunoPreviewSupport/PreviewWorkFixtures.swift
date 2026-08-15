#if DEBUG
import Foundation

/// Synthetic Juno Work fixtures for the UI Preview harness.
///
/// **Why these exist.** ``PreviewWorld`` handed the desktop a `nil` work model,
/// so every screenshot of the Work product was `ContentUnavailableView("Juno
/// Work unavailable")` — the one product whose layout nobody could look at was
/// also the one nobody could look at *by construction*. Chat and Code have had
/// fixtures since the harness was written; this is the same idea for the third
/// face of the app.
///
/// **Why JSON rather than constructed values.** `WorkSessionSummary` and friends
/// have no public memberwise initialiser outside `JunoWorkKit`, and going
/// through the wire shape is the more honest fixture anyway: the screenshots
/// then exercise `NativeWorkClient`'s real decoders, so a fixture that renders
/// is also proof the decode path works. A field renamed on the server breaks the
/// preview in the same way it would break the app.
///
/// **Timestamps are relative to launch.** The thread and the source list both
/// format dates with `.relative`, and a fixed date would render "last month" on
/// every row a week after this file was written — which is exactly the kind of
/// detail a screenshot is supposed to catch.
public enum PreviewWorkFixtures {
    // MARK: - Identifiers

    /// The task the harness opens: mid-run, blocked on an approval. Chosen as
    /// the default because it is the densest state the thread has — plan,
    /// activity, changed files, an artifact, a budget and a blocking card all on
    /// screen at once — and therefore the one most worth looking at.
    public static let openSessionID = "wk-invoices"
    /// The task that is running with nothing blocking it.
    public static let runningSessionID = "wk-interviews"

    /// Sessions whose stream must stay open, because their status is not
    /// terminal and a stream that ends would make the model reconnect in a
    /// 200ms loop for as long as the screenshot takes.
    static let liveSessionIDs: Set<String> = [openSessionID, runningSessionID, "wk-pricing"]

    // MARK: - Bodies

    /// The Macs this account can route work to.
    public static func hostsBody(empty: Bool) -> Data {
        guard !empty else { return json(["hosts": .array([])]) }
        return json([
            "hosts": .array([
                host(
                    id: "host-mbp",
                    device: "device-mbp",
                    name: "Liam’s MacBook Pro",
                    state: "online",
                    enabled: true,
                    capabilities: [
                        "local_files", "local_apps", "local_browser",
                        "web_research", "connectors", "deliverables",
                    ],
                    active: 1,
                    queued: 1,
                    lastSeen: ago(seconds: 12)
                ),
                host(
                    id: "host-studio",
                    device: "device-studio",
                    name: "Studio Mac mini",
                    state: "offline",
                    enabled: true,
                    capabilities: ["local_files", "local_shell", "deliverables"],
                    active: 0,
                    queued: 0,
                    lastSeen: ago(hours: 3)
                ),
            ])
        ])
    }

    /// The task list, covering every status the source list has to draw.
    public static func sessionsBody(empty: Bool) -> Data {
        guard !empty else { return json(["sessions": .array([])]) }
        return json(["sessions": .array(sessions)])
    }

    /// One task's thread: the run, its events, and anything blocking it.
    public static func sessionBody(id: String, empty: Bool) -> Data {
        guard !empty, let summary = session(id: id) else {
            return json(["session": .null])
        }
        var root: [String: JunoPreviewJSON] = ["session": summary]
        if let run = run(for: id) { root["run"] = run }
        root["events"] = .array(events(for: id))
        root["approvals"] = .array(approvals(for: id))
        return json(root)
    }

    /// The attempt a start request creates: queued, unclaimed, nothing spent.
    ///
    /// Without it `POST …/sessions/<id>/runs` fell through to the session route
    /// and was answered with a *session*, which the run decoder is right to
    /// refuse — so both apps' Start and Start-again controls reported "Juno
    /// received Work data it could not read" in the one place built to inspect
    /// them, and the surface most in need of visual QA was the surface QA could
    /// only ever see fail.
    ///
    /// Queued rather than running, because that is what the route returns: an
    /// attempt exists before any executor has claimed it, and the thread's job in
    /// that moment is to say so.
    public static func startedRunBody(sessionID: String) -> Data {
        json([
            "run": run(
                id: "run-\(sessionID)-started",
                session: sessionID,
                status: "queued",
                model: "claude-sonnet-4-6",
                costMicroUsd: 0,
                maxCostMicroUsd: 1_000_000,
                lastSeq: 0,
                startedAt: ago(seconds: 1)
            )
        ])
    }

    /// What the answer route says about a message it recorded.
    ///
    /// One sentence for both of its callers — an answer to a question and an
    /// unprompted instruction — because the route writes one either way, and the
    /// harness's job is to prove the client reads *the server's* words rather
    /// than composing its own.
    public static var instructionOutcomeBody: Data {
        json([
            "delivered": .bool(true),
            "explanation": .string("Juno has this and will read it before its next step."),
        ])
    }

    /// The durable artifact index for the densest Work thread.
    public static func artifactsBody(sessionID: String) -> Data {
        guard sessionID == openSessionID else { return json(["artifacts": .array([])]) }
        return json([
            "artifacts": .array([
                artifact(
                    id: "art-exceptions",
                    sessionID: sessionID,
                    title: "Q3 exceptions",
                    kind: "spreadsheet",
                    version: 2,
                    validatedAt: ago(seconds: 18),
                    updatedAt: ago(minutes: 1, seconds: 10)
                )
            ])
        ])
    }

    /// Version history and provenance for the artifact shown in the preview.
    public static func artifactDetailBody(id: String) -> Data {
        guard id == "art-exceptions" else {
            return json(["error": .string("Not found")])
        }
        return json([
            "artifact": artifact(
                id: id,
                sessionID: openSessionID,
                title: "Q3 exceptions",
                kind: "spreadsheet",
                version: 2,
                validatedAt: ago(seconds: 18),
                updatedAt: ago(minutes: 1, seconds: 10)
            ),
            "versions": .array([
                artifactVersion(
                    version: 2,
                    bytes: 18_432,
                    origin: "generated",
                    runID: "run-invoices-1",
                    validated: true,
                    createdAt: ago(minutes: 1, seconds: 10)
                ),
                artifactVersion(
                    version: 1,
                    bytes: 12_288,
                    origin: "generated",
                    runID: "run-invoices-1",
                    validated: false,
                    createdAt: ago(minutes: 1, seconds: 50)
                )
            ]),
            "truncated": .bool(false)
        ])
    }

    /// Deterministic placeholder bytes used only by the no-network preview
    /// sender. The real route returns verified workbook bytes.
    public static let artifactDownloadBytes = Data("Juno preview workbook\n".utf8)

    // MARK: - Sessions

    private static var sessions: [JunoPreviewJSON] {
        [
            session(
                id: openSessionID,
                title: "Reconcile the Q3 vendor invoices",
                goal:
                    "Match every invoice in the Q3 folder against the payments export, "
                    + "flag the ones that do not reconcile, and write the exceptions up "
                    + "as a spreadsheet I can send to Priya.",
                status: "waiting_approval",
                needsAttention: true,
                pinned: true,
                host: "Liam’s MacBook Pro",
                activity: ago(seconds: 30),
                runID: "run-invoices-1",
                lastSeq: 24
            ),
            session(
                id: runningSessionID,
                title: "Summarise 41 customer interviews",
                goal:
                    "Read the interview transcripts in Research/Q3 and pull out the "
                    + "themes, with counts and a quote for each.",
                status: "running",
                needsAttention: false,
                pinned: false,
                host: "Liam’s MacBook Pro",
                activity: ago(seconds: 4),
                runID: "run-interviews-1",
                lastSeq: 11
            ),
            session(
                id: "wk-datroom",
                title: "Draft the Series A data room index",
                goal: "Build the index for the data room and note what is still missing.",
                status: "waiting_input",
                needsAttention: true,
                pinned: false,
                host: "Liam’s MacBook Pro",
                activity: ago(minutes: 6),
                runID: "run-dataroom-1",
                lastSeq: 8
            ),
            session(
                id: "wk-pricing",
                title: "Pull competitor pricing into a sheet",
                goal: "Check the pricing pages for the five competitors and tabulate the tiers.",
                status: "queued",
                needsAttention: false,
                pinned: false,
                host: nil,
                activity: ago(minutes: 11),
                runID: nil,
                lastSeq: 0
            ),
            session(
                id: "wk-receipts",
                title: "Rename and file the scanned receipts",
                goal: "Rename everything in Scans/ to vendor-date and move it into Receipts/2026.",
                status: "completed",
                needsAttention: false,
                pinned: false,
                host: "Liam’s MacBook Pro",
                activity: ago(hours: 2),
                runID: "run-receipts-1",
                lastSeq: 31
            ),
            session(
                id: "wk-digest",
                title: "Weekly revenue digest",
                goal: "Assemble the Monday revenue digest from the warehouse export.",
                status: "paused",
                needsAttention: false,
                pinned: false,
                host: "Studio Mac mini",
                activity: ago(hours: 20),
                runID: "run-digest-4",
                lastSeq: 17
            ),
            session(
                id: "wk-downloads",
                title: "Clean up the Downloads folder",
                goal: "Sort six months of Downloads into folders by kind and delete the duplicates.",
                status: "failed",
                needsAttention: false,
                pinned: false,
                host: "Liam’s MacBook Pro",
                activity: ago(days: 2),
                runID: "run-downloads-2",
                lastSeq: 9
            ),
        ]
    }

    private static func session(id: String) -> JunoPreviewJSON? {
        sessions.first { candidate in
            guard case .object(let object) = candidate,
                case .string(let candidateID)? = object["id"]
            else { return false }
            return candidateID == id
        }
    }

    // MARK: - Runs

    private static func run(for sessionID: String) -> JunoPreviewJSON? {
        switch sessionID {
        case openSessionID:
            return run(
                id: "run-invoices-1",
                session: sessionID,
                status: "waiting_approval",
                model: "Claude Opus 4.8",
                costMicroUsd: 412_000,
                maxCostMicroUsd: 2_000_000,
                lastSeq: 24,
                startedAt: ago(minutes: 4)
            )
        case runningSessionID:
            return run(
                id: "run-interviews-1",
                session: sessionID,
                status: "running",
                model: "Claude Sonnet 4.6",
                costMicroUsd: 96_000,
                maxCostMicroUsd: 1_000_000,
                lastSeq: 11,
                startedAt: ago(minutes: 1)
            )
        case "wk-receipts":
            return run(
                id: "run-receipts-1",
                session: sessionID,
                status: "completed",
                model: "Claude Sonnet 4.6",
                costMicroUsd: 148_000,
                maxCostMicroUsd: 1_000_000,
                lastSeq: 31,
                startedAt: ago(hours: 2, minutes: 6),
                finishedAt: ago(hours: 2)
            )
        default:
            return nil
        }
    }

    // MARK: - Events

    private static func events(for sessionID: String) -> [JunoPreviewJSON] {
        switch sessionID {
        case openSessionID: return invoiceEvents
        case runningSessionID: return interviewEvents
        case "wk-receipts": return receiptEvents
        default: return []
        }
    }

    /// The dense thread: a plan part-done, sources read, files written, a
    /// document produced, and an approval outstanding.
    private static var invoiceEvents: [JunoPreviewJSON] {
        [
            event(1, "run_started", ago(minutes: 4), ["target": .string("This Mac")]),
            event(
                2, "plan_created", ago(minutes: 4),
                [
                    "steps": .array([
                        planStep("s1", "Read the Q3 invoice folder", "done"),
                        planStep("s2", "Load the payments export", "done"),
                        planStep("s3", "Match invoices to payments", "done"),
                        planStep("s4", "Write up the exceptions", "active"),
                        planStep("s5", "Save the spreadsheet to Finance/Q3", "pending"),
                    ])
                ]
            ),
            event(
                3, "step_started", ago(minutes: 4),
                ["stepId": .string("s1"), "title": .string("Read the Q3 invoice folder")]
            ),
            event(
                4, "tool_started", ago(minutes: 4),
                [
                    "tool": .string("read_folder"),
                    "summary": .string("Reading the Q3 invoice folder"),
                    "detail": .string("64 PDFs"),
                ]
            ),
            event(
                5, "tool_finished", ago(minutes: 3, seconds: 40),
                ["tool": .string("read_folder"), "summary": .string("Read 64 invoices")]
            ),
            event(
                6, "step_finished", ago(minutes: 3, seconds: 40),
                [
                    "stepId": .string("s1"),
                    "title": .string("Read the Q3 invoice folder"),
                    "state": .string("done"),
                    "summary": .string("64 invoices, 3 unreadable scans"),
                ]
            ),
            event(
                7, "step_started", ago(minutes: 3, seconds: 30),
                ["stepId": .string("s2"), "title": .string("Load the payments export")]
            ),
            event(
                8, "step_finished", ago(minutes: 3),
                [
                    "stepId": .string("s2"),
                    "title": .string("Load the payments export"),
                    "state": .string("done"),
                    "summary": .string("1,204 payment rows"),
                ]
            ),
            event(
                9, "step_started", ago(minutes: 3),
                ["stepId": .string("s3"), "title": .string("Match invoices to payments")]
            ),
            event(
                10, "assistant_message", ago(minutes: 2, seconds: 30),
                [
                    "text": .string(
                        "61 of the 64 invoices match a payment exactly. Three do not: two "
                        + "are short by the FX spread and one has no payment at all."
                    )
                ]
            ),
            event(
                11, "step_finished", ago(minutes: 2, seconds: 20),
                [
                    "stepId": .string("s3"),
                    "title": .string("Match invoices to payments"),
                    "state": .string("done"),
                    "summary": .string("3 exceptions"),
                ]
            ),
            event(
                12, "step_started", ago(minutes: 2, seconds: 10),
                ["stepId": .string("s4"), "title": .string("Write up the exceptions")]
            ),
            event(
                13, "files_changed", ago(minutes: 2),
                [
                    "files": .array([
                        fileEntry("Q3 exceptions.xlsx", change: "created"),
                        fileEntry("Reconciliation notes.md", change: "created"),
                    ])
                ]
            ),
            event(
                14, "artifact_created", ago(minutes: 1, seconds: 50),
                [
                    "artifactId": .string("art-exceptions"),
                    "title": .string("Q3 exceptions"),
                    "kind": .string("spreadsheet"),
                    "version": .number(1),
                ]
            ),
            event(
                15, "source_cited", ago(minutes: 1, seconds: 40),
                [
                    "title": .string("Vendor payment terms (internal)"),
                    "publisher": .string("Finance wiki"),
                ]
            ),
            event(
                16, "artifact_updated", ago(minutes: 1, seconds: 10),
                [
                    "artifactId": .string("art-exceptions"),
                    "title": .string("Q3 exceptions"),
                    "kind": .string("spreadsheet"),
                    "version": .number(2),
                ]
            ),
            event(
                17, "approval_requested", ago(seconds: 30),
                [
                    "summary": .string(
                        "Save “Q3 exceptions.xlsx” into Finance/Q3, replacing last quarter’s copy"
                    ),
                    "action": .string("apply_changes"),
                    "risk": .string("sensitive"),
                ]
            ),
        ]
    }

    /// A thread that is genuinely mid-action, for the "running" screenshot.
    private static var interviewEvents: [JunoPreviewJSON] {
        [
            event(1, "run_started", ago(minutes: 1), ["target": .string("This Mac")]),
            event(
                2, "plan_created", ago(minutes: 1),
                [
                    "steps": .array([
                        planStep("s1", "Read the 41 transcripts", "active"),
                        planStep("s2", "Cluster the themes", "pending"),
                        planStep("s3", "Pick a quote for each theme", "pending"),
                        planStep("s4", "Write the summary", "pending"),
                    ])
                ]
            ),
            event(
                3, "step_started", ago(minutes: 1),
                ["stepId": .string("s1"), "title": .string("Read the 41 transcripts")]
            ),
            event(
                4, "tool_started", ago(seconds: 6),
                [
                    "tool": .string("read_file"),
                    "summary": .string("Reading interview 28 of 41"),
                    "detail": .string("Research/Q3"),
                ]
            ),
        ]
    }

    /// A finished thread, so the completed state has something to show.
    private static var receiptEvents: [JunoPreviewJSON] {
        [
            event(1, "run_started", ago(hours: 2, minutes: 6), ["target": .string("This Mac")]),
            event(
                2, "plan_created", ago(hours: 2, minutes: 6),
                [
                    "steps": .array([
                        planStep("s1", "Read the scans", "done"),
                        planStep("s2", "Rename to vendor-date", "done"),
                        planStep("s3", "File into Receipts/2026", "done"),
                    ])
                ]
            ),
            event(
                3, "batch_preview", ago(hours: 2, minutes: 4),
                ["count": .number(212), "summary": .string("212 files renamed and moved")]
            ),
            event(
                4, "batch_applied", ago(hours: 2, minutes: 2),
                ["count": .number(212), "summary": .string("212 files renamed and moved")]
            ),
            event(
                5, "validation_result", ago(hours: 2, minutes: 1),
                ["ok": .bool(true), "summary": .string("Every file resolves and nothing was overwritten")]
            ),
            event(
                6, "run_finished", ago(hours: 2),
                ["reason": .string("completed"), "summary": .string("212 receipts filed")]
            ),
        ]
    }

    // MARK: - Approvals

    private static func approvals(for sessionID: String) -> [JunoPreviewJSON] {
        guard sessionID == openSessionID else { return [] }
        return [
            .object([
                "id": .string("apr-1"),
                "runId": .string("run-invoices-1"),
                "action": .string("apply_changes"),
                "risk": .string("sensitive"),
                "summary": .string(
                    "Save “Q3 exceptions.xlsx” into Finance/Q3, replacing last quarter’s copy"
                ),
                "detail": .object([
                    "destination": .string("Finance/Q3"),
                    "files": .number(1),
                    "replaces": .string("Q2 exceptions.xlsx"),
                ]),
                "actionDigest": .string(String(repeating: "c", count: 64)),
                "expiresAt": .string(iso(Date().addingTimeInterval(600))),
                "decision": .string("pending"),
            ])
        ]
    }

    // MARK: - Builders

    private static func host(
        id: String,
        device: String,
        name: String,
        state: String,
        enabled: Bool,
        capabilities: [String],
        active: Int,
        queued: Int,
        lastSeen: Date
    ) -> JunoPreviewJSON {
        .object([
            "id": .string(id),
            "deviceId": .string(device),
            "displayName": .string(name),
            "state": .string(state),
            "enabled": .bool(enabled),
            "capabilities": .array(capabilities.map { .string($0) }),
            "activeRunCount": .number(Double(active)),
            "queuedRunCount": .number(Double(queued)),
            "lastSeenAt": .string(iso(lastSeen)),
        ])
    }

    private static func session(
        id: String,
        title: String,
        goal: String,
        status: String,
        needsAttention: Bool,
        pinned: Bool,
        host: String?,
        activity: Date,
        runID: String?,
        lastSeq: Int
    ) -> JunoPreviewJSON {
        var object: [String: JunoPreviewJSON] = [
            "id": .string(id),
            "title": .string(title),
            "goal": .string(goal),
            "status": .string(status),
            "needsAttention": .bool(needsAttention),
            "requestedTarget": .string(host == nil ? "automatic" : "local"),
            "pinned": .bool(pinned),
            "archived": .bool(false),
            "lastActivityAt": .string(iso(activity)),
            "lastSeq": .number(Double(lastSeq)),
        ]
        if let host {
            object["hostId"] = .string(host == "Studio Mac mini" ? "host-studio" : "host-mbp")
            object["hostDisplayName"] = .string(host)
            object["effectiveTarget"] = .string("local")
        }
        if let runID { object["currentRunId"] = .string(runID) }
        return .object(object)
    }

    private static func run(
        id: String,
        session: String,
        status: String,
        model: String,
        costMicroUsd: Int,
        maxCostMicroUsd: Int,
        lastSeq: Int,
        startedAt: Date,
        finishedAt: Date? = nil
    ) -> JunoPreviewJSON {
        var object: [String: JunoPreviewJSON] = [
            "id": .string(id),
            "sessionId": .string(session),
            "attempt": .number(1),
            "status": .string(status),
            "requestedTarget": .string("local"),
            "effectiveTarget": .string("local"),
            "hostId": .string("host-mbp"),
            "effectiveModel": .string(model),
            "degradation": .array([]),
            "usage": .object(["costMicroUsd": .number(Double(costMicroUsd))]),
            "budget": .object(["maxCostMicroUsd": .number(Double(maxCostMicroUsd))]),
            "lastSeq": .number(Double(lastSeq)),
            "startedAt": .string(iso(startedAt)),
        ]
        if let finishedAt {
            object["finishedAt"] = .string(iso(finishedAt))
            object["terminalReason"] = .string("completed")
        }
        return .object(object)
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
            "createdAt": .string(iso(createdAt)),
            "payload": .object(payload),
        ])
    }

    private static func planStep(_ id: String, _ title: String, _ state: String) -> JunoPreviewJSON {
        .object(["id": .string(id), "title": .string(title), "state": .string(state)])
    }

    private static func fileEntry(_ name: String, change: String) -> JunoPreviewJSON {
        .object(["name": .string(name), "change": .string(change)])
    }

    private static func artifact(
        id: String,
        sessionID: String,
        title: String,
        kind: String,
        version: Int,
        validatedAt: Date?,
        updatedAt: Date
    ) -> JunoPreviewJSON {
        var object: [String: JunoPreviewJSON] = [
            "id": .string(id),
            "sessionId": .string(sessionID),
            "identifier": .string("q3-exceptions"),
            "title": .string(title),
            "kind": .string(kind),
            "mimeType": .string("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            "currentVersion": .number(Double(version)),
            "createdAt": .string(iso(ago(minutes: 2))),
            "updatedAt": .string(iso(updatedAt)),
        ]
        object["validatedAt"] = validatedAt.map { .string(iso($0)) } ?? .null
        return .object(object)
    }

    private static func artifactVersion(
        version: Int,
        bytes: Int,
        origin: String,
        runID: String,
        validated: Bool,
        createdAt: Date
    ) -> JunoPreviewJSON {
        .object([
            "version": .number(Double(version)),
            "byteSize": .number(Double(bytes)),
            "contentHash": .string(String(repeating: validated ? "a" : "b", count: 64)),
            "origin": .string(origin),
            "runId": .string(runID),
            "validation": .object([
                "ok": .bool(validated),
                "validator": .string("preview-validator"),
            ]),
            "provenance": .array([
                .object([
                    "kind": .string("file"),
                    "label": .string("Finance/Q3/payments.csv"),
                    "url": .null,
                ])
            ]),
            "createdAt": .string(iso(createdAt)),
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

/// A minimal JSON writer, local to the harness.
///
/// `JunoJSONValue` is a decoder-side type in `JunoCore` and does not encode, and
/// hand-writing these fixtures as string literals put escaping bugs between a
/// designer and the screen they were trying to look at. This is only ever used
/// to build ``PreviewWorkFixtures``.
enum JunoPreviewJSON {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JunoPreviewJSON])
    case array([JunoPreviewJSON])
    case null

    var encoded: String {
        switch self {
        case .string(let value):
            return Self.quote(value)
        case .number(let value):
            return value == value.rounded() && abs(value) < 1e15
                ? String(Int(value)) : String(value)
        case .bool(let value):
            return value ? "true" : "false"
        case .object(let value):
            // Sorted so the same fixture produces byte-identical JSON on every
            // launch. Dictionary order is not stable across runs, and a body
            // that reshuffles itself makes any diff of two captures useless.
            let members = value.sorted { $0.key < $1.key }
                .map { "\(Self.quote($0.key)):\($0.value.encoded)" }
            return "{\(members.joined(separator: ","))}"
        case .array(let value):
            return "[\(value.map(\.encoded).joined(separator: ","))]"
        case .null:
            return "null"
        }
    }

    private static func quote(_ value: String) -> String {
        var out = "\""
        for character in value.unicodeScalars {
            switch character {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if character.value < 0x20 {
                    out += String(format: "\\u%04x", character.value)
                } else {
                    out.unicodeScalars.append(character)
                }
            }
        }
        return out + "\""
    }
}
#endif
