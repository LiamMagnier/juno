import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Sessions in a worktree of their own (CODE_AGENT_SPEC §5.7):
/// `.juno/worktree.json` includes and setup, bringing changes back one asked
/// step at a time, and removal at archive.
@MainActor
final class WorktreeSessionTests: XCTestCase {
    private func fixture() async throws -> ShipFixture {
        try await ShipFixture.make(
            model: ShipScriptedModel([]),
            git: true,
            files: [
                "notes.txt": "hello\n",
                ".gitignore": ".env.local\n",
                ".juno/worktree.json": #"{ "include": [".env.local"], "setup": "touch setup-ran.txt" }"#,
            ]
        )
    }

    func testIncludeCopiesAndSetupWaitsForItsBytesToBeApproved() async throws {
        let fixture = try await fixture()
        defer { fixture.remove() }
        try "SECRET=local\n".write(to: fixture.workspace.appendingPathComponent(".env.local"), atomically: true, encoding: .utf8)

        let (session, _) = try await fixture.session(isolated: true)
        let root = try XCTUnwrap(session.executionRootPath)
        XCTAssertEqual(
            try String(contentsOfFile: root + "/.env.local", encoding: .utf8),
            "SECRET=local\n",
            "include copies the ignored file into the new worktree"
        )
        XCTAssertEqual(fixture.workbench.worktreeSetupPending[session.id], "touch setup-ran.txt")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root + "/setup-ran.txt"), "setup does not run unapproved")

        let ran = await fixture.workbench.approveAndRunWorktreeSetup(
            "touch setup-ran.txt",
            for: session.id,
            approvals: fixture.workbench.worktreeSetupApprovals
        )
        XCTAssertEqual(ran, .done)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root + "/setup-ran.txt"), "approved, it runs in the worktree")
        XCTAssertNil(fixture.workbench.worktreeSetupPending[session.id])

        let approvals = fixture.workbench.worktreeSetupApprovals
        XCTAssertTrue(approvals.isApproved("touch setup-ran.txt", workspace: fixture.workspace))
        XCTAssertFalse(
            approvals.isApproved("touch setup-ran.txt && curl example.com", workspace: fixture.workspace),
            "edited bytes ask again"
        )
        let info = await fixture.workbench.worktreeInfo(for: session.id)
        XCTAssertEqual(info?.branch, session.gitBranch)
        XCTAssertTrue(info?.headline.hasPrefix("Working in `") ?? false)
        XCTAssertTrue(info?.headline.contains("from `main`") ?? false, info?.headline ?? "")
    }

    func testBringingChangesBackAsksOneStepAtATime() async throws {
        let fixture = try await fixture()
        defer { fixture.remove() }
        let (session, _) = try await fixture.session(isolated: true)
        let root = URL(fileURLWithPath: try XCTUnwrap(session.executionRootPath), isDirectory: true)
        try "changed in the worktree\n".write(to: root.appendingPathComponent("notes.txt"), atomically: true, encoding: .utf8)

        let planned = await fixture.workbench.bringBackPlan(for: session.id)
        let steps = try planned.get()
        XCTAssertEqual(steps.count, 2, "commit, then merge")
        guard case .commit = steps[0].kind, case .merge = steps[1].kind else {
            return XCTFail("unexpected steps \(steps)")
        }
        // Each confirmation shows exactly what its step runs.
        XCTAssertTrue(steps[0].command.contains(" add -A -- . && git -C "), steps[0].command)
        XCTAssertTrue(steps[0].command.contains(" commit -m "), steps[0].command)
        XCTAssertFalse(steps[0].command.contains("commit -am"), "the step adds new files too, and says so")
        XCTAssertTrue(steps[1].command.hasPrefix("git -C "), steps[1].command)
        XCTAssertTrue(steps[1].command.contains(" merge --no-ff --no-edit juno/"), steps[1].command)

        let committed = await fixture.workbench.performBringBack(steps[0], for: session.id)
        XCTAssertEqual(committed, .done)
        XCTAssertEqual(try fixture.read("notes.txt"), "hello\n", "nothing reaches the open branch until the merge step is confirmed")

        let merged = await fixture.workbench.performBringBack(steps[1], for: session.id)
        XCTAssertEqual(merged, .done)
        XCTAssertEqual(try fixture.read("notes.txt"), "changed in the worktree\n")
        let after = try await fixture.workbench.bringBackPlan(for: session.id).get()
        XCTAssertTrue(after.isEmpty || after.allSatisfy { if case .merge = $0.kind { return true } else { return false } })
    }

    func testArchiveRemovesACleanWorktreeAndKeepsADirtyOne() async throws {
        let fixture = try await fixture()
        defer { fixture.remove() }
        let (clean, _) = try await fixture.session(isolated: true)
        let cleanRoot = try XCTUnwrap(clean.executionRootPath)
        let archived = await fixture.workbench.archive(clean.id)
        XCTAssertEqual(archived, .done)
        XCTAssertFalse(FileManager.default.fileExists(atPath: cleanRoot), "the owner's rule: remove worktrees after use")
        XCTAssertTrue(fixture.workbench.isArchived(clean.id))
        XCTAssertFalse(fixture.workbench.filteredSessions.contains { $0.id == clean.id }, "archived sessions leave the list")
        XCTAssertTrue(fixture.workbench.archivedSessions.contains { $0.id == clean.id })

        let (dirty, _) = try await fixture.session(isolated: true)
        let dirtyRoot = try XCTUnwrap(dirty.executionRootPath)
        try "work in progress\n".write(toFile: dirtyRoot + "/notes.txt", atomically: true, encoding: .utf8)
        let kept = await fixture.workbench.archive(dirty.id)
        guard case .refused = kept else { return XCTFail("a worktree with changes is kept, and said so") }
        XCTAssertTrue(FileManager.default.fileExists(atPath: dirtyRoot))

        fixture.workbench.unarchive(clean.id)
        XCTAssertFalse(fixture.workbench.isArchived(clean.id))
    }

    func testASessionWhosePullRequestMergedOrClosedIsArchivedWithItsWorktree() async throws {
        let fixture = try await fixture()
        defer { fixture.remove() }
        let (merged, _) = try await fixture.session(isolated: true)
        let mergedRoot = try XCTUnwrap(merged.executionRootPath)
        let (closed, _) = try await fixture.session()
        let (open, _) = try await fixture.session(isolated: true)
        let (closedWithWork, _) = try await fixture.session(isolated: true)
        let workRoot = try XCTUnwrap(closedWithWork.executionRootPath)
        try "not brought back yet\n".write(toFile: workRoot + "/notes.txt", atomically: true, encoding: .utf8)
        let (inView, _) = try await fixture.session()
        let (unlinked, _) = try await fixture.session()

        let workbench = fixture.workbench
        let states = [
            merged.id: "MERGED", closed.id: "CLOSED", open.id: "OPEN",
            closedWithWork.id: "CLOSED", inView.id: "MERGED",
        ]
        for (index, id) in [merged.id, closed.id, open.id, closedWithWork.id, inView.id].enumerated() {
            workbench.recordPullRequest("https://github.com/o/r/pull/\(index + 1)", for: id)
        }
        let asked = AskedSessions()
        workbench.pullRequestStateReader = { session, url in
            asked.ids.append(session.id)
            return GitHubPullRequestRef(number: 1, url: url, state: states[session.id] ?? "OPEN")
        }
        workbench.selectedSessionID = inView.id

        let archived = await workbench.archiveFinishedPullRequests()
        XCTAssertEqual(Set(archived), [merged.id, closed.id])
        XCTAssertTrue(workbench.isArchived(merged.id))
        XCTAssertFalse(FileManager.default.fileExists(atPath: mergedRoot), "its worktree goes with it")
        XCTAssertTrue(workbench.isArchived(closed.id), "a closed one is archived too")
        XCTAssertFalse(workbench.isArchived(open.id), "an open pull request keeps its session")
        XCTAssertFalse(workbench.isArchived(closedWithWork.id), "a worktree with changes keeps its session")
        XCTAssertTrue(FileManager.default.fileExists(atPath: workRoot))
        XCTAssertFalse(workbench.isArchived(inView.id), "the session the reader has open stays")
        XCTAssertFalse(asked.ids.contains(unlinked.id), "a session with no pull request is not asked about")
        XCTAssertFalse(asked.ids.contains(inView.id))

        asked.ids = []
        _ = await workbench.archiveFinishedPullRequests()
        XCTAssertFalse(asked.ids.contains(merged.id), "an archived session is not asked about again")
    }

    @MainActor
    private final class AskedSessions {
        var ids: [CodeSessionID] = []
    }

    func testOnlyAGitHubPullRequestLinkIsLookedUp() {
        XCTAssertTrue(GitHubCIClient.isPullRequestURL("https://github.com/o/r/pull/42"))
        XCTAssertFalse(GitHubCIClient.isPullRequestURL("https://github.com/o/r/pull/42?x=1"))
        XCTAssertFalse(GitHubCIClient.isPullRequestURL("http://github.com/o/r/pull/42"))
        XCTAssertFalse(GitHubCIClient.isPullRequestURL("https://github.com/o/r/issues/42"))
        XCTAssertFalse(GitHubCIClient.isPullRequestURL("--repo=x"))
    }
}
