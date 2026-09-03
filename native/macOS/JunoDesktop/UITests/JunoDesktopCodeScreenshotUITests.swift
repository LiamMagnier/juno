import XCTest

/// Captures the Code window's screens from the DEBUG preview harness so the
/// redesign can be looked at rather than inferred from the accessibility tree.
///
/// Each test launches the app into one fixture, waits for the surface's
/// stable element, and writes `XCUIScreen.main.screenshot()` as a PNG. The
/// directory comes from `JUNO_CODE_SHOT_DIR` (pass it with the
/// `TEST_RUNNER_` prefix through `xcodebuild`), falling back to the session
/// scratchpad the redesign was reviewed from. Assertions are deliberately
/// light: a screenshot of a missing surface is worth more than a red test
/// that saved nothing.
@MainActor
final class JunoDesktopCodeScreenshotUITests: XCTestCase {
    private static let fallbackDirectory =
        "/private/tmp/claude-501/-Users-liammagnier-Developer-juno/bf826af6-fa82-4fb5-bfd3-9a1b64871fd6/scratchpad/mac-code"

    private var directory: URL {
        let raw = ProcessInfo.processInfo.environment["JUNO_CODE_SHOT_DIR"] ?? Self.fallbackDirectory
        let url = URL(fileURLWithPath: raw, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func launch(_ extra: [String], tab: String = "code") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", tab,
            "--juno-preview-size", "1440x900",
        ] + extra
        app.launch()
        if app.windows.count == 0 {
            app.activate()
            app.typeKey("n", modifierFlags: [.command, .shift])
        }
        _ = app.windows.firstMatch.waitForExistence(timeout: 12)
        return app
    }

    private func save(_ name: String) {
        // One settle pass for glass and the transcript's initial scroll.
        RunLoop.current.run(until: Date().addingTimeInterval(1.2))
        let data = XCUIScreen.main.screenshot().pngRepresentation
        let url = directory.appendingPathComponent("\(name).png")
        do {
            try data.write(to: url)
            print("JUNO_SHOT \(url.path)")
        } catch {
            // The runner is sandboxed away from most of the disk; its own
            // temporary directory is always writable. The path is printed so
            // the driving script can copy the file out.
            let fallback = FileManager.default.temporaryDirectory
                .appendingPathComponent("juno-code-shots", isDirectory: true)
            try? FileManager.default.createDirectory(at: fallback, withIntermediateDirectories: true)
            let alternate = fallback.appendingPathComponent("\(name).png")
            do {
                try data.write(to: alternate)
                print("JUNO_SHOT \(alternate.path)")
            } catch {
                XCTFail("could not write \(url.path) or \(alternate.path): \(error)")
            }
        }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testNewTaskScreen() {
        let app = launch([])
        XCTAssertTrue(app.textFields["juno.code.launch-prompt"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.descendants(matching: .any)["juno.code.starter-tasks"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["juno.code.draft-context"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["juno.code.launch-contract"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["juno.code.launch-model"].exists)
        save("01-new-task")
    }

    func testThreadWithWorkedForGroupsAndRail() {
        let app = launch([
            "--juno-preview-code-session",
            "--juno-code-preview-scenario", "transcript",
            "--juno-preview-inspector",
        ])
        XCTAssertTrue(app.textFields["juno.code.composer.field"].waitForExistence(timeout: 12))
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.transcript.work-log"]
                .firstMatch.waitForExistence(timeout: 8)
        )
        XCTAssertTrue(app.descendants(matching: .any)["juno.code.inspector.pane"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["juno.code.environment.changes"].exists)
        save("02-thread-rail")

        // Open the work log so the grouped rows are on screen.
        let log = app.descendants(matching: .any)["juno.code.transcript.work-log"].firstMatch
        log.click()
        save("03-thread-worked-for-open")
    }

    func testApprovalCardInThread() {
        let app = launch([
            "--juno-preview-code-session",
            "--juno-code-preview-scenario", "approval",
            "--juno-preview-inspector",
        ])
        XCTAssertTrue(app.textFields["juno.code.composer.field"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.buttons["juno.code.approval.approve"].waitForExistence(timeout: 8))
        save("04-approval")
    }

    func testReviewPaneBesideThread() {
        let app = launch([
            "--juno-preview-code-session",
            "--juno-code-preview-scenario", "diffs",
        ])
        XCTAssertTrue(app.textFields["juno.code.composer.field"].waitForExistence(timeout: 12))
        let review = app.buttons["juno.code.thread.rail.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 8))
        review.click()
        XCTAssertTrue(app.descendants(matching: .any)["juno.code.review.pane"].waitForExistence(timeout: 8))
        save("05-review-pane")
    }

    /// The Chat column with a destination row selected *and the list holding
    /// focus* — the state in which macOS 26 paints a source-list selection in
    /// the system accent unless the row draws its own fill.
    func testChatSidebarWithFocusedSelectedRow() {
        let app = launch(["--juno-preview-appearance", "light"], tab: "chat")
        let library = app.staticTexts["Library"].firstMatch
        XCTAssertTrue(library.waitForExistence(timeout: 12))
        // A click both selects the row and makes the list first responder.
        library.click()
        _ = app.staticTexts["Library"].firstMatch.waitForExistence(timeout: 3)
        save("07-chat-sidebar-focused")
    }

    func testStreamingThreadWithSubagents() {
        let app = launch([
            "--juno-preview-code-session",
            "--juno-code-preview-scenario", "streaming",
            "--juno-preview-inspector",
        ])
        XCTAssertTrue(app.textFields["juno.code.composer.field"].waitForExistence(timeout: 12))
        save("06-streaming-subagents")
    }
}
