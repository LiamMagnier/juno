import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

// Diff review, the pull request's CI, and the session actions that reach the
// workbench: line comments queued into the next message, Keep and Revert per
// hunk, file and all, review scopes, the reviewer's findings on their lines,
// CI with Fix it and Auto-fix, fork, and the rewind's warning about files a
// command changed (CODE_AGENT_SPEC §5.3, §5.6, §5.10). Owned by Lane E.

/// What a session can ask of the workbench that holds it, set when the
/// workbench builds its controller: fork, archive and the session's own
/// worktree need the workbench's store and the project's worktrees.
public struct ShipSessionActions {
    public var fork: @MainActor (_ throughTurn: String?, _ inNewWorktree: Bool) async -> CodeSession?
    public var archive: @MainActor () async -> RunActionResult
    public var recordPullRequest: @MainActor (String) -> Void
    public var worktreeInfo: @MainActor () async -> SessionWorktreeInfo?
    /// The worktree setup command waiting for the reader's approval, if any.
    public var pendingSetup: @MainActor () -> String?
    public var runSetup: @MainActor (String) async -> RunActionResult
    public var bringBackPlan: @MainActor (WorktreeBringBackMethod) async -> Result<[WorktreeBringBackStep], WorktreeManagerError>
    public var performBringBack: @MainActor (WorktreeBringBackStep) async -> RunActionResult

    public init(
        fork: @escaping @MainActor (String?, Bool) async -> CodeSession?,
        archive: @escaping @MainActor () async -> RunActionResult,
        recordPullRequest: @escaping @MainActor (String) -> Void,
        worktreeInfo: @escaping @MainActor () async -> SessionWorktreeInfo? = { nil },
        pendingSetup: @escaping @MainActor () -> String? = { nil },
        runSetup: @escaping @MainActor (String) async -> RunActionResult = { _ in .refused("No worktree.") },
        bringBackPlan: @escaping @MainActor (WorktreeBringBackMethod) async -> Result<[WorktreeBringBackStep], WorktreeManagerError> = { _ in .failure(.worktreeMissing) },
        performBringBack: @escaping @MainActor (WorktreeBringBackStep) async -> RunActionResult = { _ in .refused("No worktree.") }
    ) {
        self.fork = fork
        self.archive = archive
        self.recordPullRequest = recordPullRequest
        self.worktreeInfo = worktreeInfo
        self.pendingSetup = pendingSetup
        self.runSetup = runSetup
        self.bringBackPlan = bringBackPlan
        self.performBringBack = performBringBack
    }
}

public extension SessionController {
    // MARK: Binding

    /// Reads the review queue and the pull request link saved with the
    /// session, and wires CI to the session: each status recorded in the
    /// transcript, settling announced, and Fix it carried out as a turn with
    /// no new reader message. Idempotent.
    func bindShipState() {
        guard let live else { return }
        reviewQueue.bind(fileURL: live.store.sessionFileURL("review-queue.json", for: sessionID))
        let pullRequest = reviewQueue.pullRequest
        pullRequest.bind(fileURL: live.store.sessionFileURL("ci.json", for: sessionID))
        let sessionID = self.sessionID
        let store = live.store
        pullRequest.record = { status in
            _ = try? await store.appendEvent(sessionID: sessionID, payload: .ciStatus(status))
        }
        pullRequest.settled = { [weak self] status in
            guard let self else { return }
            StudioRunMonitor.shared.ciSettled(sessionID: sessionID, sessionTitle: self.session.title, status: status)
        }
        pullRequest.startFix = { [weak self] plan in
            guard let self else { return false }
            return await self.startCIFix(plan)
        }
    }

    /// Fix it: records the CI goal and starts the turn that works on it,
    /// origin CI, with no reader message. Lane A's goal runtime takes the
    /// goal once it lands; until then the runtime note carries the criteria.
    func startCIFix(_ plan: CIFixPlan) async -> Bool {
        guard let live, live.context != nil else { return false }
        _ = try? await live.store.appendEvent(sessionID: sessionID, payload: .goalSet(plan.goalSet))
        return await resumeRun(note: plan.runtimeNote, origin: .ci)
    }

    // MARK: Line comments

    /// Queues a note on one line of the diff for the next message.
    func queueLineComment(
        path: String,
        line: Int?,
        isOldLine: Bool = false,
        quotedLine: String?,
        text: String
    ) {
        if !reviewQueue.isBound { bindShipState() }
        reviewQueue.add(QueuedReviewComment(
            path: path,
            line: line,
            isOldLine: isOldLine,
            quotedLine: quotedLine,
            text: text
        ))
    }

    /// Sends the queued comments now, as their own message (⌘↩ in the diff),
    /// leaving the composer's draft exactly as it is.
    @discardableResult
    func sendQueuedComments() async -> Bool {
        guard let live, reviewQueue.hasComments else { return false }
        let outgoing = reviewQueue.outgoing(prompt: "", modelPrompt: "")
        do {
            try await deliver(
                prompt: outgoing.prompt,
                modelPrompt: outgoing.modelPrompt,
                images: [],
                kind: activeInstructionKind,
                live: live
            )
            reviewQueue.markSent(outgoing.commentIDs)
            reviewQueue.message = nil
            return true
        } catch {
            reviewQueue.message = "The comments did not reach Juno: \(error.localizedDescription) They are still queued."
            return false
        }
    }

    // MARK: Keep and revert

    /// Keep: stages exactly this hunk, so it is set aside from what is still
    /// being reviewed. Revert stays the reader's other answer.
    @discardableResult
    func keepHunk(path: String, hunk: DiffHunk) async -> Bool {
        guard let context = live?.context, context.record.descriptor.isGitRepository else {
            acceptHunk(path: path, hunk: hunk)
            return true
        }
        do {
            try await context.git.stageHunk(path: path, matching: hunk)
            acceptHunk(path: path, hunk: hunk)
            reviewQueue.keptHunks.insert(Self.keptKey(path, hunk))
            reviewQueue.message = nil
            await refreshWorkspacePanels()
            return true
        } catch let error as GitStageHunkError where error == .alreadyStaged {
            acceptHunk(path: path, hunk: hunk)
            reviewQueue.keptHunks.insert(Self.keptKey(path, hunk))
            return true
        } catch {
            reviewQueue.message = (error as? LocalizedError)?.errorDescription ?? "Could not keep that change: \(error)"
            return false
        }
    }

    /// Keep for a whole file: stages it and marks it reviewed.
    @discardableResult
    func keepFile(_ path: String) async -> Bool {
        if let context = live?.context, context.record.descriptor.isGitRepository {
            do {
                try await context.git.stage(paths: [path])
            } catch {
                reviewQueue.message = "Could not keep \(path): \(error.localizedDescription)"
                return false
            }
        }
        acceptChange(path: path)
        await refreshWorkspacePanels()
        return true
    }

    /// Keep for every pending file.
    @discardableResult
    func keepAll() async -> Bool {
        let paths = changes.filter { $0.reviewState == .pending }.map(\.path)
        guard !paths.isEmpty else { return true }
        if let context = live?.context, context.record.descriptor.isGitRepository {
            do {
                try await context.git.stage(paths: paths)
            } catch {
                reviewQueue.message = "Could not keep the changes: \(error.localizedDescription)"
                return false
            }
        }
        acceptAll()
        await refreshWorkspacePanels()
        return true
    }

    func isHunkKept(path: String, hunk: DiffHunk) -> Bool {
        reviewQueue.keptHunks.contains(Self.keptKey(path, hunk)) || isHunkAccepted(path: path, hunk: hunk)
    }

    private static func keptKey(_ path: String, _ hunk: DiffHunk) -> String {
        "\(path)\u{1f}\(hunk.reviewIdentifier)"
    }

    // MARK: Scopes

    /// Loads the files of a review scope. The session's own scope is the
    /// tracked changes; the others read Git or the last turn's snapshots.
    func loadReviewScope(_ scope: ReviewScope) async {
        reviewQueue.scope = scope
        guard scope != .session else {
            reviewQueue.scopedFiles = []
            return
        }
        guard let context = live?.context else {
            reviewQueue.scopedFiles = []
            reviewQueue.message = Self.noProjectMessage("review its changes")
            return
        }
        reviewQueue.isLoadingScope = true
        defer { reviewQueue.isLoadingScope = false }
        do {
            reviewQueue.scopedFiles = try await scopedReviewFiles(scope, context: context)
            reviewQueue.message = nil
        } catch {
            reviewQueue.scopedFiles = []
            reviewQueue.message = (error as? LocalizedError)?.errorDescription ?? "Could not load \(scope.title): \(error)"
        }
    }

    private func scopedReviewFiles(_ scope: ReviewScope, context: WorkspaceContext) async throws -> [ScopedReviewFile] {
        let gitScope: GitReviewScope
        switch scope {
        case .session:
            return []
        case .lastTurn:
            var files: [ScopedReviewFile] = []
            for change in await context.turnCheckpoints.lastTurnChanges(sessionID: sessionID) {
                let before = change.before.map { String(decoding: $0, as: UTF8.self) }
                let url = try? context.access.resolveForReading(change.path)
                let after = url.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
                let diff = try DiffEngine.diff(old: before ?? "", new: after ?? "")
                let status = before == nil ? "A" : (after == nil ? "D" : "M")
                files.append(ScopedReviewFile(path: change.path.value, status: status, diff: diff))
            }
            return files
        case .uncommitted: gitScope = .uncommitted
        case .staged: gitScope = .staged
        case .branch: gitScope = .branch
        }
        return try await context.git.scopedFiles(gitScope).map { file in
            ScopedReviewFile(
                path: file.path,
                status: file.status,
                diff: (try? DiffEngine.diff(old: file.old ?? "", new: file.new ?? ""))
                    ?? TextDiff(hunks: [], linesAdded: 0, linesRemoved: 0)
            )
        }
    }

    // MARK: Findings

    /// The latest review's findings, not dismissed, most serious first.
    var inlineFindings: [InlineFinding] {
        ReviewFindingsProjection.findings(in: events, dismissed: reviewQueue.dismissedFindings)
    }

    /// Fix this: queues the finding as a comment on its line.
    func fixFinding(_ finding: InlineFinding, quotedLine: String? = nil) {
        if !reviewQueue.isBound { bindShipState() }
        reviewQueue.add(ReviewFindingsProjection.comment(for: finding, quotedLine: quotedLine))
        reviewQueue.dismiss(finding)
    }

    // MARK: Pull request and CI

    /// Links the current branch's pull request and watches its CI.
    @discardableResult
    func linkPullRequest() async -> Bool {
        guard let context = live?.context, context.record.descriptor.isGitRepository else {
            reviewQueue.message = "Open a Git repository to follow a pull request."
            return false
        }
        if !reviewQueue.isBound { bindShipState() }
        let client = GitHubCIClient(executor: context.executor)
        do {
            let ref = try await client.pullRequest()
            reviewQueue.sessionActions?.recordPullRequest(ref.url)
            await reviewQueue.pullRequest.watch(ref, reader: client)
            return true
        } catch {
            reviewQueue.message = (error as? LocalizedError)?.errorDescription ?? "Could not find the pull request: \(error)"
            return false
        }
    }

    /// Opens the pull request, then follows its CI.
    @discardableResult
    func createPullRequestAndWatch(_ draft: PullRequestDraft) async -> String? {
        guard let url = await createPullRequest(draft) else { return nil }
        reviewQueue.sessionActions?.recordPullRequest(url)
        _ = await linkPullRequest()
        return url
    }

    /// Picks the CI watch back up for a pull request linked before a
    /// relaunch, when its checks had not all settled.
    func resumeCIWatch() async {
        if !reviewQueue.isBound { bindShipState() }
        let pullRequest = reviewQueue.pullRequest
        guard let ref = pullRequest.pullRequest, !pullRequest.isWatching, !ref.isFinished,
              let context = live?.context
        else { return }
        await pullRequest.watch(ref, reader: GitHubCIClient(executor: context.executor))
    }

    // MARK: Rewind and fork

    /// What a rewind to `turnID` cannot put back: files commands changed in
    /// the turns it removes, which no checkpoint holds. Nil when those turns
    /// ran no command.
    func rewindShellWarning(for turnID: String) -> String? {
        guard let start = events.firstIndex(where: { $0.id == turnID }) else { return nil }
        let commandTools: Set<String> = ["run_command", "run_tests", "run_checks", "shell", "shell_start", "shell_write"]
        var commands: [String] = []
        var untrackedChanges = 0
        for event in events[start...] {
            switch event.payload {
            case let .toolProposed(proposed) where commandTools.contains(proposed.toolName):
                let command = proposed.input["command"]?.stringValue ?? proposed.summary
                if !commands.contains(command) { commands.append(command) }
            case let .fileChanged(change) where change.checkpointID == nil:
                untrackedChanges += 1
            default:
                continue
            }
        }
        guard !commands.isEmpty || untrackedChanges > 0 else { return nil }
        var sentence: String
        if let first = commands.first {
            let more = commands.count - 1
            sentence = "These turns ran `\(first)`"
            if more > 0 { sentence += more == 1 ? " and 1 more command" : " and \(more) more commands" }
            sentence += ". Files those commands changed are not restored."
        } else {
            sentence = "These turns changed files outside Juno's edit tools. Those files are not restored."
        }
        return sentence
    }

    /// Forks the session from one of the reader's messages into a new
    /// session, optionally in a worktree of its own. The original stays as
    /// it is.
    @discardableResult
    func fork(throughTurn turnID: String?, inNewWorktree: Bool) async -> CodeSession? {
        guard let actions = reviewQueue.sessionActions else {
            reviewQueue.message = "Forking needs the session's workbench."
            return nil
        }
        return await actions.fork(turnID, inNewWorktree)
    }
}
