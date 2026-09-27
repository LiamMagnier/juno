import Foundation
import JunoChatKit
import Observation
import SwiftUI

/// A page pushed on a destination's own `NavigationStack` (spec §9, Phase 4
/// brief §2.5): a project, an artifact, a skill, an automation or a host. An
/// agent has no page: it is its thread, with its profile as a sheet.
///
/// Every destination but Chat sits in a stack of its own
/// (``DesktopDestinationView``), with **one** `navigationDestination(for:)`
/// at the stack root; a page pushes through ``SwiftUI/EnvironmentValues/desktopPush``
/// or a `NavigationLink(value:)`, and the system's back button returns.
enum DesktopPageRoute: Hashable, Codable {
    case project(String)
    /// An artifact's own page (the web's `/a/{id}`); `version` nil is the latest.
    case artifact(String, version: Int?)
    /// Library › the document inspector (Phase 4 A7; not reachable yet).
    case document(String)
    case skill(String), newSkill
    case automation(String), newAutomation
    case host(String)
}

/// Pushes a page onto the enclosing destination's stack.
struct DesktopPushAction: Sendable {
    let push: @MainActor @Sendable (DesktopPageRoute) -> Void

    @MainActor
    func callAsFunction(_ route: DesktopPageRoute) {
        push(route)
    }

    static let none = DesktopPushAction { _ in }
}

extension EnvironmentValues {
    /// The enclosing destination's push. Outside a page stack it does nothing.
    @Entry var desktopPush: DesktopPushAction = .none
    /// Replaces the page on top of the enclosing stack — New automation
    /// becoming the automation it made — so
    /// back returns to the list rather than to a spent form. Outside a page
    /// stack it does nothing.
    @Entry var desktopReplace: DesktopPushAction = .none
}

/// Requests to open a page that come from outside the Chat window's detail
/// column: the sidebar's pinned rows, a notification, Settings, ⌘K, and the
/// Artifacts page's Open in Conversation.
///
/// One per app (``shared``), like ``DesktopWorkbenchRegistry``: Settings and
/// the ⌘K panel live outside the window that follows the request. A request
/// is held as ``pending`` until the Chat window applies it — the window
/// switches destination, and the destination's stack pushes the route — and
/// then cleared, so it is followed exactly once.
@MainActor
@Observable
final class DesktopPageRouter {
    static let shared = DesktopPageRouter()

    struct Request: Identifiable, Equatable {
        let id = UUID()
        let destination: DesktopDestination
        let route: DesktopPageRoute?
        /// The Artifacts type filter to show, as the web's `?type=` (`DESIGN`).
        let artifactsType: String?
        /// Open the Artifacts page's New menu, as the web's `?new=design`.
        let opensNewMenu: Bool
    }

    /// The Artifacts page's filter, handed over by a request: the page takes
    /// it once (``takeArtifactsFilter()``).
    struct ArtifactsFilter: Equatable {
        let id = UUID()
        let type: String
        let opensNewMenu: Bool
    }

    /// An artifact to show in its chat's canvas (Open in Conversation).
    struct CanvasRequest: Identifiable, Equatable {
        let id = UUID()
        let conversationID: String
        let artifactID: String
    }

    private(set) var pending: Request?
    private(set) var artifactsFilter: ArtifactsFilter?
    private(set) var pendingCanvas: CanvasRequest?
    /// ⌘K's "New assistant": the Assistants page opens its editor once.
    private(set) var newAssistantRequest: UUID?

    /// Opens a destination, optionally pushing one page onto it.
    ///
    /// `.design` is a destination only for stored state and old callers: the
    /// web made Design a type in Artifacts, so it opens Artifacts with the
    /// Designs filter (``DesktopNavigationState/normalized(_:)``).
    func open(
        _ destination: DesktopDestination,
        route: DesktopPageRoute? = nil,
        artifactsType: String? = nil,
        opensNewMenu: Bool = false
    ) {
        let normalized = DesktopNavigationState.normalized(destination)
        pending = Request(
            destination: normalized.destination,
            route: route,
            artifactsType: artifactsType ?? normalized.artifactsType,
            opensNewMenu: opensNewMenu
        )
    }

    /// The chat the artifact was made in, with the canvas open on this row —
    /// by its id, so a later type change cannot swap what opens (Phase 4 A1).
    func openArtifactInConversation(_ artifact: NativeArtifact) {
        pendingCanvas = CanvasRequest(conversationID: artifact.conversationID, artifactID: artifact.id)
    }

    /// Clears a request once its destination has been switched to and its
    /// route pushed. A stale id (a newer request already replaced it) is
    /// ignored.
    func consume(_ request: Request) {
        guard pending?.id == request.id else { return }
        if let type = request.artifactsType {
            artifactsFilter = ArtifactsFilter(type: type, opensNewMenu: request.opensNewMenu)
        }
        pending = nil
    }

    func consumeCanvas(_ request: CanvasRequest) {
        guard pendingCanvas?.id == request.id else { return }
        pendingCanvas = nil
    }

    /// The Artifacts filter a request asked for, once.
    func takeArtifactsFilter() -> ArtifactsFilter? {
        defer { artifactsFilter = nil }
        return artifactsFilter
    }

    /// Assistants, with the New assistant editor up (the web's
    /// `/assistants?new=1`).
    func openNewAssistant() {
        newAssistantRequest = UUID()
        open(.assistants)
    }

    /// Whether the Assistants page should open its editor, once.
    func takeNewAssistantRequest() -> Bool {
        defer { newAssistantRequest = nil }
        return newAssistantRequest != nil
    }
}

/// A destination's page stack: the root page, one `navigationDestination`
/// for every ``DesktopPageRoute``, and the push action pages reach through
/// the environment.
///
/// Its own view so the path is its own `@State`: the destination view gives
/// each destination a fresh identity, and with it a fresh, empty stack.
struct DesktopPageStack<Root: View, Page: View>: View {
    let destination: DesktopDestination
    let router: DesktopPageRouter
    @ViewBuilder let root: () -> Root
    @ViewBuilder let page: (DesktopPageRoute) -> Page
    /// Told what is pushed whenever it changes: how the Agents destination
    /// keeps the window's open agent — its sidebar row — in step with a
    /// back button or a push from the page.
    var pathChanged: (([DesktopPageRoute]) -> Void)? = nil

    @State private var path: [DesktopPageRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            root()
                // The page's name, restated as the stack root's title so the
                // window keeps it whichever of the two the system reads.
                .navigationTitle(destination.label)
                .navigationDestination(for: DesktopPageRoute.self) { route in
                    page(route)
                }
        }
        .environment(\.desktopPush, DesktopPushAction { path.append($0) })
        .environment(\.desktopReplace, DesktopPushAction { route in
            if path.isEmpty {
                path = [route]
            } else {
                path[path.count - 1] = route
            }
        })
        .onAppear(perform: follow)
        .onChange(of: router.pending) { _, _ in follow() }
        .onChange(of: path) { _, value in pathChanged?(value) }
    }

    /// Takes a request meant for this destination: pushes its route over the
    /// root (never on top of an unrelated page) and clears it.
    private func follow() {
        guard let request = router.pending, request.destination == destination else { return }
        if let route = request.route {
            path = [route]
        }
        router.consume(request)
    }
}
