import XCTest

/// Drives the chat header and the transcript through the preview harness.
///
/// These three behaviours are only observable in a running app: whether the
/// wire format leaks into the rendered transcript, where the header's three
/// controls (sidebar, title menu, New chat) land, and whether the
/// thought-process row actually opens anything. Unit tests over `NativeMessageContent` prove the
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

    // MARK: - The header

    /// The conversation bar keeps exactly three things: the sidebar button on
    /// the leading edge, the title (which IS the conversation's menu) in the
    /// middle, and New chat alone on the trailing edge — ChatGPT's bar.
    ///
    /// This replaced the old trailing "New chat + menu" pair in one capsule:
    /// the conversation's verbs moved under its title, the way Notes and
    /// Photos put a document's actions under its name. Only the laid-out
    /// frames say the order is right, so this asserts on them.
    @MainActor
    func testTheHeaderPutsTheTitleMenuBetweenTheSidebarAndNewChat() {
        let app = launch()
        let sidebar = app.buttons["juno.mobile.menu"]
        let menu = app.buttons["juno.mobile.conversation-menu"]
        let newChat = app.buttons["juno.mobile.chat-new"]
        require(newChat, app)
        require(menu, app, timeout: 5)
        require(sidebar, app, timeout: 5)

        XCTAssertLessThan(
            sidebar.frame.maxX, menu.frame.minX,
            "The sidebar button should sit on the leading side of the title."
        )
        XCTAssertLessThan(
            menu.frame.maxX, newChat.frame.minX,
            "New chat should sit on the trailing side of the title."
        )
        // The title menu reads the conversation's name: it is the title, not
        // an anonymous "…" capsule.
        XCTAssertTrue(
            menu.staticTexts["juno.mobile.conversation-title"].firstMatch.exists,
            "The conversation menu does not carry the conversation's title."
        )
        // New chat stands at the trailing edge of the bar, on the bar's edge
        // inset rather than next to the title.
        let screen = app.windows.firstMatch.frame
        XCTAssertGreaterThan(
            newChat.frame.midX, screen.width * 0.8,
            "New chat is not on the trailing edge of the bar."
        )
        XCTAssertLessThan(
            sidebar.frame.midX, screen.width * 0.2,
            "The sidebar button is not on the leading edge of the bar."
        )
        for control in [sidebar, newChat] {
            XCTAssertEqual(
                control.frame.midY, menu.frame.midY, accuracy: 2,
                "The bar's three controls are not on one row."
            )
        }
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

    /// The drawer footer is one control row. A system-sized profile control
    /// beside an oversized primary button makes that row look accidental and
    /// was the specific mismatch reported during the iOS 27 review.
    @MainActor
    func testSidebarChatAndProfileControlsHaveTheSameHeight() {
        let app = launch(["--juno-preview-sidebar"])
        // The drawer is one accessibility container, so SwiftUI deliberately
        // propagates its identifier to descendants. Select these two controls
        // by their stable user-facing labels instead.
        let profile = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Open settings for")
        ).firstMatch
        let chat = app.buttons["New chat"]
        require(profile, app)
        require(chat, app)

        XCTAssertEqual(
            profile.frame.height,
            chat.frame.height,
            accuracy: 1,
            "Profile is \(profile.frame.height)pt but Chat is \(chat.frame.height)pt."
        )
        XCTAssertGreaterThanOrEqual(profile.frame.height, 44)
        XCTAssertGreaterThanOrEqual(chat.frame.height, 44)
    }

    /// A device heartbeat alone is not enough to run Alevr Code. The target
    /// picker must distinguish the Mac that advertises queued execution from a
    /// signed-in computer that would otherwise leave a task queued forever.
    @MainActor
    func testCodeRemotePickerDistinguishesRunnableAndUnavailableHosts() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-tab", "code",
            "--juno-preview-appearance", "light",
        ]
        app.launch()

        // Code opens on the paired Mac's remote sessions. The queued-task
        // composer (and its target picker) lives under Cloud in the "Run on"
        // host menu at the top of the page.
        let hosts = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Run on")
        ).firstMatch
        require(hosts, app)
        hosts.tap()
        let cloud = app.buttons["Cloud"].firstMatch
        require(cloud, app, timeout: 5)
        cloud.tap()

        // Remote, not Cloud or No project, is what sends a task to a computer.
        // Where it runs is one menu on the composer's row: Remote, then
        // "Choose a computer" opens the hosts.
        let place = app.buttons["juno.mobile.code-target"].firstMatch
        require(place, app, timeout: 5)
        place.tap()
        let remote = app.buttons["Remote"].firstMatch
        require(remote, app, timeout: 5)
        remote.tap()
        place.tap()
        let choose = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Choose a computer")
        ).firstMatch
        require(choose, app, timeout: 5)
        choose.tap()

        require(app.staticTexts["Computer"], app, timeout: 10)
        XCTAssertTrue(app.staticTexts["Online"].exists)
        XCTAssertTrue(app.staticTexts["Not hosting"].exists)
        XCTAssertTrue(
            app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS %@", "not set up to run remote Alevr Code work")
            ).firstMatch.exists,
            "The unavailable host does not explain why it cannot accept a task."
        )
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
        // The fixture is deliberately a long transcript and opens at the
        // newest turn. Reveal the disclosure before asserting its hit target;
        // this is the same gesture a reader uses to inspect an older run.
        // Bounded rather than `while`: a fixture that stopped being long
        // should fail this test, not hang it.
        let transcript = app.scrollViews["juno.mobile.conversation-detail"].firstMatch
        for _ in 0..<6 where !row.isHittable {
            transcript.swipeDown()
        }
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
        // The model is named, and chosen, on the Thinking panel the dial
        // opens. Settings load asynchronously, so the composer legitimately
        // sits on Auto for a moment — and Auto's dial opens the catalogue,
        // not the panel — so wait for the dial to name a level first.
        let dial = app.buttons["juno.mobile.chat-thinking"]
        require(dial, app)
        let leftAuto = expectation(
            for: NSPredicate(format: "value != 'Chosen automatically for each message'"),
            evaluatedWith: dial
        )
        _ = XCTWaiter().wait(for: [leftAuto], timeout: 15)
        dial.tap()
        let row = app.descendants(matching: .any)["juno.mobile.thinking-models"].firstMatch
        require(row, app, timeout: 5)

        // The fixture account's default is Claude Opus 4.8.
        let settled = expectation(
            for: NSPredicate(format: "label CONTAINS 'Opus' OR value CONTAINS 'Opus'"),
            evaluatedWith: row
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [settled], timeout: 15),
            .completed,
            """
            The composer never adopted the account's default model. \
            Row label was \(row.label), value \(String(describing: row.value)).
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

        let card = app.buttons.matching(
            NSPredicate(
                format: "label BEGINSWITH %@",
                "Artifact, Sidebar behaviour spec, Markdown"
            )
        ).firstMatch
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

        let card = app.buttons.matching(
            NSPredicate(
                format: "label BEGINSWITH %@",
                "Artifact, Sidebar behaviour spec, Markdown"
            )
        ).firstMatch
        require(card, app)
        card.tap()

        let close = app.buttons["juno.mobile.inline-artifact-close"]
        require(close, app, timeout: 10)
        close.tap()

        require(app.buttons["juno.mobile.chat-plus"], app, timeout: 10)
    }

    /// The open drawer's search button and the pushed card's sidebar button
    /// are one control on one line: the top bar's 44pt glass circle, on the
    /// same vertical centre.
    ///
    /// What accessibility can and cannot measure here: the drawer's search
    /// button is ours (`JunoLayout.Bar.button`, 44pt) and reports its circle.
    /// The card's sidebar button is a system toolbar item, whose Liquid Glass
    /// circle the system draws OUTSIDE the frame it reports (the item reports
    /// its 36pt content box, the button its glyph). So the diameter is asserted
    /// on our button, and the shared centre line on both — the claim the
    /// design makes about the pair.
    @MainActor
    func testDrawerSearchAndSidebarButtonShareSizeAndCentreLine() {
        let app = launch(["--juno-preview-sidebar"])

        // The drawer is one accessibility container, so SwiftUI propagates its
        // identifier ("juno.mobile.sidebar") over the button's own; select the
        // button by its label within either identifier.
        let search = app.buttons.matching(
            NSPredicate(
                format: "label == %@ AND (identifier == %@ OR identifier == %@)",
                "Search", "juno.mobile.sidebar-search", "juno.mobile.sidebar"
            )
        ).firstMatch
        let toggle = app.buttons["juno.mobile.menu"]
        require(search, app, timeout: 10)
        require(toggle, app, timeout: 10)

        // The drawer is open: the card (and its sidebar button) is pushed to
        // the trailing side, the search button is the drawer header's last
        // control, so the two stand side by side.
        XCTAssertLessThan(search.frame.maxX, toggle.frame.minX, "the card is not pushed past the drawer's search")

        XCTAssertEqual(search.frame.midY, toggle.frame.midY, accuracy: 1.5, "centre lines differ")
        XCTAssertEqual(search.frame.width, 44, accuracy: 1, "the search button is not the bar's 44pt circle")
        XCTAssertEqual(search.frame.height, 44, accuracy: 1, "the search button is not the bar's 44pt circle")
    }
}
