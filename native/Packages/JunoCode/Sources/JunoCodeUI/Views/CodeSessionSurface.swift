import JunoCodeCore
import JunoDesignSystem
import SwiftUI

/// Shared reading measure for the active task surface.
enum CodeSessionLayout {
    static let measure: CGFloat = 768
    static let inset: CGFloat = 24
}

/// The complete session canvas: transcript/review, console, approvals and the
/// composer. A run that is active swaps only the bottom composer for the focused
/// steering surface; the transcript, inspector and session identity never move.
public struct CodeSessionCanvas: View {
    private let controller: SessionController
    @Bindable private var model: WorkbenchModel
    @Binding private var showsReview: Bool
    @Binding private var showsConsole: Bool
    @FocusState private var composerFocused: Bool
    @State private var slashCommands = CodeSlashCommandLibrary.builtIn

    private let beginDictation: (() -> Void)?
    private let beginVoice: (() -> Void)?
    private let voiceDock: AnyView?
    private let voiceField: AnyView?

    public init(
        controller: SessionController,
        model: WorkbenchModel,
        showsReview: Binding<Bool>,
        showsConsole: Binding<Bool>,
        beginDictation: (() -> Void)? = nil,
        beginVoice: (() -> Void)? = nil,
        voiceDock: AnyView? = nil,
        voiceField: AnyView? = nil
    ) {
        self.controller = controller
        self.model = model
        self._showsReview = showsReview
        self._showsConsole = showsConsole
        self.beginDictation = beginDictation
        self.beginVoice = beginVoice
        self.voiceDock = voiceDock
        self.voiceField = voiceField
    }

    public var body: some View {
        // The clear base clamps the surface to the detail column. An overlay is
        // used so an intrinsically-tall transcript can never resize the window.
        Color.clear
            .overlay {
                content
                    .safeAreaInset(edge: .top, spacing: 0) { goal }
                    .safeAreaInset(edge: .bottom, spacing: 0) { console }
                    .safeAreaInset(edge: .bottom, spacing: 0) { approvals }
                    .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            }
            .background(alignment: .bottom) {
                if let voiceField { voiceField }
            }
            .junoReadingCanvas()
            .animation(JunoMotion.fast, value: controller.review.isPresented)
            .animation(JunoMotion.fast, value: showsConsole)
            .onChange(of: showsReview, initial: true) { _, visible in
                if controller.review.isPresented != visible {
                    controller.review.isPresented = visible
                }
            }
            .onChange(of: controller.review.isPresented) { _, presented in
                if showsReview != presented { showsReview = presented }
            }
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
        slashCommands = .merged(workspace: await context.slashCommands())
    }

    @ViewBuilder
    private var content: some View {
        if controller.review.isPresented {
            ReviewCanvasView(controller: controller, review: controller.review)
        } else {
            TranscriptView(
                controller: controller,
                modelDisplayNames: model.modelDisplayNames,
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

    @ViewBuilder
    private var approvals: some View {
        if let request = controller.pendingApprovals.first {
            ApprovalCard(request: request, controller: controller)
                .padding(.horizontal, JunoSpace.roomy)
                .padding(.bottom, JunoSpace.snug)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    /// The normal turn composer becomes a smaller direction composer while the
    /// executor is active. Mode/model/permission controls intentionally disappear
    /// in that state: steering changes the instruction, never the in-flight
    /// execution contract. Once the run settles, the full composer returns.
    private var composer: some View {
        VStack(spacing: JunoSpace.snug) {
            if let voiceDock, !controller.isRunning { voiceDock }
            transientError

            Group {
                if controller.isRunning {
                    ActiveSteeringComposer(controller: controller)
                        .transition(.opacity)
                } else {
                    Composer(
                        controller: controller,
                        availableModels: model.availableModels,
                        focus: $composerFocused,
                        slashCommands: slashCommands,
                        beginDictation: beginDictation,
                        beginVoice: beginVoice
                    )
                    .transition(.opacity)
                }
            }
            .frame(maxWidth: CodeSessionLayout.measure)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, CodeSessionLayout.inset)
            .padding(.bottom, JunoSpace.snug)
        }
    }

    @ViewBuilder
    private var transientError: some View {
        if let message = controller.transientError {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                JunoIconView(.error, size: 15)
                    .foregroundStyle(Color.junoCaution)
                Text(message)
                    .junoCaption()
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                Spacer(minLength: 0)
                Button {
                    controller.clearTransientError()
                } label: {
                    JunoIconView(.close, size: 13)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .contentShape(.rect)
                .junoSecondaryInk()
                .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .junoPanel(cornerRadius: JunoRadius.row)
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .strokeBorder(Color.junoCaution.opacity(0.5))
            )
            .padding(.horizontal, JunoSpace.roomy)
            .transition(.opacity)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("juno.code.transient-error")
        }
    }
}

/// The inspector half of the shared Code session surface.
public struct CodeSessionInspector: View {
    private let controller: SessionController
    private let openPreview: (() -> Void)?
    private let openSources: (() -> Void)?
    private let openWorkspace: (() -> Void)?

    public init(
        controller: SessionController,
        openPreview: (() -> Void)? = nil,
        openSources: (() -> Void)? = nil,
        openWorkspace: (() -> Void)? = nil
    ) {
        self.controller = controller
        self.openPreview = openPreview
        self.openSources = openSources
        self.openWorkspace = openWorkspace
    }

    public var body: some View {
        InspectorView(
            controller: controller,
            openPreview: openPreview,
            openSources: openSources,
            openWorkspace: openWorkspace
        )
    }
}
