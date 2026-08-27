import JunoCodeCore
import JunoCodeKit
import JunoDesignSystem
import SwiftUI

// The status vocabulary for Juno Code. **This file is the vocabulary** — there
// is no second one.
//
// Before this there were six loose glyphs across the window with no shared
// family and no legend: a shield, a spinner, a filled dot, a green check, a red
// exclamation and a hollow dot. Four of them were declared at three different
// call sites from three different transports, so the same run could be a
// spinner in the sidebar and a dot in the toolbar, and nothing in the product
// could tell a reader what any of them meant.
//
// Three rules hold the set together:
//
// 1. **One shape family.** Every mark is a circle — filled, hollow, dotted or
//    carrying a glyph. A reader learns "the small circle is the run" once, then
//    only has to read its fill and its colour.
// 2. **Three inks, spent by need.** Secondary ink for anything the reader does
//    not have to act on, and hue only for the three states worth interrupting
//    for: caution when Juno is waiting on a person, danger when a run failed,
//    success when it finished. That is the website's own rule in
//    `app-sidebar.tsx`, and it is why a window with four live runs is not four
//    coral marks.
// 3. **Static.** A row's mark never spins. Motion belongs to the one live
//    surface on screen — the transcript tail — because a spinner per row is
//    both a per-row animation loop and a still-frame failure: paused, a
//    spinning row and a wedged row are the same picture. The label, the elapsed
//    time and the last action carry the state as text.

// MARK: - The table

/// Every state a Code run can be in, in one closed set.
///
/// The transports disagree about how they *report* state — a local session has
/// an enum, a cloud task has a different enum, and the relay reports flags —
/// so each of them projects into this, and everything downstream reads only
/// this.
public enum CodeRunState: String, CaseIterable, Sendable {
    /// Created, nothing in flight.
    case ready
    /// Generating plan before execution.
    case planning
    /// Accepted by the cloud, not started.
    case queued
    /// Working.
    case running
    /// Waiting for provider inference or catalog failover.
    case waitingForProvider
    /// Running in degraded mode.
    case degraded
    /// Blocked on a person. The only state that is *asking* for something.
    case needsApproval
    /// Asked to stop, not stopped yet.
    case stopping
    /// Finished on its own terms.
    case finished
    /// Finished badly.
    case failed
    /// Ended because someone ended it.
    case stopped
    /// The host that owns this run has stopped checking in.
    case hostOffline

    /// The word the whole product uses for this state. A run does not read as
    /// "Running" in the column and "Active" in the toolbar.
    public var label: String {
        switch self {
        case .ready: "Ready"
        case .planning: "Planning"
        case .queued: "Queued"
        case .running: "Running"
        case .waitingForProvider: "Waiting for model"
        case .degraded: "Degraded"
        case .needsApproval: "Needs approval"
        case .stopping: "Stopping"
        case .finished: "Completed"
        case .failed: "Failed"
        case .stopped: "Stopped"
        case .hostOffline: "Computer offline"
        }
    }

    /// One sentence a reader can learn the mark from. Shown in the legend and
    /// used as the mark's tooltip, so the vocabulary is discoverable in place
    /// rather than only in a document.
    public var meaning: String {
        switch self {
        case .ready: "Created and waiting for your first instruction."
        case .planning: "Juno is synthesizing an implementation plan."
        case .queued: "Accepted, waiting for a machine to pick it up."
        case .running: "Juno is working on it now."
        case .waitingForProvider: "Waiting for model inference response or failover."
        case .degraded: "Running with fallback model or clamped capabilities."
        case .needsApproval: "Juno stopped to ask you something."
        case .stopping: "Stopping — finishing the step it is on."
        case .finished: "Finished on its own terms."
        case .failed: "Stopped because something went wrong."
        case .stopped: "Ended because someone ended it."
        case .hostOffline: "The computer running this has stopped checking in."
        }
    }

    /// The mark. One circle family, so the column reads as one vocabulary.
    public var symbol: String {
        switch self {
        case .ready: "circle"
        case .planning: "brain.head.profile"
        case .queued: "circle.dotted"
        case .running: "circle.inset.filled"
        case .waitingForProvider: "hourglass.circle"
        case .degraded: "exclamationmark.triangle"
        case .needsApproval: "exclamationmark.circle.fill"
        case .stopping: "stop.circle"
        case .finished: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .stopped: "stop.circle.fill"
        case .hostOffline: "bolt.horizontal.circle"
        }
    }

    /// The website's own mark, where the concept has one.
    ///
    /// Most of this vocabulary is native-only — the web draws run status as a
    /// small tinted dot and has no glyph for queued, running or completed — so
    /// an SF Symbol here is an elaboration rather than a divergence. Two states
    /// *are* named on the web, and those two must not be something else here.
    public var junoIcon: JunoIcon? {
        switch self {
        case .needsApproval: .permission
        case .failed: .error
        case .ready, .planning, .queued, .running, .waitingForProvider, .degraded, .stopping, .finished, .stopped, .hostOffline: nil
        }
    }

    /// Hue only where the state asks something of the reader.
    public var tint: Color {
        switch self {
        case .needsApproval, .hostOffline, .degraded: Color.junoCaution
        case .failed: Color.junoDanger
        case .finished: Color.junoSuccess
        case .ready, .planning, .queued, .running, .waitingForProvider, .stopping, .stopped: Color.junoMutedForeground
        }
    }

    /// Whether the run is still going to change on its own.
    public var isActive: Bool {
        switch self {
        case .planning, .queued, .running, .waitingForProvider, .degraded, .needsApproval, .stopping: true
        case .ready, .finished, .failed, .stopped, .hostOffline: false
        }
    }

    /// Whether the run is blocked on a person. Sorts these to the top of any
    /// list: they are the only rows where waiting costs the reader anything.
    public var needsApproval: Bool { self == .needsApproval }
}

/// A run's state, resolved from whichever transport reported it.
///
/// A value rather than a view so the toolbar, the column and the detail
/// surfaces read the same fact, and so the projection from each transport is
/// reachable from a test without a window.
public struct CodeRunStatus: Sendable, Equatable {
    public let state: CodeRunState

    public var label: String { state.label }
    public var symbol: String { state.symbol }
    public var junoIcon: JunoIcon? { state.junoIcon }
    public var tint: Color { state.tint }
    public var isActive: Bool { state.isActive }
    public var needsApproval: Bool { state.needsApproval }

    public init(_ state: CodeRunState) {
        self.state = state
    }

    /// - Parameter hasPendingApproval: the session record's own flag, which the
    ///   store keeps current for every session including the ones not on
    ///   screen. A live session blocked on the reader outranks whatever its
    ///   status says.
    public init(_ status: SessionStatus, hasPendingApproval: Bool = false) {
        if hasPendingApproval, !status.isTerminal {
            self.init(CodeRunState.needsApproval)
            return
        }
        switch status {
        case .idle: self.init(CodeRunState.ready)
        case .planning: self.init(CodeRunState.planning)
        case .running: self.init(CodeRunState.running)
        case .waitingForApproval: self.init(CodeRunState.needsApproval)
        case .waitingForProvider: self.init(CodeRunState.waitingForProvider)
        case .degraded: self.init(CodeRunState.degraded)
        case .stopping: self.init(CodeRunState.stopping)
        case .completed: self.init(CodeRunState.finished)
        case .failed: self.init(CodeRunState.failed)
        case .cancelled: self.init(CodeRunState.stopped)
        }
    }

    public init(_ status: NativeCodeTaskStatus) {
        switch status {
        case .queued: self.init(CodeRunState.queued)
        case .running: self.init(CodeRunState.running)
        case .awaitingApproval: self.init(CodeRunState.needsApproval)
        case .done: self.init(CodeRunState.finished)
        case .failed: self.init(CodeRunState.failed)
        case .cancelled: self.init(CodeRunState.stopped)
        }
    }

    /// The relay reports a session's state as flags rather than an enum, and a
    /// host that has stopped checking in is *stale* rather than idle: sending
    /// to it would produce a command nobody claims.
    public init(_ summary: CodeRemoteSessionSummary) {
        if summary.isAwaitingApproval {
            self.init(CodeRunState.needsApproval)
        } else if summary.fresh == false {
            self.init(CodeRunState.hostOffline)
        } else if summary.isRunning {
            self.init(CodeRunState.running)
        } else if summary.lastError != nil {
            self.init(CodeRunState.failed)
        } else {
            self.init(CodeRunState.ready)
        }
    }
}

// MARK: - The mark

/// A run's state as one mark, at one size, in one place.
///
/// Fixed-width so a list of rows keeps one text column no matter which state
/// each row is in — a mark that changes width re-flows the whole list every
/// time a run finishes.
///
/// The symbol is swapped **in place** on `JunoMotion.fast`: a property changing
/// on an element already under the pointer is exactly what that rung is for,
/// and `.replace` keeps the mark's identity so the row does not resize or
/// re-enter. Nothing here spins.
public struct CodeStatusGlyph: View {
    private let status: CodeRunStatus
    private let size: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ status: CodeRunStatus, size: CGFloat = 13) {
        self.status = status
        self.size = size
    }

    public var body: some View {
        // Use the same generated Lucide family as the website and the phone.
        // The old implementation rendered SF Symbols for every state, which
        // made the desktop Code rail look like a separate product and allowed
        // the icon weight to drift from the native Juno surfaces. States that
        // have a semantic mark keep it; the neutral lifecycle states share the
        // refresh/check/stop vocabulary so the mark remains legible at 13pt.
        JunoIconView(statusIcon, size: size)
            .foregroundStyle(status.tint)
        .frame(width: CodeRowMetrics.markColumn)
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
            value: status.state
        )
        // **No `.help` here, deliberately.** A tooltip on the mark itself
        // attaches a dynamic tooltip responder to every row of a `List`, and
        // AppKit's tooltip bridge walks that responder tree on every mouse
        // move — a sidebar of forty runs made it forty deep and it segfaulted
        // inside `NSViewDynamicToolTipManager` on a hover. The meaning belongs
        // to the *row* or the *header* that owns the mark, which is one
        // responder rather than one per glyph, and ``CodeStatusLegend`` is the
        // discoverable version of the same information.
        .accessibilityLabel(status.label)
    }

    private var statusIcon: JunoIcon {
        if let icon = status.junoIcon { return icon }
        switch status.state {
        case .ready, .finished: return .check
        case .stopped: return .stop
        case .hostOffline: return .device
        case .planning, .queued, .running, .waitingForProvider, .degraded, .stopping:
            return .refresh
        case .needsApproval, .failed: return .error
        }
    }
}

/// The vocabulary, written out.
///
/// Six unexplained glyphs was the complaint; a table nobody can reach is the
/// same complaint with extra steps. This is reachable — the sidebar's own
/// section header carries it — and it is generated from ``CodeRunState``, so a
/// state added without a legend entry is not possible.
public struct CodeStatusLegend: View {
    public init() {}

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            ForEach(CodeRunState.allCases, id: \.self) { state in
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    CodeStatusGlyph(CodeRunStatus(state))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(state.label).junoRowLabel()
                        Text(state.meaning).junoCaption()
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: 320, alignment: .leading)
        .padding(JunoSpace.cozy)
    }
}

// MARK: - Shared row metrics

/// The numbers every Code row agrees on.
///
/// They live here rather than at each call site because the loading skeleton
/// has to claim *exactly* the geometry the loaded row will occupy — that is the
/// whole difference between a skeleton and a spinner — and a second copy of
/// these numbers is how the two silently drift apart.
public enum CodeRowMetrics {
    /// The status mark's column. Fixed so titles share one left edge.
    public static let markColumn: CGFloat = 16
    /// The pointer target for a row. The platform's minimum, not a suggestion.
    public static let minHeight: CGFloat = 44
    /// A two-line row: title over caption.
    public static let stackedHeight: CGFloat = 44
}
