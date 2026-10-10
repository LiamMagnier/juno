import Foundation
import XCTest

@testable import JunoCore

/// Apple Handoff's payload for the open thread (docs/code-v2/REMOTE-CONTROL.md
/// §Hand-off): ids only, a round trip through `userInfo`, a web fallback, and
/// nothing accepted that could not have come from Alevr.
final class JunoHandoffTests: XCTestCase {
    private let base = URL(string: "https://alevr.com")!

    func testChatRoundTripsAndFallsBackToTheChatOnTheWeb() {
        let handoff = JunoHandoff.chat("cm123", title: "Trip plan")
        XCTAssertEqual(handoff.userInfo, ["v": "1", "kind": "chat", "id": "cm123", "title": "Trip plan"])
        XCTAssertEqual(JunoHandoff(userInfo: handoff.userInfo), handoff)
        XCTAssertEqual(handoff.webURL(base: base).absoluteString, "https://alevr.com/chat/cm123")
    }

    func testCodeCarriesItsMacAndOpensItsConversationOrCodeOnTheWeb() {
        let handoff = JunoHandoff.code(deviceID: "mac1", sessionID: "sess_9", title: "Fix login", conversationID: "cm9")
        XCTAssertEqual(JunoHandoff(userInfo: handoff.userInfo), handoff)
        XCTAssertEqual(handoff.webURL(base: base).absoluteString, "https://alevr.com/code/cm9")
        XCTAssertEqual(JunoHandoff.code(deviceID: "mac1", sessionID: "s").webURL(base: base).absoluteString, "https://alevr.com/code")
        XCTAssertEqual(JunoHandoff.activityType, "com.liammagnier.juno.thread")
    }

    func testRefusesMalformedOrUnsafePayloads() {
        XCTAssertNil(JunoHandoff(userInfo: nil))
        XCTAssertNil(JunoHandoff(userInfo: ["kind": "chat"]))
        XCTAssertNil(JunoHandoff(userInfo: ["kind": "mail", "id": "x"]))
        XCTAssertNil(JunoHandoff(userInfo: ["kind": "chat", "id": "../../etc/passwd"]))
        XCTAssertNil(JunoHandoff(userInfo: ["kind": "code", "id": "s1"]), "a Code thread needs its Mac")
        XCTAssertNil(JunoHandoff(userInfo: ["kind": "chat", "id": String(repeating: "a", count: 201)]))
        let chatWithDevice = JunoHandoff(userInfo: ["kind": "chat", "id": "c1", "deviceID": "mac1"])
        XCTAssertNil(chatWithDevice?.deviceID, "a chat never carries a Mac")
    }
}
