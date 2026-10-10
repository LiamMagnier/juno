import JunoChatKit
import JunoDesignSystem
import SwiftUI
import UIKit
import XCTest
@testable import JunoMobile

/// The composer's tool state, which is three different promises in one type.
///
/// The rules being pinned here are the ones that are invisible until they are
/// wrong: a research flag that outlives its message bills the next one for a
/// multi-minute run nobody asked for, and a "sticky" default read with
/// `bool(forKey:)` silently turns web search off for every reader on first
/// launch, because that call cannot tell "never set" from "set to false".
@MainActor
final class JunoMobileComposerToolsTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUpWithError() throws {
        // A private suite per test: `.standard` would carry one test's writes
        // into the next, and into the app on this simulator.
        suiteName = "juno.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    // MARK: - The tray

    /// A skill armed from the tray goes with one message, as on the web; the
    /// draft's project is the tray's until the chat is filed.
    func testTheTraysSkillIsPerSendAndTheDraftProjectIsKept() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        tools.skillSlug = "brief"
        tools.draftProjectID = "p1"
        XCTAssertEqual(tools.consumeForSend().skillSlug, "brief")
        XCTAssertNil(tools.skillSlug)
        XCTAssertNil(tools.consumeForSend().skillSlug)
        XCTAssertEqual(tools.draftProjectID, "p1")
        tools.skillSlug = "brief"
        tools.resetForConversationChange()
        XCTAssertNil(tools.skillSlug)
    }

    // MARK: - Defaults

    func testWebSearchAndCanvasBothStartOn() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        XCTAssertTrue(tools.webSearch)
        XCTAssertTrue(tools.canvas)
        XCTAssertFalse(tools.deepResearch)
        XCTAssertTrue(tools.connectors.isEmpty)
    }

    /// The regression `bool(forKey:)` would produce: "off" and "never set" are
    /// the same value there, so a fresh install would read every default as off.
    func testAnExplicitOffSurvivesARelaunch() {
        let first = JunoMobileComposerTools(defaults: defaults)
        first.webSearch = false

        let second = JunoMobileComposerTools(defaults: defaults)
        XCTAssertFalse(second.webSearch, "Web search did not stay off across launches.")
        XCTAssertTrue(second.canvas, "Canvas was turned off by a write to web search.")
    }

    func testCanvasPersistsIndependently() {
        let first = JunoMobileComposerTools(defaults: defaults)
        first.canvas = false
        XCTAssertFalse(JunoMobileComposerTools(defaults: defaults).canvas)
    }

    // MARK: - Deep research is per-send

    func testSendingReportsResearchAndThenDisarmsIt() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        tools.deepResearch = true

        let sent = tools.consumeForSend()
        XCTAssertTrue(sent.deepResearch, "The message did not carry the research flag.")
        XCTAssertFalse(
            tools.deepResearch,
            "Research stayed armed after sending — the next message would pay for it."
        )
    }

    /// The sticky pair is emphatically *not* reset by a send.
    func testSendingLeavesTheStickySwitchesAlone() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        tools.webSearch = false
        _ = tools.consumeForSend()
        XCTAssertFalse(tools.webSearch)
        XCTAssertTrue(tools.canvas)
    }

    func testSentOptionsMirrorTheCurrentState() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        tools.canvas = false
        tools.toggleConnector("github")

        let sent = tools.consumeForSend()
        XCTAssertFalse(sent.canvas)
        XCTAssertTrue(sent.webSearch)
        XCTAssertEqual(sent.connectors, ["github"])
    }

    /// Ultra fast and Flash are two premiums for one thing: arming one
    /// disarms the other, both survive a send like the other preferences, and
    /// either lights the `+`.
    func testUltraFastAndFlashAreExclusiveAndSticky() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        XCTAssertFalse(tools.ultraFast, "a 6x premium is never on by default")
        tools.fastMode = true
        tools.ultraFast = true
        XCTAssertFalse(tools.fastMode)
        XCTAssertTrue(tools.isArmed)
        let sent = tools.consumeForSend()
        XCTAssertTrue(sent.ultraFast)
        XCTAssertFalse(sent.fastMode)
        XCTAssertTrue(tools.ultraFast, "a preference, not a one-shot")
        tools.fastMode = true
        XCTAssertFalse(tools.ultraFast)
        XCTAssertTrue(JunoMobileComposerTools(defaults: defaults).fastMode)
        XCTAssertFalse(JunoMobileComposerTools(defaults: defaults).ultraFast)
    }

    // MARK: - Connectors

    func testConnectorsToggleOnAndOff() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        tools.toggleConnector("gmail")
        XCTAssertTrue(tools.isConnectorEnabled("gmail"))
        tools.toggleConnector("gmail")
        XCTAssertFalse(tools.isConnectorEnabled("gmail"))
    }

    /// The web's `MAX_CHAT_CONNECTORS`, restated. Past the cap a further pick is
    /// refused rather than silently evicting one already chosen.
    func testTheConnectorCapIsEnforced() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        for index in 0..<(JunoMobileComposerTools.connectorLimit + 3) {
            tools.toggleConnector("app-\(index)")
        }
        XCTAssertEqual(tools.connectors.count, JunoMobileComposerTools.connectorLimit)
        XCTAssertFalse(tools.canAddConnector)
        XCTAssertTrue(tools.isConnectorEnabled("app-0"), "An earlier pick was evicted.")
    }

    /// Turning one off at the cap frees a slot — the limit is on the count, not
    /// on how many picks have been made.
    func testRemovingAtTheCapFreesASlot() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        for index in 0..<JunoMobileComposerTools.connectorLimit {
            tools.toggleConnector("app-\(index)")
        }
        tools.toggleConnector("app-0")
        XCTAssertTrue(tools.canAddConnector)
        tools.toggleConnector("late")
        XCTAssertTrue(tools.isConnectorEnabled("late"))
    }

    /// Connectors are per-conversation. Carrying "this chat may act through
    /// Gmail" into the next thread is the failure this guards.
    func testChangingConversationClearsTheScopedState() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        tools.toggleConnector("gmail")
        tools.deepResearch = true
        tools.webSearch = false

        tools.resetForConversationChange()

        XCTAssertTrue(tools.connectors.isEmpty)
        XCTAssertFalse(tools.deepResearch)
        XCTAssertFalse(tools.webSearch, "A sticky preference was reset with the scope.")
    }

    // MARK: - The armed dot

    /// Deliberately not "any tool is on". Web search and canvas default to on, so
    /// a dot for those would be lit permanently and would say nothing.
    func testTheDefaultsDoNotLightTheDot() {
        XCTAssertFalse(JunoMobileComposerTools(defaults: defaults).isArmed)
    }

    func testResearchAndConnectorsBothLightTheDot() {
        let research = JunoMobileComposerTools(defaults: defaults)
        research.deepResearch = true
        XCTAssertTrue(research.isArmed)

        let connected = JunoMobileComposerTools(defaults: defaults)
        connected.toggleConnector("gmail")
        XCTAssertTrue(connected.isArmed)
    }

    func testTheDotGoesOutWithTheMessageThatCarriedTheResearch() {
        let tools = JunoMobileComposerTools(defaults: defaults)
        tools.deepResearch = true
        _ = tools.consumeForSend()
        XCTAssertFalse(tools.isArmed)
    }
}

/// Pro in the thinking dial: drawn under the track for a model whose scale has
/// the mode, bound to `tools.proMode`, and absent otherwise. With
/// `JUNO_SNAPSHOT_DIR` set (pass `TEST_RUNNER_JUNO_SNAPSHOT_DIR` to
/// xcodebuild), the open dial is also drawn offscreen, light and dark:
/// `$JUNO_SNAPSHOT_DIR/ios-thinking-pro-<off|on>-<light|dark>.png`.
@MainActor
final class JunoMobileThinkingProTests: XCTestCase {
    private func scale(pro: Bool) -> NativeThinkingScale {
        NativeThinkingScale(model: NativeChatModelOption(
            id: "openai:gpt-5.6-sol",
            providerID: "openai",
            providerName: "OpenAI · GPT",
            displayName: "GPT-5.6 Sol",
            minimumPlan: "free",
            availability: "available",
            supportedReasoningEfforts: [.low, .medium, .high, .xhigh, .max],
            defaultReasoningEffort: .medium,
            canDisableReasoning: true,
            supportsReasoning: true,
            supportsProMode: pro,
            fastModeRateMultiplier: 2,
            ultraFastRateMultiplier: 6,
            supportsStreaming: true
        ))
    }

    func testTheScaleCarriesProOnlyWhereTheModelHasIt() {
        XCTAssertTrue(scale(pro: true).supportsProMode)
        XCTAssertFalse(scale(pro: false).supportsProMode)
        XCTAssertTrue(scale(pro: true).isAdjustable)
    }

    func testTheProCopyIsTheWebsWords() {
        XCTAssertEqual(JunoProMode.title, "Pro")
        XCTAssertEqual(JunoProMode.help, "The model's deeper reasoning mode. Slower and costs more.")
    }

    func testDrawsTheOpenDialWithPro() throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to draw the thinking dial with Pro.")
        }
        let root = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let size = CGSize(width: 390, height: 200)
        let states: [(name: String, fast: Bool, ultra: Bool, pro: Bool)] = [
            ("off", false, false, false), ("fast", true, false, false),
            ("ultra", false, true, false), ("pro", false, false, true),
        ]
        for state in states {
            for dark in [false, true] {
                let view = JunoMobileThinkingPanel(
                    scale: scale(pro: true),
                    effort: .constant(.high),
                    fastMode: .constant(state.fast),
                    ultraFast: .constant(state.ultra),
                    proMode: .constant(state.pro),
                    modelName: "GPT-5.6 Sol",
                    providerID: "openai",
                    providerName: "OpenAI · GPT",
                    openModels: {}
                )
                .padding(JunoSpace.cozy)
                .background(Color.junoCanvas)
                .frame(width: size.width, height: size.height)
                let host = UIHostingController(rootView: view)
                host.overrideUserInterfaceStyle = dark ? .dark : .light
                let window = UIWindow(frame: CGRect(origin: .zero, size: size))
                window.overrideUserInterfaceStyle = dark ? .dark : .light
                window.rootViewController = host
                window.isHidden = false
                host.view.frame = window.bounds
                host.view.setNeedsLayout()
                host.view.layoutIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.4))
                let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
                    _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
                }
                let data = try XCTUnwrap(image.pngData())
                let url = root.appendingPathComponent("ios-thinking-\(state.name)-\(dark ? "dark" : "light").png")
                try data.write(to: url)
                window.isHidden = true
                XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
            }
        }
    }
}
