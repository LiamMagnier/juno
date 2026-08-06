import Foundation
import JunoCore
import JunoWorkCore
import JunoWorkKit
import JunoWorkRuntime
import Testing
@testable import JunoDesktop

/// The conversion between the relay's command and the local runtime's.
///
/// This is the join that did not exist. `DesktopWorkHostModel.executorProvider`
/// was declared and never assigned, so `syncRemoteHost` fell through to
/// `phase = .off` and no command was ever claimed — the entire local Work
/// runtime was in the binary's source tree and unreachable from the app. What
/// these pin down is that the translation is *total*: a value dropped on the way
/// across is an argument the tool never received, and an approval digest
/// computed over something other than what ran.
struct DesktopWorkExecutorAdapterTests {
    /// A run host that records rather than runs. The loop is not what these
    /// tests are about, and driving a model to prove a payload was translated
    /// would be a test of the model.
    private actor RecordingRunHost: WorkRunHosting {
        private(set) var started: [WorkRunRequest] = []
        private(set) var stopped: [(String, String)] = []
        private(set) var answers: [(String, String)] = []

        func startRun(_ request: WorkRunRequest) async throws { started.append(request) }
        func resumeRun(_ request: WorkRunRequest) async throws { started.append(request) }
        func pauseRun(runID: String) async throws {}
        func stopRun(runID: String, reason: String) async throws {
            stopped.append((runID, reason))
        }
        func deliverAnswer(runID: String, text: String) async throws {
            answers.append((runID, text))
        }
    }

    private func adapter(
        runs: RecordingRunHost = RecordingRunHost(),
        hostID: String = "host-1"
    ) -> DesktopWorkExecutorAdapter {
        DesktopWorkExecutorAdapter(
            executor: LocalWorkExecutor(
                hostID: hostID,
                approvals: WorkApprovalCoordinator(policy: .conservative),
                undo: WorkUndoLedger(),
                runs: runs,
                manifest: {
                    WorkCapabilityManifest(
                        hostID: hostID,
                        displayName: "Test Mac",
                        toggles: WorkHostToggles(workEnabled: true),
                        generatedAt: Date()
                    )
                }
            )
        )
    }

    private func command(
        kind: String,
        runID: String? = "run-1",
        payload: [String: JunoJSONValue] = [:],
        expiresIn: TimeInterval = 60
    ) -> WorkCommand {
        WorkCommand(
            id: "cmd-1",
            sessionID: "session-1",
            runID: runID,
            kind: kind,
            payload: payload,
            status: "claimed",
            leaseExpiresAt: nil,
            expiresAt: Date().addingTimeInterval(expiresIn)
        )
    }

    // MARK: - The value tree

    /// Every case maps, in both directions. A bridge that flattened one of them
    /// would be invisible until a tool refused an argument it was never given.
    @Test func everyJSONCaseSurvivesTheRoundTrip() {
        let original = JunoJSONValue.object([
            "text": .string("hello"),
            "count": .number(41.5),
            "flag": .bool(false),
            "missing": .null,
            "items": .array([.string("a"), .number(2), .null]),
            "nested": .object(["deep": .array([.object(["deeper": .bool(true)])])]),
        ])
        let there = DesktopWorkValueBridge.toolValue(original)
        let back = DesktopWorkValueBridge.jsonValue(there)
        #expect(back == original)
    }

    /// Null is a value, not an absence. Collapsing it to a missing key changes
    /// what `WorkToolSchema.validate` decides about a required argument.
    @Test func nullIsCarriedRatherThanDropped() {
        let bridged = DesktopWorkValueBridge.toolValue(.object(["field": .null]))
        #expect(bridged.objectValue?["field"] == .null)
        #expect(bridged.objectValue?.count == 1)
    }

    // MARK: - The command

    /// The result comes back in the relay's tree, so an acknowledgement carries
    /// what actually happened rather than an empty object.
    @Test func resultsAreTranslatedBack() async throws {
        let result = try await adapter().execute(command(kind: "ping"))
        #expect(result["ok"]?.boolValue == true)
        #expect(result["hostId"]?.stringValue == "host-1")
    }

    /// The payload reaches the executor intact, which is the whole point of the
    /// adapter: `stop`'s reason is shown to the person whose task stopped.
    @Test func payloadReachesTheLocalExecutor() async throws {
        let runs = RecordingRunHost()
        _ = try await adapter(runs: runs).execute(
            command(kind: "stop", payload: ["reason": .string("You stopped this task.")])
        )
        let stopped = await runs.stopped
        #expect(stopped.count == 1)
        #expect(stopped.first?.0 == "run-1")
        #expect(stopped.first?.1 == "You stopped this task.")
    }

    /// A nested payload is handed to the run host as it arrived. `start` carries
    /// the goal and whatever else the sender put in it, and the run reads it as
    /// data — never as authority.
    @Test func nestedStartPayloadArrivesWhole() async throws {
        let runs = RecordingRunHost()
        _ = try await adapter(runs: runs).execute(
            command(
                kind: "start",
                payload: [
                    "goal": .string("Tidy the downloads folder"),
                    "limits": .object(["maxSteps": .number(12)]),
                ]
            )
        )
        let started = await runs.started
        #expect(started.count == 1)
        #expect(started.first?.payload["goal"]?.stringValue == "Tidy the downloads folder")
        #expect(
            started.first?.payload["limits"]?.objectValue?["maxSteps"]?.intValue == 12
        )
        // Identity travels too: the run host reports events against the run and
        // the session, and a lost session id is a transcript with no thread.
        #expect(started.first?.runID == "run-1")
        #expect(started.first?.sessionID == "session-1")
        #expect(started.first?.commandID == "cmd-1")
    }

    /// An unknown kind is refused by name, not approximated to the nearest one
    /// this build understands. Approximating is how an intent to stop becomes a
    /// pause and somebody watches a task keep going after they told it not to.
    @Test func anUnknownKindIsRefusedByName() async {
        await #expect(throws: WorkLocalExecutionError.unsupportedCommandKind("teleport")) {
            _ = try await adapter().execute(command(kind: "teleport"))
        }
    }

    /// Expiry is re-checked at execution time, not only when the command was
    /// claimed — a `stop` claimed by a Mac that had been asleep for an hour would
    /// stop a run the person has since restarted.
    @Test func anExpiredCommandIsRefused() async {
        await #expect(throws: WorkLocalExecutionError.commandExpired) {
            _ = try await adapter().execute(command(kind: "ping", expiresIn: -1))
        }
    }

    /// A run-scoped command with no run id is refused rather than guessed at.
    @Test func aRunScopedCommandNeedsARun() async {
        await #expect(throws: WorkLocalExecutionError.missingField("task")) {
            _ = try await adapter().execute(command(kind: "pause", runID: nil))
        }
    }

    /// Every kind in the relay's vocabulary maps to one this build handles, so a
    /// command the relay is willing to deliver is never met with "this Mac's
    /// version of Juno does not understand that".
    @Test func theTwoCommandVocabulariesAgree() {
        let relayKinds = Set(JunoWorkCommandKind.allCases.map(\.rawValue))
        let localKinds = Set(WorkLocalCommandKind.allCases.map(\.rawValue))
        #expect(relayKinds.subtracting(localKinds).isEmpty)
    }
}
