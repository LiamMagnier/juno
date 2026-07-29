import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

@MainActor
final class CheckpointHistoryRestoreTests: XCTestCase {
    private var testRootURL: URL!
    private var workspaceURL: URL!
    private var context: WorkspaceContext!
    private var controller: SessionController!

    override func setUp() async throws {
        let rootURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-history-restore-\(UUID().uuidString)")
        testRootURL = rootURL
        workspaceURL = testRootURL.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("Sources"),
            withIntermediateDirectories: true
        )
        try "original\n".write(
            to: workspaceURL.appendingPathComponent("Sources/App.swift"),
            atomically: true,
            encoding: .utf8
        )
        addTeardownBlock {
            try? FileManager.default.removeItem(at: rootURL)
        }

        let workspaceID = WorkspaceID()
        let access = try WorkspaceAccess(
            workspaceID: workspaceID,
            grantedURL: workspaceURL
        )
        let record = WorkspaceRecord(
            descriptor: WorkspaceDescriptor(
                id: workspaceID,
                displayName: "History fixture",
                localPathHint: workspaceURL.path,
                isGitRepository: false,
                lastOpenedAt: Date()
            ),
            bookmarkData: Data()
        )
        context = WorkspaceContext(
            record: record,
            access: access,
            storageRoot: testRootURL.appendingPathComponent("workspace-storage")
        )
        let now = Date()
        let session = CodeSession(
            workspaceID: workspaceID,
            title: "History restore",
            configuration: AgentConfiguration(modelID: "test-model"),
            createdAt: now,
            updatedAt: now
        )
        controller = SessionController(
            session: session,
            context: context,
            store: CodeSessionStore(
                directoryURL: testRootURL.appendingPathComponent("sessions")
            ),
            modelClient: UnconfiguredModelClient()
        )
    }

    func testHistoryRestoreOffersForceOnlyForDivergedContent() async throws {
        let path = try WorkspacePath("Sources/App.swift")
        let mutation = try await context.files.write(
            path,
            content: "changed by Juno\n",
            expectedBase: nil,
            sessionID: controller.sessionID
        )
        let checkpointID = try XCTUnwrap(mutation.checkpointID)
        let newerContent = "changed after checkpoint\n"
        try newerContent.write(
            to: workspaceURL.appendingPathComponent(path.value),
            atomically: true,
            encoding: .utf8
        )

        let refused = await controller.restoreCheckpoint(checkpointID, force: false)

        XCTAssertEqual(refused, .diverged(path: path.value))
        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent(path.value),
                encoding: .utf8
            ),
            newerContent
        )

        let restored = await controller.restoreCheckpoint(checkpointID, force: true)

        XCTAssertEqual(restored, .restored)
        XCTAssertEqual(
            try String(
                contentsOf: workspaceURL.appendingPathComponent(path.value),
                encoding: .utf8
            ),
            "original\n"
        )
    }

    func testMissingHistoryRemainsFailureEvenWhenForceIsRequested() async {
        let normalResult = await controller.restoreCheckpoint(
            "missing-checkpoint",
            force: false
        )
        let forcedResult = await controller.restoreCheckpoint(
            "missing-checkpoint",
            force: true
        )

        guard case let .failed(normalMessage) = normalResult else {
            return XCTFail("missing history must be an operational failure")
        }
        guard case let .failed(forcedMessage) = forcedResult else {
            return XCTFail("force must not turn missing history into divergence")
        }
        XCTAssertTrue(normalMessage.contains("unavailable"))
        XCTAssertEqual(forcedMessage, normalMessage)
        XCTAssertEqual(controller.transientError, forcedMessage)
    }
}
