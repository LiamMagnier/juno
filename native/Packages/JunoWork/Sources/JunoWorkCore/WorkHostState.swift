import Foundation

/// How reachable a Mac is.
///
/// Raw values match `WORK_HOST_STATES` in `src/lib/work/domain.ts`. The web app,
/// the phone and the scheduler all compare against these exact strings when
/// deciding whether a task can be sent to this Mac.
public enum WorkHostState: String, Codable, CaseIterable, Sendable {
    /// Heartbeating and running something.
    case online
    /// Heartbeating and free.
    case idle
    /// Missed a heartbeat. Might come back in a moment; might be a closed lid.
    case stale
    /// Gone.
    case offline

    /// A heartbeat older than this and the Mac is stale, not online.
    public static let staleAfter: TimeInterval = 90
    /// A heartbeat older than this and the Mac is simply gone.
    public static let offlineAfter: TimeInterval = 5 * 60

    /// The state a heartbeat implies.
    ///
    /// Takes `now` rather than reading the clock so the boundaries can be tested
    /// exactly. The two thresholds are separate because `stale` and `offline`
    /// deserve different words to the person: a Mac that missed one heartbeat is
    /// worth waiting for, and one that has been quiet for five minutes is worth
    /// telling them about.
    public static func state(lastSeenAt: Date, now: Date, activeRuns: Int) -> WorkHostState {
        let age = now.timeIntervalSince(lastSeenAt)
        if age > offlineAfter { return .offline }
        if age > staleAfter { return .stale }
        return activeRuns > 0 ? .online : .idle
    }
}

/// One Mac as the rest of Work sees it.
///
/// `enabled` and `revoked` are separate from `state` because they answer
/// different questions and only one of them is about the network. A Mac the
/// person switched off is not offline, and telling them "your Mac is offline"
/// when they turned Work off themselves sends them to check their Wi-Fi.
public struct WorkHostSnapshot: Hashable, Codable, Sendable {
    public let hostID: String
    public let displayName: String
    public let state: WorkHostState
    /// The person's switch for this Mac.
    public let enabled: Bool
    /// Set when this Mac's registration was withdrawn. Terminal: a revoked host
    /// never becomes usable again without being registered afresh.
    public let revoked: Bool
    public let manifest: WorkCapabilityManifest

    public init(
        hostID: String,
        displayName: String,
        state: WorkHostState,
        enabled: Bool,
        revoked: Bool,
        manifest: WorkCapabilityManifest
    ) {
        self.hostID = hostID
        self.displayName = displayName
        self.state = state
        self.enabled = enabled
        self.revoked = revoked
        self.manifest = manifest
    }

    /// Whether a task could be sent here at this moment.
    public var isUsable: Bool {
        enabled && !revoked && (state == .online || state == .idle)
    }

    /// The required capabilities this Mac cannot serve.
    ///
    /// A Mac that is not usable is missing *everything*, rather than reporting
    /// the capabilities its last heartbeat claimed. Answering from a stale
    /// manifest is how a sleeping Mac gets picked to run a task and the person
    /// is shown a spinner that never resolves.
    public func missing(from required: [WorkCapability]) -> [WorkCapability] {
        isUsable ? manifest.missing(from: required) : Set(required).sorted()
    }

    public func canServe(_ required: [WorkCapability]) -> Bool {
        missing(from: required).isEmpty
    }
}
