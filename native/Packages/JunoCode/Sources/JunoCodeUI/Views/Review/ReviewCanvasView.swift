import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The review canvas: every changed file in one continuous scroll, at the full
/// width of the detail column.
///
/// It takes the detail column rather than living in the inspector because a
/// hunk-level review editor cannot be honest in a 320pt strip — the previous
/// build's diff pane was hardcoded to a 760pt frame inside a 320pt column. The
/// composer and the approval card stay visible above it, so the reader can talk
/// to Juno about the diff they are reading, and the agent keeps running while
/// they read.
///
/// Opaque where the text is, and only there: the pinned file headers, the diff
/// rows and the document editor each carry their own fill, because code over a
/// translucent surface loses contrast the moment the window moves. The ground
/// around and between them belongs to ``CodeSessionCanvas``, which is the single
/// view under this surface that paints a reading canvas — see the omission below.
public struct ReviewCanvasView: View {
    @Bindable private var controller: SessionController
    @Bindable private var review: ReviewModel
    /// Measured, not guessed: the paired layout's column width and the unified
    /// layout's minimum row width both come from the canvas's real width.
    @State private var canvasWidth: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(controller: SessionController, review: ReviewModel) {
        self.controller = controller
        self.review = review
    }

    public var body: some View {
        Group {
            if let document = review.openDocument {
                WorkspaceDocumentEditor(
                    controller: controller,
                    document: document,
                    onClose: { review.closeDocument() },
                    onChange: { review.openDocument = $0 }
                )
            } else if controller.changes.isEmpty {
                JunoEmptyState(
                    title: "Nothing to review",
                    message: "Files Juno edits appear here as a diff you can keep or revert hunk by hunk.",
                    icon: .branch
                )
            } else {
                fileScroll
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // No `junoReadingCanvas()` here, and the absence is load-bearing.
        //
        // This view used to paint one across its whole frame. It changed nothing
        // visually — the session surface already paints the same colour behind
        // it — but it did cover the host's voice field, which that surface mounts
        // between its canvas and its content. A live call therefore lit the
        // transcript and went dark for exactly as long as Review was open,
        // returning when the reader closed it: a layering fault that reads as a
        // fault in the call. Everything here that carries text brings its own
        // fill, so the diff is no less legible on the shared ground.
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { canvasWidth = $0 }
        .task(id: ReviewModel.signature(of: controller.changes)) {
            await review.load(from: controller)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if review.openDocument == nil, !controller.changes.isEmpty {
                reviewControls
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !controller.reviewComments.isEmpty {
                ReviewBatchBar(controller: controller)
            }
        }
    }

    /// The review's own controls: how the diff is arranged, and how much of it
    /// has been dealt with. Not a title strip — the window's title and subtitle
    /// already name the session.
    private var reviewControls: some View {
        HStack(spacing: JunoSpace.cozy) {
            ReviewLayoutPicker(review: review)
            Text(progressSummary)
                .junoCaption()
                .accessibilityLabel("Review progress: \(progressSummary)")
            Spacer(minLength: 0)
            DiffStat(added: totalAdded, removed: totalRemoved)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .background(alignment: .bottom) {
            VStack(spacing: 0) {
                Color.junoRaised
                Divider().overlay(Color.junoSeparator)
            }
        }
    }

    private var totalAdded: Int { controller.changes.reduce(0) { $0 + $1.linesAdded } }
    private var totalRemoved: Int { controller.changes.reduce(0) { $0 + $1.linesRemoved } }

    private var progressSummary: String {
        let reviewed = controller.changes.filter { $0.reviewState != .pending }.count
        return "\(reviewed) of \(PathDisplay.fileCount(controller.changes.count)) reviewed"
    }

    private var fileScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(
                    alignment: .leading,
                    spacing: JunoSpace.section,
                    pinnedViews: [.sectionHeaders]
                ) {
                    ForEach(controller.changes) { change in
                        Section {
                            ReviewFileBody(
                                controller: controller,
                                review: review,
                                change: change,
                                canvasWidth: canvasWidth
                            )
                        } header: {
                            ReviewFileHeader(
                                controller: controller,
                                review: review,
                                change: change
                            )
                        }
                    }
                }
                .padding(.bottom, JunoSpace.region)
            }
            .onChange(of: review.focusedPath) {
                guard let path = review.consumeFocus() else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    proxy.scrollTo(path, anchor: .top)
                }
            }
            .task {
                // A file chosen before the canvas existed still has to land on
                // screen; without this the first selection from Changes opens
                // Review at the top instead of at the file that was clicked.
                guard let path = review.consumeFocus() else { return }
                proxy.scrollTo(path, anchor: .top)
            }
        }
    }
}

/// The unsubmitted review batch.
///
/// It is deliberately explicit that the notes are not durable: there is no
/// review-comment event in the transcript, so until they are submitted they
/// exist only in this session's memory.
private struct ReviewBatchBar: View {
    @Bindable var controller: SessionController
    @State private var submitting = false

    private var fileCount: Int {
        Set(controller.reviewComments.map(\.path)).count
    }

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 1) {
                Text(summary)
                    .junoRowLabel()
                Text("Unsubmitted notes are not saved when Juno quits.")
                    .junoCaption()
            }
            Spacer(minLength: JunoSpace.snug)
            Button("Discard") {
                controller.discardReviewComments()
            }
            .help("Delete every note in this review")

            Button(submitting ? "Sending…" : "Send comments to Juno") {
                submitting = true
                Task {
                    await controller.submitReviewComments()
                    submitting = false
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .disabled(submitting)
            .keyboardShortcut(.return, modifiers: [.command, .shift])
            .help("Posts every note as one follow-up message to Juno (⇧⌘↩)")
            .accessibilityIdentifier("juno.code.review.submit")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .background(alignment: .top) {
            VStack(spacing: 0) {
                Divider().overlay(Color.junoSeparator)
                Color.junoRaised
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var summary: String {
        let notes = controller.reviewComments.count
        let noteLabel = notes == 1 ? "1 note" : "\(notes) notes"
        return "\(noteLabel) on \(PathDisplay.fileCount(fileCount))"
    }
}

/// The review's own layout control.
///
/// Unified and side-by-side answer one question — how this diff is arranged —
/// so they are one segmented control, and it lives with the review rather than
/// being repeated per file. Exposed separately from the canvas so the window can
/// host it in the toolbar, where a per-scene view setting belongs.
public struct ReviewLayoutPicker: View {
    @Bindable private var review: ReviewModel

    public init(review: ReviewModel) {
        self.review = review
    }

    public var body: some View {
        Picker("Diff layout", selection: $review.layout) {
            ForEach(ReviewModel.Layout.allCases) { layout in
                JunoIconView(layout.icon)
                    .accessibilityLabel(layout.label)
                    .tag(layout)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 74)
        .help("Show the diff unified or side by side")
        .accessibilityIdentifier("juno.code.review.layout")
    }
}
