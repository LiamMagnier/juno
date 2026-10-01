import Foundation
import JunoCodeCore

// Forking a session, and the per-session files that travel with a rewind or a
// fork (CODE_AGENT_SPEC §5.6). Owned by Lane E (review, ship, sessions and
// away); it reaches the store only through its public API, so the store's own
// file stays Lane A's.

public extension CodeSessionStore {
    /// What the store writes on a session that was mid-run when the app quit
    /// or crashed: it becomes `failed` with exactly this summary, and the
    /// Runs list reads it as interrupted, with Resume (§1.12).
    static let interruptionMessage = "Interrupted by app termination."

    /// A file inside the session's own folder, for state a lane keeps per
    /// session. It goes when the session is deleted, with everything else.
    nonisolated func sessionFileURL(_ name: String, for id: CodeSessionID) -> URL {
        sessionDirectoryURL(for: id).appendingPathComponent(name, isDirectory: false)
    }

    /// The session's own folder: `sessions/<id>/`.
    nonisolated func sessionDirectoryURL(for id: CodeSessionID) -> URL {
        commandOutputDirectory(for: id).deletingLastPathComponent()
    }

    /// The session's turn-state snapshots: the goal and the run journal as
    /// they stood when each of the reader's turns began.
    nonisolated func turnState(for id: CodeSessionID) -> TurnStateSnapshots {
        TurnStateSnapshots(sessionDirectory: sessionDirectoryURL(for: id))
    }

    /// Why a session cannot be forked.
    enum ForkError: Error, Equatable, LocalizedError {
        /// The session is working; its last turn is still being written.
        case sessionRunning
        case turnNotFound

        public var errorDescription: String? {
            switch self {
            case .sessionRunning: "Juno is working in this session. Stop it, or fork from an earlier message."
            case .turnNotFound: "That message is no longer in the conversation."
            }
        }
    }

    /// Creates a new session whose transcript and model conversation are the
    /// source's up to and including the turn `turnID` (all of it when nil).
    /// The source is not touched.
    ///
    /// The copy is cut exactly where a rewind to the *next* turn would cut,
    /// so the conversation it carries is one the model accepts and the goal
    /// and run journal are the ones that stood when that next turn began.
    ///
    /// - Parameters:
    ///   - executionRootPath: the worktree the fork runs in, when it has its
    ///     own; nil runs it in the source's checkout.
    ///   - gitBranch: the branch to record for it.
    @discardableResult
    func forkSession(
        _ sourceID: CodeSessionID,
        throughTurn turnID: String?,
        id: CodeSessionID = CodeSessionID(),
        title: String? = nil,
        executionRootPath: String? = nil,
        gitBranch: String? = nil
    ) async throws -> CodeSession {
        let source = try session(id: sourceID)
        let events = await events(for: sourceID)
        let conversation = loadConversation(sessionID: sourceID)
        let turns = ConversationRewind.turns(in: events)

        var keptEvents = events
        var keptMessages = conversation
        var goal = source.goal
        var status = source.status
        var stateBeforeSequence: Int?
        if let turnID {
            guard let position = turns.firstIndex(where: { $0.id == turnID }) else {
                throw ForkError.turnNotFound
            }
            if position + 1 < turns.count {
                let next = turns[position + 1]
                let plan = try ConversationRewind.plan(
                    rewindingTo: next.id,
                    events: events,
                    conversation: conversation
                )
                keptEvents = plan.events
                keptMessages = plan.messages
                goal = plan.goal
                status = plan.status
                stateBeforeSequence = events.first(where: { $0.id == next.id })?.sequence
            } else if source.status.isActive {
                throw ForkError.sessionRunning
            }
        } else if source.status.isActive {
            throw ForkError.sessionRunning
        }

        let created = events.lazy.compactMap { event -> SessionCreatedEvent? in
            if case let .sessionCreated(created) = event.payload { return created }
            return nil
        }.first
        let fork = try createSession(
            id: id,
            workspaceID: source.workspaceID,
            executionRootPath: executionRootPath ?? source.executionRootPath,
            workspaceName: created?.workspaceName,
            title: title ?? Self.forkTitle(for: source.title),
            configuration: source.configuration,
            gitBranch: gitBranch ?? source.gitBranch
        )
        for event in keptEvents {
            switch event.payload {
            case .sessionCreated, .transcriptRewound:
                // The fork opened with its own `sessionCreated`, and starts
                // its numbering from there rather than from a restart.
                continue
            default:
                _ = try appendEvent(sessionID: fork.id, payload: event.payload)
            }
        }
        try saveConversation(sessionID: fork.id, messages: keptMessages)
        let settled = status.isActive ? SessionStatus.cancelled : status
        let keptGoal = goal
        let updated = try updateSession(id: fork.id) { session in
            session.goal = keptGoal
            session.status = settled
            session.hasPendingApproval = false
        }

        // The lanes' per-session files, as they stood at the cut.
        let sourceState = turnState(for: sourceID)
        let forkState = turnState(for: fork.id)
        if let stateBeforeSequence {
            sourceState.copyState(atOrBefore: stateBeforeSequence, to: forkState)
        } else {
            sourceState.copyCurrentState(to: forkState)
        }
        return updated
    }

    /// "Fork of Fix the settings menu", never "Fork of Fork of …".
    nonisolated static func forkTitle(for title: String) -> String {
        let base = title.hasPrefix("Fork of ") ? String(title.dropFirst("Fork of ".count)) : title
        return "Fork of \(base)"
    }
}

/// The per-session files a rewind puts back and a fork carries: Lane A's goal
/// (`goal.json`) and run journal (`run.json`). Whatever their format, they are
/// kept as the bytes they were when each of the reader's turns began, in
/// `turn-state/<sequence>/` inside the session's folder. The todo list needs
/// none: it is the last `todosUpdated` in the transcript, which the cut keeps
/// or drops with its turn. The reader's unsent review comments are not
/// rewound; they are the reader's, not the run's.
///
/// Snapshotting the files rather than folding events keeps this independent
/// of how each lane stores its state: a rewound goal cannot keep evidence
/// from turns that no longer exist, because the file it is read from is the
/// one from before them.
public struct TurnStateSnapshots: Sendable {
    /// The files that travel with the conversation.
    public static let trackedFileNames = ["goal.json", "run.json"]
    /// Snapshots kept per session; the oldest go first.
    public static let maximumSnapshots = 100

    public let sessionDirectory: URL

    public init(sessionDirectory: URL) {
        self.sessionDirectory = sessionDirectory
    }

    private var root: URL {
        sessionDirectory.appendingPathComponent("turn-state", isDirectory: true)
    }

    private struct Manifest: Codable {
        var present: [String]
    }

    /// Records the tracked files as they are now, keyed by the transcript
    /// sequence the turn's first event takes.
    public func snapshot(atSequence sequence: Int) {
        let folder = root.appendingPathComponent(String(sequence), isDirectory: true)
        let manager = FileManager.default
        try? manager.removeItem(at: folder)
        do {
            try manager.createDirectory(at: folder, withIntermediateDirectories: true)
            var present: [String] = []
            for name in Self.trackedFileNames {
                let source = sessionDirectory.appendingPathComponent(name)
                guard manager.fileExists(atPath: source.path) else { continue }
                try manager.copyItem(at: source, to: folder.appendingPathComponent(name))
                present.append(name)
            }
            try JSONEncoder().encode(Manifest(present: present))
                .write(to: folder.appendingPathComponent("manifest.json"), options: .atomic)
        } catch {
            // A snapshot that could not be written is simply absent: the
            // rewind then restores from an earlier one, or leaves the files.
            try? manager.removeItem(at: folder)
        }
        prune()
    }

    /// The sequences that have a snapshot, oldest first.
    public var sequences: [Int] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return names.compactMap(Int.init).sorted()
    }

    /// Puts back the tracked files as they stood when the turn at `sequence`
    /// began: the newest snapshot at or before it. A file that did not exist
    /// then is removed. Returns false, changing nothing, when there is none.
    @discardableResult
    public func restore(toSequence sequence: Int) -> Bool {
        guard let key = sequences.last(where: { $0 <= sequence }) else { return false }
        write(snapshot: key, into: sessionDirectory)
        // Later snapshots describe turns that no longer exist.
        for later in sequences where later > key {
            try? FileManager.default.removeItem(at: root.appendingPathComponent(String(later)))
        }
        return true
    }

    /// Copies the files as they stood at `sequence` into another session.
    public func copyState(atOrBefore sequence: Int, to other: TurnStateSnapshots) {
        guard let key = sequences.last(where: { $0 <= sequence }) else { return }
        try? FileManager.default.createDirectory(at: other.sessionDirectory, withIntermediateDirectories: true)
        write(snapshot: key, into: other.sessionDirectory)
    }

    /// Copies the files as they are now into another session.
    public func copyCurrentState(to other: TurnStateSnapshots) {
        let manager = FileManager.default
        try? manager.createDirectory(at: other.sessionDirectory, withIntermediateDirectories: true)
        for name in Self.trackedFileNames {
            let source = sessionDirectory.appendingPathComponent(name)
            let destination = other.sessionDirectory.appendingPathComponent(name)
            guard manager.fileExists(atPath: source.path) else { continue }
            try? manager.removeItem(at: destination)
            try? manager.copyItem(at: source, to: destination)
        }
    }

    private func write(snapshot key: Int, into directory: URL) {
        let manager = FileManager.default
        let folder = root.appendingPathComponent(String(key), isDirectory: true)
        let present = (try? Data(contentsOf: folder.appendingPathComponent("manifest.json")))
            .flatMap { try? JSONDecoder().decode(Manifest.self, from: $0) }?
            .present ?? []
        for name in Self.trackedFileNames {
            let destination = directory.appendingPathComponent(name)
            try? manager.removeItem(at: destination)
            if present.contains(name) {
                try? manager.copyItem(at: folder.appendingPathComponent(name), to: destination)
            }
        }
    }

    private func prune() {
        let all = sequences
        guard all.count > Self.maximumSnapshots else { return }
        for key in all.prefix(all.count - Self.maximumSnapshots) {
            try? FileManager.default.removeItem(at: root.appendingPathComponent(String(key)))
        }
    }
}
