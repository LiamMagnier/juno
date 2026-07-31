import JunoAuth
import JunoCodeUI
import JunoDesignSystem
import SwiftUI

/// The window's contents for the current product, and the one moment of motion
/// between them.
///
/// **Why the mode change is veiled rather than cross-faded.** Chat and Code are
/// each a `NavigationSplitView`, and a SwiftUI transition between two of them
/// keeps both alive for the length of the animation — two split views, two
/// AppKit split-view controllers, negotiating sizes against the same window at
/// the same time. That is precisely the shape that produced the documented
/// update-constraints crash (`docs/native/MACOS_CRASH_ROOT_CAUSE.md`), and a
/// nicer-feeling switch is not worth reintroducing it.
///
/// So the swap itself stays instantaneous — only one workspace is ever
/// instantiated — and the *veil* is what animates: the new window paints under a
/// full-strength canvas wash that dissolves off it. The result reads as the
/// content fading in, which is the intent, without either tree having to
/// co-exist with the other for a single frame.
struct JunoDesktopWorkspaceView: View {
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Binding var product: DesktopProductMode
    let workbenchModel: WorkbenchModel?
    /// Screenshot-harness override; nil in production. See
    /// ``DesktopChatWorkspace/initialDestination``.
    var initialDestination: DesktopDestination?

    @State private var veilOpacity: Double = 0
    /// A Code-sidebar "New chat" is deliberately not a Code session with no
    /// folder. It is an ordinary Juno conversation, so it crosses the product
    /// boundary and is consumed exactly once by the Chat workspace.
    ///
    /// A token rather than a Bool means two consecutive requests can never be
    /// coalesced into one by SwiftUI's state batching.
    @State private var unscopedChatRequestID: UUID?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        workspace
            .overlay {
                // Never interactive: the veil is scenery over a window that is
                // already live underneath it, and swallowing the first click
                // after a mode change would be worse than no transition at all.
                Color.junoCanvasWarm
                    .opacity(veilOpacity)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .onChange(of: product) { _, _ in
                guard !reduceMotion else { return }
                // Two phases, and they cannot be one. Setting the veil and
                // clearing it inside a single update coalesces to "stay at
                // zero" — SwiftUI animates from the last *rendered* value, not
                // from the one written and overwritten in the same transaction.
                // Yielding lets the opaque frame render first, so there is
                // something for the fade to fade from.
                veilOpacity = 1
                Task { @MainActor in
                    await Task.yield()
                    withAnimation(.easeOut(duration: 0.28)) { veilOpacity = 0 }
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
                    unscopedChatRequestID: unscopedChatRequestID,
                    consumeUnscopedChatRequest: {
                        unscopedChatRequestID = nil
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
        }
    }
}
