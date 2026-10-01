import AppKit
import Foundation
import JunoCodeCore
import JunoCodeKit
import JunoCodeUI
import JunoCore
import Observation
import SwiftUI

/// Where the app's scenes that are *not* the main window find the live Code
/// models: the menu bar extra, the Settings window's Code section, and the
/// floating quick-entry panel.
///
/// The `WorkbenchModel` is built in ``JunoDesktopRootView`` when sign-in lands
/// and torn down at sign-out, so it cannot be a stored property of the `App`.
/// Those three scenes only ever need to *look at* it — list the running
/// sessions, read the granted projects — and a weak reference is the honest
/// shape for that: when the workbench goes, the menu bar item reads "signed
/// out" rather than keeping a dead workbench alive.
///
/// It also carries the one thing the main window needs to *receive* from those
/// scenes: a request to start a task, as a token the window consumes exactly
/// once. A token rather than a Bool so two requests a second apart cannot be
/// coalesced by SwiftUI's state batching.
@MainActor
@Observable
final class DesktopWorkbenchRegistry {
    static let shared = DesktopWorkbenchRegistry()

    /// A request from outside the main window to begin something in it.
    struct Request: Identifiable, Equatable {
        enum Kind: Equatable {
            /// Open Code on the New task screen, optionally with a prompt.
            case newCodeTask(prompt: String?)
            /// Open Chat on a new draft, optionally with a prompt; `isPrivate`
            /// makes the draft a private chat (⇧⌘N with no window focused).
            case newChat(prompt: String?, isPrivate: Bool = false)
            /// Open Code on this session.
            case openSession(CodeSessionID)
        }

        let id = UUID()
        let kind: Kind
    }

    /// Where a tapped notification points: an agent's page, a thread, or a
    /// Work task. Raised by the app delegate, which has no window of its own,
    /// and consumed by whichever main window takes it first.
    ///
    /// Its own token rather than a `Request.Kind`: the Code window switches
    /// over the kinds exhaustively, and none of these is a thing Code should
    /// have to name.
    struct RouteRequest: Identifiable, Equatable {
        let id = UUID()
        let route: JunoNotificationRoute
    }

    private(set) weak var workbench: WorkbenchModel?
    private(set) weak var codeModel: NativeCodeModel?
    /// The request the main window has not yet consumed.
    private(set) var pendingRequest: Request?
    /// The notification route the main window has not yet consumed.
    private(set) var pendingRoute: RouteRequest?

    func register(workbench: WorkbenchModel?, codeModel: NativeCodeModel?) {
        self.workbench = workbench
        self.codeModel = codeModel
        // The run monitor follows the workbench for as long as it exists, not
        // a window: its notifications and its keep-awake assertion matter
        // most while Chat is showing or the window is closed. The workbench's
        // shutdown hands it an empty list, which releases the assertion.
        workbench?.sessionsObserver = { sessions in
            StudioRunMonitor.shared.observe(sessions)
        }
        // The Runs list is what the monitor speaks from: a finished run, an
        // approval, a question, each said in words with its answer on the
        // banner (CODE_AGENT_SPEC §1.11). The session in view says nothing:
        // its card is on screen.
        StudioRunMonitor.shared.sessionInView = { [weak workbench] in
            NSApp?.isActive == true ? workbench?.selectedSessionID : nil
        }
        workbench?.runIndexObserver = { entries in
            StudioRunMonitor.shared.observeRuns(entries)
        }
    }

    /// How many sessions have a run open: what the quit guard asks about.
    var activeRunCount: Int {
        workbench?.activeRunCount ?? 0
    }

    func request(_ kind: Request.Kind) {
        pendingRequest = Request(kind: kind)
    }

    func consume(_ request: Request) {
        guard pendingRequest?.id == request.id else { return }
        pendingRequest = nil
    }

    /// An errand — something to be done rather than asked — opens a new chat.
    ///
    /// Work stopped being a product in Phase 1 of the Liquid Glass redesign,
    /// and an errand no longer has a workspace of its own to land in. It lands
    /// where tasks live: an ordinary chat, with the sentence in the composer.
    /// Nothing is armed — there is no task switch on the web either. The model
    /// reads the sentence and starts a task itself when it is one
    /// (`start_task`), and the chat draws it (Phase 5).
    func requestWorkErrand(prompt: String?) {
        request(.newChat(prompt: prompt))
    }

    func requestRoute(_ route: JunoNotificationRoute) {
        pendingRoute = RouteRequest(route: route)
    }

    func consume(_ routeRequest: RouteRequest) {
        guard pendingRoute?.id == routeRequest.id else { return }
        pendingRoute = nil
    }

    /// Every session that is still going to change on its own, across the
    /// local workbench and the account's cloud and device runs.
    var activeSessions: [ActiveSession] {
        var rows: [ActiveSession] = []
        if let workbench {
            for session in workbench.visibleSessions where session.status.isActive {
                rows.append(
                    ActiveSession(
                        id: "session:\(session.id.value)",
                        title: session.title,
                        detail: workbench.workspaceName(for: session.workspaceID),
                        status: CodeRunStatus(
                            session.status,
                            hasPendingApproval: session.hasPendingApproval
                        ),
                        updatedAt: session.updatedAt,
                        sessionID: session.id
                    )
                )
            }
        }
        if let codeModel {
            for task in codeModel.tasks where task.status.isActive {
                rows.append(
                    ActiveSession(
                        id: "task:\(task.id)",
                        title: task.title,
                        detail: task.target == .cloud ? "Cloud" : (task.workspaceName ?? "Device"),
                        status: CodeRunStatus(task.status),
                        updatedAt: task.updatedAt,
                        sessionID: nil
                    )
                )
            }
        }
        return rows.sorted { left, right in
            if left.status.needsApproval != right.status.needsApproval {
                return left.status.needsApproval
            }
            return left.updatedAt > right.updatedAt
        }
    }

    struct ActiveSession: Identifiable, Equatable {
        let id: String
        let title: String
        let detail: String
        let status: CodeRunStatus
        let updatedAt: Date
        /// Nil for a cloud or device run, which the menu bar item cannot open
        /// directly; it opens the window on Code instead.
        let sessionID: CodeSessionID?
    }
}
