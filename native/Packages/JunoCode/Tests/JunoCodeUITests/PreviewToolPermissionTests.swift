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

    private func services(_ permissions: PermissionCoordinator? = nil, approvals: PreviewConfigApprovals = PreviewConfigApprovals()) -> PreviewToolServices {
        PreviewToolServices(
            workspaceRoot: root,
            permissions: permissions,
            approvals: approvals,
            settings: PreviewLocalSettings(fileURL: root.appendingPathComponent("settings.json"))
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
        PreviewRefLabels.shared.remember("""
        [e1] button "Delete project" (10,10 120×28)
        [e2] button "Open menu" (10,50 90×28)
        """)
        let tool = PreviewBrowserTool(services: services())
        XCTAssertEqual(tool.assessRisk(input: ["action": "click", "ref": "e1"]), .destructive)
        XCTAssertEqual(tool.assessRisk(input: ["action": "click", "ref": "e2"]), .execute)
        XCTAssertEqual(tool.summary(input: ["action": "click", "ref": "e1"]), "Click \"Delete project\" (button) in the local Preview")
        XCTAssertEqual(tool.assessRisk(input: ["action": "type", "ref": "e2", "secret": "admin"]), .destructive)
        XCTAssertEqual(tool.assessRisk(input: ["action": "type", "ref": "e2", "text": "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"]), .destructive)
        XCTAssertEqual(
            tool.assessRisk(input: ["action": "batch", "actions": [["action": "snapshot"], ["action": "click", "ref": "e1"]]]),
            .destructive
        )
        PreviewDialogMirror.shared.set("Delete this project forever?")
        XCTAssertEqual(tool.assessRisk(input: ["action": "dialog", "answer": "accept"]), .destructive)
        XCTAssertEqual(tool.assessRisk(input: ["action": "dialog", "answer": "dismiss"]), .execute)
        PreviewDialogMirror.shared.set(nil)

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
        let tool = PreviewServerTool(services: services(permissions, approvals: approvals))
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
