import XCTest

/// Drives the chat header and the transcript through the preview harness.
///
/// These three behaviours are only observable in a running app: whether the
/// wire format leaks into the rendered transcript, whether the two trailing
/// header controls land in ONE capsule or two, and whether the thought-process
/// row actually opens anything. Unit tests over `NativeMessageContent` prove the
/// parsing; only this proves what a reader sees.
final class JunoMobileChatChromeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// The harness opens the first fixture conversation, which has a user turn,
    /// an assistant answer with reasoning, a `<juno:memory>` fact and an artifact.
    private func launch(_ extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-tab", "chat",
        ] + extraArguments
        app.launch()
        return app
    }

    private func require(
        _ element: XCUIElement,
        _ app: XCUIApplication,
        timeout: TimeInterval = 20,
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

    // MARK: - The wire format

    /// The reported defect, as a guard.
    ///
    /// `juno` is a legal URI scheme, so `<juno:memory>` was not merely visible —
    /// Apple's Markdown parser turned it into a coral *tappable link* labelled
    /// "juno:memory" in the middle of the answer. Asserting across every element
    /// type rather than only `staticTexts` is the point: the failing build put it
    /// in `links`.
    @MainActor
    func testTheTranscriptNeverRendersWireTags() {
        let app = launch()
        require(app.descendants(matching: .any)["juno.mobile.thought-process"].firstMatch, app)

        for tag in ["juno:memory", "juno:artifact", "clarification-wizard"] {
            let leaked = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@", tag))
            XCTAssertEqual(
                leaked.count,
                0,
                "\"\(tag)\" reached the transcript. On screen:\n\(app.debugDescription)"
            )
        }
    }

    /// The artifact's own source must not arrive as prose either — the card
    /// stands in for it.
    ///
    /// Matched on a prefix rather than the whole label. The label gained ". Opens
    /// it." when the card stopped being inert: it used to resolve only against
    /// stored artifact rows, and this fixture's tag deliberately has none — which
    /// is what every freshly-written artifact looks like until its row syncs.
    @MainActor
    func testAnArtifactBecomesACardRatherThanItsSource() {
        let app = launch()
        let card = app.descendants(matching: .any)
            .matching(
                NSPredicate(
                    format: "label BEGINSWITH %@",
                    "Artifact, Sidebar behaviour spec, Markdown"
                )
            )
        require(card.firstMatch, app)

        let leaked = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "min 220pt"))
        XCTAssertEqual(leaked.count, 0, "The artifact's body rendered as text.")
    }

    // MARK: - The header pill

    /// New chat and the menu have to be ONE capsule, not two.
    ///
    /// From OS 26 the toolbar merges adjacent items into a single pane of glass,
    /// and a `ToolbarSpacer` between them would split it into two bubbles that
    /// look nothing like the design. Nothing in the source says which happened —
    /// only the laid-out frames do, so this asserts on the gap between them.
    @MainActor
    func testTheHeaderPairsNewChatWithTheMenuInOneCapsule() {
        let app = launch()
        let newChat = app.buttons["juno.mobile.chat-new"]
        let menu = app.buttons["juno.mobile.conversation-menu"]
        require(newChat, app)
        require(menu, app, timeout: 5)

        XCTAssertLessThan(
            newChat.frame.maxX, menu.frame.minX + 1,
            "New chat should sit on the leading side of the menu."
        )
        XCTAssertLessThan(
            menu.frame.minX - newChat.frame.maxX, 24,
            "The two trailing controls are too far apart to be sharing one capsule."
        )
        XCTAssertEqual(
            newChat.frame.midY, menu.frame.midY, accuracy: 2,
            "The two trailing controls are not on one row."
        )
    }

    @MainActor
    func testNewChatFromTheHeaderOpensADraft() {
        let app = launch()
        let newChat = app.buttons["juno.mobile.chat-new"]
        require(newChat, app)
        XCTAssertTrue(newChat.isHittable, "New chat is on screen but not hittable.")

        newChat.tap()
        require(app.descendants(matching: .any)["juno.mobile.chat-draft"].firstMatch, app, timeout: 10)
    }

    /// A draft has no chat to leave, so the pill collapses back to the menu
    /// alone — and New chat must not offer to replace a blank chat with one.
    @MainActor
    func testADraftOffersNoNewChatButton() {
        let app = launch()
        let newChat = app.buttons["juno.mobile.chat-new"]
        require(newChat, app)
        newChat.tap()
        require(app.descendants(matching: .any)["juno.mobile.chat-draft"].firstMatch, app, timeout: 10)

        let gone = expectation(
            for: NSPredicate(format: "exists == false"), evaluatedWith: newChat
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [gone], timeout: 5),
            .completed,
            "New chat is still in the header of an empty draft."
        )
    }

    // MARK: - The thought process

    @MainActor
    func testTheThoughtProcessRowOpensTheRunPanel() {
        let app = launch()
        let row = app.descendants(matching: .any)["juno.mobile.thought-process"].firstMatch
        require(row, app)
        XCTAssertTrue(row.isHittable, "The thought-process row is on screen but not hittable.")

        row.tap()
        require(app.buttons["juno.mobile.thought-process-close"], app, timeout: 10)
        // The model's own reasoning is what the reader opened this for.
        XCTAssertTrue(
            app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@", "NavigationSplitView already handles"))
                .count > 0,
            "The panel opened without the reasoning trace. On screen:\n\(app.debugDescription)"
        )

        app.buttons["juno.mobile.thought-process-close"].tap()
        let closed = expectation(
            for: NSPredicate(format: "exists == false"),
            evaluatedWith: app.buttons["juno.mobile.thought-process-close"]
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [closed], timeout: 5),
            .completed,
            "Closing the run panel left it on screen."
        )
    }

    /// The row is a disclosure and a touch target, not a caption: it has to clear
    /// Apple's 44pt minimum on the axis with room for it. The control it replaced
    /// was a `DisclosureGroup` label whose hit area was the text itself.
    @MainActor
    func testTheThoughtProcessRowIsARealTouchTarget() {
        let app = launch()
        let row = app.descendants(matching: .any)["juno.mobile.thought-process"].firstMatch
        require(row, app)
        XCTAssertGreaterThanOrEqual(
            row.frame.height, 44, "The thought-process row collapsed to its text."
        )
    }
    // MARK: - The composer's opening model

    /// The reported bug: the app always opened on Auto, whatever Settings said.
    ///
    /// Two things had to be true and only the running app can show both — that the
    /// account default reaches the composer at all, and that it survives the
    /// resolver's own "keep the current selection" rule. It did not: the first
    /// resolution ran before settings loaded, fell back to `juno:auto`, and the
    /// second resolution then kept that fallback as though the reader had chosen it.
    @MainActor
    func testTheComposerOpensOnTheAccountDefaultModelNotAuto() {
        let app = launch()
        let chip = app.buttons["juno.mobile.chat-model"]
        require(chip, app)

        // The fixture account's default is Claude Opus 4.8. Settings load
        // asynchronously, so the chip legitimately shows Auto for a moment.
        let settled = expectation(
            for: NSPredicate(format: "label CONTAINS 'Claude Opus' OR value CONTAINS 'Claude Opus'"),
            evaluatedWith: chip
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [settled], timeout: 15),
            .completed,
            """
            The composer never adopted the account's default model. \
            Chip label was \(chip.label), value \(String(describing: chip.value)).
            """
        )
    }

    /// The reported bug: tapping an artifact card in the transcript did nothing.
    ///
    /// The harness reproduces the exact cause. Its assistant turn carries
    /// `<juno:artifact identifier='sidebar-spec'>`, and the only stored artifact
    /// row in the fixtures is `brightness-chart` in a different conversation — so
    /// resolution by identifier finds nothing, which is what every freshly-written
    /// artifact looks like until the next sync lands its row. The card used to go
    /// inert there and stay inert; it now opens the artifact from the reply's own
    /// tag body.
    @MainActor
    func testTappingAnArtifactCardOpensIt() {
        let app = launch()

        let card = app.buttons["juno.mobile.chat-artifact"]
        require(card, app)
        card.tap()

        require(
            app.descendants(matching: .any)["juno.mobile.inline-artifact"].firstMatch,
            app,
            timeout: 10
        )
        // Markdown renders, so the viewer offers the Preview/Source switch —
        // which is what says an artifact is actually on screen rather than an
        // empty sheet.
        XCTAssertTrue(app.descendants(matching: .any)["Source"].firstMatch.exists)
    }

    /// And it closes back onto the conversation it came from.
    @MainActor
    func testTheInlineArtifactViewerCloses() {
        let app = launch()

        let card = app.buttons["juno.mobile.chat-artifact"]
        require(card, app)
        card.tap()

        let close = app.buttons["juno.mobile.inline-artifact-close"]
        require(close, app, timeout: 10)
        close.tap()

        require(app.buttons["juno.mobile.chat-plus"], app, timeout: 10)
    }
}
