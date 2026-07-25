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
