import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

/// The compact, task-oriented repository rail.
///
/// Environment is intentionally a short list rather than another settings
/// dashboard. It keeps the facts that matter while a task is running in one
/// place: the current diff, the checkout, the branch, publication, review and
/// the files that supplied context. Every action below routes through an
/// existing controller or review capability; the rail never invents status.
struct EnvironmentTab: View {
    @Bindable var controller: SessionController
    let review: ReviewModel
    let openSources: (() -> Void)?
    let openWorkspace: (() -> Void)?

    @State private var localExpanded = false
    @State private var branchExpanded = false
    @State private var commitMessage = "Apply changes from Juno"
    @State private var showingCommit = false
    @State private var committing = false
    @State private var preparingPush = false
    @State private var pushing = false
    @State private var pushPlan: GitPushPlan?
    @State private var actionError: String?

    private var status: GitStatusSummary? { controller.gitStatus }

    private var canUseGitActions: Bool {
        controller.context != nil
            && controller.isGitRepository
            && controller.session.configuration.behavior == .code
    }

    private var hasRepositoryChanges: Bool {
        !(status?.files.isEmpty ?? true) || !controller.changes.isEmpty
    }

    private var sourceEntries: [SourceEntry] {
        var entries: [SourceEntry] = []
        var seen = Set<String>()

        for file in controller.instructionFiles {
            appendSource(
                path: file.path.value,
                detail: "Instructions",
                icon: .file,
                to: &entries,
                seen: &seen
            )
        }

        for change in controller.changes {
            appendSource(
                path: change.path,
                detail: "Changed file",
                icon: .code,
                to: &entries,
                seen: &seen
            )
        }

        if entries.isEmpty {
            for file in controller.rootEntries where !file.isDirectory {
                appendSource(
                    path: file.path.value,
                    detail: "Workspace file",
                    icon: .file,
                    to: &entries,
                    seen: &seen
                )
            }
        }

        return entries
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                changesRow
                hairline

                disclosureRow(
                    title: "Local",
                    subtitle: controller.workspaceDisplayName,
                    icon: .device,
                    isExpanded: $localExpanded
                )
                if localExpanded {
                    localDetails
                }

                if controller.isGitRepository {
                    disclosureRow(
                        title: branchName,
                        subtitle: branchSubtitle,
                        icon: .branch,
                        isExpanded: $branchExpanded
                    )
                    if branchExpanded {
                        branchDetails
                    }

                    actionRow(
                        title: "Commit or push",
                        subtitle: commitPushSubtitle,
                        icon: .send,
                        isEnabled: canUseGitActions,
                        isBusy: committing || preparingPush || pushing,
                        action: commitOrPush
                    )

                    actionRow(
                        title: "Review branch changes",
                        subtitle: "Open the current diff",
                        icon: .code,
                        isEnabled: !controller.changes.isEmpty,
                        action: { review.present() }
                    )
                }

                hairline
                sourcesSection
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, JunoSpace.snug)
        }
        .scrollIndicators(.hidden)
        .background(Color.junoCanvas)
        .alert("Commit changes", isPresented: $showingCommit) {
            TextField("Commit message", text: $commitMessage)
            Button("Commit") { commit() }
                .disabled(commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Juno will stage the current workspace changes and create one local commit.")
        }
        .confirmationDialog(
            pushPlan?.setsUpstream == true ? "Publish branch?" : "Push branch?",
            isPresented: Binding(
                get: { pushPlan != nil },
                set: { if !$0 { pushPlan = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let plan = pushPlan {
                Button(plan.setsUpstream ? "Publish \(plan.localBranch)" : "Push \(plan.localBranch)") {
                    publish(plan)
                }
                .contentShape(.rect)
            }
            Button("Cancel", role: .cancel) { pushPlan = nil }
                .contentShape(.rect)
        } message: {
            if let plan = pushPlan {
                Text("Push \(plan.localBranch) to \(plan.displayTarget). Juno never force-pushes from this control.")
            }
        }
        .alert(
            "Git action couldn’t finish",
            isPresented: Binding(
                get: { actionError != nil },
                set: { if !$0 { actionError = nil } }
            )
        ) {
            Button("OK") { actionError = nil }
                .contentShape(.rect)
        } message: {
            Text(actionError ?? "Try again after checking the workspace and branch.")
        }
        .task(id: controller.sessionID) {
            await controller.refreshWorkspacePanels()
        }
    }

    private var changesRow: some View {
        Button {
            review.present()
        } label: {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(.file, size: 17)
                        .foregroundStyle(Color.junoAccent)
                    Text("Review changes")
                        .font(.callout.weight(.semibold))
                    Spacer(minLength: JunoSpace.tight)
                    JunoIconView(.chevronRight, size: 12)
                        .junoSecondaryInk()
                }
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(changeSubtitle)
                        .junoCaption()
                        .lineLimit(1)
                }
                Spacer(minLength: JunoSpace.tight)
                if totalAdded > 0 || totalRemoved > 0 {
                    DiffStat(added: totalAdded, removed: totalRemoved)
                }
                }
            }
            .padding(JunoSpace.cozy)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(Color.junoRaised.opacity(0.72))
            )
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Review the files changed by this task")
        .accessibilityIdentifier("juno.code.environment.changes")
    }

    private var localDetails: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            detailRow("Workspace", controller.workspacePathDisplay, icon: .projects)
            detailRow(
                "Permission",
                PermissionModeLabel.text(for: effectivePermissionMode),
                icon: PermissionModeLabel.junoIcon(for: effectivePermissionMode)
            )
            if let openWorkspace {
                Button {
                    openWorkspace()
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(.external, size: 13)
                        Text("Reveal in Finder")
                    }
                    .junoCaption()
                }
                .contentShape(.rect)
                .buttonStyle(.borderless)
                .disabled(controller.context == nil)
            }
        }
        .padding(.leading, 42)
        .padding(.trailing, JunoSpace.cozy)
        .padding(.bottom, JunoSpace.snug)
    }

    private var branchDetails: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            detailRow("Upstream", status?.upstream ?? "No upstream", icon: .external)
            HStack(spacing: JunoSpace.regular) {
                compactCount("Ahead", value: status?.ahead ?? 0, icon: .send)
                compactCount("Behind", value: status?.behind ?? 0, icon: .arrowDown)
            }
        }
        .padding(.leading, 42)
        .padding(.trailing, JunoSpace.cozy)
        .padding(.bottom, JunoSpace.snug)
    }

    private var sourcesSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Sources")
                    .junoCaption()
                Spacer(minLength: 0)
                Button {
                    openSources?()
                } label: {
                    JunoIconView(.plus, size: 14)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .disabled(openSources == nil)
                .help("Open a file from this workspace")
                .accessibilityLabel("Add source")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)

            if sourceEntries.isEmpty {
                Text("No source files recorded yet")
                    .junoCaption()
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.snug)
            } else {
                ForEach(Array(sourceEntries.prefix(3))) { entry in
                    sourceRow(entry)
                }
                if sourceEntries.count > 3 || openSources != nil {
                    Button("View all") {
                        openSources?()
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.top, JunoSpace.hairline)
                    .padding(.bottom, JunoSpace.snug)
                    .disabled(openSources == nil)
                    .contentShape(.rect)
                    .accessibilityIdentifier("juno.code.environment.sources.all")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sourceRow(_ entry: SourceEntry) -> some View {
        Button {
            openSource(entry.path)
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(entry.icon, size: 14)
                    .junoSecondaryInk()
                VStack(alignment: .leading, spacing: 1) {
                    Text(PathDisplay.fileName(entry.path))
                        .junoCode()
                        .lineLimit(1)
                    Text(entry.detail)
                        .font(.caption2)
                        .junoMetaInk()
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.tight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Open \(entry.path)")
    }

    private func disclosureRow(
        title: String,
        subtitle: String,
        icon: JunoIcon,
        isExpanded: Binding<Bool>
    ) -> some View {
        Button {
            withAnimation(JunoMotion.fast) {
                isExpanded.wrappedValue.toggle()
            }
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(icon, size: 17)
                    .junoSecondaryInk()
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .junoRowLabel()
                        .lineLimit(1)
                    Text(subtitle)
                        .junoCaption()
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                JunoIconView(isExpanded.wrappedValue ? .chevronDown : .chevronRight, size: 12)
                    .junoSecondaryInk()
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityValue(isExpanded.wrappedValue ? "Expanded" : "Collapsed")
    }

    private func actionRow(
        title: String,
        subtitle: String,
        icon: JunoIcon,
        isEnabled: Bool,
        isBusy: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(icon, size: 17)
                    .junoSecondaryInk()
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .junoRowLabel()
                    Text(subtitle)
                        .junoCaption()
                        .lineLimit(1)
                }
                Spacer(minLength: JunoSpace.tight)
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    JunoIconView(.chevronRight, size: 12)
                        .junoSecondaryInk()
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled || isBusy)
        .help(isEnabled ? subtitle : disabledActionHelp)
    }

    private func detailRow(_ title: String, _ value: String, icon: JunoIcon) -> some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(icon, size: 13)
                .junoSecondaryInk()
            Text(title)
                .junoCaption()
            Spacer(minLength: JunoSpace.tight)
            Text(value)
                .junoCodeSmall()
                .junoMetaInk()
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .accessibilityElement(children: .combine)
    }

    private func compactCount(_ title: String, value: Int, icon: JunoIcon) -> some View {
        HStack(spacing: JunoSpace.hairline) {
            JunoIconView(icon, size: 12)
                .junoSecondaryInk()
            Text("\(title) \(value)")
                .junoCodeSmall()
                .junoMetaInk()
                .monospacedDigit()
        }
    }

    private var hairline: some View {
        Divider()
            .overlay(Color.junoSeparator)
            .padding(.vertical, JunoSpace.hairline)
    }

    private var branchName: String {
        status?.branch ?? controller.session.gitBranch ?? "No branch"
    }

    private var branchSubtitle: String {
        if let upstream = status?.upstream { return upstream }
        return status == nil ? "Loading repository" : "No upstream"
    }

    private var changeSubtitle: String {
        if !controller.changes.isEmpty {
            return PathDisplay.fileCount(controller.changes.count)
        }
        if let status, !status.files.isEmpty {
            return "\(status.files.count) working tree files"
        }
        return "Working tree clean"
    }

    private var commitPushSubtitle: String {
        if !canUseGitActions { return controller.context == nil ? "Unavailable in preview" : "Read-only session" }
        if hasRepositoryChanges { return "\(status?.files.count ?? controller.changes.count) files ready" }
        if let status, status.ahead > 0 { return "\(status.ahead) local commit\(status.ahead == 1 ? "" : "s") to push" }
        return "Nothing to publish"
    }

    private var disabledActionHelp: String {
        if controller.context == nil { return "Git actions are unavailable in the preview fixture" }
        if controller.session.configuration.behavior != .code { return "Ask and Plan sessions are read-only" }
        return "There is nothing to publish from this workspace"
    }

    private var effectivePermissionMode: PermissionMode {
        controller.session.configuration.behavior == .code
            ? controller.session.configuration.permissionMode
            : .readOnly
    }

    private var totalAdded: Int {
        controller.changes.reduce(0) { $0 + $1.linesAdded }
    }

    private var totalRemoved: Int {
        controller.changes.reduce(0) { $0 + $1.linesRemoved }
    }

    private func commitOrPush() {
        guard canUseGitActions else { return }
        if hasRepositoryChanges {
            showingCommit = true
        } else {
            preparePush()
        }
    }

    private func commit() {
        let message = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        committing = true
        Task {
            let succeeded = await controller.commit(message: message)
            if !succeeded {
                actionError = controller.transientError ?? "The commit could not be created."
            }
            committing = false
        }
    }

    private func preparePush() {
        preparingPush = true
        Task {
            if let plan = await controller.prepareGitPush() {
                pushPlan = plan
            } else {
                actionError = controller.transientError ?? "Juno could not prepare a push."
            }
            preparingPush = false
        }
    }

    private func publish(_ plan: GitPushPlan) {
        pushPlan = nil
        pushing = true
        Task {
            let succeeded = await controller.publishGitBranch(plan)
            if !succeeded {
                actionError = controller.transientError ?? "The branch could not be published."
            }
            pushing = false
        }
    }

    private func openSource(_ rawPath: String) {
        guard let path = try? WorkspacePath(rawPath) else { return }
        Task { await review.open(path, using: controller) }
    }

    private func appendSource(
        path: String,
        detail: String,
        icon: JunoIcon,
        to entries: inout [SourceEntry],
        seen: inout Set<String>
    ) {
        guard !path.isEmpty, seen.insert(path).inserted else { return }
        entries.append(SourceEntry(path: path, detail: detail, icon: icon))
    }
}

private struct SourceEntry: Identifiable {
    let path: String
    let detail: String
    let icon: JunoIcon

    var id: String { path }
}
