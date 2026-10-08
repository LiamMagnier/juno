import Foundation
import XCTest
@testable import JunoCore

/// A notification's route is parsed from a payload another process handed the
/// app, and it selects a screen and names a record to load. Every shape the
/// server writes and every way to fall outside them is pinned here.
final class JunoNotificationRouteTests: XCTestCase {
    func testTheThreeServerPathsParse() {
        XCTAssertEqual(JunoNotificationRoute(path: "/agents/agent_1"), .agent(id: "agent_1"))
        XCTAssertEqual(JunoNotificationRoute(path: "/chat/conv_2"), .conversation(id: "conv_2"))
        XCTAssertEqual(JunoNotificationRoute(path: "/work/session_3"), .workSession(id: "session_3"))
    }

    func testQueryAndFragmentAreIgnored() {
        XCTAssertEqual(JunoNotificationRoute(path: "/work/session_3?tab=log"), .workSession(id: "session_3"))
        XCTAssertEqual(JunoNotificationRoute(path: "/chat/conv_2#message-9"), .conversation(id: "conv_2"))
        XCTAssertEqual(JunoNotificationRoute(path: "  /agents/agent_1  "), .agent(id: "agent_1"))
    }

    func testPathRoundTrips() {
        for route: JunoNotificationRoute in [.agent(id: "a1"), .conversation(id: "c2"), .workSession(id: "s3"), .research(id: "r4")] {
            XCTAssertEqual(JunoNotificationRoute(path: route.path), route)
        }
    }

    func testAnythingElseIsNil() {
        for path in [
            "",
            "/",
            "/agents",
            "/agents/",
            "/agents/a1/extra",
            "/settings/delete-account",
            "/usage",
            "agents/a1",
            "//evil.example/agents/a1",
            "https://evil.example/agents/a1",
            "/\\evil.example",
            "/agents/..",
            "/agents/a%2Fb",
            "/chat/a b",
            "/chat/a\tb",
            "/chat/\(String(repeating: "x", count: 201))",
        ] {
            XCTAssertNil(JunoNotificationRoute(path: path), path)
        }
    }

    /// The research push (`announceFinish` in `stages/context.ts`): its path
    /// names the run, and the conversation rides beside it for older builds.
    func testResearchReadyOpensTheRun() {
        XCTAssertEqual(JunoNotificationRoute(path: "/research/run_7"), .research(id: "run_7"))
        XCTAssertNil(JunoNotificationRoute(path: "/research/run_7/report"))
        XCTAssertNil(JunoNotificationRoute(path: "/research/.."))
        let push = ["path": "/research/run_7", "conversationId": "conv_2", "runId": "run_7", "kind": "work"]
        XCTAssertEqual(JunoNotificationRoute(userInfo: push), .research(id: "run_7"))
    }

    func testUserInfoPrefersPath() {
        let info = [
            "path": "/work/session_3",
            "agentId": "agent_1",
            "conversationId": "conv_2",
            "sessionId": "session_3",
            "kind": "agent",
        ]
        XCTAssertEqual(JunoNotificationRoute(userInfo: info), .workSession(id: "session_3"))
    }

    func testUserInfoFallsBackToIDsInOrder() {
        XCTAssertEqual(
            JunoNotificationRoute(userInfo: ["path": "/settings", "agentId": "agent_1", "conversationId": "conv_2"]),
            .agent(id: "agent_1")
        )
        XCTAssertEqual(
            JunoNotificationRoute(userInfo: ["conversationId": "conv_2", "sessionId": "session_3", "kind": "work"]),
            .conversation(id: "conv_2")
        )
        XCTAssertEqual(
            JunoNotificationRoute(userInfo: ["sessionId": "session_3", "kind": "work"]),
            .workSession(id: "session_3")
        )
    }

    func testCodeApprovalPushIsNotReadAsWork() {
        // `buildCodeApprovalPayload` sends a Code session's id under the same
        // key, with no `kind`; it must not open a Work task by that id.
        let info = ["sessionId": "code_session", "approvalId": "ap_1", "toolName": "bash", "action": "run"]
        XCTAssertNil(JunoNotificationRoute(userInfo: info))
        // Nor do Code's own local notifications, whose keys are spelled differently.
        XCTAssertNil(JunoNotificationRoute(userInfo: ["deviceID": "d1", "sessionID": "s2"]))
    }

    func testUserInfoRejectsUnsafeIDs() {
        XCTAssertNil(JunoNotificationRoute(userInfo: ["agentId": "../admin"]))
        XCTAssertNil(JunoNotificationRoute(userInfo: ["conversationId": "a/b"]))
        XCTAssertNil(JunoNotificationRoute(userInfo: ["sessionId": "s?x=1", "kind": "work"]))
        XCTAssertNil(JunoNotificationRoute(userInfo: ["agentId": ""]))
        XCTAssertNil(JunoNotificationRoute(userInfo: [:]))
    }
}
