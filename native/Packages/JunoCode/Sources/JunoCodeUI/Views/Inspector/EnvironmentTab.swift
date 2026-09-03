import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

/// The rail's face: the task's environment as a short column of rows.
///
/// Changes with the diff stat, where the task runs, the branch, the way to
/// commit or push, the compare link, then the delegated agents and the sources
/// that supplied context. Every row routes through an existing controller or
/// review capability; the rail never invents status, and every honest
/// "unavailable" stays visible rather than hidden.
struct EnvironmentTab: View {
    @Bindable var controller: SessionController
    let review: ReviewModel
    let openSources: (() -> Void)?
    let openWorkspace: (() -> Void)?
    /// Opens the Subagents pane, from the section's header.
    let openSubagents: (() -> Void)?
    /// Opens the Create pull request sheet, or nil where the host has none.
    let createPullRequest: (() -> Void)?
    /// Starts a new task in this project in another environment. The engine a
    /// session runs on is fixed when the session is created, so the picker
    /// under "Local" cannot migrate this thread; it starts the next one.
    let startTask: ((CodeEnvironmentChoice) -> Void)?

    @State private var commitMessage = "Apply changes from Juno"
    @State private var showingCommit = false
    @State private var committing = false
    @State private var preparingPush = false
    @State private var pushing = false
    @State private var pushPlan: GitPushPlan?
    @State private var actionError: String?
    @State private var creatingBranch = false
    @State private var newBranchName = ""
    @Environment(\.openURL) private var openURL

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
            appendSource(path: file.path.value, detail: "Instructions", icon: .file, to: &entries, seen: &seen)
        }
        for path in controller.composerFileReferences {
            appendSource(path: path.value, detail: "Attached", icon: .link, to: &entries, seen: &seen)
        }
        for change in controller.changes {
            appendSource(path: change.path, detail: "Changed", icon: .fileDiff, to: &entries, seen: &seen)
        }
        if entries.isEmpty {
            for file in controller.rootEntries where !file.isDirectory {
                appendSource(path: file.path.value, detail: "Workspace file", icon: .file, to: &entries, seen: &seen)
            }
        }
        return entries
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                changesRow
                environmentRow
                if controller.isGitRepository {
                    branchRow
                    actionRow(
                        title: "Commit or push",
                        subtitle: commitPushSubtitle,
                        icon: .gitCommit,
                        isEnabled: canUseGitActions,
                        isBusy: committing || preparingPush || pushing,
                        identifier: "juno.code.environment.commit",
                        action: commitOrPush
                    )
                    actionRow(
                        title: "Compare branch",
                        subtitle: compareSubtitle,
                        icon: .external,
                        isEnabled: canCompare,
                        trailing: .external,
                        identifier: "juno.code.environment.compare",
                        action: compareBranch
                    )
                }

                sectionHeader("Subagents") { EmptyView() }
                subagentsRow

                sectionHeader("Sources") {
                    Button {
                        openSources?()
                    } label: {
                        JunoIconView(.plus, size: 13)
                            .junoSecondaryInk()
                            .frame(width: 24, height: 24)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.junoPress)
                    .disabled(openSources == nil)
                    .help("Open a file from this workspace")
                    .accessibilityLabel("Add source")
                    .accessibilityIdentifier("juno.code.environment.sources.add")
                }
                sourcesList
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, JunoSpace.tight)
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
        .alert("New branch", isPresented: $creatingBranch) {
            TextField("Branch name", text: $newBranchName)
            Button("Create") { createBranch() }
                .disabled(newBranchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Creates and checks out a branch from the current HEAD.")
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

    // MARK: - Rows

    /// The diff, as `+1,926 −1,668` in green and red mono. Opens the review.
    private var changesRow: some View {
        Button {
            review.present()
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.fileDiff, size: 15)
                    .junoSecondaryInk()
                    .frame(width: 18)
                Text("Changes")
                    .junoRowLabel()
                    .junoInk()
                Spacer(minLength: JunoSpace.tight)
                if totalAdded > 0 || totalRemoved > 0 {
                    HStack(spacing: JunoSpace.tight) {
                        Text("+\(Self.grouped(totalAdded))")
                            .foregroundStyle(Color.junoSuccess)
                        Text("−\(Self.grouped(totalRemoved))")
                            .foregroundStyle(Color.junoDanger)
                    }
                    .junoCode()
                    .monospacedDigit()
                } else {
                    Text(changeSubtitle)
                        .junoCaption()
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Review the files changed by this task (⌥⌘R)")
        .accessibilityLabel("Changes, \(totalAdded) added, \(totalRemoved) removed")
        .accessibilityIdentifier("juno.code.environment.changes")
    }

    /// "Local ▾" — where this thread runs, and the menu that starts the next
    /// one somewhere else.
    private var environmentRow: some View {
        let current: CodeEnvironmentChoice = controller.session.executionRootPath != nil ? .worktree : .local
        return Menu {
            Section("This thread") {
                Text(controller.workspacePathDisplay)
                Text(current.detail)
            }
            Section("Start the next task in") {
                ForEach(CodeEnvironmentChoice.allCases) { choice in
                    Button {
                        startTask?(choice)
                    } label: {
                        HStack {
                            Text(choice.label)
                            Spacer(minLength: JunoSpace.regular)
                            if choice == current {
                                JunoIconView(.check, size: 13).accessibilityHidden(true)
                            }
                        }
                    }
                    .disabled(startTask == nil)
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
            menuRowLabel(
                title: current.label,
                subtitle: controller.workspaceDisplayName,
                icon: current == .worktree ? .fork : .device
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .contentShape(.rect)
        .help("Where this thread runs")
        .accessibilityLabel("Environment")
        .accessibilityValue(current.label)
        .accessibilityIdentifier("juno.code.environment.location")
    }

    /// "main ▾" — the branch, its upstream, and the branch actions.
    private var branchRow: some View {
        Menu {
            Section(branchName) {
                Text(branchSubtitle)
                if let status {
                    Text("Ahead \(status.ahead) · Behind \(status.behind)")
                }
            }
            Button {
                newBranchName = ""
                creatingBranch = true
            } label: {
                JunoIconLabel(verbatim: "New branch…", icon: .branch, size: 14)
            }
            .disabled(!canUseGitActions)
            if !controller.managedWorktrees.isEmpty {
                Section("Worktrees") {
                    ForEach(controller.managedWorktrees) { worktree in
                        Text("\(worktree.branch) · \(PathDisplay.fileName(worktree.rootPath))")
                    }
                }
            }
        } label: {
            menuRowLabel(title: branchName, subtitle: branchSubtitle, icon: .branch)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .contentShape(.rect)
        .help("The branch this thread works on")
        .accessibilityLabel("Branch")
        .accessibilityValue(branchName)
        .accessibilityIdentifier("juno.code.environment.branch")
    }

    /// A menu row: mark, title, quiet subtitle, and the one chevron a menu
    /// row earns.
    private func menuRowLabel(title: String, subtitle: String, icon: JunoIcon) -> some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(icon, size: 15)
                .junoSecondaryInk()
                .frame(width: 18)
            Text(title)
                .junoRowLabel()
                .junoInk()
                .lineLimit(1)
                .truncationMode(.middle)
            JunoIconView(.chevronDown, size: 11)
                .junoMetaInk()
            Spacer(minLength: JunoSpace.tight)
            Text(subtitle)
                .junoCaption()
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 120, alignment: .trailing)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 44)
        .contentShape(.rect)
    }

    private func actionRow(
        title: String,
        subtitle: String,
        icon: JunoIcon,
        isEnabled: Bool,
        isBusy: Bool = false,
        trailing: JunoIcon? = nil,
        identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(icon, size: 15)
                    .junoSecondaryInk()
                    .frame(width: 18)
                Text(title)
                    .junoRowLabel()
                    .junoInk()
                if let trailing {
                    JunoIconView(trailing, size: 11)
                        .junoMetaInk()
                }
                Spacer(minLength: JunoSpace.tight)
                if isBusy {
                    ProgressView().controlSize(.small)
                } else {
                    Text(subtitle)
                        .junoCaption()
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: 120, alignment: .trailing)
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled || isBusy)
        .help(isEnabled ? subtitle : disabledActionHelp)
        .accessibilityIdentifier(identifier)
    }

    // MARK: - Subagents

    /// One dot per agent, coloured by its state, and the count.
    private var subagentsRow: some View {
        let runs = controller.subagents
        let active = runs.filter(\.isActive).count
        let done = runs.count - active
        return Button {
            openSubagents?()
        } label: {
            HStack(spacing: JunoSpace.snug) {
                if runs.isEmpty {
                    Text("No agents delegated")
                        .junoCaption()
                } else {
                    HStack(spacing: 3) {
                        ForEach(runs.prefix(12)) { run in
                            Circle()
                                .fill(Self.dotTint(run.status))
                                .frame(width: 7, height: 7)
                        }
                    }
                    .accessibilityHidden(true)
                    Text(subagentSummary(active: active, done: done))
                        .junoCaption()
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(runs.isEmpty || openSubagents == nil)
        .accessibilityLabel(runs.isEmpty ? "No agents delegated" : subagentSummary(active: active, done: done))
        .accessibilityIdentifier("juno.code.environment.subagents")
    }

    private func subagentSummary(active: Int, done: Int) -> String {
        var parts: [String] = []
        if active > 0 { parts.append("\(active) running") }
        if done > 0 { parts.append("\(done) done") }
        return parts.joined(separator: " · ")
    }

    private static func dotTint(_ status: SubagentStatus) -> Color {
        switch status {
        case .completed: .junoSuccess
        case .failed: .junoDanger
        case .waitingForApproval, .interrupted: .junoCaution
        case .running: .junoAccent
        case .queued, .preparing, .cancelled: .junoMutedForeground
        }
    }

    // MARK: - Sources

    @ViewBuilder
    private var sourcesList: some View {
        let entries = sourceEntries
        if entries.isEmpty {
            Text("No sources yet")
                .junoCaption()
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.bottom, JunoSpace.snug)
        } else {
            ForEach(Array(entries.prefix(4))) { entry in
                sourceRow(entry)
            }
            if entries.count > 4 || openSources != nil {
                Button {
                    openSources?()
                } label: {
                    Text("View all")
                        .junoCaption()
                        .padding(.horizontal, JunoSpace.cozy)
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(openSources == nil)
                .accessibilityIdentifier("juno.code.environment.sources.all")
            }
        }
    }

    private func sourceRow(_ entry: SourceEntry) -> some View {
        Button {
            openSource(entry.path)
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(entry.icon, size: 13)
                    .junoSecondaryInk()
                    .frame(width: 18)
                Text(PathDisplay.fileName(entry.path))
                    .junoCode()
                    .junoInk()
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: JunoSpace.tight)
                Text(entry.detail)
                    .junoCaption()
                    .lineLimit(1)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Open \(entry.path)")
    }

    private func sectionHeader<Trailing: View>(
        _ title: String,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: JunoSpace.tight) {
            Text(title)
                .junoSidebarSection()
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.leading, JunoSpace.cozy)
        .padding(.trailing, JunoSpace.tight)
        .padding(.top, JunoSpace.regular)
        .frame(minHeight: 32)
        .accessibilityAddTraits(.isHeader)
    }

    // MARK: - Facts

    private var branchName: String {
        status?.branch ?? controller.session.gitBranch ?? "No branch"
    }

    private var branchSubtitle: String {
        if let upstream = status?.upstream { return upstream }
        return status == nil ? "Loading" : "No upstream"
    }

    private var changeSubtitle: String {
        if !controller.changes.isEmpty {
            return PathDisplay.fileCount(controller.changes.count)
        }
        if let status, !status.files.isEmpty {
            return "\(status.files.count) in working tree"
        }
        return "Clean"
    }

    private var commitPushSubtitle: String {
        if !canUseGitActions { return controller.context == nil ? "Unavailable in preview" : "Read-only" }
        if hasRepositoryChanges { return "\(status?.files.count ?? controller.changes.count) files" }
        if let status, status.ahead > 0 { return "\(status.ahead) to push" }
        return "Nothing to publish"
    }

    private var canCompare: Bool {
        controller.gitHubPullRequest != nil || createPullRequest != nil
    }

    private var compareSubtitle: String {
        if let pull = controller.gitHubPullRequest { return "#\(pull.number)" }
        if createPullRequest != nil { return "Open a pull request" }
        return controller.pullRequestUnavailableReason ?? "Unavailable"
    }

    private var disabledActionHelp: String {
        if controller.context == nil { return "Git actions are unavailable in the preview fixture" }
        if controller.session.configuration.behavior != .code { return "Ask and Plan sessions are read-only" }
        return "There is nothing to publish from this workspace"
    }

    private var totalAdded: Int { controller.changes.reduce(0) { $0 + $1.linesAdded } }
    private var totalRemoved: Int { controller.changes.reduce(0) { $0 + $1.linesRemoved } }

    static func grouped(_ value: Int) -> String {
        value.formatted(.number.grouping(.automatic))
    }

    // MARK: - Actions

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

    private func createBranch() {
        let name = newBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task {
            let succeeded = await controller.createGitBranch(named: name)
            if !succeeded {
                actionError = controller.transientError ?? "The branch could not be created."
            }
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

    /// The pull request when there is one, the sheet that opens one otherwise.
    private func compareBranch() {
        if let pull = controller.gitHubPullRequest, let url = URL(string: pull.url) {
            openURL(url)
            return
        }
        createPullRequest?()
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
