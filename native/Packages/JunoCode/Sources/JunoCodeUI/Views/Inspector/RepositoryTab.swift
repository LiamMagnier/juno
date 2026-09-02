import AppKit
import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoDesignSystem

/// Git status, history, publication and CI in one column, because they are all
/// facts about the repository rather than about the agent.
///
/// Everything that changes a remote goes through a confirmation that names the
/// exact remote and branch, and nothing here can force-push: `GitServicing` has
/// no history-rewriting operation, and the command tool's classifier marks one as
/// critical if the agent ever asks for it.
struct RepositoryTab: View {
    @Bindable var controller: SessionController
    /// Opens the Create pull request sheet, when the host offers one.
    var createPullRequest: (() -> Void)? = nil

    @State private var commitMessage = ""
    @State private var committing = false
    @State private var preparingPush = false
    @State private var pushing = false
    @State private var pushPlan: GitPushPlan?
    @State private var creatingBranch = false
    @State private var newBranchName = ""
    @State private var creatingWorktree = false
    @State private var newWorktreeBranch = ""
    @State private var confirmingHookTrust = false

    private var isEditable: Bool {
        controller.session.configuration.behavior == .code
    }

    var body: some View {
        List {
            if controller.isGitRepository {
                if let status = controller.gitStatus {
                    branchSection(status)
                    worktreesSection
                    workingTreeSection(status)
                }
                pullRequestSection
                commitsSection
            } else {
                Section {
                    JunoEmptyState(
                        title: "Not a Git repository",
                        message: "Juno can still read and edit this folder. Branch, commit and pull-request information needs a repository.",
                        symbol: "arrow.triangle.branch"
                    )
                }
            }
            extensibilitySection
            instructionsSection
        }
        .listStyle(.inset)
        .refreshable {
            await controller.refreshWorkspacePanels()
            await controller.refreshGitHubPullRequest()
        }
        .task(id: controller.sessionID) {
            if controller.gitHubPullRequest == nil, controller.gitHubStatusMessage == nil {
                await controller.refreshGitHubPullRequest()
            }
        }
        .alert("New branch", isPresented: $creatingBranch) {
            TextField("Branch name", text: $newBranchName)
            Button("Create") {
                let name = newBranchName
                newBranchName = ""
                Task { await controller.createGitBranch(named: name) }
            }
            Button("Cancel", role: .cancel) { newBranchName = "" }
        } message: {
            Text(
                "Switches this repository to a new branch from the current one, so the work in progress is isolated."
            )
        }
        .alert("Isolate worktree", isPresented: $creatingWorktree) {
            TextField("feature/branch-name", text: $newWorktreeBranch)
            Button("Create") {
                let name = newWorktreeBranch
                newWorktreeBranch = ""
                Task {
                    if let worktree = await controller.createIsolatedWorktree(named: name) {
                        NSWorkspace.shared.open(worktree.rootURL)
                    }
                }
            }
            Button("Cancel", role: .cancel) { newWorktreeBranch = "" }
        } message: {
            Text(
                "Creates a real Git worktree under .juno/worktrees and leaves this checkout's dirty files and branch untouched."
            )
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
                Button(
                    plan.setsUpstream
                        ? "Publish \(plan.localBranch)"
                        : "Push \(plan.localBranch)"
                ) {
                    publish(plan)
                }
            }
            Button("Cancel", role: .cancel) { pushPlan = nil }
        } message: {
            if let plan = pushPlan {
                Text(
                    "Push \(plan.localBranch) to \(plan.displayTarget). "
                        + "Juno never force-pushes from this control."
                )
            }
        }
        .confirmationDialog(
            "Trust workspace hooks?",
            isPresented: $confirmingHookTrust,
            titleVisibility: .visible
        ) {
            Button("Trust & enable hooks") {
                Task { await controller.setHooksEnabled(true) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "This allows the discovered .claude/settings.json and .juno/hooks.json commands to run inside the granted workspace. Juno still applies its command sandbox and approval policy."
            )
        }
    }

    // MARK: - Branch

    private func branchSection(_ status: GitStatusSummary) -> some View {
        Section("Branch") {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(systemImage: "arrow.triangle.branch")
                    .junoSecondaryInk()
                VStack(alignment: .leading, spacing: 1) {
                    Text(status.branch ?? "detached HEAD")
                        .junoCode()
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(status.upstream ?? "No upstream")
                        .font(.caption2)
                        .junoMetaInk()
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: JunoSpace.tight)
                if status.ahead > 0 {
                    Label {
                        Text("\(status.ahead)")
                    } icon: {
                        JunoIconView(.send, size: 13)
                    }
                        .junoCaption()
                        .monospacedDigit()
                        .help("\(status.ahead) commits not yet pushed")
                }
                if status.behind > 0 {
                    Label {
                        Text("\(status.behind)")
                    } icon: {
                        JunoIconView(.arrowDown, size: 13)
                    }
                        .junoCaption()
                        .monospacedDigit()
                        .help("\(status.behind) commits on the upstream you do not have")
                }
            }

            HStack(spacing: JunoSpace.snug) {
                Button("New Branch…") { creatingBranch = true }
                    .controlSize(.small)
                    .disabled(!isEditable)
                    .help(
                        isEditable
                            ? "Start a branch for this work"
                            : "Ask and Plan sessions are read-only"
                    )
                Button("Isolate…") { creatingWorktree = true }
                    .controlSize(.small)
                    .disabled(!isEditable)
                    .help(
                        isEditable
                            ? "Create a separate checkout without switching this repository"
                            : "Ask and Plan sessions are read-only"
                    )
                Spacer(minLength: 0)
                Button {
                    preparePush()
                } label: {
                    if preparingPush || pushing {
                        ProgressView().controlSize(.small)
                    } else {
                        JunoIconLabel(
                            status.upstream == nil ? "Publish…" : "Push…",
                            icon: .send
                        )
                    }
                }
                .controlSize(.small)
                .disabled(!isEditable || preparingPush || pushing)
                .help(
                    isEditable
                        ? "Confirm the exact remote and branch before anything leaves this Mac"
                        : "Ask and Plan sessions are read-only"
                )
                .accessibilityLabel(
                    status.upstream == nil ? "Publish current branch" : "Push current branch"
                )
                .accessibilityIdentifier("juno.code.repository.push")
            }
        }
    }

    private var worktreesSection: some View {
        Section {
            if controller.managedWorktrees.isEmpty {
                Text("No isolated worktrees created in this session.")
                    .junoCaption()
            } else {
                ForEach(controller.managedWorktrees) { worktree in
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        HStack(spacing: JunoSpace.snug) {
                            JunoIconView(systemImage: "square.split.2x1")
                                .foregroundStyle(Color.junoAccent)
                            Text(worktree.branch)
                                .junoRowLabel()
                                .lineLimit(1)
                            Spacer(minLength: JunoSpace.tight)
                            Button {
                                NSWorkspace.shared.open(worktree.rootURL)
                            } label: {
                                JunoIconView(systemImage: "arrow.up.right.square")
                            }
                            .buttonStyle(.borderless)
                            .help("Open isolated worktree")
                            .accessibilityLabel("Open isolated worktree")
                            Button(role: .destructive) {
                                Task { await controller.removeIsolatedWorktree(worktree) }
                            } label: {
                                JunoIconView(systemImage: "trash")
                            }
                            .buttonStyle(.borderless)
                            .help("Remove this isolated worktree")
                            .accessibilityLabel("Remove isolated worktree")
                        }
                        Text(worktree.rootPath)
                            .junoCodeSmall()
                            .junoMetaInk()
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, JunoSpace.hairline)
                }
            }
        } header: {
            HStack {
                Text("Isolated worktrees")
                Spacer()
                Button {
                    creatingWorktree = true
                } label: {
                    JunoIconView(systemImage: "plus")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(!isEditable)
                .help("Create an isolated worktree")
                .accessibilityLabel("Create isolated worktree")
            }
        } footer: {
            Text("Useful for parallel work: each checkout has its own branch and files.")
                .junoCaption()
        }
    }

    // MARK: - Working tree

    private func workingTreeSection(_ status: GitStatusSummary) -> some View {
        Section("Working tree") {
            if status.isClean {
                JunoIconLabel("Working tree clean", icon: .check)
                    .junoCaption()
                    .foregroundStyle(Color.junoSuccess)
            } else {
                ForEach(status.files) { file in
                    HStack(spacing: JunoSpace.snug) {
                        // The real two-letter porcelain state: index then
                        // worktree, so a staged-and-then-edited file reads as
                        // "MM" rather than as one invented word.
                        Text("\(file.indexState)\(file.worktreeState)")
                            .junoCodeSmall()
                            .foregroundStyle(stateTint(file))
                            .frame(width: 26)
                            .help(stateHelp(file))
                        Text(file.path)
                            .junoCode()
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(file.path), \(stateHelp(file))")
                }

                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    TextField("Commit message", text: $commitMessage, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("juno.code.repository.commit-message")
                    HStack(spacing: JunoSpace.snug) {
                        if status.hasConflicts {
                            JunoIconLabel("Resolve conflicts first", icon: .error)
                                .junoCaption()
                                .foregroundStyle(Color.junoCaution)
                        }
                        Spacer(minLength: 0)
                        Button(committing ? "Committing…" : "Stage All & Commit") { commit() }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                            .tint(Color.junoAccent)
                            .disabled(
                                !isEditable
                                    || committing
                                    || status.hasConflicts
                                    || commitMessage.trimmingCharacters(in: .whitespaces).isEmpty
                            )
                            .help(
                                isEditable
                                    ? "Stage every change in the working tree and commit it"
                                    : "Ask and Plan sessions are read-only"
                            )
                            .accessibilityIdentifier("juno.code.repository.commit")
                    }
                }
                .padding(.top, JunoSpace.hairline)
            }
        }
    }

    private func stateTint(_ file: GitFileStatus) -> Color {
        if file.isConflicted { return .junoDanger }
        if file.isStaged { return .junoSuccess }
        return .junoCaution
    }

    private func stateHelp(_ file: GitFileStatus) -> String {
        if file.isConflicted { return "Conflicted" }
        if file.isUntracked { return "Untracked" }
        var parts: [String] = []
        if file.isStaged { parts.append("staged") }
        if file.hasUnstagedChanges { parts.append("unstaged changes") }
        return parts.isEmpty ? "Unchanged" : parts.joined(separator: ", ").capitalized
    }

    // MARK: - Pull request and CI

    /// Poll-on-demand, by construction: the status comes from shelling out to the
    /// GitHub CLI, and there is no webhook or push channel to keep it live. The
    /// panel says so rather than pretending to be a CI feed.
    private var pullRequestSection: some View {
        Section {
            if controller.isLoadingGitHubStatus {
                HStack(spacing: JunoSpace.snug) {
                    ProgressView().controlSize(.small)
                    Text("Loading pull request…").junoCaption()
                }
            } else if let pullRequest = controller.gitHubPullRequest {
                pullRequestSummary(pullRequest)
                if pullRequest.checks.isEmpty {
                    Text("No CI checks are reported for this pull request.")
                        .junoCaption()
                } else {
                    ForEach(pullRequest.checks) { check in
                        checkRow(check)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text(controller.gitHubStatusMessage ?? "GitHub status has not been loaded.")
                        .junoCaption()
                    HStack(spacing: JunoSpace.snug) {
                        Button("Check Again") {
                            Task { await controller.refreshGitHubPullRequest() }
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        if let createPullRequest, controller.pullRequestUnavailableReason == nil {
                            Button("Create Pull Request…", action: createPullRequest)
                                .controlSize(.small)
                                .accessibilityIdentifier("juno.code.repository.create-pull-request")
                        }
                    }
                    if let url = controller.lastPullRequestURL {
                        Text(url)
                            .junoCodeSmall()
                            .junoSecondaryInk()
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
            }
        } header: {
            HStack {
                Text("Pull request & CI")
                Spacer()
                if !controller.isLoadingGitHubStatus {
                    Button {
                        Task { await controller.refreshGitHubPullRequest() }
                    } label: {
                        JunoIconView(systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .help("Read the pull request and its checks again")
                    .accessibilityLabel("Refresh pull request status")
                }
            }
        }
    }

    private func pullRequestSummary(_ pullRequest: GitHubPullRequestStatus) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                Text("#\(pullRequest.number)")
                    .junoCodeSmall()
                    .junoSecondaryInk()
                Text(pullRequest.title)
                    .junoRowLabel()
                    .lineLimit(2)
                Spacer(minLength: JunoSpace.tight)
                if let url = safeWebURL(pullRequest.url) {
                    Link(destination: url) {
                        JunoIconView(systemImage: "arrow.up.right.square")
                    }
                    .help("Open the pull request on GitHub")
                    .accessibilityLabel("Open pull request in browser")
                }
            }
            HStack(spacing: JunoSpace.snug) {
                Text(pullRequest.isDraft ? "Draft" : pullRequest.state.capitalized)
                    .junoCaption()
                    .foregroundStyle(pullRequest.isDraft ? Color.junoMutedForeground : Color.junoSuccess)
                Text("\(pullRequest.headRefName) → \(pullRequest.baseRefName)")
                    .junoCodeSmall()
                    .junoMetaInk()
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let review = pullRequest.reviewDecision, !review.isEmpty {
                    Text(review.replacingOccurrences(of: "_", with: " ").capitalized)
                        .junoCaption()
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func checkRow(_ check: GitHubCheckStatus) -> some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(systemImage: checkSymbol(check.bucket))
                .foregroundStyle(checkColor(check.bucket))
                .frame(width: 15)
            VStack(alignment: .leading, spacing: 1) {
                Text(check.name)
                    .junoRowLabel()
                    .lineLimit(1)
                if let workflow = check.workflow, !workflow.isEmpty {
                    Text(workflow)
                        .font(.caption2)
                        .junoMetaInk()
                        .lineLimit(1)
                }
            }
            Spacer(minLength: JunoSpace.tight)
            Text(check.state.replacingOccurrences(of: "_", with: " ").capitalized)
                .junoCaption()
            if let link = check.link, let url = safeWebURL(link) {
                Link(destination: url) {
                    JunoIconView(systemImage: "arrow.up.right")
                        .imageScale(.small)
                }
                .accessibilityLabel("Open \(check.name) check")
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Commits

    private var commitsSection: some View {
        Section("Recent commits") {
            if controller.gitHistory.isEmpty {
                Text("No commits yet.").junoCaption()
            } else {
                ForEach(controller.gitHistory) { commit in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(commit.subject)
                            .junoRowLabel()
                            .lineLimit(1)
                        HStack(spacing: JunoSpace.tight) {
                            Text(commit.shortHash).junoCodeSmall()
                            Text(commit.author)
                            Text(commit.date, style: .relative)
                        }
                        .font(.caption2)
                        .junoMetaInk()
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(commit.subject), \(commit.author), \(commit.shortHash)")
                }
            }
        }
    }

    // MARK: - Instructions

    private var extensibilitySection: some View {
        Section("Extensions") {
            HStack {
                JunoIconLabel("Skills", icon: .knowledge)
                Spacer()
                Text("\(controller.skillDiscoveryResult.skills.count)")
                    .junoCaption()
                    .monospacedDigit()
            }
            HStack {
                JunoIconLabel("Hooks", icon: .work)
                Spacer()
                Text(
                    controller.hookDiscoveryResult.hooks.isEmpty
                        ? "None"
                        : "\(controller.hookDiscoveryResult.hooks.count) discovered"
                )
                .junoCaption()
                .junoSecondaryInk()
            }
            HStack {
                JunoIconLabel("MCP servers", icon: .tools)
                Spacer()
                Text("\(controller.mcpServerConfigurations.count)")
                    .junoCaption()
                    .monospacedDigit()
            }
            ForEach(controller.mcpServerConfigurations, id: \.name) { server in
                Label {
                    Text(server.name)
                } icon: {
                    JunoIconView(server.enabled ? .check : .stop, size: 14)
                }
                    .junoCaption()
                    .junoSecondaryInk()
            }
            if let error = controller.mcpConfigurationError {
                Text("MCP configuration: \(error)")
                    .junoCaption()
                    .foregroundStyle(Color.junoCaution)
                    .lineLimit(3)
            }
            if !controller.hookDiscoveryResult.hooks.isEmpty {
                if controller.hooksAreEnabled {
                    HStack {
                        JunoIconLabel("Hooks enabled", icon: .permission)
                            .junoCaption()
                            .foregroundStyle(Color.junoSuccess)
                        Spacer()
                        Button("Disable") {
                            Task { await controller.setHooksEnabled(false) }
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                    }
                } else {
                    Text("Hooks remain off until explicitly trusted and allowlisted.")
                        .junoCaption()
                        .junoSecondaryInk()
                    Button("Trust & enable hooks") {
                        confirmingHookTrust = true
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                }
            }
            if !controller.hookDiscoveryResult.diagnostics.isEmpty
                || !controller.skillDiscoveryResult.diagnostics.isEmpty
            {
                JunoIconLabel(
                    verbatim: "\(controller.hookDiscoveryResult.diagnostics.count + controller.skillDiscoveryResult.diagnostics.count) configuration issue(s)",
                    icon: .error
                )
                .junoCaption()
                .foregroundStyle(Color.junoCaution)
            }
        }
    }

    private var instructionsSection: some View {
        Section("Instructions") {
            if controller.instructionFiles.isEmpty {
                Text("No repository instruction files found.").junoCaption()
            } else {
                ForEach(controller.instructionFiles) { file in
                    JunoIconLabel(verbatim: file.path.value, icon: .file)
                        .junoCode()
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Text(
                    "Instructions are context for the agent, never policy: they cannot override permissions or approvals."
                )
                .junoCaption()
            }
        }
    }

    // MARK: - Actions

    private func commit() {
        committing = true
        let message = commitMessage
        Task {
            if await controller.commit(message: message) {
                commitMessage = ""
            }
            committing = false
        }
    }

    private func preparePush() {
        preparingPush = true
        Task {
            pushPlan = await controller.prepareGitPush()
            preparingPush = false
        }
    }

    private func publish(_ plan: GitPushPlan) {
        pushPlan = nil
        pushing = true
        Task {
            _ = await controller.publishGitBranch(plan)
            pushing = false
        }
    }

    private func safeWebURL(_ string: String) -> URL? {
        guard let url = URL(string: string),
              url.scheme == "https" || url.scheme == "http"
        else { return nil }
        return url
    }

    private func checkSymbol(_ bucket: String) -> String {
        switch bucket.lowercased() {
        case "pass": "checkmark.circle.fill"
        case "fail": "xmark.circle.fill"
        case "pending": "clock.fill"
        case "skipping": "forward.circle.fill"
        case "cancel": "minus.circle.fill"
        default: "circle"
        }
    }

    private func checkColor(_ bucket: String) -> Color {
        switch bucket.lowercased() {
        case "pass": .junoSuccess
        case "fail": .junoDanger
        case "pending": .junoCaution
        default: .junoMutedForeground
        }
    }
}
