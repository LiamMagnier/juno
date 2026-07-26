import JunoCodeCore
import JunoDesignSystem
import SwiftUI

/// The session surface: everything inside the detail column of a Code window.
///
/// This is the boundary between the host app and this package. The app owns the
/// *window* — the columns, the toolbar, the titles, sidebar selection, session
/// lifecycle and repository grants. It owns nothing inside the canvas, because the
/// arrangement of these five things relative to one another is a property of the
/// session surface rather than of the window:
///
/// - the transcript (or the review editor) is the reading canvas, and is opaque;
/// - the console drawer sits between that content and the composer, so a burst of
///   output pushes nothing off screen and never covers the last thing the reader
///   typed;
/// - the approval card sits directly above the composer, where a blocking decision
///   cannot be scrolled away from;
/// - the composer floats over the bottom edge and stays visible in both the
///   transcript and the review, because the next turn can be composed while
///   reading either.
///
/// Splitting those responsibilities the other way — letting the window place the
/// composer and the drawer — is what previously allowed the approval card and the
/// composer to disagree about which was on top.
public struct CodeSessionCanvas: View {
    private let controller: SessionController
    @Bindable private var model: WorkbenchModel
    @Binding private var showsReview: Bool
    @Binding private var showsConsole: Bool
    @FocusState private var composerFocused: Bool
    /// The workspace's saved prompts, layered over the built-ins. Starts as the
    /// built-ins so the menu works on the very first keystroke, before the
    /// workspace has been read.
    @State private var slashCommands = CodeSlashCommandLibrary.builtIn

    public init(
        controller: SessionController,
        model: WorkbenchModel,
        showsReview: Binding<Bool>,
        showsConsole: Binding<Bool>
    ) {
        self.controller = controller
        self.model = model
        self._showsReview = showsReview
        self._showsConsole = showsConsole
    }

    public var body: some View {
        // Clamped to the column it is given, and unable to resize it.
        //
        // A detail column reports an ideal size upward and `NavigationSplitView`
        // grows its AppKit split view to satisfy it, so a transcript's ideal
        // height resizes the *window* rather than being clipped by it. Measured on
        // macOS 27, this surface produced a split view 227pt taller than the window
        // and 54pt above it — which put the sidebar's top rows off-screen and,
        // because the composer is a bottom `safeAreaInset`, pushed the composer
        // clean below the window's bottom edge. The composer was not missing; it
        // was outside the window.
        //
        // `Color.clear` takes the height it is proposed and has no intrinsic size;
        // an `.overlay` is sized by its base and never reports back. A `ScrollView`
        // does *not* do this — it propagates its content's ideal height — which is
        // why the transcript alone was enough to inflate the window.
        Color.clear
            .overlay {
                content
                    // Order reads bottom-up: the composer is applied last so it
                    // ends up outermost and closest to the window edge, with the
                    // approval card immediately above it and the console above
                    // that.
                    .safeAreaInset(edge: .bottom, spacing: 0) { console }
                    .safeAreaInset(edge: .bottom, spacing: 0) { approvals }
                    .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            }
            .junoReadingCanvas()
            .animation(JunoMotion.fast, value: showsReview)
            .animation(JunoMotion.fast, value: showsConsole)
            // Read once per session rather than per keystroke: the menu is
            // consulted on every character typed after a slash, and hitting the
            // filesystem there would put a directory listing in the type-ahead
            // path. A workspace whose commands change mid-session picks them up
            // on the next session, which is the same contract every other agent
            // that reads these files offers.
            .task(id: controller.sessionID) { await loadSlashCommands() }
    }

    private func loadSlashCommands() async {
        guard let context = controller.context else { return }
        let workspace = await context.slashCommands()
        // Merged even when empty: `.merged` is what puts the built-ins in a
        // deterministic order, and skipping it would make a workspace with no
        // `.juno/commands` show a differently-ordered menu from one with them.
        slashCommands = .merged(workspace: workspace)
    }

    @ViewBuilder
    private var content: some View {
        if showsReview {
            ReviewCanvasView(controller: controller, review: controller.review)
        } else {
            TranscriptView(
                controller: controller,
                modelDisplayNames: model.modelDisplayNames,
                openSession: { model.selectedSessionID = $0 },
                focus: $composerFocused
            )
        }
    }

    @ViewBuilder
    private var console: some View {
        if showsConsole {
            CodeConsoleDrawer(controller: controller, isPresented: $showsConsole)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    /// Only the first pending approval is drawn.
    ///
    /// Approvals are answered one at a time and a second card would push the
    /// composer off the bottom of a short window. The count of the rest is the
    /// card's own business, not a reason to stack cards.
    @ViewBuilder
    private var approvals: some View {
        if let request = controller.pendingApprovals.first {
            ApprovalCard(request: request, controller: controller)
                .padding(.horizontal, JunoSpace.roomy)
                .padding(.bottom, JunoSpace.snug)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private var composer: some View {
        Composer(
            controller: controller,
            availableModels: model.availableModels,
            focus: $composerFocused,
            slashCommands: slashCommands
        )
    }
}

/// The inspector's three list-shaped segments.
///
/// A thin alias over ``InspectorView`` so the host app names the two halves of the
/// session surface symmetrically — ``CodeSessionCanvas`` and
/// ``CodeSessionInspector`` — and so the app never has to know which internal view
/// happens to implement a segment today.
public struct CodeSessionInspector: View {
    private let controller: SessionController

    public init(controller: SessionController) {
        self.controller = controller
    }

    public var body: some View {
        InspectorView(controller: controller)
    }
}
