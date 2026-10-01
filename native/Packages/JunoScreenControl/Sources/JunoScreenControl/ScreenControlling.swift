import Foundation

/// Takeover or not.
public enum ScreenControlMode: String, Hashable, Codable, Sendable {
    /// One window at a time; the reader keeps the pointer and keyboard.
    case background
    /// The whole display and the real pointer. Needs its own consent card
    /// every session (CODE_AGENT_SPEC §3.7).
    case takeover
}

/// Where a session's screen control stands, for the tools' first check.
public enum ScreenSessionState: Hashable, Sendable {
    case off
    case running(mode: ScreenControlMode, app: String?)
    case paused
    case stopped(ScreenControlStopReason)
}

/// The resolved target of an action, in words, for the card and the row.
public struct ScreenTargetSummary: Hashable, Codable, Sendable {
    public var bundleID: String
    public var appName: String
    /// "“Save” button".
    public var element: String?
    public var role: String?
    public var title: String?

    public init(bundleID: String, appName: String, element: String? = nil, role: String? = nil, title: String? = nil) {
        self.bundleID = bundleID
        self.appName = appName
        self.element = element
        self.role = role
        self.title = title
    }
}

/// An action that passed every check and is ready to be approved and sent.
///
/// Made by ``ScreenControlling/prepare(sessionID:action:)``. It carries what
/// the approval card shows — the exact text, a crop of the frame with the
/// target marked, the app and the element — and the frame it is bound to.
public struct PreparedScreenAction: Hashable, Sendable, Identifiable {
    public var id: String
    public var sessionID: String
    public var action: ScreenAction
    public var target: ScreenTargetSummary
    /// Where it lands, in global points.
    public var point: ScreenPoint?
    public var startPoint: ScreenPoint?
    /// The point in frame pixels, for the marker.
    public var framePoint: [Double]?
    /// Why it always asks, when it does.
    public var floor: FloorReason?
    /// SHA-256 of the frame the coordinates refer to. The approval digest
    /// includes it.
    public var frameHash: String
    /// The exact sentence: "Type “hello” into the “Name” text field in TextEdit".
    public var summary: String
    /// A PNG crop of the frame around the target, with the target marked.
    public var crop: Data?
    /// Whether it changes anything. Observations are never approved.
    public var isInput: Bool

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: String,
        action: ScreenAction,
        target: ScreenTargetSummary,
        point: ScreenPoint? = nil,
        startPoint: ScreenPoint? = nil,
        framePoint: [Double]? = nil,
        floor: FloorReason? = nil,
        frameHash: String,
        summary: String,
        crop: Data? = nil,
        isInput: Bool
    ) {
        self.id = id
        self.sessionID = sessionID
        self.action = action
        self.target = target
        self.point = point
        self.startPoint = startPoint
        self.framePoint = framePoint
        self.floor = floor
        self.frameHash = frameHash
        self.summary = summary
        self.crop = crop
        self.isInput = isInput
    }
}

/// What an action returns to the model.
public struct ScreenActionResult: Hashable, Sendable {
    /// One sentence: "Clicked the “Save” button in TextEdit." The thread's
    /// step row shows it.
    public var summary: String
    /// The frame header and the untrusted-data line, when a frame is attached.
    public var frameHeader: String?
    /// The settled after-frame.
    public var frame: EncodedFrame?
    /// Anything else the model should know: a clamped wait, a zoom note.
    public var notes: [String]

    public init(summary: String, frameHeader: String? = nil, frame: EncodedFrame? = nil, notes: [String] = []) {
        self.summary = summary
        self.frameHeader = frameHeader
        self.frame = frame
        self.notes = notes
    }

    /// The text the model reads, header and framing included.
    public var text: String {
        var lines = [summary]
        if let frameHeader { lines.append(frameHeader) }
        lines.append(contentsOf: notes)
        return lines.joined(separator: "\n")
    }
}

/// What the approval card for a screen tool shows, by approval digest.
public enum ScreenApprovalDetail: Hashable, Sendable {
    case action(PreparedScreenAction)
    case grants(GrantProposal)
    case takeover(sessionID: String, display: String)
}

/// One app in `computer_apps list`.
public struct ScreenAppListing: Hashable, Sendable {
    public var bundleID: String
    public var name: String
    public var running: Bool
    public var category: AppCategory
    public var grantedTier: AppTier?
    public var cap: AppTier?
}

/// A step the reader can see: what happened, where, and the after-frame,
/// for the live thumbnail and the step rows (CU-13). Memory only.
public struct ScreenActivity: Sendable, Identifiable {
    public var id: String
    public var sessionID: String
    public var toolCallID: String?
    public var kind: ScreenActionKind?
    public var summary: String
    public var appName: String?
    /// A small JPEG of the after-frame.
    public var thumbnail: Data?
    /// The point acted on, as a fraction of the thumbnail (0…1 each way).
    public var markedPoint: [Double]?
    public var succeeded: Bool
    public var at: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: String,
        toolCallID: String?,
        kind: ScreenActionKind?,
        summary: String,
        appName: String?,
        thumbnail: Data?,
        markedPoint: [Double]?,
        succeeded: Bool,
        at: Date
    ) {
        self.id = id
        self.sessionID = sessionID
        self.toolCallID = toolCallID
        self.kind = kind
        self.summary = summary
        self.appName = appName
        self.thumbnail = thumbnail
        self.markedPoint = markedPoint
        self.succeeded = succeeded
        self.at = at
    }
}

/// Everything the presence surfaces need, in one value.
public struct ScreenPresenceState: Hashable, Sendable {
    public var holder: ScreenControlHolder?
    public var mode: ScreenControlMode
    public var paused: Bool
    /// The target window's frame, for the outline glow, when known.
    public var targetWindowFrame: ScreenRect?
    public var displayFrame: ScreenRect?

    public init(
        holder: ScreenControlHolder? = nil,
        mode: ScreenControlMode = .background,
        paused: Bool = false,
        targetWindowFrame: ScreenRect? = nil,
        displayFrame: ScreenRect? = nil
    ) {
        self.holder = holder
        self.mode = mode
        self.paused = paused
        self.targetWindowFrame = targetWindowFrame
        self.displayFrame = displayFrame
    }

    public static let idle = ScreenPresenceState()

    /// "Juno is using TextEdit · Esc to stop".
    public var caption: String? {
        guard let holder else { return nil }
        let app = holder.appName.map { "Juno is using \($0)" } ?? "Juno is using apps"
        return paused ? "You took over · Juno is waiting" : app + " · Esc to stop"
    }
}

/// The agent-facing surface of screen control, keyed by session id.
///
/// Implemented by ``ScreenControlService`` and adapted by Juno Code's
/// coordinator. Every method re-checks the session's grant after every
/// suspension point; nothing here can be reached without the reader having
/// started screen control for the session.
public protocol ScreenControlling: Sendable {
    func state(sessionID: String) async -> ScreenSessionState
    func listApps(sessionID: String) async -> [ScreenAppListing]
    func proposeGrants(sessionID: String, apps: [String], reason: String?, clipboardRead: Bool, clipboardWrite: Bool) async throws -> GrantProposal
    /// Applies a proposal the reader approved, with the choices they made on
    /// the sheet.
    func applyGrants(sessionID: String, proposalID: String) async throws -> [AppGrant]
    func grants(sessionID: String) async -> [AppGrant]
    func release(sessionID: String, apps: [String]) async -> [String]
    /// Targets a granted app (launching it in the background if needed) and
    /// returns its first frame.
    func open(sessionID: String, app: String) async throws -> ScreenActionResult
    /// Every check before an action: running, granted, tier, Juno, secure
    /// fields, prompts in front, the frame, the floor.
    func prepare(sessionID: String, action: ScreenAction) async throws -> PreparedScreenAction
    /// Sends a prepared action, after re-proving the frame and the grant.
    func perform(sessionID: String, prepared: PreparedScreenAction, toolCallID: String?, attachFrame: Bool) async throws -> ScreenActionResult
    /// A settled frame of the current target, for the end of a batch.
    func settledFrame(sessionID: String) async throws -> ScreenActionResult
    func accessibility(sessionID: String, app: String?, query: String?, filter: AXSnapshot.Filter, depth: Int) async throws -> String
    func prepareMenu(sessionID: String, app: String?, path: [String]) async throws -> PreparedScreenAction
    func performMenu(sessionID: String, prepared: PreparedScreenAction, path: [String], toolCallID: String?) async throws -> ScreenActionResult
    func displays(sessionID: String) async -> [DisplayInfo]
    func requestTakeover(sessionID: String, displayID: UInt32?) async throws -> ScreenApprovalDetail
    func beginTakeover(sessionID: String, displayID: UInt32?) async throws -> String
    func endTakeover(sessionID: String) async -> String
    /// What the card for an approval shows, published before the approval is
    /// asked and cleared after it is answered.
    func publishApprovalDetail(_ detail: ScreenApprovalDetail, digest: String) async
    func clearApprovalDetail(digest: String) async
    func approvalDetail(digest: String) async -> ScreenApprovalDetail?
    /// The reader's choices on a grant sheet before they press Allow.
    func updateGrantChoices(proposalID: String, offers: [AppGrantOffer]) async
    /// Whether `bundleID` is granted at any tier, for gated readers like
    /// `inspect_active_editor` (CU-12).
    func isGranted(sessionID: String, bundleID: String) async -> Bool
}
