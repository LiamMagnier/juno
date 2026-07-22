import XCTest
import JunoCodeRuntime
import JunoCodeUI

@MainActor
final class JunoCodeAppTests: XCTestCase {
    func testCompositionRootConstructs() async {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-app-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let model = WorkbenchModel(
            dependencies: WorkbenchModel.Dependencies(
                storageRootURL: base,
                modelClient: UnconfiguredModelClient(),
                availableModels: [ModelOption(modelID: "m", displayName: "Model")]
            )
        )
        await model.bootstrap()
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertNil(model.selectedSessionID)
    }
}
