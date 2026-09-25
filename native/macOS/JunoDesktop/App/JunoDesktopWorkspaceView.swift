import JunoAuth
import JunoCodeUI
import JunoCore
import JunoDesignSystem
import SwiftUI

/// The window's contents for the current product, and the one moment of motion
/// between them.
///
/// **Why the workspaces are never on screen together.** Chat and Code are
/// each a `NavigationSplitView`, and a SwiftUI
/// transition between two of them keeps both alive for the length of the
/// animation — two split views, two AppKit split-view controllers, negotiating
/// sizes against the same window at the same time. That is precisely the shape
/// that produced the documented update-constraints crash
/// (`docs/native/MACOS_CRASH_ROOT_CAUSE.md`, rule 1), and a nicer-feeling
/// switch is not worth reintroducing it.
///
/// So the swap itself stays instantaneous — only one workspace is ever
/// instantiated — and what animates is the arriving workspace *settling in*:
/// it appears fully transparent six points low and rises into place on
/// `JunoMotion.standard`, the same curve and the same distance the rest of the
/// app uses for something small arriving.
///
/// **Two products.** The switch offers Chat and Code (§1.4). Work is no longer
/// a product and its old workspace is gone (Phase 5 Stage D): a task lives in
/// the chat that started it, one with no chat opens in a sheet over Chat
/// (register #63), and an errand handed over from Quick Entry opens a chat.
struct JunoDesktopWorkspaceView: View {
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Binding var product: DesktopProductMode
    let workbenchModel: WorkbenchModel?
    /// Screenshot-harness override; nil in production. See
    /// ``DesktopChatWorkspace/initialDestination``.
    var initialDestination: DesktopDestination?
    /// Called once when a production launch route has been consumed. Preview
    /// callers leave this nil, so their explicit destination remains isolated
    /// from the live app's launch policy.
    var consumeInitialDestination: (() -> Void)? = nil

    /// A "New chat" raised from Code, the menu bar or Quick Entry is deliberately not a session with no folder or a task with
    /// no goal. It is an ordinary Juno conversation, so it crosses the product
    /// boundary and is consumed exactly once by the Chat workspace.
    ///
    /// A token rather than a Bool means two consecutive requests can never be
    /// coalesced into one by SwiftUI's state batching.
    @State private var unscopedChatRequestID: UUID?
    /// The text a quick-entry or menu bar request asked the new chat to open
    /// with. Consumed with the request.
    @State private var unscopedChatPrompt: String?
    /// Whether the request is for a private draft (⇧⌘N). Consumed with it.
    @State private var unscopedChatIsPrivate = false
    /// A tapped notification's destination in Chat — an agent's page, a
    /// thread, or a task (its chat, or the task sheet) — consumed once by the
    /// Chat workspace, which is the only view that can open any of them.
    @State private var chatRoute: DesktopWorkbenchRegistry.RouteRequest?
    @State private var registry = DesktopWorkbenchRegistry.shared

    var body: some View {
        workspace
            .modifier(DesktopWorkspaceArrival())
            // Outside the modifier, not inside it. A fresh identity per product
            // is what resets the arrival modifier's own state and re-fires its
            // `onAppear`, so every switch — not only the first appearance —
            // gets its rise. With the id on the workspace alone the modifier
            // would keep its identity, and its state, across the swap.
            .id(product)
            // Requests from the menu bar item and the quick-entry panel that
            // need the *product* changed land here, because only this view can
            // change it. Code's own requests are consumed by the Code window.
            .onChange(of: registry.pendingRequest, initial: true) { _, request in
                guard let request else { return }
                switch request.kind {
                case .newChat(let prompt, let isPrivate):
                    requestChat(prompt: prompt, isPrivate: isPrivate)
                    registry.consume(request)
                case .newCodeTask, .openSession:
                    product = .code
                }
            }
            // What the menu bar reaches in *every* product: a new private chat
            // (⇧⌘N, which lives in Chat whatever the window was showing).
            .focusedSceneValue(
                \.junoShellActions,
                DesktopShellActions(
                    newPrivateChat: { requestChat(prompt: nil, isPrivate: true) }
                )
            )
            // A tapped notification. Re-read from the registry rather than
            // trusted from the change: every open window hears the change, and
            // only the first to reach it may act on it. Every route lands in
            // Chat; a task's is resolved there (its chat, or the task sheet).
            .onChange(of: registry.pendingRoute, initial: true) { _, request in
                guard let request, registry.pendingRoute == request else { return }
                registry.consume(request)
                chatRoute = request
                product = .chat
            }
    }

    private func requestChat(prompt: String?, isPrivate: Bool) {
        unscopedChatPrompt = prompt
        unscopedChatIsPrivate = isPrivate
        unscopedChatRequestID = UUID()
        product = .chat
    }

    @ViewBuilder
    private var workspace: some View {
        switch product {
        case .chat:
            if let conversationModel = configuration.conversationModel {
                DesktopChatWorkspace(
                    model: conversationModel,
                    configuration: configuration,
                    session: session,
                    product: $product,
                    initialDestination: initialDestination,
                    consumeInitialDestination: consumeInitialDestination,
                    unscopedChatRequestID: unscopedChatRequestID,
                    unscopedChatPrompt: unscopedChatPrompt,
                    unscopedChatIsPrivate: unscopedChatIsPrivate,
                    consumeUnscopedChatRequest: {
                        unscopedChatRequestID = nil
                        unscopedChatPrompt = nil
                        unscopedChatIsPrivate = false
                    },
                    route: chatRoute,
                    consumeRoute: { chatRoute = nil }
                )
            } else {
                JunoEmptyState(
                    title: "Chat unavailable",
                    message: "The encrypted conversation store could not be opened.",
                    icon: .error
                )
            }

        case .code:
            if let workbenchModel,
                let codeModel = configuration.codeModel,
                let remoteCodeModel = configuration.remoteCodeModel
            {
                DesktopCodeWorkspace(
                    workbenchModel: workbenchModel,
                    codeModel: codeModel,
                    remoteModel: remoteCodeModel,
                    pullsClient: configuration.pullsClient,
                    accountID: session.profile.id,
                    configuration: configuration,
                    session: session,
                    product: $product,
                    newChat: { requestChat(prompt: nil, isPrivate: false) }
                )
            } else {
                JunoEmptyState(
                    title: "Code unavailable",
                    message: "The authenticated Code transport could not be composed.",
                    icon: .error
                )
            }
        }
    }
}

/// The arriving workspace's rise: transparent and 6pt low on the frame it is
/// built, in place a `JunoMotion.standard` later.
///
/// A modifier with its own `@State` rather than state on the parent, because
/// the parent's state would have to be reset *and* animated in one update —
/// and SwiftUI only renders the end of that, so nothing would move. Fresh
/// identity (`.id(product)` above) gives this modifier fresh state, and
/// `onAppear` is the moment the new workspace exists to be animated.
///
/// Under Reduce Motion the rise collapses to a plain cross-fade through
/// `JunoMotion.reduced`; the opacity still animates, the offset is skipped,
/// because a whole window's contents shifting is exactly the travel the
/// preference asks to remove.
private struct DesktopWorkspaceArrival: ViewModifier {
    @State private var settled = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(settled ? 1 : 0)
            .offset(y: settled || reduceMotion ? 0 : 6)
            .onAppear {
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    settled = true
                }
            }
    }
}
