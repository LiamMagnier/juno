import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The inspector is supervision, not another editor.
///
/// The three primary destinations are the three surfaces a reader repeatedly
/// needs while an agent is working: an overview of the run, the files it
/// changed, and the agents it delegated. Environment, Repository and Preview
/// remain available as secondary workspace tools without consuming permanent
/// horizontal space in a 320pt inspector.
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
        case .subagents: "Agents"
        case .environment: "Environment"
        case .repository: "Repository"
        case .preview: "Preview"
        }
    }

    public var segmentLabel: String { label }

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

    var isPrimary: Bool {
        switch self {
        case .activity, .changes, .subagents: true
        case .environment, .repository, .preview: false
        }
    }
}

/// The trailing supervision workspace for a local Code session.
///
/// There is deliberately no icon-grid dashboard and no permanent list of six
/// destinations. At this width the inspector should behave like a compact
/// native tool: one status header, three high-frequency destinations, and a
/// menu for the lower-frequency workspace utilities.
public struct InspectorView: View {
    @Bindable private var controller: SessionController
    private let openPreview: (() -> Void)?
    private let openSources: (() -> Void)?
    private let openWorkspace: (() -> Void)?

    /// v3 intentionally starts the redesigned inspector on Overview rather than
    /// inheriting the old v2 default of Environment. A session opens on what is
    /// happening now, not on filesystem metadata.
    @SceneStorage("juno.code.inspector.pane.v3") private var storedPane =
        CodeInspectorPane.activity.rawValue

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

    private var review: ReviewModel { controller.review }

    private var pane: Binding<CodeInspectorPane> {
        Binding(
            get: { CodeInspectorPane(rawValue: storedPane) ?? .activity },
            set: { storedPane = $0.rawValue }
        )
    }

    private var status: CodeRunStatus {
        CodeRunStatus(
            controller.session.status,
            hasPendingApproval: !controller.pendingApprovals.isEmpty
        )
    }

    private var isShowingPrimaryPane: Bool {
        pane.wrappedValue.isPrimary
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color.junoSeparator)
            navigation
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
        .task(id: controller.sessionID) {
            #if DEBUG
            let arguments = CommandLine.arguments
            if let flag = arguments.firstIndex(of: "--juno-preview-inspector-pane"),
               arguments.indices.contains(arguments.index(after: flag)),
               let requested = CodeInspectorPane(
                   rawValue: arguments[arguments.index(after: flag)]
               )
            {
                storedPane = requested.rawValue
            }
            #endif
            await controller.refreshWorkspacePanels()
        }
    }

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            CodeStatusGlyph(status, size: 14)

            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Task")
                    .font(.headline)
                Text(status.label)
                    .junoCaption()
                    .foregroundStyle(status.tint)
            }

            Spacer(minLength: JunoSpace.tight)

            if !controller.pendingApprovals.isEmpty {
                HStack(spacing: JunoSpace.hairline) {
                    JunoIconView(.permission, size: 12)
                    Text("\(controller.pendingApprovals.count)")
                        .monospacedDigit()
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.junoCaution)
                .padding(.horizontal, JunoSpace.tight)
                .padding(.vertical, 3)
                .background(Color.junoCaution.opacity(0.12), in: Capsule())
                .help("Approval requests waiting")
                .accessibilityLabel("\(controller.pendingApprovals.count) approval requests waiting")
            }

            secondaryMenu
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .accessibilityIdentifier("juno.code.inspector.header")
    }

    @ViewBuilder
    private var navigation: some View {
        if isShowingPrimaryPane {
            Picker("Inspector", selection: pane) {
                Text("Overview")
                    .tag(CodeInspectorPane.activity)
                Text(changeTabLabel)
                    .tag(CodeInspectorPane.changes)
                Text(agentTabLabel)
                    .tag(CodeInspectorPane.subagents)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .accessibilityIdentifier("juno.code.inspector.primary-navigation")
        } else {
            HStack(spacing: JunoSpace.snug) {
                Button {
                    pane.wrappedValue = .activity
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(systemImage: "chevron.left", size: 12)
                        Text("Overview")
                    }
                }
                .buttonStyle(.plain)
                .junoSecondaryInk()
                .accessibilityLabel("Back to Overview")

                Spacer(minLength: 0)

                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(systemImage: pane.wrappedValue.symbol, size: 13)
                    Text(pane.wrappedValue.label)
                        .junoRowLabel()
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("juno.code.inspector.secondary-navigation")
        }
    }

    private var changeTabLabel: String {
        controller.changes.isEmpty ? "Changes" : "Changes \(controller.changes.count)"
    }

    private var agentTabLabel: String {
        controller.subagents.isEmpty ? "Agents" : "Agents \(controller.subagents.count)"
    }

    private var secondaryMenu: some View {
        Menu {
            Section("Workspace") {
                secondaryButton(.environment)
                secondaryButton(.repository)
                secondaryButton(.preview)
            }

            Divider()

            Button {
                pane.wrappedValue = .activity
            } label: {
                menuLabel(.activity)
            }
            Button {
                pane.wrappedValue = .changes
            } label: {
                menuLabel(.changes)
            }
            Button {
                pane.wrappedValue = .subagents
            } label: {
                menuLabel(.subagents)
            }
        } label: {
            JunoIconView(.ellipsis, size: 15)
                .frame(width: 30, height: 30)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Circle())
        }
        .menuStyle(.borderlessButton)
        .help("More task tools")
        .accessibilityLabel("More task tools")
        .accessibilityIdentifier("juno.code.inspector.more")
    }

    private func secondaryButton(_ candidate: CodeInspectorPane) -> some View {
        Button {
            pane.wrappedValue = candidate
        } label: {
            menuLabel(candidate)
        }
    }

    private func menuLabel(_ candidate: CodeInspectorPane) -> some View {
        HStack {
            JunoIconView(systemImage: candidate.symbol, size: 14)
            Text(candidate.label)
            Spacer(minLength: JunoSpace.regular)
            if pane.wrappedValue == candidate {
                JunoIconView(.check, size: 13)
            }
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
                openWorkspace: openWorkspace
            )
        case .repository:
            RepositoryTab(controller: controller)
        case .preview:
            PreviewTab(controller: controller, openPreview: openPreview)
        }
    }
}
