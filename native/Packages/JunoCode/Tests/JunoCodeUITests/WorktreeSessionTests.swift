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
        XCTAssertTrue(steps[0].command.contains("commit"))
        XCTAssertTrue(steps[1].command.hasPrefix("git merge --no-ff --no-edit juno/"))

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
}
