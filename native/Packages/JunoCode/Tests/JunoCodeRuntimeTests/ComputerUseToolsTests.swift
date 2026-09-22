import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// A different image on every capture, so a test can tell which one a tool
/// handed on and which one the coordinator kept.
private actor NumberedCaptures {
    private var count: UInt8 = 0

    func next() -> Data {
        count &+= 1
        return Data([0xFF, 0xD8, count])
    }
}

private struct NumberedCaptureDriver: ComputerUseDriving {
    let captures: NumberedCaptures

    func screenCapturePermission() -> ComputerUsePermissionState { .granted }
    func accessibilityPermission() -> ComputerUsePermissionState { .granted }
    func displayBounds() async throws -> CGRect {
        CGRect(x: 0, y: 0, width: 1_000, height: 800)
    }
    func captureScreen() async throws -> Data { await captures.next() }
    func perform(_ action: ComputerUseActionKind) async throws {}
}

/// The agent's screen-control tools against the real coordinator.
final class ComputerUseToolsTests: XCTestCase {
    private let sessionID = CodeSessionID()

    private func context() -> ToolContext {
        ToolContext(sessionID: sessionID, toolCallID: "call", emitOutput: { _, _ in })
    }

    func testTheWindowShowsTheScreenshotTheModelWasSent() async throws {
        // The session banner labels the coordinator's capture "What Juno saw
        // last". That is only true if it is the image a tool put in front of
        // the model, and stays that image while the agent clicks and types
        // on the strength of it.
        nonisolated(unsafe) var currentTime = Date(timeIntervalSince1970: 1_000)
        let coordinator = ComputerUseCoordinator(
            driver: NumberedCaptureDriver(captures: NumberedCaptures()),
            now: { currentTime }
        )
        try await coordinator.activate(sessionID: sessionID, userConsented: true)

        let screenshot = try await ComputerScreenshotTool(computer: coordinator)
            .execute(input: [:], context: context())
        let sent = try XCTUnwrap(screenshot.images.first?.data)
        var shown = await coordinator.snapshot().latestCapture
        XCTAssertEqual(shown?.imageData, sent)

        let inputs: [(any CodeTool, JSONValue)] = [
            (ComputerClickTool(computer: coordinator), ["x": 40, "y": 40]),
            (ComputerTypeTool(computer: coordinator), ["text": "hello"]),
            (ComputerKeyTool(computer: coordinator), ["key": "return"]),
            (ComputerScrollTool(computer: coordinator), ["x": 40, "y": 40, "delta_y": -120]),
        ]
        for (tool, input) in inputs {
            currentTime = currentTime.addingTimeInterval(1)
            let result = try await tool.execute(input: input, context: context())
            XCTAssertTrue(result.images.isEmpty, "\(tool.name) sends the model words, not a screen")
            shown = await coordinator.snapshot().latestCapture
            XCTAssertEqual(shown?.imageData, sent, "\(tool.name) must not change what the window says Juno saw")
        }

        currentTime = currentTime.addingTimeInterval(1)
        let again = try await ComputerScreenshotTool(computer: coordinator)
            .execute(input: [:], context: context())
        shown = await coordinator.snapshot().latestCapture
        XCTAssertNotEqual(again.images.first?.data, sent)
        XCTAssertEqual(shown?.imageData, again.images.first?.data)
    }
}
