import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// The run report's runtime parts come only from the ledger
/// (CODE_AGENT_SPEC §1.10).
final class RunReportBuilderTests: XCTestCase {
    private func record(
        _ command: String,
        passed: Bool,
        at revision: Int,
        kind: CheckKind = .test,
        checkID: String? = nil,
        excerpt: String = ""
    ) -> VerificationRecord {
        VerificationRecord(
            checkID: checkID, command: command, kind: kind, exitCode: passed ? 0 : 1, passed: passed,
            workspaceRevision: revision, durationMs: 9_200, excerpt: excerpt.isEmpty ? (passed ? "passed" : "failed with exit code 1") : excerpt
        )
    }

    private func input(
        _ reason: RunEndReason,
        report: String = "Done: the settings menu opens on click again.",
        evidence: VerificationSnapshot,
        files: Int = 2,
        checksKnown: Bool = true
    ) -> RunReportBuilder.Input {
        RunReportBuilder.Input(
            endReason: reason, modelReport: report, evidence: evidence,
            filesChanged: files, durationSeconds: 252, checksKnown: checksKnown
        )
    }

    func testCheckedRowsComeOnlyFromTheLedger() {
        let model = """
            1. Done: the menu opens again.
            2. What changed: src/menu.tsx:41.
            I ran `npm test` and all 38 tests passed, and `npm run lint` is clean.
            """
        let evidence = VerificationSnapshot(
            workspaceRevision: 3,
            verifications: [record("npm run typecheck", passed: true, at: 3, kind: .typecheck)]
        )
        let outcome = RunReportBuilder.build(input(.doneChecked, report: model, evidence: evidence))
        XCTAssertEqual(outcome.checks.map(\.label), ["npm run typecheck"])
        XCTAssertFalse(outcome.checks.contains { $0.label.contains("npm test") || $0.label.contains("lint") },
                       "a check the model claims but the ledger lacks is not shown as checked")
        XCTAssertEqual(outcome.summary, "Done: the menu opens again.")
        XCTAssertEqual(outcome.verification, "Checked with `npm run typecheck`")
        XCTAssertEqual(outcome.checks.first?.recordID, evidence.verifications.first?.id)
    }

    func testStaleEvidenceSaysNotCheckedSinceTheLastEdit() {
        let evidence = VerificationSnapshot(workspaceRevision: 5, verifications: [record("swift test", passed: true, at: 4)])
        let outcome = RunReportBuilder.build(input(.doneUnchecked, evidence: evidence))
        XCTAssertEqual(outcome.notChecked, ["Not checked since the last edit"])
        XCTAssertEqual(outcome.checks.first?.detail, "passed · 9 s · before the last edit")
        XCTAssertEqual(outcome.verification, "Not checked since the last edit")
        let fresh = RunReportBuilder.build(input(.doneChecked, evidence: VerificationSnapshot(
            workspaceRevision: 5, verifications: [record("swift test", passed: true, at: 5)]
        )))
        XCTAssertTrue(fresh.notChecked.isEmpty)
        XCTAssertEqual(fresh.checks.first?.detail, "passed · 9 s · after the last edit")
    }

    func testAProjectWithNoChecksSaysSo() {
        let outcome = RunReportBuilder.build(input(.doneUnchecked, evidence: VerificationSnapshot(workspaceRevision: 1), checksKnown: false))
        XCTAssertEqual(outcome.verification, "Not checked: no test command for this project")
        XCTAssertEqual(outcome.notChecked, ["Not checked since the last edit"])
        let nothingChanged = RunReportBuilder.build(input(.doneUnchecked, evidence: VerificationSnapshot(), files: 0))
        XCTAssertNil(nothingChanged.verification, "a change that needs no check says nothing about checks")
        XCTAssertTrue(nothingChanged.notChecked.isEmpty)
    }

    func testAFailingCheckIsNamedWithItsCount() {
        let evidence = VerificationSnapshot(workspaceRevision: 2, verifications: [
            record("npm test", passed: false, at: 2, excerpt: "2 of 38 tests failed\nFAIL src/menu.test.tsx"),
        ])
        let outcome = RunReportBuilder.build(input(.checksFailing, evidence: evidence))
        XCTAssertEqual(outcome.verification, "`npm test` still fails (2 tests)")
        XCTAssertEqual(outcome.checks.first?.passed, false)
        XCTAssertEqual(outcome.checks.first?.detail, "failed · 2 of 38 tests failed · 9 s · after the last edit")
    }

    func testOneRowPerCheckWithItsNewestResult() {
        let evidence = VerificationSnapshot(workspaceRevision: 3, verifications: [
            record("npx vitest run a.test.ts", passed: false, at: 2, checkID: "web-test"),
            record("npm run typecheck", passed: true, at: 3, kind: .typecheck, checkID: "web-typecheck"),
            record("npx vitest run a.test.ts", passed: true, at: 3, checkID: "web-test", excerpt: "38 tests passed"),
        ])
        let outcome = RunReportBuilder.build(input(.doneChecked, evidence: evidence))
        XCTAssertEqual(outcome.checks.map(\.label), ["npx vitest run a.test.ts", "npm run typecheck"])
        XCTAssertEqual(outcome.checks.first?.detail, "passed · 38 tests · 9 s · after the last edit")
        XCTAssertEqual(outcome.verification, "Checked with `npm run typecheck` and `npx vitest run a.test.ts`")
    }

    func testUIEvidenceAndTheReviewHaveRowsAndNotesGoInLeft() {
        let evidence = VerificationSnapshot(
            workspaceRevision: 4,
            verifications: [record("npm test", passed: true, at: 4)],
            uiVerifications: [
                UIVerificationRecord(surface: .web, target: "/settings", viewport: "desktop",
                                     checks: [UICheckResult(name: "no new console errors", passed: true), UICheckResult(name: "menu opened", passed: true)],
                                     passed: true, screenshotHash: "a", workspaceRevision: 4),
                UIVerificationRecord(surface: .web, target: "/settings", viewport: "phone",
                                     checks: [UICheckResult(name: "no new console errors", passed: true)],
                                     passed: true, screenshotHash: "b", workspaceRevision: 4),
            ],
            review: ReviewRecord(round: 1, findings: [
                ReviewFinding(priority: .p3, confidence: 0.9, path: "src/menu.tsx", line: 12, title: "Consider removing the unused onOpenChange prop"),
            ], overall: .correct, workspaceRevision: 4)
        )
        let outcome = RunReportBuilder.build(input(.doneChecked, evidence: evidence))
        XCTAssertEqual(outcome.checks.map(\.label), ["npm test", "Preview /settings, desktop and phone", "Review"])
        XCTAssertEqual(outcome.checks[1].detail, "no new console errors · 2 screenshots")
        XCTAssertEqual(outcome.checks[2].detail, "no correctness findings · 1 note")
        XCTAssertEqual(outcome.left, ["Consider removing the unused onOpenChange prop (src/menu.tsx:12) (review, P3)"])
    }

    func testAReviewNoteIsAddedToNotChecked() {
        var request = input(.doneChecked, evidence: VerificationSnapshot(workspaceRevision: 1, verifications: [record("swift test", passed: true, at: 1)]))
        request.reviewNote = "The reviewer's answer could not be read, so no review findings were recorded."
        XCTAssertEqual(RunReportBuilder.build(request).notChecked, [request.reviewNote!])
    }

    func testTheOutcomeSentenceIsTheFirstLineThatSaysSomething() {
        XCTAssertEqual(RunReportBuilder.outcomeSentence(from: "## Outcome:\n**Fixed** the crash on launch.\n- more"), "Fixed the crash on launch.")
        XCTAssertEqual(RunReportBuilder.outcomeSentence(from: "1) Added the setting.\n"), "Added the setting.")
        XCTAssertEqual(RunReportBuilder.outcomeSentence(from: "\n\n"), "Run completed.")
        XCTAssertEqual(RunReportBuilder.outcomeSentence(from: String(repeating: "a", count: 400)).count, 240)
    }

    // MARK: - The <verify> section

    func testTheVerifySectionListsTheChecksAndWhetherTheLastOneStillCounts() {
        let recipe = VerifyRecipe(
            checks: [
                VerifyCheck(id: "web-typecheck", kind: .typecheck, run: .shell("npm run typecheck"), paths: ["src/**"]),
                VerifyCheck(id: "web-test", kind: .test, run: .shell("npm test"), targeted: "npx vitest run {files}", paths: ["src/**"]),
            ],
            ui: [VerifyUITarget(kind: .web, launch: "web", routes: ["/", "/settings"])]
        )
        let evidence = VerificationSnapshot(
            workspaceRevision: 14,
            verifications: [record("npm test", passed: true, at: 12, checkID: "web-test")]
        )
        let section = VerifyStateSection.make(status: .accepted(recipe), evidence: evidence)
        XCTAssertEqual(section.name, "verify")
        XCTAssertEqual(section.body, """
            Checks for this project (from .juno/verify.json):
            - web-typecheck (typecheck): npm run typecheck — paths src/**
            - web-test (test): npx vitest run {files} — paths src/**; full: npm test
            UI: web preview "web", routes / and /settings
            Last check: web-test passed, but files changed since, so it no longer counts.
            """)
        let pending = VerifyStateSection.body(status: .awaitingAcceptance(recipe), evidence: VerificationSnapshot())
        XCTAssertFalse(pending.contains("npm test"), "an unaccepted file's commands are not offered to the model")
    }
}
