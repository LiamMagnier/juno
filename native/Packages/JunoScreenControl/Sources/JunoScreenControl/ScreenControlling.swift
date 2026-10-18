import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

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

    public init(bundleID: String, name: String, running: Bool, category: AppCategory, grantedTier: AppTier?, cap: AppTier?) {
        self.bundleID = bundleID
        self.name = name
        self.running = running
        self.category = category
        self.grantedTier = grantedTier
        self.cap = cap
    }
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
    /// Paused because the Mac is locked, not because the reader took over.
    public var lockedPause: Bool

    public init(
        holder: ScreenControlHolder? = nil,
        mode: ScreenControlMode = .background,
        paused: Bool = false,
        targetWindowFrame: ScreenRect? = nil,
        displayFrame: ScreenRect? = nil,
        lockedPause: Bool = false
    ) {
        self.holder = holder
        self.mode = mode
        self.paused = paused
        self.targetWindowFrame = targetWindowFrame
        self.displayFrame = displayFrame
        self.lockedPause = lockedPause
    }

    public static let idle = ScreenPresenceState()

    /// "Alevr is using TextEdit · Esc to stop". The one place the presence
    /// says how to stop: the action overlay's label does not repeat it.
    public var caption: String? {
        guard let holder else { return nil }
        let app = holder.appName.map { "\(ScreenControlBrand.productName) is using \($0)" } ?? "\(ScreenControlBrand.productName) is using apps"
        if lockedPause { return "Paused: your Mac is locked" }
        return paused ? "You took over · \(ScreenControlBrand.productName) is waiting" : app + " · Esc to stop"
    }
}

#if canImport(CoreGraphics)
/// Where the presence draws, in AppKit's global coordinates (bottom-left
/// origin, the space `NSScreen.frame` and ``ScreenPresenceState``'s frames
/// flipped by the app share). Plain geometry, so the placement is tested
/// here rather than in the app.
public enum ScreenPresenceLayout {
    /// The screen the caption belongs on: the one holding most of the driven
    /// window (or, in takeover, the driven display), else the main screen,
    /// else the first. Nil only when there are no screens.
    public static func screenIndex(holding target: CGRect?, screens: [CGRect], mainIndex: Int?) -> Int? {
        guard !screens.isEmpty else { return nil }
        let fallback = mainIndex.flatMap { screens.indices.contains($0) ? $0 : nil } ?? 0
        guard let target, !target.isNull, !target.isEmpty else { return fallback }
        var best: (index: Int, area: CGFloat)?
        for (index, screen) in screens.enumerated() {
            let overlap = screen.intersection(target)
            guard !overlap.isNull, !overlap.isEmpty else { continue }
            let area = overlap.width * overlap.height
            if area > (best?.area ?? 0) { best = (index, area) }
        }
        return best?.index ?? fallback
    }

    /// Below the menu bar, centred: `visibleFrame` is the screen minus the
    /// menu bar and the Dock.
    public static func captionFrame(size: CGSize, visibleFrame: CGRect, gap: CGFloat = 8) -> CGRect {
        CGRect(
            x: (visibleFrame.midX - size.width / 2).rounded(),
            y: (visibleFrame.maxY - size.height - gap).rounded(),
            width: size.width,
            height: size.height
        )
    }

    /// The driven window's outline: just outside its edge, so it frames the
    /// window rather than covering its content.
    public static func outlineFrame(around window: CGRect, outset: CGFloat = 4) -> CGRect {
        window.insetBy(dx: -outset, dy: -outset)
    }
}
#endif

/// A step an unattended run did not take because it needed someone's say-so.
public struct ScreenSkippedStep: Hashable, Sendable {
    /// What the step would have done: "Click the “Send” button in Mail".
    public var summary: String
    /// Why it was skipped, in a sentence.
    public var reason: String
    public var at: Date

    public init(summary: String, reason: String, at: Date) {
        self.summary = summary
        self.reason = reason
        self.at = at
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
    /// The route's image budget, set by the tools before they capture.
    func setImageBudget(sessionID: String, budget: ImageBudget) async
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
    /// Drops what a prepared action holds — its bound frame — when it will
    /// never be performed: the reader denied it, or the approval failed.
    func discard(sessionID: String, preparedID: String) async
    /// The reader's "whole display" tick on an open take-over card, set by
    /// the card before Allow. No tool reaches it.
    func setTakeoverScope(sessionID: String, wholeDisplay: Bool) async
    /// Whether nobody is watching this session's run (scheduled, resumed
    /// after a usage reset): the tools then skip what would ask.
    func isUnattended(sessionID: String) async -> Bool
    /// Records a step an unattended run skipped instead of asking, for the
    /// run's report and the step rows.
    func recordSkipped(sessionID: String, summary: String, reason: String) async
}

public extension ScreenControlling {
    func discard(sessionID _: String, preparedID _: String) async {}
}
