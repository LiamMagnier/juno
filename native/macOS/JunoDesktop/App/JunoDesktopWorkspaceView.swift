import JunoAuth
import JunoCodeUI
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// The window's contents for the current product, and the one moment of motion
/// between them.
///
/// **Why the two workspaces are never on screen together.** Chat, Code and Work
/// are each a `NavigationSplitView`, and a SwiftUI transition between two of
/// them keeps both alive for the length of the animation — two split views,
/// two AppKit split-view controllers, negotiating sizes against the same window
/// at the same time. That is precisely the shape that produced the documented
/// update-constraints crash (`docs/native/MACOS_CRASH_ROOT_CAUSE.md`), and a
/// nicer-feeling switch is not worth reintroducing it.
///
/// So the swap itself stays instantaneous — only one workspace is ever
/// instantiated — and what animates is the arriving workspace *settling in*:
/// it appears fully transparent six points low and rises into place on
/// `JunoMotion.standard`, the same curve and the same distance the rest of the
/// app uses for something small arriving. Read alongside the product switch's
/// own thumb sliding in the sidebar, the two read as one gesture — the thumb
/// moves, the window follows — where a hard swap read as the window being
/// replaced.
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

    /// A "New chat" raised from Code or Work is deliberately not a session with
    /// no folder or a task with no goal. It is an ordinary Juno conversation, so
    /// it crosses the product boundary and is consumed exactly once by the Chat
    /// workspace.
    ///
    /// A token rather than a Bool means two consecutive requests can never be
    /// coalesced into one by SwiftUI's state batching.
    @State private var unscopedChatRequestID: UUID?
    /// The text a quick-entry or menu bar request asked the new chat to open
    /// with. Consumed with the request.
    @State private var unscopedChatPrompt: String?
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
                case .newChat(let prompt):
                    unscopedChatPrompt = prompt
                    unscopedChatRequestID = UUID()
                    product = .chat
                    registry.consume(request)
                case .newCodeTask, .openSession:
                    product = .code
                }
            }
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
                    consumeUnscopedChatRequest: {
                        unscopedChatRequestID = nil
                        unscopedChatPrompt = nil
                    }
                )
            } else {
                ContentUnavailableView(
                    "Chat unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text("The encrypted conversation store could not be opened.")
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
                    newChat: {
                        unscopedChatRequestID = UUID()
                        product = .chat
                    }
                )
            } else {
                ContentUnavailableView(
                    "Code unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text("The authenticated Code transport could not be composed.")
                )
            }

        case .work:
            if let workModel = configuration.workModel {
                DesktopWorkWorkspace(
                    model: workModel,
                    hostModel: configuration.workHostModel,
                    configuration: configuration,
                    session: session,
                    product: $product,
                    newChat: {
                        unscopedChatRequestID = UUID()
                        product = .chat
                    }
                )
            } else {
                ContentUnavailableView(
                    "Juno Work unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text("The authenticated Work transport could not be composed.")
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
