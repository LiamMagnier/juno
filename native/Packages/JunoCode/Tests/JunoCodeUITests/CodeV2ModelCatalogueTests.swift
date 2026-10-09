import XCTest
import JunoCodeCore
import JunoCodeRuntime
import JunoDesignSystem
@testable import JunoCodeUI

/// The Code picker's grouping, as the web's picker-catalogue tests pin it:
/// labs from Alevr and your keys, Subscriptions apart, text models only.
final class CodeV2ModelCatalogueTests: XCTestCase {
    private let directory = CodeV2Fixtures.directory

    func testLabsFollowTheWebsLabOrder() {
        let labs = CodeV2ModelCatalogue.labs(directory).map(\.id)
        XCTAssertEqual(labs, ["anthropic", "openai", "zhipu", "moonshot", "google", "deepseek", "xai", "qwen"])
        XCTAssertEqual(CodeV2ModelCatalogue.labs(directory).first?.name, "Anthropic")
    }

    func testALabListsAlevrThenYourKey() {
        let groups = CodeV2ModelCatalogue.groups(lab: "anthropic", directory: directory)
        XCTAssertEqual(groups.map(\.title), ["Alevr", "Your Anthropic key"])
        XCTAssertEqual(groups[0].entries.map(\.model.id), ["anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5-5", "anthropic:claude-haiku-4-5"])
        XCTAssertTrue(groups.allSatisfy { $0.entries.allSatisfy { !CodeV2ModelCatalogue.isSubscription($0.instance) } })
    }

    func testAKeyWithNoModelsReachesItsLabsAlevrModels() {
        let built = CodeV2ProviderDirectory.build(alevr: CodeV2Fixtures.alevr, envInstances: nil, byokKeys: [.openai])
        let key = try! XCTUnwrap(built.instance("byok:openai"))
        let ids = CodeV2ModelCatalogue.models(of: key, in: built).map(\.id)
        XCTAssertEqual(ids, ["openai:gpt-6.1", "openai:gpt-6-astra", "openai:gpt-5.4-mini"])
    }

    func testSubscriptionsHoldOnlyConnectedPlansNeverKeys() {
        let groups = CodeV2ModelCatalogue.subscriptionGroups(directory)
        XCTAssertEqual(groups.map(\.title), ["Claude plan", "ChatGPT plan"])
        XCTAssertNotNil(groups[0].trailing, "a plan's usage sits on its heading")
        XCTAssertFalse(groups.flatMap(\.entries).contains { $0.instance.kind == .byok || $0.instance.kind == .alevr })
    }

    func testNoConnectedSubscriptionMeansAnEmptySection() {
        XCTAssertTrue(CodeV2ModelCatalogue.subscriptionGroups(CodeV2Fixtures.directoryWithoutSubscriptions).isEmpty)
    }

    func testThePickerOpensWhereTheSelectionLives() {
        XCTAssertEqual(CodeV2ModelCatalogue.place(for: CodeV2Fixtures.claudeSelection, in: directory), .subscriptions)
        XCTAssertEqual(CodeV2ModelCatalogue.place(for: CodeV2Fixtures.alevrSelection, in: directory), .lab("openai"))
    }

    func testSearchGroupsByLabThenSubscriptions() {
        let groups = CodeV2ModelCatalogue.groups(place: .lab("openai"), directory: directory, query: "opus")
        XCTAssertEqual(groups.map(\.title), ["Anthropic", "Subscriptions"])
    }

    func testRowWords() {
        let line = CodeV2ModelCatalogue.rowLine(CodeV2Fixtures.opusAlevr, in: CodeV2Fixtures.alevr)
        XCTAssertEqual(line, "$5 / $25 · 1M")
        XCTAssertEqual(CodeV2ModelCatalogue.rowLine(CodeV2Fixtures.opusAlevr, in: CodeV2Fixtures.alevr, namesSource: true), "Alevr · $5 / $25 · 1M")
        XCTAssertEqual(CodeV2ModelCatalogue.rowLine(CodeV2Fixtures.claude.models![0], in: CodeV2Fixtures.claude), "Included in your plan · 1M")
        XCTAssertEqual(CodeV2ModelCatalogue.rowLine(CodeV2Fixtures.opusAlevr, in: CodeV2Fixtures.anthropicKey), "Your key · 1M")
    }

    func testTheAlevrInstanceKeepsDisplayOrderAndMarksTheBestDefault() {
        func option(_ id: String, rank: Int?, modality: JunoModelModality = .chat) -> ModelOption {
            ModelOption(catalog: JunoModelDescriptor(
                id: id, providerID: String(id.split(separator: ":")[0]), providerName: "Lab", displayName: id,
                modality: modality, codeAgentic: true, codeRank: rank
            ))
        }
        let instance = CodeV2AlevrCatalog.instance(from: [
            option("anthropic:claude-opus-5-5", rank: 2),
            option("openai:gpt-image-2.5", rank: nil, modality: .image),
            option("openai:gpt-6.1", rank: 1),
        ])
        XCTAssertEqual(instance.models?.map(\.id), ["anthropic:claude-opus-5-5", "openai:gpt-6.1"], "no image model, manifest order")
        XCTAssertEqual(instance.models?.first { $0.isDefault == true }?.id, "openai:gpt-6.1")
    }
}

final class CodeGenerationModelsTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "juno.code.tests.generation.\(UUID().uuidString)"
        return UserDefaults(suiteName: name)!
    }

    func testChoicesAreCurrentModelsOfTheKind() {
        let images = CodeGenerationModels.choices(.image, in: CodeV2Fixtures.generationModels).map(\.id)
        XCTAssertFalse(images.contains("openai:gpt-image-2"), "past generations are not offered")
        XCTAssertEqual(images.first, "openai:gpt-image-2.5-sunburst")
        XCTAssertEqual(CodeGenerationModels.kinds(in: CodeV2Fixtures.generationModels), [.image, .video, .audio])
    }

    func testTheDefaultIsTheNewestTiesInDisplayOrder() {
        let models = CodeV2Fixtures.generationModels
        XCTAssertEqual(CodeGenerationModels.resolved(.image, in: models, defaults: defaults()), "openai:gpt-image-2.5-sunburst")
        XCTAssertEqual(CodeGenerationModels.resolved(.video, in: models, defaults: defaults()), "minimax:MiniMax-H3")
        XCTAssertEqual(CodeGenerationModels.resolved(.audio, in: models, defaults: defaults()), "google:lyria-3.5")
    }

    func testAStoredChoiceWinsWhileTheCatalogueOffersIt() {
        let store = defaults()
        let models = CodeV2Fixtures.generationModels
        CodeGenerationModels.store("google:gemini-3.1-flash-image", for: .image, defaults: store)
        XCTAssertEqual(CodeGenerationModels.resolved(.image, in: models, defaults: store), "google:gemini-3.1-flash-image")
        CodeGenerationModels.store("openai:gpt-image-2", for: .image, defaults: store)
        XCTAssertEqual(CodeGenerationModels.resolved(.image, in: models, defaults: store), "openai:gpt-image-2.5-sunburst", "a past model falls back to the default")
        XCTAssertNil(CodeGenerationModels.resolved(.image, in: [], defaults: store))
    }
}
