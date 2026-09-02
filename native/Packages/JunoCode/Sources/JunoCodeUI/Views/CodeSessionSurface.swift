import AppKit
import JunoCodeCore
import JunoDesignSystem
import SwiftUI

/// Shared reading measure for the active task surface. The transcript and the
/// composer are one workbench, so their left and right edges should agree while
/// the window grows around them.
enum CodeSessionLayout {
    /// Code and Chat share one reading measure. Review and terminal surfaces may
    /// expand beyond it, but prose and the composer should never turn into a
    /// full-window line of text just because the inspector is hidden.
    static let measure: CGFloat = JunoReadingMeasure.reading
    static let inset: CGFloat = 24
}

/// The review pane's resize range, beside the thread.
///
/// Wide enough for a unified diff at the thread's own measure, and never so
/// wide the thread beside it drops under a readable column. The reader's
/// chosen width is remembered across launches.
public enum CodeReviewPaneMetrics {
    public static let minimum: CGFloat = 420
    public static let ideal: CGFloat = 640
    public static let maximum: CGFloat = 1200
    /// The thread keeps at least this much beside an open review; below it
    /// the review takes the column instead.
    public static let minimumThread: CGFloat = 440
    public static let handleWidth: CGFloat = JunoSpace.snug
}

/// The session surface: everything inside the detail column of a Code window.
///
/// This is the boundary between the host app and this package. The app owns the
/// *window* — the columns, the toolbar, the titles, sidebar selection, session
/// lifecycle and repository grants. It owns nothing inside the canvas, because the
/// arrangement of these five things relative to one another is a property of the
/// session surface rather than of the window:
///
/// - this surface paints the one opaque reading canvas the transcript and the
///   review editor share, and neither of them paints another;
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
    @Binding private var showsConsole: Bool
    @FocusState private var composerFocused: Bool
    /// The review pane's width, remembered across launches and windows. A
    /// drag on the handle writes it; nothing else does.
    @AppStorage("juno.code.review.width") private var storedReviewWidth: Double = 0
    @State private var canvasWidth: CGFloat = 0
    @State private var dragBaseline: CGFloat?
    @State private var isPushingResizeCursor = false
    @State private var isCreatingPullRequest = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The workspace's saved prompts, layered over the built-ins. Starts as the
    /// built-ins so the menu works on the very first keystroke, before the
    /// workspace has been read.
    @State private var slashCommands = CodeSlashCommandLibrary.builtIn

    /// Starts dictation, or nil where the host offers none. See ``Composer``.
    private let beginDictation: (() -> Void)?
    /// Starts realtime voice mode, or nil where the host offers none.
    private let beginVoice: (() -> Void)?
    /// Host-owned voice dock rendered directly above the Code composer.
    /// `AnyView` keeps JunoCodeUI independent of the app's voice implementation.
    private let voiceDock: AnyView?
    /// Host-owned voice field: the accent light that hugs the bottom edge of this
    /// canvas and climbs its sides while a call is live.
    ///
    /// Erased for the same reason the dock is — it is drawn by the app's voice
    /// stack, which this package deliberately knows nothing about — and it has to
    /// come through the initialiser rather than being wrapped around
    /// ``CodeSessionCanvas`` from outside, because this view paints its own
    /// opaque reading canvas. A `.background` written by the caller stacks
    /// *behind* that canvas and is never seen; mounted here, the order is
    /// canvas, then field, then content. Chat has no such problem: its canvas
    /// sits on an ancestor of the column it lights.
    private let voiceField: AnyView?

    /// - Note: there is deliberately no `showsReview` binding. Whether the
    ///   reader is reviewing is ``ReviewModel/isPresented`` and nothing else —
    ///   the window's toolbar toggle, the inspector's Changes list, Open
    ///   Quickly and the completion card all write that one flag. The mirrored
    ///   `@SceneStorage` this replaced was the second source of truth the
    ///   audit found, and the two disagreed.
    public init(
        controller: SessionController,
        model: WorkbenchModel,
        showsConsole: Binding<Bool>,
        beginDictation: (() -> Void)? = nil,
        beginVoice: (() -> Void)? = nil,
        voiceDock: AnyView? = nil,
        voiceField: AnyView? = nil
    ) {
        self.controller = controller
        self.model = model
        self._showsConsole = showsConsole
        self.beginDictation = beginDictation
        self.beginVoice = beginVoice
        self.voiceDock = voiceDock
        self.voiceField = voiceField
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
                splitContent
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { canvasWidth = $0 }
            }
            // Before the canvas, and the order is the whole of it: successive
            // `.background` layers stack further back, so the canvas applied on
            // the next line paints behind the light and the light stays behind
            // the transcript. Bottom-aligned because the field is a floor lamp —
            // it belongs to the edge the composer sits on, not to the middle of
            // the reading area.
            //
            // That canvas is the *only* one permitted anywhere under this
            // surface, and the rule is what keeps the light on across a switch
            // to Review. `ReviewCanvasView` used to paint a second one over its
            // whole frame; drawn from inside `content` it landed in front of the
            // field, so a live call lit the transcript and went dark for exactly
            // as long as the diff was open — and came back when the reader
            // closed it, which reads as a fault in the call rather than in the
            // layout. Both branches now put their own cards, rows and bars on
            // this one ground, and neither fills it.
            .background(alignment: .bottom) {
                if let voiceField {
                    voiceField
                }
            }
            .junoReadingCanvas()
            .animation(
                JunoMotion.reduced(JunoMotion.canvasEnter, when: reduceMotion),
                value: controller.review.isPresented
            )
            .animation(JunoMotion.fast, value: showsConsole)
            .sheet(isPresented: $isCreatingPullRequest) {
                CreatePullRequestSheet(controller: controller)
            }
            // Read once per session rather than per keystroke: the menu is
            // consulted on every character typed after a slash, and hitting the
            // filesystem there would put a directory listing in the type-ahead
            // path. A workspace whose commands change mid-session picks them up
            // on the next session, which is the same contract every other agent
            // that reads these files offers.
            .task(id: controller.sessionID) { await loadSlashCommands() }
    }

    @ViewBuilder
    private var goal: some View {
        if controller.session.goal != nil {
            GoalBar(controller: controller)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private func loadSlashCommands() async {
        guard let context = controller.context else { return }
        let workspace = await context.slashCommands()
        // Merged even when empty: `.merged` is what puts the built-ins in a
        // deterministic order, and skipping it would make a workspace with no
        // `.juno/commands` show a differently-ordered menu from one with them.
        slashCommands = .merged(workspace: workspace)
    }

    /// The thread, with the review pane beside it when the review is open.
    ///
    /// **Beside, never instead of.** The review used to swap the transcript out
    /// of the column, so reading a diff meant losing the conversation about it.
    /// It is now a split: the thread keeps its readable measure on the left, the
    /// review takes a resizable pane on the right, and the composer stays under
    /// the thread so the reader can talk to Juno about the hunk they are
    /// looking at. Under a narrow window the review takes the column — a diff
    /// in 300pt is not a diff — and the thread comes back when it closes.
    @ViewBuilder
    private var splitContent: some View {
        let reviewOpen = controller.review.isPresented
        let stacked = reviewOpen && !canFitSideBySide
        HStack(spacing: 0) {
            if !stacked {
                thread
                    .frame(maxWidth: .infinity)
            }
            if reviewOpen {
                if !stacked {
                    reviewHandle
                }
                reviewPane
                    .frame(width: stacked ? nil : reviewWidth)
                    .frame(maxWidth: stacked ? .infinity : nil)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
    }

    private var thread: some View {
        // No session-selection callback by design. A sub-agent's transcript
        // opens inside this one, under the call that delegated it; handing
        // the transcript a way to change `selectedSessionID` is what used to
        // let "Open sub-agent" replace the reader's conversation with the
        // child's.
        TranscriptView(
            controller: controller,
            modelDisplayNames: model.modelDisplayNames,
            focus: $composerFocused,
            createPullRequest: controller.pullRequestUnavailableReason == nil
                ? { [$isCreatingPullRequest] in $isCreatingPullRequest.wrappedValue = true }
                : nil
        )
        .safeAreaInset(edge: .top, spacing: 0) { goal }
        // Order reads bottom-up: the composer is applied last so it ends up
        // outermost and closest to the window edge, with the approval queue
        // immediately above it and the console above that.
        .safeAreaInset(edge: .bottom, spacing: 0) { console }
        .safeAreaInset(edge: .bottom, spacing: 0) { approvals }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
    }

    private var reviewPane: some View {
        ReviewCanvasView(controller: controller, review: controller.review)
            .safeAreaInset(edge: .top, spacing: 0) { reviewPaneHeader }
            .background(Color.junoCanvas)
            .overlay(alignment: .leading) {
                if canFitSideBySide {
                    Rectangle().fill(Color.junoSeparator).frame(width: 1)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Review")
            .accessibilityIdentifier("juno.code.review.pane")
    }

    /// The pane's own title strip: what it is, and the way to close it.
    private var reviewPaneHeader: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.branch, size: 13)
                .junoSecondaryInk()
            Text("Review")
                .junoRowLabel()
            Text(PathDisplay.fileCount(controller.changes.count))
                .junoCaption()
            Spacer(minLength: 0)
            Button {
                controller.review.dismiss()
            } label: {
                JunoIconView(.close, size: 13)
                    .junoSecondaryInk()
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .keyboardShortcut("r", modifiers: [.command, .option])
            .help("Close the review (⌥⌘R)")
            .accessibilityLabel("Close review")
            .accessibilityIdentifier("juno.code.review.close")
        }
        .padding(.leading, JunoSpace.regular)
        .padding(.trailing, JunoSpace.tight)
        .frame(height: 44)
        .background(Color.junoRaised)
        .overlay(alignment: .bottom) { Divider().overlay(Color.junoSeparator) }
    }

    private var canFitSideBySide: Bool {
        canvasWidth == 0
            || canvasWidth >= CodeReviewPaneMetrics.minimumThread + CodeReviewPaneMetrics.minimum
                + CodeReviewPaneMetrics.handleWidth
    }

    private var reviewWidth: CGFloat {
        let stored = storedReviewWidth > 0 ? CGFloat(storedReviewWidth) : CodeReviewPaneMetrics.ideal
        return clampedReviewWidth(stored)
    }

    private func clampedReviewWidth(_ proposed: CGFloat) -> CGFloat {
        var maximum = CodeReviewPaneMetrics.maximum
        if canvasWidth > 0 {
            maximum = min(
                maximum,
                canvasWidth - CodeReviewPaneMetrics.minimumThread - CodeReviewPaneMetrics.handleWidth
            )
        }
        return max(CodeReviewPaneMetrics.minimum, min(maximum, proposed))
    }

    /// The drag handle between the thread and the review.
    private var reviewHandle: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: CodeReviewPaneMetrics.handleWidth)
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let baseline = dragBaseline ?? reviewWidth
                        dragBaseline = baseline
                        storedReviewWidth = Double(clampedReviewWidth(baseline - value.translation.width))
                    }
                    .onEnded { _ in dragBaseline = nil }
            )
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    guard !isPushingResizeCursor else { return }
                    isPushingResizeCursor = true
                    NSCursor.resizeLeftRight.push()
                case .ended:
                    guard isPushingResizeCursor else { return }
                    isPushingResizeCursor = false
                    NSCursor.pop()
                }
            }
            .onDisappear {
                guard isPushingResizeCursor else { return }
                isPushingResizeCursor = false
                NSCursor.pop()
            }
            .accessibilityLabel("Resize review")
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var console: some View {
        if showsConsole {
            CodeConsoleDrawer(controller: controller, isPresented: $showsConsole)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    /// Every pending approval, as a queue.
    ///
    /// The first is the full card and takes the keyboard (⇧↩ approves, ⇧⎋
    /// denies); the rest are one-line rows underneath it, each with its own
    /// Approve and Deny, so a run that stopped on three things at once shows
    /// three things rather than one and a number. Answering the first
    /// promotes the next.
    @ViewBuilder
    private var approvals: some View {
        if let request = controller.pendingApprovals.first {
            VStack(spacing: JunoSpace.tight) {
                ApprovalCard(request: request, controller: controller)
                ForEach(controller.pendingApprovals.dropFirst(), id: \.id) { queued in
                    ApprovalQueueRow(request: queued, controller: controller)
                }
            }
            .frame(maxWidth: CodeSessionLayout.measure)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, CodeSessionLayout.inset)
            .padding(.bottom, JunoSpace.snug)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(
                controller.pendingApprovals.count == 1
                    ? "1 approval waiting"
                    : "\(controller.pendingApprovals.count) approvals waiting"
            )
        }
    }

    private var composer: some View {
        VStack(spacing: JunoSpace.snug) {
            if let voiceDock {
                voiceDock
            }
            Composer(
                controller: controller,
                availableModels: model.availableModels,
                focus: $composerFocused,
                slashCommands: slashCommands,
                beginDictation: beginDictation,
                beginVoice: beginVoice
            )
            .frame(maxWidth: CodeSessionLayout.measure)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, CodeSessionLayout.inset)
            .padding(.bottom, JunoSpace.snug)
        }
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
    private let openPreview: (() -> Void)?
    private let openSources: (() -> Void)?
    private let openWorkspace: (() -> Void)?
    private let createPullRequest: (() -> Void)?

    public init(
        controller: SessionController,
        openPreview: (() -> Void)? = nil,
        openSources: (() -> Void)? = nil,
        openWorkspace: (() -> Void)? = nil,
        createPullRequest: (() -> Void)? = nil
    ) {
        self.controller = controller
        self.openPreview = openPreview
        self.openSources = openSources
        self.openWorkspace = openWorkspace
        self.createPullRequest = createPullRequest
    }

    public var body: some View {
        InspectorView(
            controller: controller,
            openPreview: openPreview,
            openSources: openSources,
            openWorkspace: openWorkspace,
            createPullRequest: createPullRequest
        )
    }
}
