import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// The verify loop's deterministic half (CODE_AGENT_SPEC §4.6): which edits
/// are UI edits, which routes they touch, how evidence is minted, and rule 8
/// of the stop check with its three-round cap and repeated-failure stop.
final class PreviewVerificationTests: XCTestCase {
    // MARK: - Triggers

    func testWhichEditsAreUIEdits() {
        let roots = ["apps/web"]
        XCTAssertTrue(PreviewUIEdits.isUIEdit("apps/web/src/components/SettingsMenu.tsx", webRoots: roots))
        XCTAssertTrue(PreviewUIEdits.isUIEdit("apps/web/app/globals.css", webRoots: roots))
        XCTAssertTrue(PreviewUIEdits.isUIEdit("apps/web/public/logo.png", webRoots: roots), "anything under public/")
        XCTAssertTrue(PreviewUIEdits.isUIEdit("apps/web/content/post.mdx", webRoots: roots))
        XCTAssertFalse(PreviewUIEdits.isUIEdit("apps/api/src/server.ts", webRoots: roots), "outside the web configuration")
        XCTAssertFalse(PreviewUIEdits.isUIEdit("apps/web/next.config.mjs", webRoots: roots))
        XCTAssertFalse(PreviewUIEdits.isUIEdit("apps/web/src/menu.test.tsx", webRoots: roots))
        XCTAssertFalse(PreviewUIEdits.isUIEdit("apps/web/src/types.d.ts", webRoots: roots))
        XCTAssertFalse(PreviewUIEdits.isUIEdit("apps/web/README.md", webRoots: roots))
        XCTAssertFalse(PreviewUIEdits.isUIEdit("apps/web/node_modules/x/index.js", webRoots: roots))
        XCTAssertTrue(PreviewUIEdits.isUIEdit("index.html", webRoots: ["."]))
        XCTAssertFalse(PreviewUIEdits.isUIEdit("index.html", webRoots: []), "no web configuration, no UI check")
    }

    func testRoutesFromPageFiles() {
        XCTAssertEqual(PreviewUIEdits.route(forFile: "app/(marketing)/settings/page.tsx"), "/settings")
        XCTAssertEqual(PreviewUIEdits.route(forFile: "src/app/page.tsx"), "/")
        XCTAssertEqual(PreviewUIEdits.route(forFile: "src/pages/index.tsx"), "/")
        XCTAssertEqual(PreviewUIEdits.route(forFile: "pages/blog/[slug].tsx"), "/blog/[slug]")
        XCTAssertNil(PreviewUIEdits.route(forFile: "pages/api/users.ts"))
        XCTAssertNil(PreviewUIEdits.route(forFile: "pages/_app.tsx"))
        XCTAssertEqual(PreviewUIEdits.route(forFile: "src/routes/blog/+page.svelte"), "/blog")
        XCTAssertEqual(PreviewUIEdits.route(forFile: "src/pages/about.astro"), "/about")
        XCTAssertNil(PreviewUIEdits.route(forFile: "src/components/SettingsMenu.tsx"))

        XCTAssertEqual(
            PreviewUIEdits.affectedRoutes(for: ["web/app/settings/page.tsx", "web/components/Menu.tsx"], webRoots: ["web"]),
            ["/settings", "/"]
        )
        XCTAssertEqual(
            PreviewUIEdits.affectedRoutes(for: ["web/components/Menu.tsx"], webRoots: ["web"], fallback: ["/settings"]),
            ["/settings"],
            "a component maps to the routes last checked"
        )
    }

    // MARK: - Evidence

    private func observation(
        status: Int? = 200,
        console: [String] = [],
        overlay: String? = nil,
        server: [String] = [],
        screenshot: String? = "hash",
        revision: Int = 3
    ) -> PreviewObservation {
        PreviewObservation(
            route: "/settings", viewport: "desktop", httpStatus: status, newConsoleErrors: console,
            errorOverlay: overlay, newServerErrors: server, screenshotHash: screenshot, workspaceRevision: revision
        )
    }

    func testEvidencePassesOnlyWhenEveryConditionHolds() {
        let passing = PreviewEvidence.mint(observation())
        XCTAssertTrue(passing.passed)
        XCTAssertEqual(passing.surface, .web)
        XCTAssertEqual(passing.target, "/settings")
        XCTAssertEqual(passing.workspaceRevision, 3)
        XCTAssertEqual(passing.screenshotHash, "hash")

        let consoleError = PreviewEvidence.mint(observation(console: ["TypeError: menu is undefined"]))
        XCTAssertFalse(consoleError.passed)
        XCTAssertEqual(consoleError.checks.first { !$0.passed }?.detail, "TypeError: menu is undefined")

        XCTAssertFalse(PreviewEvidence.mint(observation(status: 500)).passed)
        XCTAssertFalse(PreviewEvidence.mint(observation(overlay: "Failed to compile")).passed)
        XCTAssertFalse(PreviewEvidence.mint(observation(server: ["error TS2322: Type 'string'"])).passed)
        XCTAssertFalse(PreviewEvidence.mint(observation(screenshot: nil)).passed, "no screenshot, no evidence")
    }

    // MARK: - Rule 8

    private struct Fixed: CompletionGating {
        let decision: GateDecision
        func evaluate(_: CompletionGateContext) async -> GateDecision { decision }
    }

    private let session = CodeSessionID(value: "preview-gate")

    private func state(autoVerify: Bool = true, roots: [String] = ["web"], live: Bool = true) -> PreviewVerifyState {
        PreviewVerifyState(sessionID: session) {
            PreviewVerifyEnvironment(autoVerify: autoVerify, webRoots: roots, hasLiveServer: live)
        }
    }

    private func changed(_ path: String) -> SessionEventPayload {
        .fileChanged(FileChangedEvent(path: try! WorkspacePath(path), kind: .modified, linesAdded: 1, linesRemoved: 0, checkpointID: nil))
    }

    private func context(files: Set<String>, continuations: [GateReason] = []) -> CompletionGateContext {
        CompletionGateContext(
            sessionID: session, steps: 3, filesChanged: files, testsPassed: nil,
            lastAssistantText: "Done.", continuations: continuations, turnsSinceToolCall: 0
        )
    }

    private func record(passed: Bool, revision: Int, detail: String = "TypeError: menu is undefined") -> UIVerificationRecord {
        PreviewEvidence.mint(observation(console: passed ? [] : [detail], revision: revision))
    }

    func testAUIEditWithoutEvidenceSendsTheAgentBackNamingTheRoute() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        let gate = PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify)
        let decision = await gate.evaluate(context(files: ["web/app/settings/page.tsx"]))
        guard case let .continueWith(reason, detail) = decision else { return XCTFail("\(decision)") }
        XCTAssertEqual(reason, .uiUnchecked)
        XCTAssertTrue(detail.contains("/settings"), detail)
        XCTAssertTrue(detail.contains("preview_browser"), detail)
        XCTAssertLessThan(detail.count, 600)
    }

    func testFreshPassingEvidenceLetsTheRunFinish() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        verify.observe(.uiVerificationRecorded(record(passed: true, revision: verify.workspaceRevision)))
        let gate = PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify)
        let decision = await gate.evaluate(context(files: ["web/app/settings/page.tsx"]))
        XCTAssertEqual(decision, .finish(.doneUnchecked))
    }

    func testEvidenceFromBeforeTheLastUIEditDoesNotCount() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        verify.observe(.uiVerificationRecorded(record(passed: true, revision: verify.workspaceRevision)))
        verify.observe(changed("web/app/settings/page.tsx"))
        let decision = await PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify)
            .evaluate(context(files: ["web/app/settings/page.tsx"]))
        XCTAssertEqual(decision.reason, .uiUnchecked)
    }

    /// A later edit to a test file changes no page: the UI evidence stands.
    func testANonUIEditAfterTheCheckKeepsTheEvidenceFresh() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        verify.observe(.uiVerificationRecorded(record(passed: true, revision: verify.workspaceRevision)))
        verify.observe(changed("web/app/settings/page.test.tsx"))
        let decision = await PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify)
            .evaluate(context(files: ["web/app/settings/page.tsx", "web/app/settings/page.test.tsx"]))
        XCTAssertEqual(decision, .finish(.doneUnchecked))
    }

    func testAFailingCheckSendsTheAgentBackWithTheFailure() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        verify.observe(.uiVerificationRecorded(record(passed: false, revision: verify.workspaceRevision)))
        let decision = await PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify)
            .evaluate(context(files: ["web/app/settings/page.tsx"], continuations: [.uiUnchecked]))
        guard case let .continueWith(_, detail) = decision else { return XCTFail("\(decision)") }
        XCTAssertTrue(detail.contains("failed"), detail)
        XCTAssertTrue(detail.contains("TypeError: menu is undefined"), detail)
    }

    func testTheSameFailureTwiceStopsAsChecksFailing() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        verify.observe(.uiVerificationRecorded(record(passed: false, revision: 1)))
        verify.observe(changed("web/app/settings/page.tsx"))
        verify.observe(.uiVerificationRecorded(record(passed: false, revision: 2)))
        let decision = await PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify)
            .evaluate(context(files: ["web/app/settings/page.tsx"], continuations: [.uiUnchecked, .uiUnchecked]))
        XCTAssertEqual(decision, .finish(.checksFailing))
    }

    func testAtMostThreeRounds() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        let gate = PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify)
        let after3 = await gate.evaluate(context(files: ["web/app/settings/page.tsx"], continuations: [.uiUnchecked, .todosOpen, .uiUnchecked, .uiUnchecked]))
        XCTAssertEqual(after3, .finish(.doneUnchecked), "rounds spent, no failure seen: the base verdict stands")

        verify.observe(.uiVerificationRecorded(record(passed: false, revision: verify.workspaceRevision, detail: "first")))
        let failing = await gate.evaluate(context(files: ["web/app/settings/page.tsx"], continuations: [.uiUnchecked, .uiUnchecked, .uiUnchecked]))
        XCTAssertEqual(failing, .finish(.checksFailing))
    }

    func testNothingFiresWithoutAutoVerifyAWebConfigurationOrAUIEdit() async {
        let edits: Set<String> = ["web/app/settings/page.tsx"]
        for verify in [state(autoVerify: false), state(roots: [])] {
            verify.observe(changed("web/app/settings/page.tsx"))
            let decision = await PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify).evaluate(context(files: edits))
            XCTAssertEqual(decision, .finish(.doneUnchecked))
        }
        let verify = state()
        verify.observe(changed("web/lib/db.sql"))
        let decision = await PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify).evaluate(context(files: ["web/lib/db.sql"]))
        XCTAssertEqual(decision, .finish(.doneUnchecked))
    }

    /// The decorator never overrides the base gate's own continuation or a
    /// failing verdict, and never widens anything: it only adds a look.
    func testTheBaseGateDecidesFirst() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        let todos = await PreviewUIGate(base: Fixed(decision: .continueWith(.todosOpen, detail: "2 open")), advisor: verify)
            .evaluate(context(files: ["web/app/settings/page.tsx"]))
        XCTAssertEqual(todos, .continueWith(.todosOpen, detail: "2 open"))
        let failing = await PreviewUIGate(base: Fixed(decision: .finish(.checksFailing)), advisor: verify)
            .evaluate(context(files: ["web/app/settings/page.tsx"]))
        XCTAssertEqual(failing, .finish(.checksFailing))
        let wait = await PreviewUIGate(base: Fixed(decision: .wait), advisor: verify)
            .evaluate(context(files: ["web/app/settings/page.tsx"]))
        XCTAssertEqual(wait, .wait)
    }

    func testAReaderMessageStartsANewRun() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        verify.observe(.uiVerificationRecorded(record(passed: false, revision: 1)))
        verify.observe(.userPrompt(UserPromptEvent(text: "Now the header")))
        XCTAssertEqual(verify.runRecords, [])
        XCTAssertEqual(verify.runChangedFiles, [])
        XCTAssertEqual(verify.workspaceRevision, 1, "the revision keeps counting across runs")
    }

    // MARK: - Adversarial review

    private func failing(_ revision: Int, viewport: String = "desktop", detail: String = "TypeError: menu is undefined") -> UIVerificationRecord {
        PreviewEvidence.mint(PreviewObservation(
            route: "/settings", viewport: viewport, httpStatus: 200, newConsoleErrors: [detail],
            errorOverlay: nil, newServerErrors: [], screenshotHash: "h", workspaceRevision: revision
        ))
    }

    /// The desktop and phone screenshots of one broken page are one attempt,
    /// not the same failure twice; the repeat is the same failure after a fix.
    func testFailuresWithinOneRevisionAreOneAttempt() {
        XCTAssertFalse(PreviewVerifyPolicy.repeatsFailure([failing(3), failing(3, viewport: "phone")]))
        XCTAssertTrue(PreviewVerifyPolicy.repeatsFailure([failing(3), failing(3, viewport: "phone"), failing(4)]))
        XCTAssertFalse(PreviewVerifyPolicy.repeatsFailure([failing(3), failing(4, detail: "ReferenceError: x")]))
        XCTAssertFalse(
            PreviewVerifyPolicy.repeatsFailure([failing(3), record(passed: true, revision: 4), failing(5)]),
            "a revision that passed breaks the chain"
        )
    }

    /// Two failing screenshots in the first round, then a fix: the agent is
    /// asked to look again, not stopped as if the fix had failed.
    func testAFixAfterOneFailingRoundIsCheckedAgain() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        verify.observe(.uiVerificationRecorded(failing(verify.workspaceRevision)))
        verify.observe(.uiVerificationRecorded(failing(verify.workspaceRevision, viewport: "phone")))
        verify.observe(changed("web/app/settings/page.tsx"))
        let decision = await PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify)
            .evaluate(context(files: ["web/app/settings/page.tsx"], continuations: [.uiUnchecked]))
        XCTAssertEqual(decision.reason, .uiUnchecked)
    }

    func testCheckedRoutesMatchThePageRoutes() {
        XCTAssertTrue(PreviewUIEdits.route("/settings?tab=2", matches: "/settings"))
        XCTAssertTrue(PreviewUIEdits.route("/settings/", matches: "/settings"))
        XCTAssertTrue(PreviewUIEdits.route("/blog/hello", matches: "/blog/[slug]"))
        XCTAssertTrue(PreviewUIEdits.route("/docs/a/b", matches: "/docs/[...path]"))
        XCTAssertTrue(PreviewUIEdits.route("/docs", matches: "/docs/[[...path]]"))
        XCTAssertTrue(PreviewUIEdits.route("/about", matches: "/about.html"), "the static server answers /about for about.html")
        XCTAssertTrue(PreviewUIEdits.route("/index.html", matches: "/"))
        XCTAssertFalse(PreviewUIEdits.route("/", matches: "/settings"))
        XCTAssertFalse(PreviewUIEdits.route("/blog", matches: "/blog/[slug]"))
        XCTAssertFalse(PreviewUIEdits.route("/docs", matches: "/docs/[...path]"))
        XCTAssertFalse(PreviewUIEdits.route("/settings/billing", matches: "/settings"))
    }

    /// A passing look at another route does not cover an edited page: the
    /// evidence has to be of the page that changed.
    func testAPassOnAnotherRouteDoesNotCoverAChangedPage() async {
        let verify = state()
        verify.observe(changed("web/app/settings/page.tsx"))
        let home = PreviewEvidence.mint(PreviewObservation(
            route: "/", viewport: "desktop", httpStatus: 200, newConsoleErrors: [], errorOverlay: nil,
            newServerErrors: [], screenshotHash: "h", workspaceRevision: verify.workspaceRevision
        ))
        verify.observe(.uiVerificationRecorded(home))
        let gate = PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: verify)
        let decision = await gate.evaluate(context(files: ["web/app/settings/page.tsx"]))
        XCTAssertEqual(decision.reason, .uiUnchecked)

        verify.observe(.uiVerificationRecorded(record(passed: true, revision: verify.workspaceRevision)))
        let covered = await gate.evaluate(context(files: ["web/app/settings/page.tsx"]))
        XCTAssertEqual(covered, .finish(.doneUnchecked))

        // A component edit names no page: a pass anywhere counts.
        let component = state()
        component.observe(changed("web/components/Menu.tsx"))
        component.observe(.uiVerificationRecorded(home))
        let anywhere = await PreviewUIGate(base: ReportOnlyCompletionGate(), advisor: component)
            .evaluate(context(files: ["web/components/Menu.tsx"]))
        XCTAssertEqual(anywhere, .finish(.doneUnchecked))
    }

    func testTheNoteAsksToStartTheServerWhenNoneRuns() async {
        let verify = state(live: false)
        verify.observe(changed("web/app/settings/page.tsx"))
        let decision = await verify.decide(for: context(files: ["web/app/settings/page.tsx"]))
        guard case let .continueWith(detail) = decision else { return XCTFail("\(decision)") }
        XCTAssertTrue(detail.contains("preview_server start"), detail)
    }
}

private extension GateDecision {
    var reason: GateReason? {
        if case let .continueWith(reason, _) = self { return reason }
        return nil
    }
}
