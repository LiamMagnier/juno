import CoreGraphics
import XCTest
@testable import JunoScreenControl

/// The adversarial review of the screen lane: each test is a way an action
/// got past a stop, the floor, the clipboard grant or a bound, and now
/// does not.
final class ScreenControlHardeningTests: XCTestCase {
    // MARK: Esc and Stop end the action in flight

    func testEscapeEndsALongTypeBetweenChunks() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        fixture.accessibility.settableText = false
        fixture.accessibility.focused[101] = fixture.accessibility.regions[2].1
        let text = String(repeating: "a", count: 200)
        let prepared = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .type, text: text))
        let service = fixture.service
        fixture.pauseHook.set { number in
            if number == 20 { await service.stopAll(reason: .escapeKey) }
        }
        do {
            _ = try await fixture.service.perform(sessionID: "s1", prepared: prepared, toolCallID: "c", attachFrame: true)
            XCTFail("typing outlived Esc")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .stoppedByReader)
            XCTAssertTrue(error.endsTurn)
        }
        let typed = await fixture.sink.events.filter { if case .keyDown = $0 { return true } else { return false } }.count
        XCTAssertLessThanOrEqual(typed, 21, "typing stops at the next chunk after Esc, not after 200 characters")
        XCTAssertGreaterThan(typed, 0)
    }

    func testAStopLetsAHeldKeyGoWithinASlice() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        let prepared = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .holdKey, text: "shift", duration: 30))
        let service = fixture.service
        let before = fixture.clock.now
        fixture.pauseHook.set { number in
            if number == 3 { await service.stopAll(reason: .stopButton) }
        }
        do {
            _ = try await fixture.service.perform(sessionID: "s1", prepared: prepared, toolCallID: nil, attachFrame: false)
            XCTFail("the key stayed held after Stop")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .stoppedByReader)
        }
        let events = await fixture.sink.events
        XCTAssertEqual(events.count, 2, "down, then up at the stop")
        if case .keyUp = events.last {} else { XCTFail("the held key was not released: \(events)") }
        XCTAssertLessThan(fixture.clock.now.timeIntervalSince(before), 1, "released within a slice, not after 30 s")
    }

    func testAStopEndsAWaitAtOnce() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        let prepared = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .wait, duration: 30))
        let service = fixture.service
        let before = fixture.clock.now
        fixture.pauseHook.set { number in
            if number == 2 { await service.stopAll(reason: .escapeKey) }
        }
        do {
            _ = try await fixture.service.perform(sessionID: "s1", prepared: prepared, toolCallID: nil, attachFrame: false)
            XCTFail("the wait outlived Esc")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .stoppedByReader)
        }
        XCTAssertLessThanOrEqual(fixture.clock.now.timeIntervalSince(before), 0.5 + 0.001)
    }

    func testAStopReleasesAButtonLeftDownByLeftMouseDown() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        let scale = try await screenshot(fixture)
        let down = try await fixture.service.prepare(
            sessionID: "s1",
            action: ScreenAction(kind: .leftMouseDown, coordinate: fixture.framePoint(ScreenFixture.nameField.center, scale: scale))
        )
        _ = try await fixture.service.perform(sessionID: "s1", prepared: down, toolCallID: nil, attachFrame: false)
        await fixture.service.stopAll(reason: .escapeKey)
        try await waitUntil {
            await fixture.sink.events.contains { if case .mouseUp(.left, _, _, _) = $0 { return true } else { return false } }
        }
        let posted = await fixture.sink.posted
        XCTAssertEqual(posted.last?.target, .process(pid: 101), "released where it was pressed")
    }

    // MARK: The floor reads what is pressed

    private func screenshot(_ fixture: ScreenFixture) async throws -> Double {
        let shot = try await fixture.service.perform(
            sessionID: "s1",
            prepared: try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot)),
            toolCallID: nil, attachFrame: true
        )
        return Double(try XCTUnwrap(shot.frame?.size.width)) / 1600
    }

    func testAClickOnTheLabelInsideASendButtonAsks() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        // SwiftUI and web buttons: the hit-test finds the label, an untitled
        // static text; AXPress walks up to the button, whose word is "Send".
        fixture.accessibility.regions.append((ScreenFixture.saveButton, ScreenTarget(
            pid: 101, bundleID: "com.apple.TextEdit", appName: "TextEdit",
            element: AXElementInfo(id: "h", role: "AXStaticText", roleDescription: "text", frame: ScreenFixture.saveButton),
            actionTexts: ["Send"]
        )))
        let scale = try await screenshot(fixture)
        let prepared = try await fixture.service.prepare(
            sessionID: "s1",
            action: ScreenAction(kind: .leftClick, coordinate: fixture.framePoint(ScreenFixture.saveButton.center, scale: scale))
        )
        XCTAssertEqual(prepared.floor, .consequentialControl("send"))
    }

    func testAnElementIdCarriesItsOwnWordsToTheFloor() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        fixture.accessibility.snapshots[101] = AXSnapshot(bundleID: "com.apple.TextEdit", appName: "TextEdit", windowTitle: "Untitled", elements: [
            AXElementInfo(id: "e1", role: "AXButton", roleDescription: "button", title: "Delete", frame: ScreenFixture.saveButton, pressable: true),
        ])
        // What the hit-test finds at its centre says nothing.
        fixture.accessibility.regions.append((ScreenFixture.saveButton, ScreenTarget(
            pid: 101, bundleID: "com.apple.TextEdit", appName: "TextEdit",
            element: AXElementInfo(id: "h", role: "AXGroup", frame: ScreenFixture.saveButton)
        )))
        _ = try await screenshot(fixture)
        _ = try await fixture.service.accessibility(sessionID: "s1", app: nil, query: nil, filter: .interactive, depth: 4)
        let prepared = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .leftClick, element: "e1"))
        XCTAssertEqual(prepared.floor, .consequentialControl("delete"))
    }

    func testAnElementWithNoFrameIsRefused() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        fixture.accessibility.snapshots[101] = AXSnapshot(bundleID: "com.apple.TextEdit", appName: "TextEdit", windowTitle: "Untitled", elements: [
            AXElementInfo(id: "e1", role: "AXButton", title: "Delete", frame: ScreenRect(x: 0, y: 0, width: 0, height: 0), pressable: true),
            AXElementInfo(id: "e2", role: "AXButton", title: "Elsewhere", frame: ScreenRect(x: 3000, y: 3000, width: 40, height: 20), pressable: true),
        ])
        _ = try await screenshot(fixture)
        _ = try await fixture.service.accessibility(sessionID: "s1", app: nil, query: nil, filter: .all, depth: 4)
        for id in ["e1", "e2"] {
            do {
                _ = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .leftClick, element: id))
                XCTFail("pressed \(id), which the reader cannot see")
            } catch let error as ScreenControlError {
                XCTAssertTrue(error.errorDescription!.contains("is not visible in the latest screenshot"), "\(error)")
            }
        }
    }

    func testTypingALineBreakInAMessagingAppAsksAsReturnDoes() async throws {
        let fixture = ScreenFixture()
        try await fixture.start(grant: ["com.apple.mail"])
        let prepared = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .type, app: "Mail", text: "On my way\n"))
        XCTAssertEqual(prepared.floor, .sendsMessage)
    }

    func testKeysInTakeoverAreJudgedInTheAppThatGetsThem() async throws {
        let fixture = ScreenFixture()
        try await fixture.start(grant: ["com.apple.TextEdit", "com.apple.mail"])
        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        // TextEdit is the target, Mail has the keyboard.
        fixture.environment.front = ScreenFixture.mail
        let typing = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .type, text: "See you then"))
        XCTAssertEqual(typing.target.appName, "Mail", "the card names where the text goes")
        _ = try await fixture.service.perform(sessionID: "s1", prepared: typing, toolCallID: nil, attachFrame: false)
        let send = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .key, text: "return"))
        XCTAssertEqual(send.floor, .sendsMessage, "Return after typing in Mail sends, whatever app was targeted")
    }

    // MARK: Takeover with a card to answer

    func testAnsweringACardInTakeoverIsNotTheReaderTakingOver() async throws {
        let fixture = ScreenFixture()
        try await fixture.start(grant: ["com.apple.TextEdit", "com.apple.mail"])
        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        fixture.environment.front = ScreenFixture.mail
        let typing = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .type, text: "hello"))
        await fixture.service.publishApprovalDetail(.action(typing), digest: "d1")
        // The reader moves the pointer to the card and clicks Approve.
        await fixture.service.readerInput()
        var state = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(state, .running(mode: .takeover, app: "TextEdit"), "answering Juno is not taking the Mac back")
        // Approve brought Juno forward.
        fixture.environment.front = ScreenFixture.juno
        await fixture.service.clearApprovalDetail(digest: "d1")
        await fixture.service.readerInput()
        state = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(state, .running(mode: .takeover, app: "TextEdit"), "nor is the click's own tail")
        _ = try await fixture.service.perform(sessionID: "s1", prepared: typing, toolCallID: nil, attachFrame: false)
        XCTAssertEqual(fixture.environment.activated, [ScreenFixture.mail.pid], "Mail came back to the front before the keys")
        let posted = await fixture.sink.posted
        XCTAssertFalse(posted.isEmpty)
        XCTAssertTrue(posted.allSatisfy { $0.target == .global })
        // After the grace, the reader's own input pauses as before.
        fixture.clock.advance(2)
        await fixture.service.readerInput()
        state = await fixture.service.state(sessionID: "s1")
        XCTAssertEqual(state, .paused)
    }

    func testInTakeoverWithJunoInFrontClicksStillLandButKeysWait() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        // The reader just sent the prompt from Juno: Juno is in front.
        fixture.environment.front = ScreenFixture.juno
        let shot = try await fixture.service.perform(
            sessionID: "s1",
            prepared: try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot)),
            toolCallID: nil, attachFrame: true
        )
        let size = try XCTUnwrap(shot.frame?.size)
        // The display is 1512 points wide at scale 2.
        let scale = Double(size.width) / 3024
        let point = [ScreenFixture.nameField.center.x * 2 * scale, ScreenFixture.nameField.center.y * 2 * scale]
        let click = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .leftClick, coordinate: point))
        XCTAssertEqual(click.target.appName, "TextEdit")
        do {
            _ = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .key, text: "cmd+s"))
            XCTFail("keys went to Juno")
        } catch let error as ScreenControlError {
            XCTAssertTrue(error.errorDescription!.contains("Juno's own window has the keyboard"))
        }
    }

    func testATakeoverFrameLeavesOutPasswordManagersAndDeniedApps() async throws {
        let fixture = ScreenFixture()
        fixture.environment.apps += [
            RunningApp(pid: 201, bundleID: "com.1password.1password", name: "1Password"),
            RunningApp(pid: 202, bundleID: "com.robinhood.desktop", name: "Robinhood"),
            RunningApp(pid: 203, bundleID: "com.apple.Notes", name: "Notes"),
        ]
        try await fixture.start()
        await fixture.service.setPreferences(ScreenControlPreferences(denied: ["com.apple.notes"]))
        _ = try await fixture.service.beginTakeover(sessionID: "s1", displayID: nil)
        _ = try await fixture.service.perform(
            sessionID: "s1",
            prepared: try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot)),
            toolCallID: nil, attachFrame: true
        )
        let excluded = try XCTUnwrap(fixture.capture.excludedApps.last)
        XCTAssertTrue(excluded.isSuperset(of: ["com.1password.1password", "com.robinhood.desktop", "com.apple.notes"]))
        XCTAssertFalse(excluded.contains("com.apple.textedit"))
    }

    // MARK: The card's place, proved again after the wait

    func testAFieldThatTurnedSecureWhileTheCardWaitedIsRefused() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        fixture.accessibility.focused[101] = fixture.accessibility.regions[2].1
        let prepared = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .type, text: "hello"))
        fixture.accessibility.focused[101] = ScreenTarget(
            pid: 101, bundleID: "com.apple.TextEdit", appName: "TextEdit",
            element: AXElementInfo(id: "h", role: "AXTextField", subrole: "AXSecureTextField", frame: ScreenFixture.nameField)
        )
        do {
            _ = try await fixture.service.perform(sessionID: "s1", prepared: prepared, toolCallID: nil, attachFrame: false)
            XCTFail("typed into a password field")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .secureField)
        }
        XCTAssertTrue(fixture.accessibility.setTexts.isEmpty)
        let events = await fixture.sink.events
        XCTAssertTrue(events.isEmpty)
    }

    func testReturnApprovedBeforeADeleteDialogOpenedIsRefused() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        fixture.accessibility.focused[101] = fixture.accessibility.regions[2].1
        let prepared = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .key, text: "return"))
        XCTAssertNil(prepared.floor)
        // While the card waited, a sheet opened whose default button deletes.
        fixture.accessibility.focused[101] = ScreenTarget(
            pid: 101, bundleID: "com.apple.TextEdit", appName: "TextEdit",
            element: fixture.accessibility.regions[2].1.element, defaultButtonTitle: "Delete"
        )
        do {
            _ = try await fixture.service.perform(sessionID: "s1", prepared: prepared, toolCallID: nil, attachFrame: false)
            XCTFail("Return pressed a Delete button the reader never saw")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .screenChanged)
        }
        let events = await fixture.sink.events
        XCTAssertTrue(events.isEmpty)
    }

    // MARK: The clipboard grant

    func testPasteFromTheMenuNeedsClipboardReading() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        do {
            _ = try await fixture.service.prepareMenu(sessionID: "s1", app: nil, path: ["Edit", "Paste and Match Style"])
            XCTFail("Edit › Paste got past the clipboard grant")
        } catch let error as ScreenControlError {
            XCTAssertTrue(error.errorDescription!.contains("clipboard reading was not allowed"))
        }
        do {
            _ = try await fixture.service.prepareMenu(sessionID: "s1", app: nil, path: ["Édition", "Copier"])
            XCTFail("Copier got past the clipboard grant")
        } catch let error as ScreenControlError {
            XCTAssertTrue(error.errorDescription!.contains("clipboard writing was not allowed"))
        }
    }

    func testAClickOnPasteInAMenuNeedsClipboardReading() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        fixture.accessibility.regions.append((ScreenFixture.saveButton, ScreenTarget(
            pid: 101, bundleID: "com.apple.TextEdit", appName: "TextEdit",
            element: AXElementInfo(id: "h", role: "AXMenuItem", roleDescription: "menu item", title: "Paste", frame: ScreenFixture.saveButton, pressable: true)
        )))
        let scale = try await screenshot(fixture)
        do {
            _ = try await fixture.service.prepare(
                sessionID: "s1",
                action: ScreenAction(kind: .leftClick, coordinate: fixture.framePoint(ScreenFixture.saveButton.center, scale: scale))
            )
            XCTFail("a click on Paste got past the clipboard grant")
        } catch let error as ScreenControlError {
            XCTAssertTrue(error.errorDescription!.contains("clipboard reading was not allowed"))
        }
    }

    func testEveryLevelOfAMenuPathCountsForTheFloor() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        let prepared = try await fixture.service.prepareMenu(sessionID: "s1", app: nil, path: ["File", "Share", "AirDrop"])
        XCTAssertEqual(prepared.floor, .consequentialControl("share"))
    }

    func testSystemSettingsChangesAlwaysAsk() async throws {
        let fixture = ScreenFixture()
        let settings = RunningApp(pid: 105, bundleID: "com.apple.systempreferences", name: "System Settings")
        fixture.environment.apps.append(settings)
        try await fixture.start(grant: ["com.apple.systempreferences"])
        let menu = try await fixture.service.prepareMenu(sessionID: "s1", app: nil, path: ["View", "Privacy & Security"])
        XCTAssertEqual(menu.floor, .systemSettings)
        let key = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .key, text: "space"))
        XCTAssertEqual(key.floor, .systemSettings, "a space on a privacy switch flips it")
    }

    func testAMenuChoiceMustBeTheOneOnTheCard() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        let prepared = try await fixture.service.prepareMenu(sessionID: "s1", app: nil, path: ["File", "Save"])
        do {
            _ = try await fixture.service.performMenu(sessionID: "s1", prepared: prepared, path: ["File", "Delete"], toolCallID: nil)
            XCTFail("performed a menu item the card did not name")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .screenChanged)
        }
        XCTAssertTrue(fixture.accessibility.menus.isEmpty)
    }

    // MARK: Bounds

    func testFramesForActionsNeverPerformedAreBounded() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        let scale = try await screenshot(fixture)
        var ids: [String] = []
        for _ in 0..<10 {
            let prepared = try await fixture.service.prepare(
                sessionID: "s1",
                action: ScreenAction(kind: .leftClick, coordinate: fixture.framePoint(ScreenFixture.saveButton.center, scale: scale))
            )
            ids.append(prepared.id)
        }
        var count = await fixture.service.pendingFrameCount(sessionID: "s1")
        XCTAssertLessThanOrEqual(count, ScreenControlService.maximumPendingFrames)
        // Through the protocol, as the tools call it: the service's own
        // discard is the witness, not the protocol's empty default.
        let screen: any ScreenControlling = fixture.service
        for id in ids { await screen.discard(sessionID: "s1", preparedID: id) }
        count = await fixture.service.pendingFrameCount(sessionID: "s1")
        XCTAssertEqual(count, 0)
    }

    // MARK: Settings narrow live grants

    func testDenyingOrLoweringAnAppInSettingsAppliesToItsLiveGrant() async throws {
        let fixture = ScreenFixture()
        try await fixture.start()
        fixture.accessibility.focused[101] = fixture.accessibility.regions[2].1
        await fixture.service.setPreferences(ScreenControlPreferences(loweredTiers: ["com.apple.textedit": .click]))
        do {
            _ = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .type, text: "hello"))
            XCTFail("typed into an app lowered to clicks")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error.errorDescription, "TextEdit is granted for clicks only; typing, keys, right-click and drags were not sent.")
        }
        await fixture.service.setPreferences(ScreenControlPreferences(denied: ["com.apple.textedit"]))
        do {
            _ = try await fixture.service.prepare(sessionID: "s1", action: ScreenAction(kind: .screenshot))
            XCTFail("looked at an app denied in Settings")
        } catch let error as ScreenControlError {
            XCTAssertEqual(error, .appRefused(app: "TextEdit", reason: "you denied it in Settings"))
        }
    }

    // MARK: Juno Work under the same Esc

    func testEscapeStopsAWorkTaskThatHoldsTheLock() async throws {
        let fixture = ScreenFixture()
        await fixture.service.connect()
        _ = try await fixture.service.lock.claim(ScreenControlHolder(id: "work:run-1", kind: .workTask, title: "Tidy downloads"))
        try await waitUntil { fixture.tap.started >= 1 }
        let caption = await fixture.service.presenceState().caption
        XCTAssertEqual(caption, "Juno is using apps · Esc to stop", "the caption shows for Work too")
        fixture.tap.pressEscape()
        try await waitUntil { await fixture.service.lock.currentHolder == nil }
        try await waitUntil { fixture.tap.stopped >= 1 }
    }
}
