import Foundation
import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime
@testable import JunoCodeUI

/// §4.4's deterministic permissions for the Preview's tools, and the safety
/// invariants around them: the always-confirm floor is never silenced by Full
/// Access, rules or hooks; approvals bind the configuration's bytes; a
/// read-only session starts nothing; eval stays off until the reader allows it.
final class PreviewToolPermissionTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-preview-perm-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".juno"), withIntermediateDirectories: true)
        try writeLaunch(args: ["run", "dev"])
    }

    override func tearDownWithError() throws {
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    private func writeLaunch(args: [String]) throws {
        let quoted = args.map { "\"\($0)\"" }.joined(separator: ", ")
        try #"{ "configurations": [ { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": [\#(quoted)], "cwd": "." } ] }"#
            .write(to: root.appendingPathComponent(".juno/launch.json"), atomically: true, encoding: .utf8)
    }

    private func services(
        _ permissions: PermissionCoordinator? = nil,
        session: CodeSessionID? = nil,
        approvals: PreviewConfigApprovals = PreviewConfigApprovals(),
        labels: PreviewRefLabels = PreviewRefLabels()
    ) -> PreviewToolServices {
        PreviewToolServices(
            workspaceRoot: root,
            sessionID: session,
            permissions: permissions,
            approvals: approvals,
            settings: PreviewLocalSettings(fileURL: root.appendingPathComponent("settings.json")),
            labels: labels
        )
    }

    func testReadsAreReadsAndInputIsExecute() {
        let tool = PreviewBrowserTool(services: services())
        for action in ["snapshot", "find", "text", "console", "network", "screenshot", "resize", "navigate", "wait_for"] {
            var input: JSONValue = ["action": .string(action)]
            if action == "find" { input = ["action": "find", "query": "save"] }
            if action == "navigate" { input = ["action": "navigate", "path": "/settings"] }
            XCTAssertEqual(tool.assessRisk(input: input), .read, action)
        }
        XCTAssertEqual(tool.assessRisk(input: ["action": "hover", "ref": "e2"]), .execute)
        XCTAssertEqual(tool.assessRisk(input: ["action": "key", "chord": "Escape"]), .execute)
        XCTAssertEqual(tool.assessRisk(input: ["action": "upload", "ref": "e2", "path": "a.png"]), .write)
    }

    /// The floor: a seen Delete, a credential, accepting a destructive
    /// question — `.destructive`, which no mode, rule or hook silences.
    func testTheFloorIsDestructiveAndNeverSilenced() throws {
        let labels = PreviewRefLabels()
        labels.remember("""
        [e1] button "Delete project" (10,10 120×28)
        [e2] button "Open menu" (10,50 90×28)
        """)
        let tool = PreviewBrowserTool(services: services(labels: labels))
        XCTAssertEqual(tool.assessRisk(input: ["action": "click", "ref": "e1"]), .destructive)
        XCTAssertEqual(tool.assessRisk(input: ["action": "click", "ref": "e2"]), .execute)
        XCTAssertEqual(tool.summary(input: ["action": "click", "ref": "e1"]), "Click \"Delete project\" (button) in the local Preview")
        XCTAssertEqual(tool.assessRisk(input: ["action": "type", "ref": "e2", "secret": "admin"]), .destructive)
        // Assembled at run time, so the tracked-secret scan never sees a
        // token-shaped literal in this file.
        let token = "ghp" + "_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        XCTAssertEqual(tool.assessRisk(input: ["action": "type", "ref": "e2", "text": .string(token)]), .destructive)
        XCTAssertEqual(
            tool.assessRisk(input: ["action": "batch", "actions": [["action": "snapshot"], ["action": "click", "ref": "e1"]]]),
            .destructive
        )
        let pageKey = PreviewKey(checkoutRoot: root, name: "web")
        PreviewDialogMirror.shared.set("Delete this project forever?", for: pageKey)
        XCTAssertEqual(tool.assessRisk(input: ["action": "dialog", "answer": "accept"]), .destructive)
        XCTAssertEqual(tool.assessRisk(input: ["action": "dialog", "answer": "dismiss"]), .execute)
        PreviewDialogMirror.shared.set(nil, for: pageKey)

        let allowAll = PermissionRule(tool: "preview_browser")
        XCTAssertEqual(
            PermissionCoordinator.ruling(mode: .fullAccess, risk: .destructive, approvalPolicy: .byRisk, rule: .allow(allowAll)),
            .requireApproval,
            "Full Access with an allow rule still asks"
        )
        XCTAssertEqual(
            PermissionCoordinator.ruling(mode: .fullAccess, risk: .destructive, approvalPolicy: .byRisk, rule: nil, hook: .allow, toolName: "preview_browser"),
            .requireApproval,
            "a hook's allow never silences it"
        )
        XCTAssertEqual(PermissionPolicy.ruling(mode: .readOnly, risk: .destructive), .deny(reason: "The session is read-only."))
    }

    /// In a Full Access session with an allow rule for the tool, a floor
    /// action still waits for the reader, and no "Always allow" is offered.
    func testAFloorActionWaitsForTheReaderInFullAccess() async throws {
        let session = CodeSessionID(value: "floor-\(UUID().uuidString)")
        let permissions = PermissionCoordinator(sessionID: session, mode: .fullAccess)
        await permissions.addAllowRule(PermissionRule(tool: "preview_browser"))
        let authorization = Task {
            await permissions.authorize(toolName: "preview_browser", actionDigest: "d", risk: .destructive, summary: "Click \"Delete project\" (button)")
        }
        var pending: [ApprovalRequest] = []
        for _ in 0..<100 where pending.isEmpty {
            pending = await permissions.pendingApprovals
            if pending.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        }
        let request = try XCTUnwrap(pending.first, "the reader is asked")
        XCTAssertNil(request.suggestedRule, "no Always allow for the floor")
        await permissions.resolve(approvalID: request.id, decision: .denied)
        let outcome = await authorization.value
        XCTAssertEqual(outcome, .denied(reason: "The user declined this action."))
    }

    func testFloorWordsMatchOnWordBoundaries() {
        XCTAssertEqual(PreviewConsequentialActions.match("\"Send invoice\" (button)"), "send")
        XCTAssertEqual(PreviewConsequentialActions.match("\"Supprimer\" (button)"), "supprimer")
        XCTAssertEqual(PreviewConsequentialActions.match("\"Sign in\" (button)"), "sign in")
        XCTAssertNil(PreviewConsequentialActions.match("\"Blog posts\" (link)"))
        XCTAssertNil(PreviewConsequentialActions.match("\"Open menu\" (button)"))
        XCTAssertNil(PreviewConsequentialActions.match("\"Resend\" (button)"), "a floor word inside another word is not a match")
    }

    func testEvalIsOffUntilEnabledAndThenAlwaysAsks() {
        let settings = PreviewLocalSettings(fileURL: root.appendingPathComponent("settings.json"))
        let tool = PreviewBrowserTool(services: PreviewToolServices(workspaceRoot: root, settings: settings))
        XCTAssertEqual(tool.assessRisk(input: ["action": "eval", "js": "document.title"]), .destructive)
        XCTAssertNotNil(tool.precheck(input: ["action": "eval", "js": "document.title"]))
        settings.update(root) { $0.allowEval = true }
        XCTAssertNil(tool.precheck(input: ["action": "eval", "js": "document.title"]))
        XCTAssertEqual(tool.assessRisk(input: ["action": "eval", "js": "document.title"]), .destructive)
    }

    /// A new configuration is `.critical`; once the reader approves its start
    /// card the same bytes are `.read`; changed bytes ask again.
    func testAnApprovedStartCoversTheBytesNotTheTool() async throws {
        let session = CodeSessionID(value: "perm-\(UUID().uuidString)")
        let permissions = PermissionCoordinator(sessionID: session, mode: .workspaceWrite)
        let approvals = PreviewConfigApprovals()
        await approvals.observe(permissions: permissions, sessionID: session)
        let tool = PreviewServerTool(services: services(permissions, session: session, approvals: approvals))
        let input: JSONValue = ["action": "start"]
        XCTAssertEqual(tool.assessRisk(input: input), .critical)
        XCTAssertTrue(tool.summary(input: input).contains("npm run dev"))

        let digest = tool.actionDigest(input: input)
        let authorization = Task {
            await permissions.authorize(
                toolName: "preview_server", actionDigest: digest, risk: .critical, summary: tool.summary(input: input)
            )
        }
        var pending: [ApprovalRequest] = []
        for _ in 0..<100 where pending.isEmpty {
            pending = await permissions.pendingApprovals
            if pending.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        }
        let request = try XCTUnwrap(pending.first)
        await permissions.resolve(approvalID: request.id, decision: .approved)
        _ = await authorization.value

        XCTAssertEqual(tool.assessRisk(input: input), .read, "the approval is for the configuration")
        try writeLaunch(args: ["run", "dev", "--", "--evil"])
        XCTAssertEqual(tool.assessRisk(input: input), .critical, "changed bytes ask again")
    }

    // MARK: - Adversarial review

    /// A press and a release on Delete is a click; a line break typed into a
    /// field is Enter. Both are on the floor like the click and submit.
    func testADragOrALineBreakOnTheFloorIsDestructive() {
        let labels = PreviewRefLabels()
        labels.remember("""
        [e1] button "Delete project" (10,10 120×28)
        [e2] button "Open menu" (10,50 90×28)
        [e3] textbox "Post a comment" (10,90 300×28)
        """)
        let tool = PreviewBrowserTool(services: services(labels: labels))
        XCTAssertEqual(tool.assessRisk(input: ["action": "drag", "ref": "e1", "to_ref": "e1"]), .destructive)
        XCTAssertEqual(tool.assessRisk(input: ["action": "drag", "ref": "e2", "to_ref": "e1"]), .destructive)
        XCTAssertEqual(tool.assessRisk(input: ["action": "drag", "ref": "e2", "to_ref": "e2"]), .execute)
        XCTAssertEqual(tool.assessRisk(input: ["action": "type", "ref": "e3", "text": "hello\n"]), .destructive)
        XCTAssertEqual(tool.assessRisk(input: ["action": "type", "ref": "e3", "text": "hello\r"]), .destructive)
        XCTAssertEqual(tool.assessRisk(input: ["action": "type", "ref": "e3", "text": "hello"]), .execute)
        XCTAssertTrue(tool.summary(input: ["action": "type", "ref": "e3", "text": "hello\n"]).contains("and press Enter"))
        XCTAssertTrue(PreviewInput.isActivationKey("\r"))
        XCTAssertTrue(PreviewInput.isActivationKey("Return"))
        XCTAssertFalse(PreviewInput.isActivationKey("k"))
    }

    /// What `execute` honours is the assessment the reader answered, taken
    /// once, bound to the names the card showed; a later relabel (a newer
    /// snapshot) never turns an ordinary call into an approved press.
    func testAFloorApprovalIsTheAssessmentTheReaderAnswered() {
        let labels = PreviewRefLabels()
        labels.remember(#"[e1] button "Delete project" (10,10 120×28)"#)
        let services = services(labels: labels)
        let tool = PreviewBrowserTool(services: services)
        let click: JSONValue = ["action": "click", "ref": "e1"]
        XCTAssertEqual(tool.assessRisk(input: click), .destructive)
        let approval = services.floorApprovals.take(digest: tool.actionDigest(input: click))
        XCTAssertEqual(approval?.targets["e1"], PreviewRefLabels.Entry(role: "button", name: "Delete project"))
        XCTAssertNil(services.floorApprovals.take(digest: tool.actionDigest(input: click)), "taken once")

        labels.remember(#"[e1] button "Open menu" (10,10 120×28)"#)
        XCTAssertEqual(tool.assessRisk(input: click), .execute)
        labels.remember(#"[e1] button "Delete project" (10,10 120×28)"#)
        XCTAssertNil(
            services.floorApprovals.take(digest: tool.actionDigest(input: click)),
            "assessed as ordinary input, so nothing was approved, whatever the labels say now"
        )
    }

    /// One session's snapshot never relabels another session's refs.
    func testRefLabelsAreTheSessionsOwn() {
        let mine = PreviewRefLabels()
        mine.remember(#"[e1] button "Delete project" (10,10 120×28)"#)
        let theirs = PreviewRefLabels()
        theirs.remember(#"[e1] button "Open menu" (10,10 120×28)"#)
        XCTAssertEqual(PreviewBrowserTool(services: services(labels: mine)).assessRisk(input: ["action": "click", "ref": "e1"]), .destructive)
        XCTAssertEqual(PreviewBrowserTool(services: services(labels: theirs)).assessRisk(input: ["action": "click", "ref": "e1"]), .execute)
    }

    /// A repository-authored `url` points the agent's browser at another
    /// server on this Mac: it is asked about like any configuration, and it
    /// is not a navigation target until approved.
    func testAnAttachConfigurationIsAskedAbout() throws {
        try #"{ "configurations": [ { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"] }, { "name": "admin", "url": "http://127.0.0.1:8384" } ] }"#
            .write(to: root.appendingPathComponent(".juno/launch.json"), atomically: true, encoding: .utf8)
        let services = services(session: CodeSessionID(value: "attach"))
        let tool = PreviewServerTool(services: services)
        XCTAssertEqual(tool.assessRisk(input: ["action": "start", "name": "admin"]), .critical)
        XCTAssertTrue(tool.summary(input: ["action": "start", "name": "admin"]).contains("attach to http://127.0.0.1:8384"))
        let attach = try XCTUnwrap(services.catalog().configuration(named: "admin"))
        XCTAssertFalse(services.isApprovedForThisSession(attach))
    }

    /// A start card approved in one session is that session's; another
    /// session on the same checkout is asked again, and its card never
    /// changes what the first session's approval covers.
    func testAStartApprovalBelongsToItsSession() async throws {
        let first = CodeSessionID(value: "first-\(UUID().uuidString)")
        let second = CodeSessionID(value: "second-\(UUID().uuidString)")
        let permissions = PermissionCoordinator(sessionID: first, mode: .workspaceWrite)
        let approvals = PreviewConfigApprovals()
        await approvals.observe(permissions: permissions, sessionID: first)
        let mine = PreviewServerTool(services: services(permissions, session: first, approvals: approvals))
        let theirs = PreviewServerTool(services: services(session: second, approvals: approvals))
        let input: JSONValue = ["action": "start"]
        let digest = mine.actionDigest(input: input)

        XCTAssertEqual(mine.assessRisk(input: input), .critical)
        let shownToMe = approvals.shownHash(session: first, digest: digest)
        let authorization = Task {
            await permissions.authorize(toolName: "preview_server", actionDigest: digest, risk: .critical, summary: mine.summary(input: input))
        }
        var pending: [ApprovalRequest] = []
        for _ in 0..<100 where pending.isEmpty {
            pending = await permissions.pendingApprovals
            if pending.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        }
        await permissions.resolve(approvalID: try XCTUnwrap(pending.first).id, decision: .approved)
        _ = await authorization.value

        XCTAssertEqual(mine.assessRisk(input: input), .read)
        XCTAssertEqual(theirs.assessRisk(input: input), .critical, "another session is asked again")
        try writeLaunch(args: ["run", "dev", "--", "--other"])
        _ = theirs.assessRisk(input: input)
        XCTAssertEqual(approvals.shownHash(session: first, digest: digest), shownToMe, "their card does not rewrite mine")
    }

    /// With no record of what a card showed, an unapproved start runs nothing.
    func testAStartThatWasNeverShownRunsNothing() async throws {
        let session = CodeSessionID(value: "unseen-\(UUID().uuidString)")
        let tool = PreviewServerTool(services: services(session: session))
        do {
            _ = try await tool.execute(input: ["action": "start"], context: ToolContext(sessionID: session, toolCallID: "c", emitOutput: { _, _ in }))
            XCTFail("an unapproved, unshown start must be refused")
        } catch let error as ToolError {
            guard case let .denied(reason) = error else { return XCTFail("\(error)") }
            XCTAssertTrue(reason.contains("shown for approval"), reason)
        }
    }

    func testAReadOnlySessionStartsNothing() async throws {
        let permissions = PermissionCoordinator(sessionID: CodeSessionID(value: "ro"), mode: .readOnly)
        let tool = PreviewServerTool(services: services(permissions))
        do {
            _ = try await tool.execute(input: ["action": "start"], context: ToolContext(sessionID: CodeSessionID(value: "ro"), toolCallID: "c", emitOutput: { _, _ in }))
            XCTFail("read-only must refuse")
        } catch let error as ToolError {
            XCTAssertEqual(error, .denied(reason: "The session is read-only."))
        }
    }
}
