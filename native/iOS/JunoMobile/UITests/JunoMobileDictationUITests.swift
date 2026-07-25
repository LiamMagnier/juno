import XCTest

/// Opens Dictate Mode for real.
///
/// This exists because of a crash, and the crash is the reason the test cannot be
/// replaced by a unit test. `JunoSpeechService` is `@MainActor`, so under Swift 6
/// the `AVAudioEngine` tap block written inside one of its methods inherited that
/// isolation and got an executor check compiled into it. `AVAudioEngine` calls a
/// tap on the realtime audio thread, so the check ran `dispatch_assert_queue` off
/// the main queue and trapped — `EXC_BREAKPOINT` on
/// `RealtimeMessenger.mServiceQueue`, the instant the microphone produced its
/// first buffer. Nothing short of starting a real audio engine reaches that.
final class JunoMobileDictationUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--juno-ui-preview", "--juno-preview-tab", "chat"]
        app.launch()
        return app
    }

    /// Taps the microphone, lets the engine run past its first buffers, and
    /// asserts the app is still alive and still showing the capsule.
    ///
    /// A permission alert on a fresh simulator is expected: the test answers it and
    /// carries on, because the crash happened *after* the grant.
    @MainActor
    func testDictateModeStartsWithoutTrappingOnTheAudioThread() throws {
        let app = launch()

        let mic = app.buttons["juno.mobile.chat-dictate"]
        guard mic.waitForExistence(timeout: 20) else {
            // No recognizer on this simulator, so the composer correctly offers no
            // microphone at all.
            throw XCTSkip("Speech recognition is unavailable on this device.")
        }
        XCTAssertTrue(mic.isHittable, "The mic is on screen but not hittable.")
        mic.tap()

        // Grant whatever the system asks for. `addUIInterruptionMonitor` does not
        // fire reliably for these, so the alerts are answered directly.
        for _ in 0..<2 {
            let alert = app.alerts.firstMatch
            if alert.waitForExistence(timeout: 3) {
                let allow = alert.buttons.matching(
                    NSPredicate(format: "label CONTAINS 'Allow' OR label CONTAINS 'OK'")
                ).firstMatch
                if allow.exists { allow.tap() }
            }
        }

        let capsule = app.descendants(matching: .any)["juno.mobile.dictation"].firstMatch
        let unavailable = app.descendants(matching: .any)["juno.mobile.dictation-unavailable"]
            .firstMatch

        // Either the capsule is listening, or the app said plainly that it cannot.
        // Both are correct; a dead process is not.
        //
        // Polled rather than waited on: `XCTWaiter.wait(for:)` requires EVERY
        // expectation to be satisfied, so handing it both states asserted that the
        // capsule and its own failure card were on screen at once.
        var settled = false
        for _ in 0..<30 where !settled {
            settled = capsule.exists || unavailable.exists
            if !settled { Thread.sleep(forTimeInterval: 0.5) }
        }
        XCTAssertTrue(
            settled,
            "Dictate Mode neither opened nor reported why. On screen:\n\(app.debugDescription)"
        )

        // THE assertion: the engine has been running for several seconds of real
        // audio buffers and the process is still here.
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(
            app.state, .runningForeground,
            "The app died while dictation was running — the audio tap trapped again."
        )

        // And the exit still works.
        let cancel = app.buttons["juno.mobile.dictation-cancel"]
        if cancel.exists {
            cancel.tap()
            require(app.buttons["juno.mobile.chat-composer"], app, timeout: 10)
        }
    }

    private func require(
        _ element: XCUIElement,
        _ app: XCUIApplication,
        timeout: TimeInterval,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(
            element.waitForExistence(timeout: timeout),
            "Not found. On screen:\n\(app.debugDescription)",
            file: file,
            line: line
        )
    }
}
