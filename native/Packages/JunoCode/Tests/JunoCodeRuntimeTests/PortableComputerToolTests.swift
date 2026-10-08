import XCTest
import JunoCodeCore
import JunoScreenControl
@testable import JunoCodeRuntime

/// `computer_use`, computer use for every model (Code v2 SPEC §3.12), against
/// a fake screen and the real permission ladder.
final class PortableComputerToolTests: XCTestCase {
    private let sessionID = CodeSessionID()

    private func context(_ call: String = "call") -> ToolContext {
        ToolContext(sessionID: sessionID, toolCallID: call, emitOutput: { _, _ in })
    }

    private final class Published: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [CodeV2.TurnItem] = []
        func add(_ item: CodeV2.TurnItem) { lock.withLock { items.append(item) } }
        var all: [CodeV2.TurnItem] { lock.withLock { items } }
    }

    private func tool(
        _ screen: FakeScreen,
        mode: PermissionMode = .fullAccess,
        budget: ImageBudget = .portable,
        sees: Bool = true,
        recorder: ComputerActionRecorder? = nil
    ) -> PortableComputerTool {
        PortableComputerTool(
            computer: screen,
            permissions: PermissionCoordinator(sessionID: sessionID, mode: mode),
            budget: budget,
            seesImages: sees,
            recorder: recorder
        )
    }

    func testTheSchemaIsTheContractsVocabularyAndFlat() throws {
        let schema = tool(FakeScreen()).inputSchema
        let actions = schema["properties"]?["action"]?["enum"]?.arrayValue?.compactMap(\.stringValue)
        XCTAssertEqual(actions, CodeV2.ComputerActionKind.allCases.map(\.rawValue))
        XCTAssertEqual(actions, PortableComputerVocabulary.actions, "the Swift contract mirror and the screen-control vocabulary agree")
        let text = schema.canonicalJSONString()
        for banned in ["oneOf", "anyOf", "minItems", "$ref"] { XCTAssertFalse(text.contains(banned), banned) }
        XCTAssertEqual(tool(FakeScreen()).name, "computer_use")
        XCTAssertTrue(ComputerUseToolName.input.contains("computer_use"), "no settings file may let it run without asking")
        XCTAssertTrue(ComputerUseToolName.allowedOnlyAtTheMac.contains("computer_use"))
        XCTAssertTrue(tool(FakeScreen(), budget: .portableNormalized).description.contains("0-999"))
        XCTAssertTrue(tool(FakeScreen(), sees: false).description.contains("You cannot see screenshots"))
    }

    func testAClickRunsThroughTheToolsetActionAndReturnsTheFrame() async throws {
        let screen = FakeScreen()
        let result = try await tool(screen).execute(input: ["action": "click", "x": 512, "y": 300], context: context())
        XCTAssertFalse(result.isError, result.content)
        XCTAssertEqual(screen.performed, [.leftClick])
        XCTAssertEqual(screen.preparedActions.last?.coordinate, [512, 300])
        XCTAssertEqual(result.images.count, 1)
        XCTAssertTrue(result.content.contains("frame 1372×887"))
    }

    func testNormalizedCoordinatesOnAPixelFrameAreConvertedFromTheLastFrame() async throws {
        let screen = FakeScreen()
        let portable = tool(screen)
        _ = try await portable.execute(input: ["action": "screenshot"], context: context("c1"))
        _ = try await portable.execute(
            input: ["action": "click", "x": 500, "y": 500, "coordinate_space": "normalized_1000"], context: context("c2")
        )
        XCTAssertEqual(screen.preparedActions.last?.coordinate, [686, 443.5], "1372×887 frame")
    }

    func testInvalidCallsNeverReachTheScreen() async throws {
        let screen = FakeScreen()
        let result = try await tool(screen).execute(input: ["action": "drag", "x": 1, "y": 1], context: context())
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.contains("drag needs x, y, to_x and to_y"))
        XCTAssertTrue(screen.performed.isEmpty)
        let junk = try await tool(screen).execute(input: ["x": 1], context: context())
        XCTAssertTrue(junk.content.contains("Arguments must be an object with an action"))
    }

    func testAxPressByQueryPressesTheOneMatchingControl() async throws {
        let screen = FakeScreen()
        screen.axListing = """
        Accessibility tree of Mail.
          [e3] button "Send" (1200,40 60×28) enabled
          [e4] button "Send Later…" (1270,40 90×28) disabled
        """
        let result = try await tool(screen).execute(input: ["action": "ax_press", "query": "Send"], context: context())
        XCTAssertFalse(result.isError, result.content)
        XCTAssertEqual(screen.axQueries, ["Send"])
        XCTAssertEqual(screen.preparedActions.last?.element, "e3")
        XCTAssertEqual(screen.preparedActions.last?.kind, .leftClick)

        screen.axListing = """
          [e1] button "Open" enabled
          [e2] button "Open" enabled
        """
        let ambiguous = try await tool(screen).execute(input: ["action": "ax_press", "query": "Open"], context: context("c2"))
        XCTAssertTrue(ambiguous.isError)
        XCTAssertTrue(ambiguous.content.contains("More than one control matches “Open”"))
        XCTAssertTrue(ambiguous.content.contains("[e2]"), "the candidates come back to choose from")
    }

    func testAModelThatCannotSeeGetsTheControlsInsteadOfThePicture() async throws {
        let screen = FakeScreen()
        screen.axListing = "Accessibility tree of TextEdit.\n  [e1] button \"Save\" enabled"
        let result = try await tool(screen, sees: false).execute(input: ["action": "screenshot"], context: context())
        XCTAssertTrue(result.images.isEmpty)
        XCTAssertTrue(result.content.contains("[e1] button \"Save\""))
    }

    func testAskModeAsksOnceAndReadOnlyRefuses() async throws {
        let screen = FakeScreen()
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        let asked = LockedRequests()
        await permissions.addObserver { update in
            guard case let .requested(request) = update else { return }
            asked.append(request)
            Task { await permissions.resolve(approvalID: request.id, decision: .approved) }
        }
        let portable = PortableComputerTool(computer: screen, permissions: permissions, budget: .portable, seesImages: true)
        let result = try await portable.execute(input: ["action": "ax_press", "element": "e3"], context: context())
        XCTAssertFalse(result.isError, result.content)
        XCTAssertEqual(asked.requests.count, 1)
        XCTAssertEqual(asked.requests.first?.toolName, "computer_use")

        let readOnly = PortableComputerTool(
            computer: screen, permissions: PermissionCoordinator(sessionID: sessionID, mode: .readOnly), budget: .portable, seesImages: true
        )
        let refused = try await readOnly.execute(input: ["action": "type", "text": "hi"], context: context("c2"))
        XCTAssertTrue(refused.isError)
        let look = try await readOnly.execute(input: ["action": "screenshot"], context: context("c3"))
        XCTAssertFalse(look.isError, "looking never asks")
    }

    func testEveryStepBecomesATimelineItemWithItsScreenshot() async throws {
        let screen = FakeScreen()
        let published = Published()
        let recorder = ComputerActionRecorder(
            store: { session, call, _ in "alevr-shot://\(session)/\(call).png" },
            now: { Date(timeIntervalSince1970: 1_791_489_600) },
            publish: { _, item in published.add(item) }
        )
        let portable = tool(screen, recorder: recorder)
        _ = try await portable.execute(input: ["action": "click", "x": 686, "y": 443.5], context: context("c1"))
        _ = try await portable.execute(input: ["action": "ax_press", "element": "e3"], context: context("c2"))
        screen.failOn[.type] = .secureField
        _ = try await portable.execute(input: ["action": "type", "text": "hunter2"], context: context("c3"))
        _ = try await portable.execute(input: ["action": "menu", "path": ["File", "Export…"]], context: context("c4"))

        let items = await recorder.items.compactMap { item -> CodeV2.ComputerAction? in
            if case let .computerAction(action) = item { return action }
            return nil
        }
        XCTAssertEqual(items.map(\.callId), ["c1", "c2", "c3", "c4"])
        XCTAssertEqual(items.map(\.action), [.click, .axPress, .type, .menu])
        XCTAssertEqual(items.map(\.status), [.completed, .completed, .failed, .completed])
        XCTAssertEqual(items[0].screenshotRef, "alevr-shot://\(sessionID.value)/c1.png")
        XCTAssertEqual(items[0].point, CodeV2.ComputerAction.UnitPoint(x: 0.5, y: 0.5))
        XCTAssertEqual(items[0].frameSize, CodeV2.ComputerAction.FrameSize(width: 1372, height: 887))
        XCTAssertEqual(items[0].app, "TextEdit")
        XCTAssertEqual(items[0].summary, "Clicked TextEdit.")
        XCTAssertNotNil(items[2].error)
        XCTAssertEqual(items[3].target, "File › Export…")
        // Each step was published running, then settled, under one id.
        let ids = published.all.map(\.id)
        XCTAssertEqual(ids.filter { $0 == "ca_c1" }.count, 2)
        // And every item is a valid contract item.
        let encoded = try JSONEncoder().encode(await recorder.items)
        let decoded = try JSONDecoder().decode([CodeV2.TurnItem].self, from: encoded)
        XCTAssertEqual(decoded.count, 4)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [[String: Any]])
        XCTAssertEqual(raw.first?["kind"] as? String, "computer_action")
    }

    func testTheLegacyToolsRecordToo() async throws {
        let screen = FakeScreen()
        let recorder = ComputerActionRecorder()
        let batch = ComputerBatchTool(
            computer: screen, permissions: PermissionCoordinator(sessionID: sessionID, mode: .fullAccess), budget: .anthropicHighResolution,
            recorder: recorder
        )
        _ = try await batch.execute(
            input: ["actions": [["action": "left_click", "coordinate": [10, 10]], ["action": "key", "text": "cmd+s"]]],
            context: context("b1")
        )
        let ids = await recorder.items.map(\.id)
        XCTAssertEqual(ids, ["ca_b1#1", "ca_b1#2"])
        XCTAssertEqual(screen.attachedFrame, [false, true], "recording never captures a frame the batch did not ask for")
    }
}
