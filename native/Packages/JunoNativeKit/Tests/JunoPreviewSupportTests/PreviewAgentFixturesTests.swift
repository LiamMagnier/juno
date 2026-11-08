#if DEBUG
import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import XCTest
@testable import JunoPreviewSupport

@MainActor
final class PreviewAgentFixturesTests: XCTestCase {
    func testAgentPreviewsHaveAValidRosterInsteadOfAnUnrelatedFallback() async throws {
        let sender = PreviewSender(networkFails: false)
        let response = try await sender.send(
            NativeBearerRequest(path: "/api/agents", method: .get),
            for: AccountID("preview-account")
        )
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
        let agents = try XCTUnwrap(root["agents"] as? [[String: Any]])
        XCTAssertEqual(agents.count, 3)
        XCTAssertTrue(agents.allSatisfy { $0["id"] is String && $0["name"] is String })
    }

    func testEmptyAgentPreviewExercisesTheFirstTaskOnboarding() async throws {
        let sender = PreviewSender(networkFails: false, empty: true)
        let response = try await sender.send(
            NativeBearerRequest(path: "/api/agents", method: .get),
            for: AccountID("preview-account")
        )
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
        XCTAssertEqual((root["agents"] as? [Any])?.count, 0)
    }
}
#endif
