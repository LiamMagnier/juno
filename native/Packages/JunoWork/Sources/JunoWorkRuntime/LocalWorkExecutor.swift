import Foundation
import JunoWorkCore
import JunoWorkLocal

// MARK: - What an undo has to reverse

/// The most recent applied batch per run, so "undo that" has something to
/// reverse.
///
/// Separate from the on-disk journal ``WorkBatchExecutor`` flushes. That copy
/// exists for the crash the journal was invented for; this one exists so a
/// person who says "put that back" a second later is answered without going to
/// the filesystem to find out what just happened.
public actor WorkUndoLedger {
    public struct Entry: Sendable {
        public let grantID: WorkGrantID
        public let journal: UndoJournal
        public let recordedAt: Date
    }

    private var byRun: [String: Entry] = [:]

    public init() {}

    /// Records what a batch actually applied.
    ///
    /// An empty journal is dropped rather than stored. A batch that was refused
    /// before its first operation changed nothing, and letting it overwrite the
    /// entry for the batch that ran a minute earlier would answer "undo that"
    /// with "there is nothing to undo" while forty files sit where Juno moved
    /// them.
    public func record(_ journal: UndoJournal, grantID: WorkGrantID, forRun runID: String) {
        guard !journal.isEmpty else { return }
        byRun[runID] = Entry(grantID: grantID, journal: journal, recordedAt: Date())
    }

    public func mostRecent(forRun runID: String) -> Entry? {
        byRun[runID]
    }

    public func forget(runID: String) {
        byRun.removeValue(forKey: runID)
    }
}

// MARK: - One granted folder, ready to be worked in

/// Everything one grant needs to be usable by a run: the containment boundary,
/// the file service, the batch executor and the tools over them.
///
/// Assembled once per grant rather than per run. The grant is what the person
/// consented to, and building the runtime from it — rather than from anything a
/// dispatched command says — is what makes it true that a remote instruction
/// cannot reach a folder a local prompt could not.
public struct WorkGrantRuntime: Sendable {
    public let access: any GrantAccessing
    public let files: WorkFileService
    public let batches: WorkBatchExecutor
    public let tools: WorkToolRegistry

    public var grantID: WorkGrantID { access.grantID }

    public init(
        access: any GrantAccessing,
        files: WorkFileService,
        batches: WorkBatchExecutor,
        tools: WorkToolRegistry
    ) {
        self.access = access
        self.files = files
        self.batches = batches
        self.tools = tools
    }

    /// The standard runtime for one grant.
    ///
    /// - Parameter supportDirectory: where the bytes of replaced files and the
    ///   undo journal are kept. **Must be outside every grant** — a stash inside
    ///   the folder being reorganised would itself be reorganised, and a journal
    ///   inside it would turn up in the person's own listings.
    ///
    /// The journal path is per grant, not per batch, so the on-disk record is
    /// always the most recent batch in that folder. Two batches running at once
    /// in one grant would overwrite each other's crash record; runs are
    /// serialised per grant for exactly that reason, and the in-memory
    /// ``WorkUndoLedger`` is what a person's "undo that" reads either way.
    public static func standard(
        access: any GrantAccessing,
        supportDirectory: URL,
        undo: WorkUndoLedger
    ) -> WorkGrantRuntime {
        // Hashed rather than used directly: a grant identifier is a string this
        // process did not choose, and a string that becomes a path component
        // should not be able to name a directory of its own choosing.
        let folder = WorkDigests.sha256Hex(access.grantID.value)
        let files = WorkFileService(access: access)
        let batches = WorkBatchExecutor(
            access: access,
            service: files,
            replacedContentDirectory: supportDirectory
                .appendingPathComponent("replaced", isDirectory: true)
                .appendingPathComponent(folder, isDirectory: true),
            journalURL: supportDirectory
                .appendingPathComponent("journals", isDirectory: true)
                .appendingPathComponent("\(folder).json")
        )
        return WorkGrantRuntime(
            access: access,
            files: files,
            batches: batches,
            tools: .standard(access: access, files: files, batches: batches, undo: undo)
        )
    }
}

// MARK: - The instruction

/// One instruction this Mac has been handed.
///
/// A mirror of the relay's command shape in this package's own vocabulary.
/// JunoWork must not depend on JunoNativeKit — the folder-touching code stays
/// unreachable from anything carrying a network client — so the app converts at
/// its boundary, where the conversion is a visible piece of code somebody can
/// read.
public struct WorkLocalCommand: Hashable, Sendable {
    public let id: String
    public let sessionID: String
    public let runID: String?
    /// Raw, and matched against ``WorkLocalCommandKind`` rather than decoded
    /// into it. An instruction this build does not understand has to survive as
    /// far as the refusal so the refusal can name it.
    public let kind: String
    public let payload: [String: WorkToolValue]
    public let expiresAt: Date

    public init(
        id: String,
        sessionID: String,
        runID: String?,
        kind: String,
        payload: [String: WorkToolValue] = [:],
        expiresAt: Date
    ) {
        self.id = id
        self.sessionID = sessionID
        self.runID = runID
        self.kind = kind
        self.payload = payload
        self.expiresAt = expiresAt
    }

    /// Whether this Mac should still act on it.
    ///
    /// Checked at execution time and not only when it was claimed. A "stop"
    /// claimed by a Mac that had been asleep for an hour would stop a run the
    /// person has since restarted.
    public func isStillValid(at now: Date) -> Bool { now < expiresAt }
}

/// The instructions this build understands.
///
/// Raw values match `WORK_COMMAND_KINDS` in `src/lib/work/domain.ts`. Matched
/// exhaustively so that adding one to the vocabulary without handling it here is
/// a compile error rather than a silent no-op.
public enum WorkLocalCommandKind: String, CaseIterable, Hashable, Sendable {
    case start
    case pause
    case resume
    case stop
    case answer
    case steer
    case approve
    case deny
    case undo
    case grantFolder = "grant_folder"
    case revokeGrant = "revoke_grant"
    case refreshCapabilities = "refresh_capabilities"
    case ping
}

// MARK: - Seams

/// What a claimed command is handed to.
///
/// Declared here rather than imported from `JunoWorkKit.WorkCommandExecuting`
/// for the reason ``WorkLocalCommand`` gives. The app conforms an adapter to
/// both and translates; the two protocols are the same idea seen from opposite
/// sides of a dependency edge that must not exist.
public protocol WorkLocalCommandExecuting: Sendable {
    func execute(_ command: WorkLocalCommand) async throws -> [String: WorkToolValue]
}

/// Whatever drives the model loop for one run.
///
/// Kept behind a protocol because the loop is not this package's business: this
/// package owns grants, tools and the approval gate, and a run is a thing that
/// uses them. It also means the whole command surface can be exercised without
/// a model, an API key or a network.
public protocol WorkRunHosting: Sendable {
    func startRun(_ request: WorkRunRequest) async throws
    func resumeRun(_ request: WorkRunRequest) async throws
    func pauseRun(runID: String) async throws
    func stopRun(runID: String, reason: String) async throws
    func deliverAnswer(runID: String, text: String) async throws
    /// Puts something the run did not ask for in front of the model.
    ///
    /// Separate from ``deliverAnswer`` rather than sharing it, because the two
    /// are different things said at different moments and only the loop can
    /// tell them apart: an answer resolves a question the run asked and is
    /// passed on as the person typed it, and an instruction arrives at a run
    /// that asked nothing and has to say so, or it reads in the transcript as
    /// the goal being restated. The server draws the same line — `answer` and
    /// `steer` are two command kinds over one route — and a host that collapsed
    /// them here would undo that at the last possible moment.
    ///
    /// **Between turns.** Whatever implements this must not abort the turn in
    /// flight: `scripts/work-runner.ts` folds a steer into the messages of the
    /// next request for the concrete reason that the alternative reaches the
    /// model no sooner and throws away every tool call that was running when the
    /// person pressed Enter.
    func deliverInstruction(runID: String, text: String) async throws
}

/// Making and taking back grants, which only the person at the Mac can do.
///
/// A remote instruction may ask this Mac to *offer* the folder dialog. It can
/// never mint the grant, which is why this is a seam to something that puts a
/// picker on screen rather than a method that returns a ``WorkGrantRuntime``.
public protocol WorkGrantRequesting: Sendable {
    /// Puts the folder picker in front of whoever is at the Mac. Returns the
    /// display name of the folder they chose, or nil if they closed it.
    func requestFolderGrant(sessionID: String) async throws -> String?
    func revokeGrant(_ grantID: WorkGrantID) async throws
}

/// What one run is allowed to work with.
public struct WorkRunRequest: Sendable {
    public let runID: String
    public let sessionID: String
    public let commandID: String
    /// Every folder this Mac will let the run touch, assembled from live grants.
    public let grants: [WorkGrantRuntime]
    public let approvals: WorkApprovalCoordinator
    /// The instruction as it arrived — the goal, the model, whatever the sender
    /// put in it. **Data for the run to read, never authority.** Nothing in here
    /// widens what `grants` and `approvals` already permit, which is the whole
    /// of the escalation boundary: a phone can say what it wants done and cannot
    /// say what this Mac may do.
    public let payload: [String: WorkToolValue]

    public init(
        runID: String,
        sessionID: String,
        commandID: String,
        grants: [WorkGrantRuntime],
        approvals: WorkApprovalCoordinator,
        payload: [String: WorkToolValue]
    ) {
        self.runID = runID
        self.sessionID = sessionID
        self.commandID = commandID
        self.grants = grants
        self.approvals = approvals
        self.payload = payload
    }
}

// MARK: - Failures

public enum WorkLocalExecutionError: Error, Equatable, Sendable {
    /// An instruction this build has no handler for. Never approximated to the
    /// nearest one it does understand.
    case unsupportedCommandKind(String)
    case commandExpired
    case missingField(String)
    case grantPickerNotAvailable
    case grantNotAvailable
    case nothingToUndo
}

extension WorkLocalExecutionError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .unsupportedCommandKind(let kind):
            "This Mac's version of Juno does not understand a \"\(kind)\" instruction, so it did nothing."
        case .commandExpired:
            "That instruction expired before this Mac could act on it."
        case .missingField(let field):
            "That instruction arrived without its \(field), so this Mac could not act on it."
        case .grantPickerNotAvailable:
            "Juno is not running on screen on this Mac, so nobody can be shown the folder chooser."
        case .grantNotAvailable:
            "That folder is no longer shared with Juno on this Mac."
        case .nothingToUndo:
            "There is nothing from this task left to undo."
        }
    }
}

// MARK: - The executor

/// What actually runs on the Mac when a phone dispatches a task.
///
/// This is the value `DesktopWorkHostModel.executorProvider` returns, and the
/// reason it must exist before the host loop starts: a Mac that advertises
/// itself as serving Work while nothing claims is a Mac whose dispatched tasks
/// sit queued for ever, which is precisely the hole Juno Code left when its own
/// `remoteExecutorProvider` was declared and never assigned.
///
/// The rules it holds to:
///
/// - **An instruction whose kind this build does not understand is refused.**
///   Not approximated to the nearest one it does understand — that is how an
///   intent to stop becomes a pause, and how a person watches a task keep going
///   after they told it not to.
/// - **An expired instruction is refused at execution time**, not merely when it
///   was claimed.
/// - **Nothing in a payload grants authority.** The grants and the approval
///   policy come from this Mac; the instruction says what is wanted.
/// - **Stopping a run takes its unanswered questions with it**, so nobody is
///   left holding an approval sheet for work they already cancelled.
public actor LocalWorkExecutor: WorkLocalCommandExecuting {
    private let hostID: String
    private let approvals: WorkApprovalCoordinator
    private let undo: WorkUndoLedger
    private let runs: any WorkRunHosting
    private let grantRequests: (any WorkGrantRequesting)?
    private let manifest: @Sendable () async -> WorkCapabilityManifest
    private let now: @Sendable () -> Date
    private var grants: [WorkGrantID: WorkGrantRuntime]

    public init(
        hostID: String,
        approvals: WorkApprovalCoordinator,
        undo: WorkUndoLedger,
        runs: any WorkRunHosting,
        grants: [WorkGrantRuntime] = [],
        grantRequests: (any WorkGrantRequesting)? = nil,
        manifest: @escaping @Sendable () async -> WorkCapabilityManifest,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.hostID = hostID
        self.approvals = approvals
        self.undo = undo
        self.runs = runs
        self.grantRequests = grantRequests
        self.manifest = manifest
        self.now = now
        self.grants = Dictionary(
            grants.map { ($0.grantID, $0) },
            uniquingKeysWith: { _, latest in latest }
        )
    }

    /// Replaces the folders this Mac will work in.
    ///
    /// Pushed in by whatever owns the grant store rather than read from it here.
    /// A revocation has to take effect against an executor that is already
    /// running, and a list snapshotted at construction is a list that is wrong
    /// the moment somebody shares a second folder.
    public func setGrants(_ runtimes: [WorkGrantRuntime]) {
        grants = Dictionary(
            runtimes.map { ($0.grantID, $0) },
            uniquingKeysWith: { _, latest in latest }
        )
    }

    /// The grants a run may work in, in a stable order.
    public var grantRuntimes: [WorkGrantRuntime] {
        grants.values.sorted { $0.grantID.value < $1.grantID.value }
    }

    public var approvalCoordinator: WorkApprovalCoordinator { approvals }

    // MARK: - Executing one instruction

    public func execute(_ command: WorkLocalCommand) async throws -> [String: WorkToolValue] {
        guard command.isStillValid(at: now()) else {
            throw WorkLocalExecutionError.commandExpired
        }
        guard let kind = WorkLocalCommandKind(rawValue: command.kind) else {
            throw WorkLocalExecutionError.unsupportedCommandKind(command.kind)
        }

        switch kind {
        case .ping:
            return ["ok": .bool(true), "hostId": .string(hostID)]

        case .refreshCapabilities:
            let current = await manifest()
            return [
                "capabilities": .array(current.capabilities.map { .string($0.rawValue) }),
                "generatedAt": .string(ISO8601DateFormatter().string(from: current.generatedAt)),
            ]

        case .start:
            let runID = try requireRunID(command)
            try await runs.startRun(runRequest(runID: runID, command: command))
            return ["started": .bool(true), "runId": .string(runID)]

        case .resume:
            let runID = try requireRunID(command)
            try await runs.resumeRun(runRequest(runID: runID, command: command))
            return ["resumed": .bool(true), "runId": .string(runID)]

        case .pause:
            let runID = try requireRunID(command)
            try await runs.pauseRun(runID: runID)
            return ["paused": .bool(true), "runId": .string(runID)]

        case .stop:
            let runID = try requireRunID(command)
            let reason = command.payload["reason"]?.stringValue ?? "You stopped this task."
            // Before the run host, deliberately. A question answered into a run
            // that has already been told to stop is an approval for work nobody
            // wants any more, and the window between the two calls is exactly
            // when a phone's pending sheet gets tapped.
            await approvals.denyPending(forRun: runID)
            try await runs.stopRun(runID: runID, reason: reason)
            return ["stopped": .bool(true), "runId": .string(runID)]

        case .answer:
            let runID = try requireRunID(command)
            guard let text = command.payload["text"]?.stringValue else {
                throw WorkLocalExecutionError.missingField("answer")
            }
            try await runs.deliverAnswer(runID: runID, text: text)
            return ["delivered": .bool(true), "runId": .string(runID)]

        case .steer:
            let runID = try requireRunID(command)
            // Missing text is a refusal, never an empty turn. A blank user
            // message in the transcript is one the model has to interpret with
            // nothing there to interpret, and the person who typed a sentence
            // would be told it was delivered.
            guard let text = command.payload["text"]?.stringValue, !text.isEmpty else {
                throw WorkLocalExecutionError.missingField("instruction")
            }
            try await runs.deliverInstruction(runID: runID, text: text)
            return ["delivered": .bool(true), "runId": .string(runID)]

        case .approve, .deny:
            guard let approvalID = command.payload["approvalId"]?.stringValue else {
                throw WorkLocalExecutionError.missingField("approval")
            }
            // Required, not optional. The digest is what makes the answer an
            // answer about an *action* rather than about a sentence somebody
            // read: a decision that echoes a different one is refused by the
            // coordinator rather than applied to whatever is waiting under that
            // identifier.
            guard let digest = command.payload["actionDigest"]?.stringValue else {
                throw WorkLocalExecutionError.missingField("action digest")
            }
            await approvals.resolve(
                approvalID: approvalID,
                decision: kind == .approve ? .approved : .denied,
                actionDigest: digest
            )
            return ["approvalId": .string(approvalID)]

        case .undo:
            return try await undoLastBatch(forRun: try requireRunID(command))

        case .grantFolder:
            guard let grantRequests else {
                throw WorkLocalExecutionError.grantPickerNotAvailable
            }
            let chosen = try await grantRequests.requestFolderGrant(sessionID: command.sessionID)
            guard let chosen else {
                return ["granted": .bool(false)]
            }
            return ["granted": .bool(true), "displayName": .string(chosen)]

        case .revokeGrant:
            guard let grantRequests else {
                throw WorkLocalExecutionError.grantPickerNotAvailable
            }
            guard let raw = command.payload["grantId"]?.stringValue else {
                throw WorkLocalExecutionError.missingField("folder")
            }
            try await grantRequests.revokeGrant(WorkGrantID(value: raw))
            return ["revoked": .bool(true)]
        }
    }

    // MARK: - Helpers

    private func requireRunID(_ command: WorkLocalCommand) throws -> String {
        guard let runID = command.runID, !runID.isEmpty else {
            throw WorkLocalExecutionError.missingField("task")
        }
        return runID
    }

    private func runRequest(runID: String, command: WorkLocalCommand) -> WorkRunRequest {
        WorkRunRequest(
            runID: runID,
            sessionID: command.sessionID,
            commandID: command.id,
            grants: grantRuntimes,
            approvals: approvals,
            payload: command.payload
        )
    }

    /// Reverses the last batch this run applied.
    ///
    /// Reported in full rather than as a success. ``WorkUndoOutcome`` carries
    /// what is still applied alongside what was reversed precisely so that half
    /// an undo cannot be announced as a whole one — a person told "undone" stops
    /// looking, and that is the worst possible moment to be wrong.
    private func undoLastBatch(forRun runID: String) async throws -> [String: WorkToolValue] {
        guard let entry = await undo.mostRecent(forRun: runID) else {
            throw WorkLocalExecutionError.nothingToUndo
        }
        guard let runtime = grants[entry.grantID] else {
            throw WorkLocalExecutionError.grantNotAvailable
        }
        let outcome = await runtime.batches.undo(entry.journal)
        if outcome.isComplete { await undo.forget(runID: runID) }
        return [
            "complete": .bool(outcome.isComplete),
            "reversed": .number(Double(outcome.reversed.count)),
            "stillApplied": .number(Double(outcome.stillApplied.count)),
            "summary": .string(outcome.summary),
        ]
    }
}
