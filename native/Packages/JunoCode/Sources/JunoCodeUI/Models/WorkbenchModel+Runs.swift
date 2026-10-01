import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

// The Runs list, the answers a reader gives from it, resume after quit, and
// session archive, export and search (CODE_AGENT_SPEC §5.1, §1.12, §5.17).
// Owned by Lane E (review, ship, sessions and away).

/// What an answer from the Runs list or a notification came to.
public enum RunActionResult: Equatable, Sendable {
    case done
    /// Nothing was done, and why, in words.
    case refused(String)
}

public extension WorkbenchModel {
    // MARK: The Runs list

    /// Every session with a run or a goal, grouped by what it needs.
    var runSections: [RunIndexSection] {
        RunIndex.sections(from: runFacts, now: Date())
    }

    /// The Runs list flattened, in group order.
    var runEntries: [RunIndexEntry] {
        runSections.flatMap(\.entries)
    }

    /// "2 working, 1 waiting for you", for the menu bar.
    var runSummaryLine: String? {
        RunIndex.summaryLine(runSections)
    }

    /// Sessions whose run is still open: the quit guard counts these.
    var activeRunCount: Int {
        visibleSessions.filter { $0.status.isActive }.count
    }

    /// The facts the index is built from: every browsable session that is
    /// not archived.
    internal var runFacts: [RunFacts] {
        visibleSessions
            .filter { !runTracker.archived.contains($0.id.value) }
            .map { runTracker.facts(for: $0, project: workspaceName(for: $0.workspaceID)) }
    }

    /// Marks a session read: a finished run leaves Ready for review.
    func markViewed(_ id: CodeSessionID, at date: Date = Date()) {
        runTracker.viewedAt[id.value] = date
        saveRunTracker()
        publishRunIndex()
    }

    internal var runTrackerURL: URL {
        dependencies.storageRootURL.appendingPathComponent("run-index.json")
    }

    internal func saveRunTracker() {
        guard persistsRunIndex else { return }
        runTracker.save(to: runTrackerURL)
    }

    /// Hands the Runs list to whoever watches it (the run monitor).
    internal func publishRunIndex() {
        guard let runIndexObserver else { return }
        runIndexObserver(runEntries)
    }

    // MARK: Answers

    /// Allow once, bound to the digest the row or banner showed. A stale
    /// answer — the approval was decided, or a different action is waiting —
    /// is refused rather than applied.
    func allowOnce(sessionID: CodeSessionID, approvalID: String, digest: String) async -> RunActionResult {
        guard let controller = controllers[sessionID] else {
            return .refused("That run is not loaded. Open the session to answer.")
        }
        return await controller.allowOnce(approvalID: approvalID, digest: digest)
            ? .done
            : .refused("That approval is no longer waiting. Open the session to see where it stands.")
    }

    func decline(sessionID: CodeSessionID, approvalID: String, digest: String) async -> RunActionResult {
        guard let controller = controllers[sessionID] else {
            return .refused("That run is not loaded. Open the session to answer.")
        }
        return await controller.declineApproval(approvalID: approvalID, digest: digest)
            ? .done
            : .refused("That approval is no longer waiting. Open the session to see where it stands.")
    }

    func reply(sessionID: CodeSessionID, questionID: String, text: String) async -> RunActionResult {
        guard let controller = controllers[sessionID] else {
            return .refused("That run is not loaded. Open the session to answer.")
        }
        return await controller.reply(toQuestion: questionID, text: text)
            ? .done
            : .refused("That question is no longer waiting.")
    }

    /// Whether the session's row still offers `action`. A banner or a row
    /// can outlive what it was about.
    internal func offers(_ action: RunRowAction, _ sessionID: CodeSessionID) -> Bool {
        runEntries.first { $0.sessionID == sessionID }?.actions.contains(action) ?? false
    }

    /// Keep going, only while the run still offers it: a banner left from a
    /// step limit the reader already dealt with must not start another run
    /// with nothing to carry on.
    func keepGoing(sessionID: CodeSessionID) async -> RunActionResult {
        guard offers(.keepGoing, sessionID) else {
            return .refused("This run no longer needs Keep going. Open the session to see where it stands.")
        }
        guard let controller = await controller(for: sessionID) else {
            return .refused("The session could not be opened.")
        }
        return await controller.keepGoing() ? .done : .refused("Juno could not carry on: the session is busy.")
    }

    /// Resume after quit.
    func resume(sessionID: CodeSessionID) async -> RunActionResult {
        guard let controller = await controller(for: sessionID) else {
            return .refused("The session could not be opened.")
        }
        guard controller.isInterrupted else { return .refused("This run was not interrupted.") }
        return await controller.resumeInterrupted() ? .done : .refused("Juno could not resume: the session is busy.")
    }

    /// Retry a failed turn: no duplicate message, no clobbered draft. Only
    /// while the run still stands failed: a stale "Retry" banner on a session
    /// that has since finished starts nothing.
    func retry(sessionID: CodeSessionID) async -> RunActionResult {
        guard offers(.retry, sessionID) else {
            return .refused("This run no longer needs a retry. Open the session to see where it stands.")
        }
        guard let controller = await controller(for: sessionID) else {
            return .refused("The session could not be opened.")
        }
        return await controller.resumeRun(note: .retry, origin: .user)
            ? .done
            : .refused("Juno could not retry: the session is busy.")
    }

    /// How long after it was interrupted a run still resumes by itself at
    /// launch. An older one waits for the reader's Resume: carrying on work
    /// from last week unasked is not what the setting promises.
    static let automaticResumeWindow: TimeInterval = 24 * 60 * 60

    /// Resumes recently interrupted runs, for the launch setting (off by
    /// default).
    internal func resumeInterruptedRuns(now: Date = Date()) async {
        for session in visibleSessions where RunIndex.isInterrupted(session)
            && now.timeIntervalSince(session.updatedAt) < Self.automaticResumeWindow
            && !isArchived(session.id)
        {
            _ = await resume(sessionID: session.id)
        }
    }

    // MARK: Screen control, from the menu bar (§1.11, §3.7)

    /// Whether any session has screen control on.
    var isScreenControlActive: Bool {
        controllers.values.contains { $0.computerUseActive }
    }

    /// Stops screen control in every session: the menu bar's Stop.
    func stopAllScreenControl() async {
        for controller in controllers.values where controller.computerUseActive {
            await controller.stopComputerUse()
        }
    }

    // MARK: Archive, export and search (§5.17)

    func isArchived(_ id: CodeSessionID) -> Bool {
        runTracker.archived.contains(id.value)
    }

    /// The archived sessions, newest first.
    var archivedSessions: [CodeSession] {
        visibleSessions.filter { runTracker.archived.contains($0.id.value) }
    }

    /// Archives a session: it leaves the lists and the Runs list but keeps
    /// its transcript. With `removingWorktree`, its own worktree goes too, when
    /// it has no changes left (the owner's "remove worktrees after use").
    ///
    /// - Parameter reportsRefusal: say a refusal in ``lastError``, where the
    ///   sidebar shows it. The pull request sweep keeps quiet: it tries again.
    @discardableResult
    func archive(
        _ id: CodeSessionID,
        removingWorktree: Bool = true,
        reportsRefusal: Bool = true
    ) async -> RunActionResult {
        func refuse(_ reason: String) -> RunActionResult {
            if reportsRefusal { lastError = reason }
            return .refused(reason)
        }
        guard let session = sessions.first(where: { $0.id == id }) else {
            return refuse("That session no longer exists.")
        }
        guard !session.status.isActive else { return refuse("Stop Juno before archiving this session.") }
        if removingWorktree, session.executionRootPath != nil {
            // A worktree with changes is kept, and so is the session: archiving
            // it would hide work that exists nowhere else.
            if case let .refused(reason) = await removeWorktree(of: session) { return refuse(reason) }
        }
        runTracker.archived.insert(id.value)
        saveRunTracker()
        if selectedSessionID == id { selectedSessionID = nil }
        publishRunIndex()
        return .done
    }

    func unarchive(_ id: CodeSessionID) {
        runTracker.archived.remove(id.value)
        saveRunTracker()
        publishRunIndex()
    }

    /// How often linked pull requests are looked at for a merge or a close.
    static let pullRequestSweepInterval: TimeInterval = 30 * 60
    /// Most sessions one sweep asks GitHub about, newest first.
    static let maximumPullRequestChecks = 20

    /// Starts the sweep that archives sessions whose pull request merged or
    /// closed: shortly after launch, then every half hour. Once per
    /// workbench, and never for the preview harness.
    internal func startPullRequestSweep() {
        guard pullRequestSweep == nil, persistsRunIndex else { return }
        let interval = Self.pullRequestSweepInterval
        pullRequestSweep = Task { [weak self] in
            // Out of the way of launch.
            try? await Task.sleep(for: .seconds(15))
            while !Task.isCancelled {
                guard self != nil else { return }
                await self?.archiveFinishedPullRequests()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    /// Archives every session whose pull request merged or closed, with its
    /// worktree (§5.17). A session that is working, the one the reader has
    /// open, or one whose worktree still has changes stays where it is: the
    /// first two are in use, and archiving the last would hide work that
    /// exists nowhere else. Returns the sessions archived.
    @discardableResult
    func archiveFinishedPullRequests() async -> [CodeSessionID] {
        let candidates = visibleSessions
            .filter { session in
                !isArchived(session.id)
                    && !session.status.isActive
                    && session.id != selectedSessionID
                    && runTracker.pullRequests[session.id.value] != nil
            }
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(Self.maximumPullRequestChecks)
        var archivedNow: [CodeSessionID] = []
        for session in candidates {
            guard let url = runTracker.pullRequests[session.id.value],
                  let ref = await pullRequestState(of: session, url: url),
                  ref.isFinished,
                  // Looked at again: the reader may have opened it or sent
                  // it a message while GitHub answered.
                  let current = sessions.first(where: { $0.id == session.id }),
                  !current.status.isActive, current.id != selectedSessionID
            else { continue }
            if case .done = await archive(session.id, removingWorktree: true, reportsRefusal: false) {
                archivedNow.append(session.id)
            }
        }
        return archivedNow
    }

    private func pullRequestState(of session: CodeSession, url: String) async -> GitHubPullRequestRef? {
        if let reader = pullRequestStateReader { return await reader(session, url) }
        guard let workspaceID = session.workspaceID, let context = await context(for: workspaceID) else {
            return nil
        }
        return try? await GitHubCIClient(executor: context.executor).pullRequest(url: url)
    }

    /// Records the pull request a session opened or was linked to.
    func recordPullRequest(_ url: String, for id: CodeSessionID) {
        guard runTracker.pullRequests[id.value] != url else { return }
        runTracker.pullRequests[id.value] = url
        saveRunTracker()
    }

    func pullRequestURL(for id: CodeSessionID) -> String? {
        runTracker.pullRequests[id.value]
    }

    /// Searches every session's transcript for `query` and makes the matches
    /// part of ``filteredSessions``. Titles, projects and pull request links
    /// match at once; this is the slower full-text pass over the record.
    func searchTranscripts(_ query: String) async {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard needle.count >= 3 else {
            transcriptMatches = nil
            return
        }
        let candidates = visibleSessions.map(\.id)
        let store = sessionStore
        var matched: Set<CodeSessionID> = []
        for id in candidates {
            if Task.isCancelled { return }
            guard let url = store.transcriptURL(for: id) else { continue }
            let hit = await Task.detached(priority: .utility) {
                SessionTranscriptSearch.contains(needle, in: url)
            }.value
            if hit { matched.insert(id) }
        }
        transcriptMatches = (needle, matched)
    }

    /// The transcript as Markdown, for the reader to keep or share.
    func exportMarkdown(_ id: CodeSessionID) async -> String? {
        guard let session = sessions.first(where: { $0.id == id }) else { return nil }
        let events = await sessionStore.events(for: id)
        return SessionExport.markdown(
            session: session,
            project: workspaceName(for: session.workspaceID),
            events: events
        )
    }

    /// The transcript as the agent protocol's JSON lines, redacted, for
    /// support.
    func exportProtocolJSON(_ id: CodeSessionID) async -> String? {
        guard sessions.contains(where: { $0.id == id }) else { return nil }
        let events = await sessionStore.events(for: id)
        return SessionExport.protocolJSONLines(events)
    }

    // MARK: Fork (§5.6)

    /// Forks a session at one of the reader's messages (all of it when nil)
    /// into a new session, optionally in a worktree of its own holding the
    /// files as they were at that point. The original is not touched.
    @discardableResult
    func fork(
        _ sourceID: CodeSessionID,
        throughTurn turnID: String?,
        inNewWorktree: Bool = false,
        select: Bool = true
    ) async -> CodeSession? {
        guard let source = sessions.first(where: { $0.id == sourceID }) else { return nil }
        var executionRootPath: String?
        var branch: String?
        if inNewWorktree {
            guard let workspaceID = source.workspaceID,
                  let context = await context(for: workspaceID),
                  context.record.descriptor.isGitRepository
            else {
                lastError = "Only a session in a Git project can fork into its own worktree."
                return nil
            }
            do {
                // From the commit the source's own checkout is on: a source
                // in a worktree of its own may have commits the project's
                // checkout does not, and its uncommitted changes, copied next,
                // are relative to that commit.
                let worktree = try await context.worktrees.create(
                    branch: Self.worktreeBranchName(base: source.gitBranch, prefix: "juno/fork-"),
                    from: await Self.headRevision(of: source, in: context)
                )
                executionRootPath = worktree.rootPath
                branch = worktree.branch
                try await WorktreeSessionSetup.carryFiles(
                    of: source,
                    throughTurn: turnID,
                    events: await sessionStore.events(for: sourceID),
                    from: context,
                    into: URL(fileURLWithPath: worktree.rootPath, isDirectory: true)
                )
            } catch {
                lastError = "Could not create the fork's worktree: \(error.localizedDescription)"
                return nil
            }
        }
        do {
            let fork = try await sessionStore.forkSession(
                sourceID,
                throughTurn: turnID,
                executionRootPath: executionRootPath,
                gitBranch: branch
            )
            if select { selectedSessionID = fork.id }
            lastError = nil
            return fork
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? "Could not fork the session: \(error)"
            return nil
        }
    }

    /// The commit a session's checkout is on, when it runs in a worktree of
    /// its own; nil (the project's `HEAD`) otherwise.
    internal static func headRevision(of session: CodeSession, in context: WorkspaceContext) async -> String? {
        guard let root = session.executionRootPath else { return nil }
        let quoted = "'" + root.replacingOccurrences(of: "'", with: "'\\''") + "'"
        guard let outcome = try? await context.executor.run(
            "git -C \(quoted) rev-parse --verify 'HEAD^{commit}'",
            timeoutSeconds: 30
        ), outcome.result.exitCode == 0 else { return nil }
        let revision = outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return revision.range(of: "^[0-9a-f]{40,64}$", options: .regularExpression) == nil ? nil : revision
    }

    // MARK: Worktrees (§5.7)

    /// Removes a session's own worktree when it holds no changes.
    @discardableResult
    func removeWorktree(of session: CodeSession) async -> RunActionResult {
        guard let rootPath = session.executionRootPath, let workspaceID = session.workspaceID,
              let context = await context(for: workspaceID)
        else { return .done }
        guard let worktree = context.worktrees.worktree(rootPath: rootPath) else {
            return .done
        }
        do {
            try await context.worktrees.remove(worktree)
            return .done
        } catch {
            return .refused(
                "The worktree still has changes, so it was kept. Bring them back or discard them first."
            )
        }
    }
}

/// Whether a transcript file mentions a phrase, read in pieces so a long
/// record is never held whole. Case-insensitive.
enum SessionTranscriptSearch {
    static func contains(_ needle: String, in url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        let target = needle.lowercased()
        var carry = ""
        while let chunk = try? handle.read(upToCount: 256 * 1_024), !chunk.isEmpty {
            let text = carry + String(decoding: chunk, as: UTF8.self).lowercased()
            if text.contains(target) { return true }
            carry = String(text.suffix(target.count))
        }
        return false
    }
}

/// A transcript, written out.
enum SessionExport {
    static func markdown(session: CodeSession, project: String, events: [SessionEvent]) -> String {
        let redactor = SecretRedactor()
        let formatter = ISO8601DateFormatter()
        var lines = [
            "# \(session.title)",
            "",
            "Project: \(project) · Started \(formatter.string(from: session.createdAt))",
        ]
        if let branch = session.gitBranch { lines.append("Branch: `\(branch)`") }
        for event in events {
            switch event.payload {
            case let .userPrompt(prompt):
                lines += ["", "## You", "", prompt.text]
            case let .userInstruction(instruction):
                lines += ["", "## You, while Juno worked", "", instruction.text]
            case let .assistantMessage(message):
                lines += ["", "## Juno", "", message.text]
            case let .toolProposed(proposed):
                lines.append("- \(proposed.summary)")
            case let .fileChanged(change):
                lines.append("- Changed `\(change.path.value)` (+\(change.linesAdded) −\(change.linesRemoved))")
            case let .runOutcome(outcome):
                lines += ["", "_\(RunIndex.endSentence(outcome))_"]
                for check in outcome.checks {
                    lines.append("- Checked: \(check.label) — \(check.passed ? "passed" : "failed")")
                }
            case let .errorOccurred(error):
                lines += ["", "_Error: \(error.message)_"]
            default:
                continue
            }
        }
        return redactor.redact(lines.joined(separator: "\n")) + "\n"
    }

    static func protocolJSONLines(_ events: [SessionEvent]) -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let redactor = SecretRedactor()
        return events
            .map(CodeSessionStoreProtocolAdapter.envelope)
            .compactMap { try? encoder.encode($0) }
            .map { redactor.redact(String(decoding: $0, as: UTF8.self)) }
            .joined(separator: "\n") + "\n"
    }
}
