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
            model("audio", modality: .audio),
            model("video", modality: .video),
            model("older", legacy: true),
        ]

        let groups = JunoModelSelectorCatalog.groups(models: models, filter: .all, query: "")
        XCTAssertEqual(groups.map(\.id), ["anthropic"])
        XCTAssertEqual(groups[0].current.map(\.id), [
            "anthropic/modality:chat", "text", "anthropic/modality:image", "image",
            "anthropic/modality:video", "video", "anthropic/modality:audio", "audio",
        ])
        XCTAssertEqual(groups[0].legacy.map(\.id), ["legacy:older"])
        XCTAssertEqual(groups[0].legacyCount, 1)
        XCTAssertTrue(groups[0].showsLabel)
    }

    func testOneModalityDrawsNoHeadingAndALabViewDropsTheLabLabel() {
        let models = [model("a"), model("b"), model("gpt", provider: "openai", name: "OpenAI")]
        let all = JunoModelSelectorCatalog.groups(models: models, filter: .all, query: "")
        XCTAssertEqual(all.map(\.id), ["anthropic", "openai"])
        XCTAssertEqual(all[0].current.map(\.id), ["a", "b"])

        let lab = JunoModelSelectorCatalog.groups(models: models, filter: .lab("openai"), query: "")
        XCTAssertEqual(lab.map(\.id), ["openai"])
        XCTAssertFalse(lab[0].showsLabel)
    }

    func testAutoLeadsWithoutAHeadingAndSearchFindsItBySynonym() {
        let models = [
            model("router", provider: "juno", name: "Juno", automatic: true),
            model("claude", provider: "anthropic", name: "Anthropic"),
            model("gpt", provider: "openai", name: "OpenAI"),
        ]
        let all = JunoModelSelectorCatalog.groups(models: models, filter: .all, query: "")
        XCTAssertEqual(all.map(\.id), ["auto:", "anthropic", "openai"])
        XCTAssertFalse(all[0].showsLabel)

        let lab = JunoModelSelectorCatalog.groups(models: models, filter: .lab("anthropic"), query: "")
        XCTAssertEqual(lab.map(\.id), ["anthropic"], "a lab view has no Auto row")

        let search = JunoModelSelectorCatalog.groups(models: models, filter: .lab("anthropic"), query: "recommended")
        XCTAssertEqual(search.map(\.id), ["auto:"], "a query searches past the rail")
        XCTAssertEqual(search[0].current.map(\.id), ["router"])
    }

    func testFavoritesAndRecentLeadTheAllViewOnlyWhenTheListIsLong() {
        var models = (1...8).map { model("m\($0)") }
        let favorites: Set<String> = ["m2"]
        let groups = JunoModelSelectorCatalog.groups(
            models: models, filter: .all, query: "", favorites: favorites, recents: ["m2", "m5", "m7", "m8"]
        )
        XCTAssertEqual(groups.map(\.id), ["favorites:", "recent:", "anthropic"])
        XCTAssertEqual(groups[0].current.map(\.id), ["favorites:m2"])
        XCTAssertEqual(groups[0].count, 1)
        XCTAssertEqual(groups[1].current.map(\.id), ["recent:m5", "recent:m7"], "starred rows are not repeated; three recents at most")

        models.removeLast()
        let short = JunoModelSelectorCatalog.groups(models: models, filter: .all, query: "", favorites: [], recents: ["m1"])
        XCTAssertEqual(short.map(\.id), ["anthropic"], "below eight rows the list is the answer")

        let starredView = JunoModelSelectorCatalog.groups(models: models, filter: .favorites, query: "", favorites: ["m3"])
        XCTAssertEqual(starredView.map(\.id), ["anthropic"])
        XCTAssertEqual(starredView[0].current.map(\.id), ["m3"])
    }

    func testTheSelectedRowAndItsAnchorPreferTheLabsOwnCopy() {
        let models = (1...8).map { model("m\($0)") } + [model("pic", modality: .image)]
        let groups = JunoModelSelectorCatalog.groups(
            models: models, filter: .all, query: "", favorites: ["pic"], recents: []
        )
        XCTAssertEqual(JunoModelSelectorCatalog.selectedKey("pic", in: groups), "pic")
        XCTAssertEqual(JunoModelSelectorCatalog.anchorKey(for: "pic", in: groups), "anthropic/modality:image")
        XCTAssertEqual(JunoModelSelectorCatalog.selectedKey("missing", in: groups), nil)
    }

    func testKeyboardSkipsHeadingsAndOnlyVisitsOpenLegacyRows() {
        let models = [
            model("text"),
            model("older", legacy: true),
            model("image", modality: .image),
        ]
        let groups = JunoModelSelectorCatalog.groups(models: models, filter: .all, query: "")

        XCTAssertEqual(
            JunoModelSelectorCatalog.keyboardOrder(groups: groups, expanded: [], searching: false),
            ["text", "image"]
        )
        XCTAssertEqual(
            JunoModelSelectorCatalog.keyboardOrder(groups: groups, expanded: ["anthropic"], searching: false),
            ["text", "image", "legacy:older"]
        )
        XCTAssertEqual(JunoModelSelectorCatalog.step(from: "image", by: 1, in: ["text", "image"]), "text")
        XCTAssertEqual(JunoModelSelectorCatalog.step(from: nil, by: -1, in: ["text", "image"]), "image")
    }

    func testDetailFactsReadAsTheWebsPanel() {
        let text = model(
            "anthropic:claude",
            price: JunoModelPrice(inputPerMillion: 3, outputPerMillion: 15),
            speed: 9,
            intelligence: 10,
            context: 1_000_000,
            capabilities: [.vision, .reasoning, .search, .tools]
        )
        XCTAssertEqual(
            JunoModelSelectorCatalog.stats(text).map { "\($0.label):\($0.value):\($0.score)" },
            ["Intelligence:10:10", "Speed:9:9", "Context:1M:10", "Cost:$3 · $15:3"]
        )
        XCTAssertEqual(JunoModelSelectorCatalog.capabilityLine(text), "Vision · Thinking · Web search · Tools")
        XCTAssertEqual(JunoModelSelectorCatalog.identifier(text), "claude")
        XCTAssertEqual(JunoModelSelectorCatalog.formatPrice(0.25), "$0.25")

        let image = model("image", modality: .image, price: JunoModelPrice(inputPerMillion: 0, outputPerMillion: 0))
        XCTAssertEqual(JunoModelSelectorCatalog.stats(image).map(\.label), ["Intelligence", "Speed", "Cost"])
        XCTAssertEqual(JunoModelSelectorCatalog.stats(image).last?.value, "Free")
    }

    func testTheButtonAndTheLockSpeakTheWebsWords() {
        let open = model("open")
        let locked = JunoModelDescriptor(id: "ultra", providerID: "anthropic", providerName: "Anthropic", displayName: "Ultra", unavailabilityReason: "Requires Plus")
        let soon = JunoModelDescriptor(id: "soon", providerID: "anthropic", providerName: "Anthropic", displayName: "Soon", unavailabilityReason: "Coming soon")
        XCTAssertEqual(JunoModelSelectorCatalog.useLabel(open, selected: false), "Use this model")
        XCTAssertEqual(JunoModelSelectorCatalog.useLabel(open, selected: true), "Selected")
        XCTAssertEqual(JunoModelSelectorCatalog.useLabel(locked, selected: false), "Get Plus")
        XCTAssertEqual(JunoModelSelectorCatalog.useLabel(soon, selected: false), "Not available yet")
        XCTAssertTrue(JunoModelSelectorCatalog.isLocked(locked))
        XCTAssertFalse(JunoModelSelectorCatalog.isLocked(soon))
        XCTAssertTrue(JunoModelSelectorCatalog.accessibilityLabel(locked).hasSuffix("needs Plus"))
    }

    func testRecentsKeepTheWebsThree() {
        var raw = ""
        for id in ["a", "b", "c", "d", "b"] { raw = JunoModelRecents.recording(id, in: raw) }
        XCTAssertEqual(JunoModelRecents.ids(in: raw), ["b", "d", "c"])
    }

    /// The chat composer's All view: picture and video models leave their
    /// labs for "Images" and "Video" sections after every lab, in the rail's
    /// lab order; a lab's own view and a search keep them under their lab.
    func testMediaSectionsCollectPicturesAndVideoAfterTheLabs() {
        let models = [
            model("gpt", provider: "openai", name: "OpenAI"),
            model("veo", provider: "google", name: "Google", modality: .video),
            model("nano", provider: "google", name: "Google", modality: .image),
            model("gemini", provider: "google", name: "Google"),
            model("gpt-image", provider: "openai", name: "OpenAI", modality: .image),
        ]
        let groups = JunoModelSelectorCatalog.groups(models: models, filter: .all, query: "", mediaSections: true)
        XCTAssertEqual(groups.map(\.id), ["openai", "google", "modality:image", "modality:video"])
        XCTAssertEqual(groups.map(\.label).suffix(2), ["Images", "Video"])
        XCTAssertEqual(groups[2].current.compactMap(\.model?.id), ["gpt-image", "nano"])
        XCTAssertEqual(groups[1].current.compactMap(\.model?.id), ["gemini"])

        let lab = JunoModelSelectorCatalog.groups(models: models, filter: .lab("google"), query: "", mediaSections: true)
        XCTAssertEqual(lab.flatMap { $0.current.compactMap(\.model?.id) }, ["gemini", "nano", "veo"])

        let plain = JunoModelSelectorCatalog.groups(models: models, filter: .all, query: "")
        XCTAssertEqual(plain.map(\.id), ["openai", "google"])
    }
}
