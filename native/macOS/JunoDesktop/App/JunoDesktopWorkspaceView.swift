import JunoAuth
import JunoCodeUI
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// The window's contents for the current product, and the one moment of motion
/// between them.
///
/// **Why the mode change is not cross-faded.** Chat, Code and Work are each a
/// `NavigationSplitView`, and a SwiftUI transition between two of them keeps
/// both alive for the length of the animation — two split views, two AppKit
/// split-view controllers, negotiating sizes against the same window at the
/// same time. That is precisely the shape that produced the documented
/// update-constraints crash (`docs/native/MACOS_CRASH_ROOT_CAUSE.md`), and a
/// nicer-feeling switch is not worth reintroducing it.
///
/// So the swap itself stays instantaneous — only one workspace is ever
/// instantiated — and what animates is the arriving workspace *resolving*:
/// blurred and dimmed on the frame it appears, sharp a third of a second later.
/// Nothing has to co-exist with anything, and unlike the canvas-coloured wash
/// this replaced, what is on screen for the whole transition is the new
/// workspace rather than a rectangle of flat paint.
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

    /// 0 the instant the workspace swaps, 1 once it has settled. Drives a short
    /// defocus on the arriving content rather than a wash laid over it.
    @State private var settle: Double = 1
    /// A "New chat" raised from Code or Work is deliberately not a session with
    /// no folder or a task with no goal. It is an ordinary Juno conversation, so
    /// it crosses the product boundary and is consumed exactly once by the Chat
    /// workspace.
    ///
    /// A token rather than a Bool means two consecutive requests can never be
    /// coalesced into one by SwiftUI's state batching.
    @State private var unscopedChatRequestID: UUID?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        workspace
            // The arriving workspace resolves into focus. What was here before
            // was a full-strength `Color.junoCanvasWarm` laid over the whole
            // window and faded off, which is a flash of flat paint — for the
            // first frame of every mode change the window was a rectangle of
            // canvas colour, and the brighter the content underneath, the more
            // it read as the app blinking rather than as one thing becoming
            // another.
            //
            // Blur and a shallow opacity dip do the same job the wash was
            // there for — cover the instant of the swap, so neither tree has to
            // co-exist with the other — while what is on screen throughout is
            // the new workspace itself. Never a scale: this is a full-window
            // surface, and scaling one reads as the window resizing.
            .blur(radius: (1 - settle) * 7)
            .opacity(0.55 + 0.45 * settle)
            // Input comes back almost immediately, not when the resolve ends.
            // The blur exists to mask the split-view swap, and the swap is
            // over on the first frame; while the workspace resolves, nothing
            // underneath moves — blur and opacity only — so a click during
            // the resolve lands exactly where it would land sharp. The gate
            // used to wait for `settle > 0.6`, which ate every click for
            // ~150ms after each mode change. `outSoft`'s fast start crosses
            // 0.15 within the first frames, so the veil now swallows only
            // input aimed while the arriving tree is still too blurred to
            // read as anything.
            .allowsHitTesting(settle > 0.15)
            .onChange(of: product) { _, _ in
                guard !reduceMotion else { return }
                // Two phases, and they cannot be one. Setting `settle` and
                // clearing it inside a single update coalesces to "stay at
                // one" — SwiftUI animates from the last *rendered* value, not
                // from the one written and overwritten in the same transaction.
                // Yielding lets the defocused frame render first, so there is
                // something for the resolve to resolve from.
                //
                // `outSoft` at the slow rung: an arriving surface is an
                // entrance, entrances decelerate, and a whole region changing
                // is what the 360ms rung is for. This was a free-hand
                // `easeOut(0.3)` sitting one rung's width from `slow` 0.36 —
                // exactly the near-miss the motion ladder exists to prevent.
                settle = 0
                Task { @MainActor in
                    await Task.yield()
                    withAnimation(JunoMotion.outSoft()) { settle = 1 }
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
