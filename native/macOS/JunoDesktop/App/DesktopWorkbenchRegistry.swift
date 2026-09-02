import Foundation
import JunoCodeCore
import JunoCodeKit
import JunoCodeUI
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
            /// Open Chat on a new draft, optionally with a prompt.
            case newChat(prompt: String?)
            /// Open Code on this session.
            case openSession(CodeSessionID)
        }

        let id = UUID()
        let kind: Kind
    }

    private(set) weak var workbench: WorkbenchModel?
    private(set) weak var codeModel: NativeCodeModel?
    /// The request the main window has not yet consumed.
    private(set) var pendingRequest: Request?

    func register(workbench: WorkbenchModel?, codeModel: NativeCodeModel?) {
        self.workbench = workbench
        self.codeModel = codeModel
    }

    func request(_ kind: Request.Kind) {
        pendingRequest = Request(kind: kind)
    }

    func consume(_ request: Request) {
        guard pendingRequest?.id == request.id else { return }
        pendingRequest = nil
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
