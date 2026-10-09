import Foundation
import JunoCodeCore
import JunoCodeLocal
import Observation

/// One thread run by a vendor runtime through the env server: Claude on the
/// user's own `claude`, Codex on their ChatGPT plan, an ACP agent (SPEC §2).
///
/// It holds the snapshot + cursor, applies events with
/// ``CodeV2SessionReducer``, re-opens after a sequence gap, and turns the
/// composer's intents into wire commands. The Swift AgentOrchestrator keeps
/// running the `alevr` and BYOK engines; this is everything else.
@MainActor
@Observable
public final class CodeV2EnvSession {
    public private(set) var sessionId: String
    public let cwd: String
    public private(set) var state: CodeV2SessionState
    public private(set) var isOpening = false
    public private(set) var lastError: String?
    /// The whole-thread diff, loaded on demand for Dock › Changes.
    public private(set) var threadDiff: [CodeV2DiffFile] = []
    public private(set) var turnDiff: [CodeV2DiffFile] = []


    @ObservationIgnored private weak var hub: EnvServerHub?
    @ObservationIgnored private var buffered: [CodeV2.ServerEventEnvelope] = []
    @ObservationIgnored private var reopening = false

    init(hub: EnvServerHub, sessionId: String, cwd: String, selection: CodeV2.ModelSelection) {
        self.hub = hub
        self.sessionId = sessionId
        self.cwd = cwd
        self.state = CodeV2SessionState(snapshot: CodeV2.SessionSnapshot(id: sessionId, cwd: cwd, selection: selection))
    }

    /// A detached session for previews and snapshot tests.
    public init(preview snapshot: CodeV2.SessionSnapshot) {
        self.sessionId = snapshot.id
        self.cwd = snapshot.cwd
        self.state = CodeV2SessionState(snapshot: snapshot, cursor: 0)
    }

    /// Previews and snapshot tests: the Changes a detached session shows.
    public func setPreviewDiff(thread: [CodeV2DiffFile], turn: [CodeV2DiffFile] = []) {
        threadDiff = thread
        turnDiff = turn
    }

    public var snapshot: CodeV2.SessionSnapshot { state.snapshot }
    public var isRunning: Bool { snapshot.state == .running || snapshot.state == .waiting }
    public var turns: [CodeV2Turn] { CodeV2TurnFolding.turns(from: snapshot.items, activeTurnId: snapshot.activeTurnId) }
    public var pendingRequests: [CodeV2.TurnItem] { CodeV2TurnFolding.pendingRequests(in: snapshot.items) }

    // MARK: Events

    func receive(_ envelope: CodeV2.ServerEventEnvelope) {
        if reopening {
            buffered.append(envelope)
            return
        }
        switch CodeV2SessionReducer.apply(envelope, to: &state) {
        case .none:
            break
        case let .reopen(afterSequence):
            Task { await reopen(afterSequence: afterSequence) }
        }
    }

    // MARK: Commands

    /// Opens (or resumes) the session on the server. A fresh session sends a
    /// snapshot first; a resumed one replays from the cursor.
    public func open() async {
        guard let hub else { return }
        isOpening = true
        defer { isOpening = false }
        do {
            let connection = try await hub.ready()
            let opened = try await connection.sessionOpen(
                sessionId: state.cursor == nil && sessionId.hasPrefix("draft-") ? nil : sessionId,
                cwd: cwd,
                selection: snapshot.selection,
                afterSequence: state.cursor
            )
            if opened != sessionId {
                sessionId = opened
                state.snapshot.id = opened
                hub.register(self, as: opened)
            }
            lastError = nil
        } catch {
            lastError = Self.describe(error)
        }
    }

    private func reopen(afterSequence: Int?) async {
        guard !reopening, let hub else { return }
        reopening = true
        defer {
            reopening = false
            let pending = buffered
            buffered = []
            for envelope in pending { receive(envelope) }
        }
        guard let connection = try? await hub.ready() else { return }
        _ = try? await connection.sessionOpen(sessionId: sessionId, cwd: cwd, selection: nil, afterSequence: afterSequence)
    }

    public func send(
        _ text: String,
        selection: CodeV2.ModelSelection,
        routing: CodeV2.RoleRouting?,
        runtimeMode: CodeV2.RuntimeMode,
        interactionMode: CodeV2.InteractionMode
    ) async {
        await perform { connection in
            if self.state.cursor == nil { await self.open() }
            _ = try await connection.turnStart(
                sessionId: self.sessionId, input: CodeV2.UserInput(text: text), selection: selection,
                routing: routing, runtimeMode: runtimeMode, interactionMode: interactionMode
            )
        }
    }

    public func queue(_ text: String) async {
        await perform { connection in
            _ = try await connection.turnQueue(sessionId: self.sessionId, input: CodeV2.UserInput(text: text))
        }
    }

    /// Steers the running turn; falls back to queueing when the runtime
    /// declines (Codex between items, an ACP agent without steering).
    public func steer(_ text: String) async {
        await perform { connection in
            guard let turnId = self.snapshot.activeTurnId else {
                _ = try await connection.turnQueue(sessionId: self.sessionId, input: CodeV2.UserInput(text: text))
                return
            }
            let accepted = try await connection.turnSteer(sessionId: self.sessionId, turnId: turnId, input: CodeV2.UserInput(text: text))
            if !accepted {
                _ = try await connection.turnQueue(sessionId: self.sessionId, input: CodeV2.UserInput(text: text))
            }
        }
    }

    public func interrupt() async {
        await perform { connection in
            try await connection.turnInterrupt(sessionId: self.sessionId, turnId: self.snapshot.activeTurnId)
        }
    }

    public func respond(to requestId: String, decision: CodeV2.ApprovalDecision, answers: [String: [String]]? = nil) async {
        await perform { connection in
            try await connection.approvalRespond(sessionId: self.sessionId, requestId: requestId, decision: decision, answers: answers)
        }
    }

    public func rollback(to checkpointId: String) async {
        await perform { connection in
            _ = try await connection.checkpointRollback(sessionId: self.sessionId, checkpointId: checkpointId)
        }
    }

    /// Loads Changes: the whole thread (`checkpointId` nil) or one turn.
    public func loadDiff(checkpointId: String?) async {
        await perform { connection in
            let result = try await connection.checkpointDiff(sessionId: self.sessionId, checkpointId: checkpointId)
            let files = CodeV2UnifiedDiff.parse(result.diff)
            if checkpointId == nil { self.threadDiff = files } else { self.turnDiff = files }
        }
    }

    private func perform(_ body: @escaping (EnvServerConnection) async throws -> Void) async {
        guard let hub else {
            lastError = "This preview is not connected."
            return
        }
        do {
            let connection = try await hub.ready()
            try await body(connection)
            lastError = nil
        } catch {
            lastError = Self.describe(error)
        }
    }

    static func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
