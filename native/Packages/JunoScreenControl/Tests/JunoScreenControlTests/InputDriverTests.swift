import XCTest
@testable import JunoScreenControl

/// Chunked typing (CU-03), the key path (CU-24), move before click, scroll
/// signs. Events go to a recording sink; nothing is posted.
final class InputDriverTests: XCTestCase {
    func testTyping200CharactersWithEmojiAndAccentsGoesInOrderedChunksOfAtMost16Units() async throws {
        let base = "Héllo wörld — café ☕️ naïve façade 👩‍💻 résumé ✨ crème brûlée 🇫🇷 "
        var text = ""
        while text.count < 200 { text += base }
        text = String(text.prefix(200))
        XCTAssertEqual(text.count, 200)

        let sink = RecordingEventSink()
        let driver = InputDriver(layout: .usANSI, sink: sink, pause: { _ in })
        let plan = try await driver.type(text, target: .process(pid: 42))

        for unit in plan.units {
            XCTAssertLessThanOrEqual(unit.text.count, InputDriver.chunkUnits, "\(unit)")
        }
        XCTAssertEqual(plan.typedText, text, "every character, in order")

        // What reached the sink is the same text, chunk by chunk.
        let downs = await sink.events.compactMap { event -> [UInt16]? in
            if case let .keyDown(_, _, text) = event { return text }
            return nil
        }
        let posted = downs.flatMap { $0 }
        XCTAssertEqual(String(utf16CodeUnits: posted, count: posted.count), text.replacingOccurrences(of: "\n", with: "\r"))
        XCTAssertTrue(downs.allSatisfy { $0.count <= 16 })
        let targets = await sink.posted.map(\.target)
        XCTAssertTrue(targets.allSatisfy { $0 == .process(pid: 42) })
    }

    func testAnEmojiIsNeverSplitAcrossChunks() {
        let text = String(repeating: "👩‍👩‍👧‍👦", count: 5)
        let plan = InputDriver.plan(text, layout: .usANSI)
        for unit in plan.units {
            guard case let .unicode(units) = unit else { continue }
            let chunk = String(utf16CodeUnits: units, count: units.count)
            XCTAssertTrue(chunk.allSatisfy { $0 == "👩‍👩‍👧‍👦" }, "a chunk holds whole characters: \(chunk)")
        }
        XCTAssertEqual(plan.typedText, text)
    }

    func testMappableCharactersUseTheirKeyAndCarryTheirText() {
        let plan = InputDriver.plan("aA?é", layout: .usANSI)
        XCTAssertEqual(plan.units[0], .key(KeyStroke(keyCode: 0), text: Array("a".utf16)))
        XCTAssertEqual(plan.units[1], .key(KeyStroke(keyCode: 0, modifiers: .shift), text: Array("A".utf16)))
        XCTAssertEqual(plan.units[2], .key(KeyStroke(keyCode: 44, modifiers: .shift), text: Array("?".utf16)))
        XCTAssertEqual(plan.units[3], .unicode(Array("é".utf16)), "no key types é on US")
    }

    func testNewlinesAndTabsAreKeys() {
        let plan = InputDriver.plan("a\nb\tc", layout: .usANSI)
        XCTAssertEqual(plan.units[1], .named(.return))
        XCTAssertEqual(plan.units[3], .named(.tab))
        XCTAssertEqual(plan.typedText, "a\nb\tc")
    }

    func testAClickMovesFirstThenCountsClicks() async throws {
        let sink = RecordingEventSink()
        let driver = InputDriver(layout: .usANSI, sink: sink, pause: { _ in })
        let point = ScreenPoint(x: 10, y: 20)
        try await driver.click(at: point, count: 2, target: .global)
        let events = await sink.events
        XCTAssertEqual(events.first, .mouseMove(point), "move before click, so hover controls exist")
        XCTAssertEqual(Array(events.dropFirst()), [
            .mouseDown(.left, point, clickCount: 1, modifiers: []),
            .mouseUp(.left, point, clickCount: 1, modifiers: []),
            .mouseDown(.left, point, clickCount: 2, modifiers: []),
            .mouseUp(.left, point, clickCount: 2, modifiers: []),
        ])
    }

    func testScrollUpIsAPositiveWheelAndHorizontalWorks() async throws {
        let sink = RecordingEventSink()
        let driver = InputDriver(layout: .usANSI, sink: sink, pause: { _ in })
        let point = ScreenPoint(x: 1, y: 1)
        try await driver.scroll(at: point, direction: .up, amount: 3, target: .global)
        try await driver.scroll(at: point, direction: .right, amount: 2, target: .global)
        let scrolls = await sink.events.compactMap { event -> (Int32, Int32)? in
            if case let .scroll(dx, dy, _, _) = event { return (dx, dy) }
            return nil
        }
        XCTAssertEqual(scrolls.first?.1, 3)
        XCTAssertEqual(scrolls.last?.0, -2)
    }

    func testChordsCarryModifiersOnBothHalvesAndRepeat() async throws {
        let sink = RecordingEventSink()
        let driver = InputDriver(layout: .usANSI, sink: sink, pause: { _ in })
        try await driver.key("cmd+z", repeatCount: 3, target: .global)
        let events = await sink.events
        XCTAssertEqual(events.count, 6)
        for event in events {
            switch event {
            case let .keyDown(code, modifiers, _), let .keyUp(code, modifiers, _):
                XCTAssertEqual(code, 6)
                XCTAssertEqual(modifiers, .command)
            default:
                XCTFail("\(event)")
            }
        }
    }

    func testAStopBetweenChunksEndsTyping() async throws {
        let sink = RecordingEventSink()
        let gate = StopAfter(checks: 5)
        let driver = InputDriver(layout: .usANSI, sink: sink, pause: { _ in }, checkpoint: { try await gate.check() })
        do {
            try await driver.type(String(repeating: "x", count: 100), target: .process(pid: 1))
            XCTFail("typing outlived the stop")
        } catch is StoppedForTest {}
        let downs = await sink.events.filter { if case .keyDown = $0 { return true } else { return false } }
        XCTAssertEqual(downs.count, 6, "the first unit, then one per passed check")
    }

    func testAStopMidDragLetsTheButtonGo() async throws {
        let sink = RecordingEventSink()
        let gate = StopAfter(checks: 3)
        let driver = InputDriver(layout: .usANSI, sink: sink, pause: { _ in }, checkpoint: { try await gate.check() })
        do {
            try await driver.drag(from: ScreenPoint(x: 0, y: 0), to: ScreenPoint(x: 80, y: 0), target: .global)
            XCTFail("the drag outlived the stop")
        } catch is StoppedForTest {}
        let events = await sink.events
        guard case let .mouseUp(_, point, _, _)? = events.last else {
            return XCTFail("the button stayed down: \(events)")
        }
        XCTAssertEqual(point, ScreenPoint(x: 30, y: 0), "released where the pointer got to")
    }

    func testHoldKeyIsCappedAtThirtySeconds() async throws {
        let sink = RecordingEventSink()
        let held = HeldDuration()
        let driver = InputDriver(layout: .usANSI, sink: sink, pause: { duration in await held.add(duration) })
        try await driver.hold("shift", seconds: 300, target: .global)
        let total = await held.total
        XCTAssertEqual(total, .seconds(30))
        let events = await sink.events
        XCTAssertEqual(events.count, 2)
    }
}

private actor HeldDuration {
    var total: Duration = .zero
    func add(_ duration: Duration) { total += duration }
}

private struct StoppedForTest: Error {}

/// Passes `checks` stop checks, then throws.
private actor StopAfter {
    private var remaining: Int
    init(checks: Int) { remaining = checks }
    func check() throws {
        guard remaining > 0 else { throw StoppedForTest() }
        remaining -= 1
    }
}
