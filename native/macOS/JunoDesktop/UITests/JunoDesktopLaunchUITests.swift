import XCTest

@MainActor
final class JunoDesktopLaunchUITests: XCTestCase {
    func testLaunchesToAnHonestAuthenticationSurface() {
        let app = XCUIApplication()
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(
            app.buttons["Sign in to Juno"].waitForExistence(timeout: 12)
                || app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == %@", "Preparing Juno…"))
                    .firstMatch.exists
                || app.textFields["Message Juno"].exists
                || app.buttons["Account and settings"].exists
                || app.textFields["juno.code.launch-prompt"].exists
                || app.textFields["juno.code.composer.field"].exists
                || app.buttons["juno.code.add-project"].exists
        )
    }

    func testPreviewLaunchesIntoTheRealAuthenticatedChatShell() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-scenario", "normal",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(app.buttons.matching(labelBeginsWith("New chat")).firstMatch
            .waitForExistence(timeout: 12))
        XCTAssertTrue(app.textFields["Message Juno"].exists)
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.product-brand.chat"]
                .waitForExistence(timeout: 5)
        )
    }

    func testPreviewCanLaunchDirectlyIntoCode() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "code",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(
            app.textFields["juno.code.launch-prompt"]
                .waitForExistence(timeout: 12)
        )
        // Ordinary SwiftUI menus are exposed as menu buttons on macOS.
        XCTAssertTrue(app.menuButtons["juno.code.launch-target"].exists)
        XCTAssertTrue(app.menuButtons["juno.code.launch-contract"].exists)
        XCTAssertTrue(app.buttons["juno.code.launch-model"].exists)
        // The first-turn composer deliberately merges dictation and realtime
        // voice into one native split-menu. Active sessions still expose the
        // two distinct controls because there is enough horizontal context to
        // label both jobs without making the empty-state composer noisy.
        // A `Menu(primaryAction:)` changed from menuButton to button in the
        // macOS 27 accessibility bridge. The identifier is the stable contract;
        // the platform's private element classification is not.
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.composer.voice"].exists
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.product-brand.code"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(app.buttons["juno.code.inspector.toggle"].exists)
        XCTAssertTrue(app.buttons["juno.code.console.toggle"].exists)
        XCTAssertTrue(app.buttons["juno.code.review.toggle"].exists)
    }

    func testCodeFullAccessMenuDismissesBeforeRelayout() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "code",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        let contract = app.menuButtons["juno.code.launch-contract"]
        XCTAssertTrue(contract.waitForExistence(timeout: 12))
        contract.click()

        let fullAccess = app.menuItems["Full access"]
        XCTAssertTrue(fullAccess.waitForExistence(timeout: 5))
        fullAccess.click()

        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.launch-contract"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(
            app.staticTexts
                .matching(NSPredicate(format: "value CONTAINS[c] %@", "installs and pushes proceed"))
                .firstMatch
                .waitForExistence(timeout: 5)
        )
    }

    func testCodeLaunchIntentPopulatesTheRealComposer() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "code",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        let intent = app.descendants(matching: .any)[
            "juno.code.launch-intent.explain-project"
        ]
        XCTAssertTrue(intent.waitForExistence(timeout: 12))
        intent.click()

        let composer = app.textFields["juno.code.launch-prompt"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(
            (composer.value as? String)?.contains("Explain the architecture") == true,
            "An intent should fill the editable launch prompt instead of starting a dead-end flow."
        )
    }

    func testCodeSidebarUsesTheNativeSourceListBelowTheToolbar() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "code",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        let productSwitch = app.descendants(matching: .any)["Juno product"]
        XCTAssertTrue(productSwitch.waitForExistence(timeout: 12))
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.product-brand.code"].exists
        )
        // The column's head, top to bottom: the product switch in its strip,
        // the brand row, the search field, then the first destination row.
        let brandRow = app.descendants(matching: .any)["juno.code.brand-row"]
        XCTAssertTrue(brandRow.waitForExistence(timeout: 5))
        let search = app.searchFields["juno.code.sidebar-search-field"]
        XCTAssertTrue(search.exists)
        let newTask = app.descendants(matching: .any)["juno.code.new-conversation"]
        XCTAssertTrue(newTask.exists)
        XCTAssertLessThanOrEqual(
            productSwitch.frame.maxY, brandRow.frame.minY + 1,
            """
            The Chat / Code switch belongs at the top of the sidebar, over the \
            column it switches — above the brand row, not in the detail toolbar.
            """
        )
        XCTAssertLessThanOrEqual(
            brandRow.frame.maxY, search.frame.minY + 1,
            "The search field sits under the brand row, not above the strip."
        )
        XCTAssertLessThanOrEqual(
            search.frame.maxY, newTask.frame.minY + 1,
            "The destinations start under the search field."
        )
        XCTAssertFalse(app.buttons["juno.code.new-chat"].exists)
        XCTAssertTrue(app.buttons["juno.code.sidebar-search"].exists)

        let projectMenu = app.menuButtons["juno.code.project-menu.ws-preview-juno"]
        XCTAssertTrue(projectMenu.exists)
        projectMenu.click()

        let deleteProject = app.menuItems["Delete Project…"]
        XCTAssertTrue(deleteProject.waitForExistence(timeout: 3))
        deleteProject.click()

        // SwiftUI presents macOS alerts as document-modal sheets.
        let confirmation = app.sheets.firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 3))
        XCTAssertTrue(
            confirmation.staticTexts
                .matching(NSPredicate(format: "value CONTAINS[c] %@", "files stay"))
                .firstMatch.exists
        )
        confirmation.buttons["Cancel"].click()

    }

    func testCodeLocalSessionAndInspectorStayInteractive() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-tab", "code",
            "--juno-preview-code-session",
            "--juno-preview-inspector",
            "--juno-preview-inspector-pane", "subagents",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(app.textFields["juno.code.composer.field"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.buttons["juno.code.composer.voice"].exists)
        XCTAssertTrue(app.buttons["juno.code.composer.dictate"].exists)
        XCTAssertTrue(app.buttons["juno.code.preview.toggle"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["juno.code.inspector.toggle"].exists)
        XCTAssertTrue(app.buttons["juno.code.console.toggle"].exists)
        XCTAssertTrue(app.buttons["juno.code.review.toggle"].exists)
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.inspector.pane"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.subagents"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.goal.bar"]
                .waitForExistence(timeout: 5)
        )

        // Exercise the exact regression: closing and restoring the trailing
        // Sub-agents rail while the transcript is live must neither crash nor
        // leave the right pane detached from its toolbar control.
        let inspectorToggle = app.buttons["juno.code.inspector.toggle"]
        inspectorToggle.click()
        XCTAssertFalse(app.descendants(matching: .any)["juno.code.subagents"].exists)
        inspectorToggle.click()
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.subagents"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(app.exists)
    }

    /// Work lands on its home, opens a task from the column, and comes back.
    ///
    /// **The round trip is the point.** This used to drive a five-row filter
    /// section that no longer exists, and it asserted the overview only as the
    /// thing left behind when a filter emptied — which is exactly how the page
    /// became unreachable in the shipping app without a test noticing: once a
    /// task was open, nothing in the window ever cleared the selection again.
    /// Opening a task and returning to the overview is the navigation somebody
    /// actually performs, so it is the navigation this asserts.
    func testWorkOpensOnItsHomeAndReturnsToItFromATask() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "work",
            "--juno-preview-work-overview",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        // The home: the composer is the page's first control, and the group that
        // exists to be noticed is on it.
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.work.composer.goal"]
                .firstMatch.waitForExistence(timeout: 12)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.work.overview.attention"]
                .firstMatch.waitForExistence(timeout: 5)
        )
        // By label rather than by identifier. The row is a `Button` whose label
        // is a stack of six views including a combined status chip, and macOS
        // exposes that as a container whose identifier XCUITest will not match —
        // asserting on the sentence the row actually reads out is both findable
        // and closer to what the test means.
        XCTAssertTrue(
            app.descendants(matching: .any)
                .matching(
                    NSPredicate(
                        format: "label BEGINSWITH %@", "Reconcile the Q3 vendor invoices"
                    )
                )
                .firstMatch.waitForExistence(timeout: 5)
        )

        // "New task" no longer opens a sheet — it puts the caret in the composer
        // that is already on the page.
        let newTask = app.descendants(matching: .any)["juno.work.sidebar.new-task"].firstMatch
        XCTAssertTrue(newTask.exists)
        newTask.firstMatch.click()
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.work.composer.goal"]
                .firstMatch.waitForExistence(timeout: 5)
        )

        // A task, from the column.
        let task = app.descendants(matching: .any)["juno.work.sidebar.task.wk-invoices"].firstMatch
        XCTAssertTrue(task.waitForExistence(timeout: 5))
        task.click()
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.work.surface"]
                .waitForExistence(timeout: 8)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.work.run-facts"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.work.approval"]
                .waitForExistence(timeout: 5)
        )

        // And back. "New task" *is* the home: the composer page is a
        // destination, not the absence of one.
        let overview = app.descendants(matching: .any)["juno.work.sidebar.new-task"].firstMatch
        XCTAssertTrue(overview.exists)
        overview.click()
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.work.composer.goal"]
                .firstMatch.waitForExistence(timeout: 8)
        )
    }

    func testProjectsOpenOnTheIndexAndCanStartAScopedChatInsideAProject() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "projects",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        // The index, not a project: the destination used to auto-open whichever
        // project sorted first, which put the reader inside one project with no
        // route back to the list.
        assertShowingProjectIndex(app)

        openProject(app)
        XCTAssertTrue(app.buttons["All projects"].exists)
        XCTAssertTrue(app.menuButtons["Project detail actions"].exists)

        let composer = app.textFields["Message Juno"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["juno.desktop.chat-model"].exists)
        XCTAssertTrue(app.buttons["New chat in project"].exists)

        composer.click()
        composer.typeText("Outline the next observation")
        let send = app.buttons["Send message"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.click()
        XCTAssertTrue(
            app.textFields["Message Juno"].waitForExistence(timeout: 8),
            "Sending from a project must open the real project-scoped transcript."
        )
    }

    /// The bug this screen shipped with: the index was reachable only from
    /// *inside* a project, and the boolean that got you there was reset by the
    /// destination switch — so leaving Projects and coming back always landed on
    /// a project again.
    func testProjectsReturnToTheIndexAfterVisitingAProjectAndLeaving() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "projects",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        assertShowingProjectIndex(app)

        openProject(app)
        let backToIndex = app.buttons["All projects"]
        XCTAssertTrue(backToIndex.waitForExistence(timeout: 5))
        backToIndex.click()
        assertShowingProjectIndex(app)

        // Into a project, then out of Projects entirely, then back.
        openProject(app)
        XCTAssertTrue(app.buttons["All projects"].waitForExistence(timeout: 5))

        clickSidebarDestination("Library", in: app)
        XCTAssertTrue(
            app.buttons["All projects"].waitForNonExistence(timeout: 5),
            "Leaving Projects must leave the project detail behind."
        )

        clickSidebarDestination("Projects", in: app)
        assertShowingProjectIndex(app)
    }

    /// The index is showing, and no project detail is.
    ///
    /// Asserted on the cards and the search field rather than on the container's
    /// identifier: a plain SwiftUI stack does not reliably surface as an element,
    /// and a card that exists only on the index is the honest proof of where we are.
    private func assertShowingProjectIndex(
        _ app: XCUIApplication,
        line: UInt = #line
    ) {
        XCTAssertTrue(
            app.buttons["juno.project-card.proj-1"].waitForExistence(timeout: 12),
            "Clicking Projects must land on the index of every project.",
            line: line
        )
        XCTAssertTrue(app.textFields["Projects search"].exists, line: line)
        XCTAssertFalse(
            app.buttons["All projects"].exists,
            "The index is the root — it has nothing to go back to.",
            line: line
        )
        XCTAssertFalse(app.buttons["New chat in project"].exists, line: line)
    }

    /// Opens the seeded "Astro research" project from the index.
    private func openProject(_ app: XCUIApplication, line: UInt = #line) {
        let card = app.buttons["juno.project-card.proj-1"]
        XCTAssertTrue(card.waitForExistence(timeout: 5), line: line)
        card.click()
        XCTAssertTrue(
            app.buttons["New chat in project"].waitForExistence(timeout: 5),
            "A card must open that project's own page.",
            line: line
        )
    }

    /// Clicks a destination row in the window's navigation column.
    ///
    /// Matched by label rather than by identifier because the sidebar's rows are
    /// plain `Label`s. Each call site picks a label that is unambiguous *while the
    /// current screen is showing*, so the row is the only thing carrying it.
    private func clickSidebarDestination(
        _ label: String,
        in app: XCUIApplication,
        line: UInt = #line
    ) {
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", label))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "No sidebar row for \(label)", line: line)
        row.click()
    }

    func testArtifactsOpenAsAPreviewLibraryThenNavigateToADocument() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "artifacts",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(
            app.descendants(matching: .any)["juno.artifact-library-grid"]
                .waitForExistence(timeout: 12)
        )
        XCTAssertFalse(app.descendants(matching: .any)["juno.artifact-document"].exists)

        let artifact = app.buttons["juno.artifact-card.art-1"]
        XCTAssertTrue(artifact.exists)
        artifact.click()

        XCTAssertTrue(
            app.descendants(matching: .any)["juno.artifact-document"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(app.descendants(matching: .any)["juno.artifact-view-mode"].exists)
        XCTAssertTrue(app.menuButtons["juno.artifact-actions"].exists)
        XCTAssertTrue(app.buttons["juno.artifact-history"].exists)

        app.buttons["juno.artifact-library"].click()
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.artifact-library-grid"]
                .waitForExistence(timeout: 5)
        )
    }

    func testChatModelSelectorExposesProviderCatalog() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-model-selector",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 12))
        XCTAssertTrue(app.buttons.matching(labelBeginsWith("Anthropic")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(labelBeginsWith("OpenAI")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(labelBeginsWith("Google")).firstMatch.exists)
        XCTAssertTrue(
            app.buttons.matching(labelContains("Claude Opus 4.8")).firstMatch.exists
        )
    }

    /// Every product's column starts under the window chrome, and the product
    /// switch at its head reaches every other product.
    ///
    /// Two regressions this pins. The sidebar strip used to ignore the top
    /// safe area and pad a constant, which put Code's search field over the
    /// product switch and — on a window whose titlebar measured differently —
    /// the column's first rows under the traffic lights. And Work's column
    /// shipped with no product switch at all, so a window that had switched
    /// into Work could not switch back out from the sidebar.
    func testEveryProductColumnStartsBelowTheToolbarAndSwitchesToTheOthers() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "work",
            "--juno-preview-work-overview",
            // 1239, not 1240: the harness treats the scene default as "leave the
            // window alone", and this window has to be measured at the size asked.
            "--juno-preview-size", "1239x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        let productSwitch = app.descendants(matching: .any)["Juno product"]
        XCTAssertTrue(productSwitch.waitForExistence(timeout: 12), "Work's column has no product switch.")
        assertColumnHeadBelowChrome(in: app, product: "work")
        XCTAssertTrue(app.buttons["juno.work.new-task"].exists)

        app.descendants(matching: .any)["juno.product-brand.chat"].click()
        XCTAssertTrue(app.buttons["New chat"].waitForExistence(timeout: 8), "Work → Chat")
        assertColumnHeadBelowChrome(in: app, product: "chat")

        app.descendants(matching: .any)["juno.product-brand.code"].click()
        // The filter row, not "Add project…": that button is the last row of
        // the column and a `.sidebar` List does not build rows below the fold,
        // so on an 800pt window it does not exist to be found.
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.sidebar-filter"].waitForExistence(timeout: 8),
            "Chat → Code"
        )
        assertColumnHeadBelowChrome(in: app, product: "code")
        // Code pins a search field under its brand row; it must sit below the
        // strip, not across it.
        let search = app.searchFields["juno.code.sidebar-search-field"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(
            search.frame.minY, productSwitch.frame.maxY - 1,
            "The Code column's search field overlaps the product switch."
        )

        app.descendants(matching: .any)["juno.product-brand.work"].click()
        XCTAssertTrue(app.buttons["juno.work.new-task"].waitForExistence(timeout: 8), "Code → Work")
    }

    private func assertColumnHeadBelowChrome(in app: XCUIApplication, product: String) {
        let toolbar = app.toolbars.firstMatch
        let productSwitch = app.descendants(matching: .any)["Juno product"]
        XCTAssertTrue(productSwitch.waitForExistence(timeout: 8), product)
        XCTAssertTrue(toolbar.exists, product)
        // The arriving workspace settles over `JunoMotion.standard`; measure
        // it at rest, and leave the numbers in the log for whoever reads a
        // failure.
        Thread.sleep(forTimeInterval: 1.5)
        NSLog(
            "juno.layout %@ window=%@ toolbar=%@ switch=%@",
            product,
            NSStringFromRect(app.windows.firstMatch.frame),
            NSStringFromRect(toolbar.frame),
            NSStringFromRect(productSwitch.frame)
        )
        XCTAssertGreaterThanOrEqual(
            productSwitch.frame.minY, toolbar.frame.maxY - 1,
            "\(product): the product switch is drawn under the window's toolbar."
        )
        let closeButton = app.windows.firstMatch.buttons.matching(
            NSPredicate(format: "label == %@ OR identifier == %@", "close button", "_XCUI:CloseWindow")
        ).firstMatch
        if closeButton.exists {
            XCTAssertGreaterThanOrEqual(
                productSwitch.frame.minY, closeButton.frame.maxY,
                "\(product): the product switch collides with the traffic lights."
            )
        }
    }

    /// Window captures for design review, written to `JUNO_SCREENSHOT_DIR`.
    ///
    /// Not an assertion — a way to *look*. `screencapture` needs the Screen
    /// Recording permission the terminal does not have; an `XCUIScreenshot`
    /// taken under `xcodebuild test` does not. Skipped unless the directory is
    /// set, so the ordinary test run does not write PNGs anywhere.
    func testCapturesReviewScreenshots() throws {
        guard let directory = ProcessInfo.processInfo.environment["JUNO_SCREENSHOT_DIR"],
            !directory.isEmpty
        else {
            throw XCTSkip("Set JUNO_SCREENSHOT_DIR to capture review screenshots.")
        }
        try FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true
        )

        struct Capture {
            let name: String
            let size: String
            let arguments: [String]
        }
        let captures: [Capture] = [
            .init(name: "chat-1240", size: "1239x800", arguments: ["--juno-preview-tab", "chat"]),
            .init(name: "chat-1440", size: "1440x900", arguments: ["--juno-preview-tab", "chat"]),
            .init(name: "code-1240", size: "1239x800", arguments: ["--juno-preview-tab", "code"]),
            .init(name: "code-1440", size: "1440x900", arguments: ["--juno-preview-tab", "code"]),
            .init(
                name: "work-1240", size: "1239x800",
                arguments: ["--juno-preview-tab", "work", "--juno-preview-work-overview"]
            ),
            .init(
                name: "work-1440", size: "1440x900",
                arguments: ["--juno-preview-tab", "work", "--juno-preview-work-overview"]
            ),
            .init(name: "library", size: "1239x800", arguments: ["--juno-preview-tab", "library"]),
            .init(name: "artifacts", size: "1239x800", arguments: ["--juno-preview-tab", "artifacts"]),
            .init(name: "connections", size: "1239x800", arguments: ["--juno-preview-tab", "connections"]),
            .init(name: "projects", size: "1239x800", arguments: ["--juno-preview-tab", "projects"]),
            .init(name: "tasks", size: "1239x800", arguments: ["--juno-preview-tab", "tasks"]),
            .init(name: "memory", size: "1239x800", arguments: ["--juno-preview-tab", "memory"]),
            .init(name: "usage", size: "1239x800", arguments: ["--juno-preview-tab", "usage"]),
            .init(name: "model-selector", size: "1239x800", arguments: ["--juno-preview-model-selector"]),
        ]

        for capture in captures {
            let app = XCUIApplication()
            app.launchArguments = [
                "-ApplePersistenceIgnoreState", "YES",
                "--juno-ui-preview",
                "--juno-preview-appearance", "light",
                "--juno-preview-size", capture.size,
            ] + capture.arguments
            app.launch()
            openMainWindowIfNeeded(in: app)
            let window = app.windows.firstMatch
            XCTAssertTrue(window.waitForExistence(timeout: 12), capture.name)
            dismissKeychainPrompts()
            // Let the arrival rise and the first render settle.
            _ = app.staticTexts.firstMatch.waitForExistence(timeout: 3)
            Thread.sleep(forTimeInterval: 1.2)
            let screenshot = window.screenshot()
            // Both routes, because the runner may be sandboxed away from the
            // requested directory: a file where it can be written, and an
            // attachment in the result bundle (`xcresulttool export attachments`)
            // where it cannot.
            let attachment = XCTAttachment(screenshot: screenshot)
            attachment.name = capture.name
            attachment.lifetime = .keepAlways
            add(attachment)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(capture.name).png")
            do {
                try screenshot.pngRepresentation.write(to: url)
            } catch {
                let fallback = URL(fileURLWithPath: NSTemporaryDirectory())
                    .appendingPathComponent("\(capture.name).png")
                try screenshot.pngRepresentation.write(to: fallback)
                NSLog("juno.screenshot fallback %@", fallback.path)
            }
            app.terminate()
        }
    }

    /// A locally re-signed build is a different identity to the one that wrote
    /// the account's keychain item, so the preview raises the system's
    /// "Juno wants to use your confidential information" sheet over every
    /// window. Deny it — the preview needs no account — so it is not in the
    /// picture.
    private func dismissKeychainPrompts() {
        let agent = XCUIApplication(bundleIdentifier: "com.apple.SecurityAgent")
        for _ in 0..<3 {
            let deny = agent.buttons["Deny"]
            guard deny.waitForExistence(timeout: 2) else { return }
            deny.click()
            Thread.sleep(forTimeInterval: 0.4)
        }
    }

    private func labelBeginsWith(_ value: String) -> NSPredicate {
        NSPredicate(format: "label BEGINSWITH %@", value)
    }

    private func labelContains(_ value: String) -> NSPredicate {
        NSPredicate(format: "label CONTAINS %@", value)
    }

    /// macOS can legitimately restore an app with no windows after its last
    /// window was closed. Juno keeps the native ⌘N recovery command available in
    /// that state; the UI test exercises the same path a person would.
    private func openMainWindowIfNeeded(in app: XCUIApplication) {
        guard !app.windows.firstMatch.waitForExistence(timeout: 2) else { return }
        app.typeKey("n", modifierFlags: [.command])
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5))
    }

    // MARK: - Screenshots

    /// Photographs the shell for visual QA: every product at the two window
    /// sizes the brief names, plus Settings. Written to
    /// `JUNO_SHELL_SCREENSHOT_DIR` when the environment sets it; otherwise the
    /// test only launches each surface and asserts it came up.
    func testCaptureShellScreenshots() throws {
        let directory = ProcessInfo.processInfo.environment["JUNO_SHELL_SCREENSHOT_DIR"]
        let captures: [(name: String, tab: String, size: String, extra: [String])] = [
            ("chat-1240", "chat", "1240x800", []),
            ("code-1240", "code", "1240x800", []),
            ("work-home-1240", "work", "1240x800", ["--juno-preview-work-overview"]),
            ("work-home-1440", "work", "1440x900", ["--juno-preview-work-overview"]),
            ("work-thread-1440", "work", "1440x900", []),
            ("settings-1240", "settings", "1240x800", []),
        ]
        for capture in captures {
            let app = XCUIApplication()
            app.launchArguments = [
                "-ApplePersistenceIgnoreState", "YES",
                "--juno-ui-preview",
                "--juno-preview-tab", capture.tab,
                "--juno-preview-size", capture.size,
            ] + capture.extra
            app.launch()
            openMainWindowIfNeeded(in: app)
            XCTAssertTrue(
                app.descendants(matching: .any)["Juno product"].waitForExistence(timeout: 15),
                "\(capture.name): the product switch should head the sidebar"
            )
            // Let the preview world settle and the arrival animation finish.
            _ = app.descendants(matching: .any)["juno.never.exists"].waitForExistence(timeout: 2)
            if let directory {
                let png = XCUIScreen.main.screenshot().pngRepresentation
                let url = URL(fileURLWithPath: directory).appendingPathComponent("\(capture.name).png")
                try png.write(to: url)
            }
            app.terminate()
        }
    }
}
