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

    private func tools() -> [any CodeTool] {
        let coordinator = ComputerUseCoordinator(
            driver: NumberedCaptureDriver(captures: NumberedCaptures())
        )
        return [
            ComputerScreenshotTool(computer: coordinator),
            ComputerClickTool(computer: coordinator),
            ComputerTypeTool(computer: coordinator),
            ComputerKeyTool(computer: coordinator),
            ComputerScrollTool(computer: coordinator),
        ]
    }

    func testEveryToolThatActsOnTheMacIsNamedAsScreenInput() {
        // The settings layer decides which files may allow a tool by this
        // list, so a new input tool missing from it would be one a cloned
        // repository could silence.
        let tools = tools()
        let acting = Set(tools.filter { $0.assessRisk(input: [:]) != .read }.map(\.name))
        XCTAssertEqual(acting, ComputerUseToolName.input)
        XCTAssertEqual(
            tools.first { $0.assessRisk(input: [:]) == .read }?.name,
            ComputerUseToolName.screenshot
        )
    }

    func testACheckedInSettingsFileCannotSilenceTheQuestionAClickAsks() async throws {
        // The reviewer's case: a repository commits allow rules for every
        // input tool, the reader stays in Ask before edits and starts screen
        // control. Each action must still come to the reader as a question.
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-screen-consent-\(UUID().uuidString)")
        let project = root.appendingPathComponent("repo", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: project.appendingPathComponent(".juno"),
            withIntermediateDirectories: true
        )
        let allowAll = """
        {"permissions":{"allow":["computer_click","computer_type","computer_press_key","computer_scroll"]}}
        """
        for name in ["settings.json", "settings.local.json"] {
            try Data(allowAll.utf8).write(to: project.appendingPathComponent(".juno/\(name)"))
        }
        let store = CodeSettingsStore(userDirectory: root.appendingPathComponent("home/.juno"))

        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        await permissions.setRules(store.resolved(projectRoot: project).rules)
        let asked = LockedNames()
        await permissions.addObserver { update in
            if case let .requested(request) = update {
                asked.append(request.toolName)
            }
        }

        for tool in tools() where tool.assessRisk(input: [:]) == .critical {
            let question = expectation(description: "\(tool.name) asks")
            let observer = await permissions.addObserver { update in
                if case let .requested(request) = update, request.toolName == tool.name {
                    question.fulfill()
                }
            }
            let outcome = Task {
                await permissions.authorize(
                    toolName: tool.name,
                    actionDigest: tool.name,
                    risk: tool.assessRisk(input: [:]),
                    summary: tool.name
                )
            }
            await fulfillment(of: [question], timeout: 2)
            await permissions.removeObserver(observer)
            await permissions.denyAll(reason: "test")
            if case .allowed = await outcome.value {
                XCTFail("\(tool.name) ran without asking")
            }
        }
        XCTAssertEqual(Set(asked.names), ComputerUseToolName.input)

        // The reader's own file is the one place a standing yes can live.
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("home/.juno"),
            withIntermediateDirectories: true
        )
        try Data(#"{"permissions":{"allow":["computer_click"]}}"#.utf8)
            .write(to: root.appendingPathComponent("home/.juno/settings.json"))
        await permissions.setRules(store.resolved(projectRoot: project).rules)
        let click = await permissions.authorize(
            toolName: ComputerUseToolName.click,
            actionDigest: "click",
            risk: .critical,
            summary: "Click"
        )
        XCTAssertEqual(click, .allowed)
    }
}

private final class LockedNames: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String] = []

    func append(_ name: String) {
        lock.withLock { stored.append(name) }
    }

    var names: [String] { lock.withLock { stored } }
}
