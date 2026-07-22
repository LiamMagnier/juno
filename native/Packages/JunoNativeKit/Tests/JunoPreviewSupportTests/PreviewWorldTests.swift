#if DEBUG
import Foundation
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest
@testable import JunoPreviewSupport

@MainActor
final class PreviewWorldTests: XCTestCase {
    func testEveryScenarioBuildsInTemporaryStorageWithoutProductionDependencies() async throws {
        for scenario in PreviewScenario.allCases {
            let world = try PreviewWorld(scenario: scenario)
            await world.activate()

            // The database is a throwaway temp file, never the production store.
            let path = world.previewDatabasePath
            XCTAssertTrue(path.contains("juno-ui-preview-"), path)
            XCTAssertFalse(path.contains("accounts.sqlite3"), path)
            XCTAssertTrue(path.hasPrefix(FileManager.default.temporaryDirectory.path), path)

            // The synthetic session carries no real identity or token material.
            XCTAssertEqual(world.session.profile.email, "preview@juno.local")
            XCTAssertEqual(world.accountID.rawValue, "preview-account")
        }
    }

    func testDevelopmentKeyIsAFixedNonSecretConstant() {
        XCTAssertEqual(PreviewWorld.developmentKey.count, 32)
        XCTAssertTrue(PreviewWorld.developmentKey.allSatisfy { $0 == 0x7A })
    }

    func testOfflinePreviewSenderRefusesEveryRequestWithoutNetwork() async throws {
        let sender = PreviewSender(networkFails: true)
        do {
            _ = try await sender.send(
                try NativeBearerRequest(path: "/api/v1/models"),
                for: try AccountID("preview-account")
            )
            XCTFail("Offline preview sender must refuse the request")
        } catch {
            XCTAssertTrue(error is URLError)
        }
        let sent = await sender.sentRequestCount
        XCTAssertEqual(sent, 1)
    }

    func testNormalPreviewSenderReturnsCannedDataWithoutNetwork() async throws {
        let sender = PreviewSender(networkFails: false)
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/memory"),
            for: try AccountID("preview-account")
        )
        XCTAssertEqual(response.statusCode, 200)
        // A canned, local body — never fetched from a server.
        XCTAssertTrue(String(decoding: response.body, as: UTF8.self).contains("summary"))
    }

    func testConflictScenarioSurfacesAConflictedMutation() async throws {
        let world = try PreviewWorld(scenario: .conflict)
        await world.activate()
        XCTAssertGreaterThan(world.conversationModel.conflictedMutationCount, 0)
    }

    func testNormalScenarioSeedsRealContent() async throws {
        let world = try PreviewWorld(scenario: .normal)
        await world.activate()
        XCTAssertFalse(world.conversationModel.conversations.isEmpty)
        XCTAssertFalse(world.projectModel.projects.isEmpty)
        XCTAssertFalse(world.memorySettingsModel.memories.isEmpty)
        XCTAssertNotNil(world.memorySettingsModel.settings)
    }

    func testActivationIsIdempotent() async throws {
        let world = try PreviewWorld(scenario: .normal)
        await world.activate()
        let count = world.conversationModel.conversations.count
        await world.activate()
        XCTAssertEqual(world.conversationModel.conversations.count, count)
    }
}
#endif
