import XCTest
@testable import JunoScreenControl

/// The action overlay's cues come from the service, for every caller.
final class ComputerActionFeedTests: XCTestCase {
    private actor Collected {
        var cues: [ComputerActionCue] = []
        func add(_ cue: ComputerActionCue) { cues.append(cue) }
    }

    private func collect(_ feed: ComputerActionFeed, count: Int) -> Task<[ComputerActionCue], Never> {
        let stream = feed.cues()
        return Task {
            var out: [ComputerActionCue] = []
            for await cue in stream {
                out.append(cue)
                if out.count == count { break }
            }
            return out
        }
    }

    func testAClickCuesTheRingBeforeItIsSentAndSettlesAfter() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        let feed = fixture.service.feed
        let shot = try await fixture.service.perform(
            sessionID: "s1",
            prepared: try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot)),
            toolCallID: nil, attachFrame: true
        )
        let listening = collect(feed, count: 2)
        await Task.yield()
        let size = try XCTUnwrap(shot.frame?.size)
        let point = fixture.framePoint(ScreenFixture.saveButton.center, scale: Double(size.width) / 1600)
        let prepared = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .leftClick, coordinate: point))
        _ = try await fixture.service.perform(sessionID: "s1", prepared: prepared, toolCallID: "c1", attachFrame: false)
        let cues = await listening.value
        XCTAssertEqual(cues.map(\.phase), [.acting, .settled(succeeded: true)], "a screenshot draws nothing; the click draws twice")
        XCTAssertEqual(cues[0].label, "Click the “Save” button in TextEdit")
        XCTAssertEqual(cues[0].appName, "TextEdit")
        XCTAssertEqual(cues[0].point?.x ?? 0, ScreenFixture.saveButton.center.x, accuracy: 1)
        XCTAssertEqual(cues[0].sessionID, "s1")
    }

    func testTheStopClearsTheOverlay() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        let listening = collect(fixture.service.feed, count: 1)
        await Task.yield()
        await fixture.service.stopAll(reason: .escapeKey)
        let cues = await listening.value
        XCTAssertEqual(cues.first?.phase, .cleared)
    }

    func testALateListenerGetsTheActionInFlight() async {
        let feed = ComputerActionFeed()
        feed.post(ComputerActionCue(sessionID: "s", label: "Type “hi”", point: nil, appName: "Notes", phase: .acting))
        let late = collect(feed, count: 1)
        let cues = await late.value
        XCTAssertEqual(cues.first?.label, "Type “hi”")
        feed.post(ComputerActionCue(sessionID: "s", label: "", point: nil, appName: nil, phase: .cleared))
        let after = feed.cues()
        let task = Task { () -> ComputerActionCue? in
            for await cue in after { return cue }
            return nil
        }
        feed.post(ComputerActionCue(sessionID: "s", label: "next", point: nil, appName: nil, phase: .acting))
        let first = await task.value
        XCTAssertEqual(first?.label, "next", "a cleared overlay is not replayed")
    }
}
