import Foundation
import XCTest
@testable import JunoChatKit

final class ModelTierRouterTests: XCTestCase {
    private func model(
        id: String,
        speed: Int? = nil,
        intelligence: Int? = nil,
        inputPerMillion: Double? = nil,
        available: Bool = true,
        modality: String = "chat"
    ) -> NativeChatModelOption {
        NativeChatModelOption(
            id: id,
            providerID: "p",
            providerName: "P",
            displayName: id,
            minimumPlan: "free",
            availability: available ? "available" : "coming_soon",
            modality: modality,
            pricing: inputPerMillion.map {
                NativeModelPricing(
                    priceClass: "standard",
                    inputPerMillion: $0,
                    outputPerMillion: $0 * 4,
                    currency: "USD"
                )
            },
            grades: (speed != nil && intelligence != nil)
                ? NativeModelGrades(speed: speed!, intelligence: intelligence!)
                : nil,
            supportedReasoningEfforts: [],
            canDisableReasoning: false,
            supportsStreaming: true
        )
    }

    private func catalog(_ models: [NativeChatModelOption]) -> NativeChatModelCatalog {
        NativeChatModelCatalog(
            manifestVersion: "v1",
            contractDigest: "d",
            generatedAt: Date(),
            models: models
        )
    }

    private let router = ModelTierRouter()

    private var mixed: NativeChatModelCatalog {
        catalog([
            model(id: "haiku", speed: 9, intelligence: 4, inputPerMillion: 1),
            model(id: "opus", speed: 3, intelligence: 10, inputPerMillion: 15),
            model(id: "auto"), // a router: no grades
        ])
    }

    func testDisposableWorkRoutesToTheFastTier() {
        for task in [NativeChatTaskClass.conversationTitle, .summary, .simpleQuestion, .lightweightAssist] {
            let decision = router.route(
                task: task, preference: .automatic, catalog: mixed, fallback: "fb"
            )
            XCTAssertEqual(decision.modelID, "haiku", "\(task) should be cheap")
            XCTAssertEqual(decision.reason, .automatic(task: task, tier: .fast))
        }
    }

    func testWorkTheReaderBuildsOnRoutesToTheDeepTier() {
        for task in [NativeChatTaskClass.coding, .multiStepTools, .complexReasoning] {
            let decision = router.route(
                task: task, preference: .automatic, catalog: mixed, fallback: "fb"
            )
            XCTAssertEqual(decision.modelID, "opus", "\(task) should be capable")
            XCTAssertEqual(decision.reason, .automatic(task: task, tier: .deep))
        }
    }

    /// An unclassified turn must not be optimised for cost — the reader is the
    /// one who cannot see why the answer got worse.
    func testUnknownWorkRoutesDeepNotCheap() {
        let decision = router.route(
            task: .general, preference: .automatic, catalog: mixed, fallback: "fb"
        )
        XCTAssertEqual(decision.modelID, "opus")
    }

    /// A lock is an explicit choice. Re-routing under it would make the model
    /// picker a suggestion box.
    func testManualLockIsHonouredVerbatimForEveryTask() {
        for task in NativeChatTaskClass.allCases {
            let decision = router.route(
                task: task,
                preference: .manualLock(modelID: "locked-model"),
                catalog: mixed,
                fallback: "fb"
            )
            XCTAssertEqual(decision.modelID, "locked-model")
            XCTAssertEqual(decision.reason, .manualLock)
        }
    }

    /// Even a model absent from the catalog: the server's error naming it beats
    /// the client silently substituting something else.
    func testManualLockIsNotValidatedAgainstTheCatalog() {
        let decision = router.route(
            task: .coding,
            preference: .manualLock(modelID: "not-in-catalog"),
            catalog: mixed,
            fallback: "fb"
        )
        XCTAssertEqual(decision.modelID, "not-in-catalog")
    }

    func testAutoIsNeverChosenForTheFastTier() {
        // Auto has no grades because it is a router — it may pick anything,
        // including the expensive model the fast tier exists to avoid.
        let onlyAutoAndOpus = catalog([
            model(id: "auto"),
            model(id: "opus", speed: 3, intelligence: 10, inputPerMillion: 15),
        ])
        let decision = router.route(
            task: .conversationTitle, preference: .automatic,
            catalog: onlyAutoAndOpus, fallback: "fb"
        )
        XCTAssertEqual(decision.modelID, "opus")
        XCTAssertEqual(
            decision.reason,
            .tierUnavailable(requested: .fast, served: .deep),
            "Serving from the other tier must be recorded as a substitution"
        )
    }

    func testUnavailableAndNonChatModelsAreNeverRouted() {
        let unusable = catalog([
            model(id: "gone", speed: 10, intelligence: 10, inputPerMillion: 0.1, available: false),
            model(id: "image", speed: 10, intelligence: 10, inputPerMillion: 0.1, modality: "image"),
            model(id: "haiku", speed: 8, intelligence: 4, inputPerMillion: 1),
        ])
        let decision = router.route(
            task: .summary, preference: .automatic, catalog: unusable, fallback: "fb"
        )
        XCTAssertEqual(decision.modelID, "haiku")
    }

    func testAnEmptyCatalogFallsBackAndSaysSo() {
        let decision = router.route(
            task: .coding, preference: .automatic, catalog: catalog([]), fallback: "fb"
        )
        XCTAssertEqual(decision.modelID, "fb")
        XCTAssertEqual(decision.reason, .fallback)
    }

    /// An unpriced model must not win a cheapest-first tiebreak by looking free.
    func testUnpricedModelsSortLastOnATie() {
        let tied = catalog([
            model(id: "unpriced", speed: 9, intelligence: 4),
            model(id: "priced", speed: 9, intelligence: 4, inputPerMillion: 2),
        ])
        XCTAssertEqual(router.candidates(for: .fast, in: tied).map(\.id), ["priced", "unpriced"])
    }

    func testCustomPolicyOverridesTheBuiltInTable() {
        struct AlwaysFast: NativeModelTierResolving {
            func tier(for task: NativeChatTaskClass) -> NativeModelTier { .fast }
        }
        let decision = ModelTierRouter(policy: AlwaysFast()).route(
            task: .coding, preference: .automatic, catalog: mixed, fallback: "fb"
        )
        XCTAssertEqual(decision.modelID, "haiku")
    }

    func testIsSwapOnlyReportsARealChange() {
        let decision = NativeModelRoutingDecision(modelID: "haiku", reason: .manualLock)
        XCTAssertTrue(decision.isSwap(from: "opus"))
        XCTAssertFalse(decision.isSwap(from: "haiku"))
        XCTAssertFalse(decision.isSwap(from: nil), "Nothing was selected, so nothing was swapped")
    }
}

/// The classifier decides how a turn gets billed and how good its answer is.
/// Its bias towards `.deep` is the property under test, not an accident.
final class NativeChatTaskClassifierTests: XCTestCase {
    private func signals(
        _ prompt: String,
        attachments: Bool = false,
        research: Bool = false,
        search: Bool = false,
        connectors: Int = 0
    ) -> NativeComposerSignals {
        NativeComposerSignals(
            prompt: prompt,
            hasAttachments: attachments,
            deepResearch: research,
            webSearch: search,
            connectorCount: connectors
        )
    }

    func testAnyToolAxisMeansMultiStep() {
        XCTAssertEqual(NativeChatTaskClassifier.classify(signals("hi", research: true)), .multiStepTools)
        XCTAssertEqual(NativeChatTaskClassifier.classify(signals("hi", search: true)), .multiStepTools)
        XCTAssertEqual(NativeChatTaskClassifier.classify(signals("hi", connectors: 1)), .multiStepTools)
    }

    func testCodeShapedPromptsClassifyAsCoding() {
        XCTAssertEqual(NativeChatTaskClassifier.classify(signals("```swift\nlet x = 1\n```")), .coding)
        XCTAssertEqual(NativeChatTaskClassifier.classify(signals("why does func foo() crash")), .coding)
        XCTAssertEqual(NativeChatTaskClassifier.classify(signals("SELECT * FROM users")), .coding)
    }

    func testAShortSingleLineQuestionIsTheOnlyThingCalledSimple() {
        XCTAssertEqual(NativeChatTaskClassifier.classify(signals("what is the capital of France?")), .simpleQuestion)
    }

    /// Each of these must NOT be called simple — the bias that protects answer
    /// quality when the guess is wrong.
    func testAmbiguousWorkFallsBackToGeneralRatherThanCheap() {
        XCTAssertEqual(NativeChatTaskClassifier.classify(signals("summarise this", attachments: true)), .general,
                       "A document to reason over is not a quick question")
        XCTAssertEqual(NativeChatTaskClassifier.classify(signals("do this:\n- a\n- b")), .general,
                       "Multi-line means structure")
        XCTAssertEqual(NativeChatTaskClassifier.classify(signals(String(repeating: "a", count: 400))), .general,
                       "A long prompt is not a quick question")
    }

    /// `.general` must route deep, or the bias above buys nothing.
    func testGeneralRoutesDeepUnderTheDefaultPolicy() {
        XCTAssertEqual(NativeDefaultModelTierPolicy().tier(for: .general), .deep)
    }
}
