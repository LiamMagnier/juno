import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

final class PermissionRuleAuthorizationTests: XCTestCase {
    func testAllowRuleSkipsTheAskButNeverADestructiveOne() {
        let allow = PermissionRuleDecision.allow(PermissionRule(tool: "Bash"))
        XCTAssertEqual(
            PermissionCoordinator.ruling(mode: .askBeforeChanges, risk: .critical, approvalPolicy: .byRisk, rule: allow),
            .allow
        )
        XCTAssertEqual(
            PermissionCoordinator.ruling(mode: .fullAccess, risk: .destructive, approvalPolicy: .byRisk, rule: allow),
            .requireApproval
        )
        // A pinned tool is what an allow rule exists to opt out of.
        XCTAssertEqual(
            PermissionCoordinator.ruling(mode: .fullAccess, risk: .critical, approvalPolicy: .alwaysRequiresApproval, rule: allow),
            .allow
        )
        // Read-only still refuses: a rule cannot buy authority the mode withholds.
        if case .deny = PermissionCoordinator.ruling(mode: .readOnly, risk: .write, approvalPolicy: .byRisk, rule: allow) {
        } else {
            XCTFail("read-only must refuse writes whatever the rules say")
        }
    }

    func testAskRulePromptsEvenInFullAccess() {
        XCTAssertEqual(
            PermissionCoordinator.ruling(
                mode: .fullAccess,
                risk: .critical,
                approvalPolicy: .byRisk,
                rule: .ask(PermissionRule(tool: "Bash", specifier: "git push *"))
            ),
            .requireApproval
        )
    }

    func testDenyRuleRefusesInEveryMode() {
        for mode in PermissionMode.allCases {
            if case .deny = PermissionCoordinator.ruling(
                mode: mode,
                risk: .read,
                approvalPolicy: .byRisk,
                rule: .deny(PermissionRule(tool: "Read", specifier: ".env"))
            ) {
            } else {
                XCTFail("\(mode) must refuse a denied read")
            }
        }
    }

    func testCoordinatorOffersTheRuleAnAlwaysAllowWouldSave() async {
        let coordinator = PermissionCoordinator(sessionID: CodeSessionID(), mode: .askBeforeChanges)
        let requested = expectation(description: "approval requested")
        nonisolated(unsafe) var suggestion: PermissionRule?
        nonisolated(unsafe) var id: String?
        await coordinator.addObserver { update in
            if case let .requested(request) = update {
                suggestion = request.suggestedRule
                id = request.id
                requested.fulfill()
            }
        }
        async let outcome = coordinator.authorize(
            toolName: "run_command",
            actionDigest: "d",
            risk: .execute,
            summary: "Run npm run lint",
            subject: .command("npm run lint")
        )
        await fulfillment(of: [requested], timeout: 2)
        XCTAssertEqual(suggestion, PermissionRule(tool: "Bash", specifier: "npm run *"))
        await coordinator.resolve(approvalID: id ?? "", decision: .approved)
        if case .approved = await outcome {} else { XCTFail("expected approval") }

        await coordinator.addAllowRule(PermissionRule(tool: "Bash", specifier: "npm run *"))
        let second = await coordinator.authorize(
            toolName: "run_command",
            actionDigest: "d2",
            risk: .execute,
            summary: "Run npm run test",
            subject: .command("npm run test")
        )
        XCTAssertEqual(second, .allowed)
    }

    func testMCPNamesStayWithinProviderLimits() {
        XCTAssertEqual(MCPCodeTool.maximumNameLength, 64)
    }
}

final class WebFetchToolTests: XCTestCase {
    func testHTMLBecomesReadableText() {
        let html = """
        <html><head><title>x</title><style>p{}</style></head><body>
        <script>alert(1)</script><h1>Release notes</h1><p>Fixed &amp; improved.</p>
        <ul><li>One</li><li>Two</li></ul></body></html>
        """
        let text = WebFetchTool.text(fromHTML: html)
        XCTAssertTrue(text.contains("Release notes"))
        XCTAssertTrue(text.contains("Fixed & improved."))
        XCTAssertTrue(text.contains("• One"))
        XCTAssertFalse(text.contains("alert"))
        XCTAssertFalse(text.contains("<"))
    }

    func testOnlyWebURLsAreAccepted() {
        let tool = WebFetchTool()
        XCTAssertNil(tool.precheck(input: ["url": "https://developer.apple.com/documentation"]))
        XCTAssertNotNil(tool.precheck(input: ["url": "file:///etc/passwd"]))
        XCTAssertNotNil(tool.precheck(input: ["url": "not a url"]))
        XCTAssertEqual(tool.assessRisk(input: [:]), .critical)
        XCTAssertEqual(
            ToolRuleSubjects.subject(toolName: "web_fetch", input: ["url": "https://docs.swift.org/x"]),
            .domain("docs.swift.org")
        )
    }
}
