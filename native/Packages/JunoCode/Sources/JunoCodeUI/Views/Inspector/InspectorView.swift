import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The rail beside the thread is the task's environment, not another editor.
///
/// Its face is ``EnvironmentTab``: the diff, where the task runs, the branch,
/// the way to commit or push, the delegated agents and the sources — the
/// facts a reader keeps glancing at while an agent works. The deeper panes —
/// the run overview, the changed-file index, the agents, the repository, the
/// preview — are one menu away and come back to the environment with one
/// click, so the 320pt column is never a tab bar.
public enum CodeInspectorPane: String, CaseIterable, Identifiable, Sendable {
    case activity
    case changes
    case subagents
    case environment
    case repository
    case preview

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .activity: "Overview"
        case .changes: "Changes"
        case .subagents: "Subagents"
        case .environment: "Environment"
        case .repository: "Repository"
        case .preview: "Preview"
        }
    }

    public var segmentLabel: String { label }

    /// Legacy SF name, kept for older callers. New code draws ``junoIcon``.
    public var symbol: String {
        switch self {
        case .activity: "waveform.path.ecg"
        case .changes: "arrow.triangle.2.circlepath"
        case .subagents: "person.2"
        case .environment: "externaldrive"
        case .repository: "arrow.triangle.branch"
        case .preview: "rectangle.on.rectangle"
        }
    }

    /// The website's mark for the pane.
    public var junoIcon: JunoIcon {
        switch self {
        case .activity: .circleDot
        case .changes: .fileDiff
        case .subagents: .agents
        case .environment: .box
        case .repository: .branch
        case .preview: .play
        }
    }

    public var purpose: String {
        switch self {
        case .activity: "Run status, current work, approvals and produced work"
        case .changes: "Files this session changed and the way into review"
        case .subagents: "Every delegated agent, running and finished"
        case .environment: "Working tree, sources and local execution context"
        case .repository: "Branch, commits and pull request state"
        case .preview: "Open the live workspace preview"
        }
    }

    var isPrimary: Bool { self == .environment }
}

public struct InspectorView: View {
    @Bindable private var controller: SessionController
    private let openPreview: (() -> Void)?
    private let openSources: (() -> Void)?
    private let openWorkspace: (() -> Void)?
    private let createPullRequest: (() -> Void)?
    private let startTask: ((CodeEnvironmentChoice) -> Void)?

    /// v4: the rail's face is the environment now, and a scene that remembered
    /// "Overview" from the segmented build should open on the new face once.
    @SceneStorage("juno.code.inspector.pane.v4") private var storedPane =
        CodeInspectorPane.environment.rawValue

    public init(
        controller: SessionController,
        openPreview: (() -> Void)? = nil,
        openSources: (() -> Void)? = nil,
        openWorkspace: (() -> Void)? = nil,
        createPullRequest: (() -> Void)? = nil,
        startTask: ((CodeEnvironmentChoice) -> Void)? = nil
    ) {
        self.controller = controller
        self.openPreview = openPreview
        self.openSources = openSources
        self.openWorkspace = openWorkspace
        self.createPullRequest = createPullRequest
        self.startTask = startTask
    }

    private var review: ReviewModel { controller.review }

    private var pane: Binding<CodeInspectorPane> {
        Binding(
            get: { CodeInspectorPane(rawValue: storedPane) ?? .environment },
            set: { storedPane = $0.rawValue }
        )
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color.junoSeparator)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .inspectorColumnWidth(
            min: JunoInspectorMetrics.minimum,
            ideal: JunoInspectorMetrics.ideal,
            max: JunoInspectorMetrics.maximum
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.inspector.pane")
        .task(id: controller.sessionID) {
            #if DEBUG
            let arguments = CommandLine.arguments
            if let flag = arguments.firstIndex(of: "--juno-preview-inspector-pane"),
               arguments.indices.contains(arguments.index(after: flag)),
               let requested = CodeInspectorPane(rawValue: arguments[arguments.index(after: flag)])
            {
                storedPane = requested.rawValue
            }
            #endif
            await controller.refreshWorkspacePanels()
        }
    }

    /// "Environment", an ellipsis to the deeper panes, and Play. On a deeper
    /// pane the title becomes a way back.
    private var header: some View {
        HStack(spacing: JunoSpace.tight) {
            if pane.wrappedValue.isPrimary {
                Text(pane.wrappedValue.label)
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .semibold)
                    .junoInk()
                    .accessibilityAddTraits(.isHeader)
            } else {
                Button {
                    pane.wrappedValue = .environment
                } label: {
                    HStack(spacing: JunoSpace.hairline) {
                        JunoIconView(.chevronLeft, size: 12)
                            .junoSecondaryInk()
                        Text(pane.wrappedValue.label)
                            .junoFont(size: 13, relativeTo: .subheadline, weight: .semibold)
                            .junoInk()
                    }
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Back to Environment")
                .accessibilityLabel("Back to Environment")
                .accessibilityIdentifier("juno.code.inspector.back")
            }

            if !controller.pendingApprovals.isEmpty {
                HStack(spacing: JunoSpace.hairline) {
                    JunoIconView(.permission, size: 11)
                    Text("\(controller.pendingApprovals.count)")
                        .monospacedDigit()
                }
                .junoFont(size: 11, relativeTo: .caption2, weight: .semibold)
                .foregroundStyle(Color.junoCaution)
                .padding(.horizontal, JunoSpace.tight)
                .padding(.vertical, 2)
                .background(Color.junoCaution.opacity(0.12), in: Capsule())
                .help("Approval requests waiting")
                .accessibilityLabel("\(controller.pendingApprovals.count) approval requests waiting")
            }

            Spacer(minLength: JunoSpace.tight)

            paneMenu

            Button {
                openPreview?()
            } label: {
                JunoIconView(.play, size: 14)
                    .junoSecondaryInk()
                    .frame(width: 26, height: 26)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.junoPress)
            .disabled(openPreview == nil || controller.context == nil)
            .help("Run the project in the live preview (⌥⌘P)")
            .accessibilityLabel("Run preview")
            .accessibilityIdentifier("juno.code.inspector.play")
        }
        .padding(.leading, JunoSpace.cozy)
        .padding(.trailing, JunoSpace.tight)
        .frame(height: 44)
        .accessibilityIdentifier("juno.code.inspector.header")
    }

    private var paneMenu: some View {
        Menu {
            Section("Panes") {
                ForEach(CodeInspectorPane.allCases) { candidate in
                    Button { pane.wrappedValue = candidate } label: { menuLabel(candidate) }
                }
            }
            if let openWorkspace {
                Divider()
                Button(action: openWorkspace) {
                    JunoIconLabel(verbatim: "Reveal in Finder", icon: .external, size: 14)
                }
                .disabled(controller.context == nil)
            }
        } label: {
            JunoIconView(.ellipsis, size: 14)
                .junoSecondaryInk()
                .frame(width: 26, height: 26)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.rect)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("More task tools")
        .accessibilityLabel("More task tools")
        .accessibilityIdentifier("juno.code.inspector.more")
    }

    private func menuLabel(_ candidate: CodeInspectorPane) -> some View {
        HStack {
            JunoIconView(candidate.junoIcon, size: 14)
            Text(candidateTitle(candidate))
            Spacer(minLength: JunoSpace.regular)
            if pane.wrappedValue == candidate {
                JunoIconView(.check, size: 13)
            }
        }
    }

    private func candidateTitle(_ candidate: CodeInspectorPane) -> String {
        switch candidate {
        case .changes where !controller.changes.isEmpty:
            "Changes (\(controller.changes.count))"
        case .subagents where !controller.subagents.isEmpty:
            "Subagents (\(controller.subagents.count))"
        default:
            candidate.label
        }
    }

    @ViewBuilder
    private var content: some View {
        switch pane.wrappedValue {
        case .activity:
            ActivityTab(controller: controller)
        case .changes:
            ChangesTab(controller: controller, review: review)
        case .subagents:
            SubagentPane(controller: controller)
        case .environment:
            EnvironmentTab(
                controller: controller,
                review: review,
                openSources: openSources,
                openWorkspace: openWorkspace,
                openSubagents: { pane.wrappedValue = .subagents },
                createPullRequest: createPullRequest,
                startTask: startTask
            )
        case .repository:
            RepositoryTab(controller: controller, createPullRequest: createPullRequest)
        case .preview:
            PreviewTab(controller: controller, openPreview: openPreview)
        }
    }
}
