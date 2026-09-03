import XCTest
@testable import JunoDesignSystem

final class JunoModelSelectorCatalogTests: XCTestCase {
    private func model(
        _ id: String,
        provider: String = "anthropic",
        name: String = "Anthropic",
        modality: JunoModelModality = .chat,
        legacy: Bool = false,
        automatic: Bool = false,
        price: JunoModelPrice? = nil,
        costGlyph: String? = "$",
        speed: Int? = 7,
        intelligence: Int? = 8,
        context: Int? = 200_000,
        capabilities: [JunoModelCapability] = []
    ) -> JunoModelDescriptor {
        JunoModelDescriptor(
            id: id,
            providerID: provider,
            providerName: name,
            displayName: id,
            modality: modality,
            isLegacy: legacy,
            contextWindowTokens: context,
            costGlyph: costGlyph,
            speedGrade: speed,
            intelligenceGrade: intelligence,
            capabilities: capabilities,
            choosesThinkingAutomatically: automatic,
            price: price
        )
    }

    func testRailUsesWebLabOrderAndLeavesAutoOut() {
        let models = [
            model("router", provider: "juno", name: "Juno", automatic: true),
            model("google", provider: "google", name: "Google"),
            model("openai", provider: "openai", name: "OpenAI"),
            model("unknown", provider: "local", name: "Local"),
        ]

        XCTAssertEqual(JunoModelSelectorCatalog.labs(in: models).map(\.id), [
            "openai", "google", "local",
        ])
    }

    func testGroupsKeepModalitiesTogetherAndFoldLegacyModels() {
        let models = [
            model("image", modality: .image),
            model("text"),
            model("video", modality: .video),
            model("older", legacy: true),
        ]

        let groups = JunoModelSelectorCatalog.groups(models: models, providerID: nil, query: "")
        XCTAssertEqual(groups.map(\.id), ["anthropic"])
        XCTAssertEqual(groups[0].current.map(\.id), ["text", "modality:image", "image", "modality:video", "video"])
        XCTAssertEqual(groups[0].legacy.map(\.id), ["older"])
        XCTAssertEqual(groups[0].legacyCount, 1)
    }

    func testSearchCrossesLabsAndIncludesAutoSynonyms() {
        let models = [
            model("router", provider: "juno", name: "Juno", automatic: true),
            model("claude", provider: "anthropic", name: "Anthropic"),
            model("gpt", provider: "openai", name: "OpenAI"),
        ]

        let groups = JunoModelSelectorCatalog.groups(
            models: models,
            providerID: "anthropic",
            query: "smart"
        )

        XCTAssertEqual(groups.map(\.id), ["juno"])
        XCTAssertEqual(groups[0].current.map(\.id), ["router"])
    }

    func testKeyboardSkipsCaptionsAndOnlyVisitsOpenLegacyRows() {
        let models = [
            model("text"),
            model("older", legacy: true),
            model("image", modality: .image),
        ]
        let groups = JunoModelSelectorCatalog.groups(models: models, providerID: nil, query: "")

        XCTAssertEqual(
            JunoModelSelectorCatalog.keyboardOrder(groups: groups, expanded: [], searching: false),
            ["text", "image"]
        )
        XCTAssertEqual(
            JunoModelSelectorCatalog.keyboardOrder(groups: groups, expanded: ["anthropic"], searching: false),
            ["text", "image", "older"]
        )
        XCTAssertEqual(JunoModelSelectorCatalog.step(from: "image", by: 1, in: ["text", "image"]), "text")
        XCTAssertEqual(JunoModelSelectorCatalog.step(from: nil, by: -1, in: ["text", "image"]), "image")
    }

    func testDetailFactsUsePublishedMetricsAndCapabilityOrder() {
        let text = model(
            "claude",
            price: JunoModelPrice(inputPerMillion: 3, outputPerMillion: 15),
            speed: 9,
            intelligence: 10,
            context: 1_000_000,
            capabilities: [.vision, .reasoning, .search]
        )
        XCTAssertEqual(
            JunoModelSelectorCatalog.meters(text).map { "\($0.label):\($0.value)" },
            ["Intelligence:10", "Speed:9", "Context:10", "Cost:8"]
        )
        XCTAssertEqual(JunoModelSelectorCatalog.chips(text).map(\.label), ["Vision", "Thinking", "Search", "Fast"])
        XCTAssertEqual(JunoModelSelectorCatalog.formatPrice(0.25), "$0.25")

        let image = model("image", modality: .image, price: JunoModelPrice(inputPerMillion: 0, outputPerMillion: 0))
        XCTAssertEqual(JunoModelSelectorCatalog.meters(image).map(\.label), ["Quality", "Speed", "Cost"])
        XCTAssertEqual(JunoModelSelectorCatalog.chips(image).map(\.label), ["Image"])
    }
}
