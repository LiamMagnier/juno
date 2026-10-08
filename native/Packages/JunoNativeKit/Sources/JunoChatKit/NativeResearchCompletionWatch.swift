import Foundation

/// A research run that finished while the reader may not have been looking.
public struct NativeResearchCompletion: Equatable, Sendable {
    public enum Kind: String, Sendable {
        /// A report exists (`completed`, or `partially_completed` with one).
        case ready
        /// The run ended in an error.
        case failed
    }

    public let runID: String
    public let conversationID: String?
    /// The run's title, else its goal.
    public let title: String
    public let kind: Kind

    public init(runID: String, conversationID: String?, title: String, kind: Kind) {
        self.runID = runID
        self.conversationID = conversationID
        self.title = title
        self.kind = kind
    }

    /// What a terminal state reads as: a report, a failure, or — for a
    /// cancel — nothing, because the person who pressed Stop knows.
    public static func kind(forState state: String) -> Kind? {
        switch state {
        case "completed", "partially_completed": .ready
        case "failed": .failed
        default: nil
        }
    }

    /// The notification's headline (the server push's own words, so a
    /// local and a remote notification for one run read the same).
    public var headline: String {
        kind == .ready ? "Your research is ready" : "Your research did not finish"
    }

    /// The local notification's identifier. APNs uses `apns-collapse-id`
    /// (`research-<run id>`, `announceFinish` on the server) as the
    /// delivered request's identifier, so a local and a remote
    /// notification for one run replace each other instead of stacking.
    public var notificationIdentifier: String { "research-\(runID)" }

    /// The payload a tapped notification routes on
    /// (`JunoNotificationRoute(userInfo:)`): the run's report, with the
    /// conversation beside it as every server push carries it.
    public var userInfo: [String: String] {
        var info = ["path": "/research/\(runID)", "runId": runID, "kind": "research"]
        if let conversationID { info["conversationId"] = conversationID }
        return info
    }

    /// Notifications for one conversation group together on the device, as
    /// the server's `thread-id` groups them.
    public var threadIdentifier: String { conversationID.map { "research-\($0)" } ?? "research-\(runID)" }
}

/// Noticing that a research run finished while the app was elsewhere — in
/// another conversation, in the background, or not running at all — as a
/// pure machine (the web's `completion-watch.ts`, SPEC §9.8).
///
/// It acts only on a transition it saw: a run it saw live and now sees
/// finished. A run that was already finished the first time it was read is
/// the baseline, not news, so a relaunch never re-announces an old report.
/// The runs seen live are kept across launches (``seenLive``), which is what
/// lets a Mac that was quit mid-run say "your research is ready" when it
/// opens again: the run it saw working is now finished.
///
/// `GET /api/research?live=1` lists live runs and those finished in the last
/// ten minutes. A run seen live that the list no longer carries finished
/// earlier than that; it comes back in ``Outcome/missing`` for the caller to
/// read on its own and settle with ``settle(_:)``.
public struct NativeResearchCompletionWatch: Equatable, Sendable {
    /// Run ids seen working and not yet seen finished.
    public private(set) var seenLive: Set<String>

    /// At most this many runs are remembered: a list that only grows would
    /// be a leak, and no account has this many runs going at once.
    public static let capacity = 64

    public init(seenLive: Set<String> = []) {
        self.seenLive = seenLive
    }

    public struct Outcome: Equatable, Sendable {
        /// Runs seen live before and finished now, oldest first.
        public var finished: [NativeResearchCompletion] = []
        /// Runs seen live that the list no longer carries: read each one.
        public var missing: [String] = []
    }

    /// Notes runs the app is already following as live (a hand-off, an open
    /// conversation), so one that finishes before the next read still counts.
    public mutating func noteLive(_ runIDs: some Sequence<String>) {
        for id in runIDs { seenLive.insert(id) }
        trim()
    }

    /// Folds one `?live=1` read in.
    public mutating func apply(_ runs: [NativeResearchRunSummary]) -> Outcome {
        var outcome = Outcome()
        let listed = Set(runs.map(\.id))
        for run in runs.reversed() {
            if run.live {
                seenLive.insert(run.id)
            } else if seenLive.remove(run.id) != nil,
                let kind = NativeResearchCompletion.kind(forState: run.state)
            {
                outcome.finished.append(
                    NativeResearchCompletion(
                        runID: run.id,
                        conversationID: run.conversationID,
                        title: Self.title(run.title),
                        kind: kind
                    )
                )
            }
        }
        outcome.missing = seenLive.filter { !listed.contains($0) }.sorted()
        trim()
        return outcome
    }

    /// Settles a run that fell out of the list, from its own read: nil
    /// while it is still live (it stays watched), else its completion (or
    /// nil for a cancel, and it is forgotten).
    public mutating func settle(_ run: NativeResearchRun) -> NativeResearchCompletion? {
        guard seenLive.contains(run.id) else { return nil }
        guard NativeResearchRunSummary.terminalStates.contains(run.state) else { return nil }
        seenLive.remove(run.id)
        guard let kind = NativeResearchCompletion.kind(forState: run.state) else { return nil }
        return NativeResearchCompletion(
            runID: run.id,
            conversationID: run.conversationID,
            title: Self.title(run.displayTitle),
            kind: kind
        )
    }

    /// Forgets a run that can no longer be read (deleted, or another
    /// account's after a switch).
    public mutating func forget(_ runID: String) {
        seenLive.remove(runID)
    }

    private static func title(_ value: String?) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Deep research" : trimmed
    }

    private mutating func trim() {
        guard seenLive.count > Self.capacity else { return }
        seenLive = Set(seenLive.sorted().suffix(Self.capacity))
    }
}
