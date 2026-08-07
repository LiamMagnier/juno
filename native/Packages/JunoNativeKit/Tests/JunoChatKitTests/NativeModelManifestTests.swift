import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoSync
import XCTest
@testable import JunoChatKit

/// The manifest is the single source of truth for what the pickers may show.
/// These cover the fields the redesigned selector depends on, and the shapes it
/// must refuse rather than render as something plausible.
final class NativeModelManifestTests: XCTestCase {
    private let accountID = try! AccountID("account_12345678")

    func testRichModelFieldsSurviveDecoding() async throws {
        let client = client(body: manifest(models: [fullModel]))

        let catalog = try await client.modelCatalog(for: accountID)
        let model = try XCTUnwrap(catalog.models.first)

        XCTAssertEqual(model.displayName, "Kimi K3")
        XCTAssertEqual(model.providerName, "Moonshot · Kimi")
        XCTAssertEqual(model.summary, "Moonshot's flagship reasoner.")
        XCTAssertEqual(model.contextWindowTokens, 1_000_000)
        XCTAssertEqual(model.grades, NativeModelGrades(speed: 2, intelligence: 10))
        XCTAssertEqual(model.pricing?.priceClass, "premium")
        XCTAssertTrue(model.supportsVision)
        XCTAssertTrue(model.supportsWebSearch)
        XCTAssertEqual(model.supportedReasoningEfforts, [.low, .high, .max])
        XCTAssertNil(model.unavailability)
        XCTAssertTrue(model.supportsProMode)
        XCTAssertEqual(model.fastModeRateMultiplier, 2.5)
        XCTAssertTrue(model.supportsFastMode)
        // Pro is a mode, never a rung. If it ever leaks into the ladder the
        // client will send "pro" where the route expects a reasoning effort.
        XCTAssertEqual(NativeThinkingScale(model: model).stops.map(\.id), ["low", "high", "max"])
    }

    func testAServerThatPredatesTheModesStillDecodes() async throws {
        // The whole catalog is decoded in one do/catch, so a field this build
        // expects and an older server does not send is not a missing toggle —
        // it is an empty model picker. Both keys are stripped here to prove the
        // absence is tolerated rather than fatal.
        let older = fullModel
            .replacingOccurrences(of: ",\"supportsProMode\":true", with: "")
            .replacingOccurrences(of: "\"fastMode\": {\"rateMultiplier\":2.5},", with: "")
        let client = client(body: manifest(models: [older]))

        let catalog = try await client.modelCatalog(for: accountID)
        let model = try XCTUnwrap(catalog.models.first)

        XCTAssertEqual(model.displayName, "Kimi K3", "the rest of the row must still decode")
        XCTAssertFalse(model.supportsProMode)
        XCTAssertNil(model.fastModeRateMultiplier)
        XCTAssertFalse(model.supportsFastMode)
    }

    func testAutoOffersNeitherModeHoweverTheServerAnswers() async throws {
        // Auto routes per message, so a premium agreed to on the router would be
        // charged on a model the reader never picked. The client refuses on its
        // own rather than trusting the server to keep saying false.
        let permissiveAuto = autoModel
            .replacingOccurrences(
                of: "\"automatic\":true",
                with: "\"automatic\":true,\"supportsProMode\":true"
            )
            .replacingOccurrences(
                of: "\"deprecationNote\": null",
                with: "\"fastMode\": {\"rateMultiplier\":2}, \"deprecationNote\": null"
            )
        let client = client(body: manifest(models: [permissiveAuto]))

        let catalog = try await client.modelCatalog(for: accountID)
        let auto = try XCTUnwrap(catalog.models.first)

        XCTAssertTrue(auto.choosesReasoningAutomatically)
        XCTAssertFalse(auto.supportsProMode)
        XCTAssertNil(auto.fastModeRateMultiplier)
    }

    func testRetirementDateSurvivesDecodingAndFormats() async throws {
        // The date is what a person acts on; `deprecationNote` only says it in a
        // sentence, which no client can parse. A model with no announced
        // retirement — most of the catalog — must decode to nil, not to a
        // fabricated date.
        let retiring = fullModel.replacingOccurrences(
            of: "\"deprecationNote\": null",
            with: "\"deprecationNote\": \"Retires Oct 23, 2026 — use GPT-5.5\", \"retiresOn\": \"2026-10-23\""
        )
        let client = client(body: manifest(models: [retiring]))

        let catalog = try await client.modelCatalog(for: accountID)
        let model = try XCTUnwrap(catalog.models.first)

        XCTAssertEqual(model.retiresOn, "2026-10-23")
        XCTAssertEqual(JunoModelFormatting.retirementDate("2026-10-23"), "23 Oct 2026")
        XCTAssertEqual(model.junoDescriptor.retiresOn, "2026-10-23")
    }

    func testAModelWithNoRetirementDecodesToNil() async throws {
        let client = client(body: manifest(models: [fullModel]))

        let catalog = try await client.modelCatalog(for: accountID)
        let model = try XCTUnwrap(catalog.models.first)

        XCTAssertNil(model.retiresOn)
        XCTAssertNil(model.junoDescriptor.retiresOn)
    }

    func testAMalformedRetirementDateIsNotRendered() async throws {
        // Rendering has to refuse anything that is not a calendar day rather
        // than print the raw string into a spec sheet.
        XCTAssertNil(JunoModelFormatting.retirementDate("soon"))
        XCTAssertNil(JunoModelFormatting.retirementDate("2026-13-01"))
        XCTAssertNil(JunoModelFormatting.retirementDate("26-10-23"))
        XCTAssertEqual(JunoModelFormatting.retirementDate("2026-01-05"), "5 Jan 2026")
    }

    func testServerOrderIsPreservedSoAutoStaysFirst() async throws {
        let client = client(body: manifest(models: [autoModel, fullModel]))

        let catalog = try await client.modelCatalog(for: accountID)

        XCTAssertEqual(catalog.models.map(\.id), ["juno:auto", "moonshot:kimi-k3"])
    }

    func testAutoDecodesAsAutomaticWithNoGradesToShow() async throws {
        let client = client(body: manifest(models: [autoModel]))

        let catalog = try await client.modelCatalog(for: accountID)
        let model = try XCTUnwrap(catalog.models.first)

        XCTAssertTrue(model.choosesReasoningAutomatically)
        XCTAssertTrue(model.supportedReasoningEfforts.isEmpty)
        XCTAssertNil(model.grades)
        XCTAssertNil(model.pricing)
        XCTAssertNil(model.contextWindowTokens)
        XCTAssertEqual(model.highlights.count, 1)
    }

    func testPlanGatedModelIsUnavailableWithTheEnforcedPlan() async throws {
        let client = client(body: manifest(models: [gatedModel]))

        let catalog = try await client.modelCatalog(for: accountID)
        let model = try XCTUnwrap(catalog.models.first)

        XCTAssertFalse(model.isAvailable)
        XCTAssertTrue(model.isChatCapable)
        XCTAssertEqual(model.unavailability, .requiresPlan("max"))
        XCTAssertEqual(NativeModelPresentation.unavailabilityReason(model), "Requires Max")
    }

    func testAnOutOfRangeGradeIsRejectedRatherThanClamped() async throws {
        let client = client(body: manifest(models: [
            fullModel.replacingOccurrences(
                of: #""metrics": {"speed":2,"intelligence":10}"#,
                with: #""metrics": {"speed":2,"intelligence":42}"#
            ),
        ]))

        await assertMalformed(client)
    }

    func testAnAutomaticModelPublishingTiersIsRejected() async throws {
        // Auto plus a ladder has no coherent meaning for the slider; a manifest
        // that says both is a contract break, not something to guess through.
        let client = client(body: manifest(models: [
            autoModel.replacingOccurrences(
                of: #""supportedReasoningEfforts": []"#,
                with: #""supportedReasoningEfforts": ["high"]"#
            ),
        ]))

        await assertMalformed(client)
    }

    func testAnUnknownEffortTierIsRejected() async throws {
        let client = client(body: manifest(models: [
            fullModel.replacingOccurrences(of: #""max""#, with: #""ludicrous""#)
        ]))

        await assertMalformed(client)
    }

    func testMissingOptionalCopyDegradesInsteadOfFailing() async throws {
        let client = client(body: manifest(models: [
            fullModel.replacingOccurrences(
                of: #""description": "Moonshot's flagship reasoner.""#,
                with: #""description": null"#
            ),
        ]))

        let catalog = try await client.modelCatalog(for: accountID)
        let model = try XCTUnwrap(catalog.models.first)

        XCTAssertNil(model.summary)
        XCTAssertEqual(model.displayName, "Kimi K3")
    }

    // MARK: Presentation

    func testContextWindowMatchesTheWebFormatting() {
        XCTAssertEqual(NativeModelPresentation.contextWindow(1_000_000), "1M")
        XCTAssertEqual(NativeModelPresentation.contextWindow(1_500_000), "1.5M")
        XCTAssertEqual(NativeModelPresentation.contextWindow(200_000), "200K")
    }

    func testCostGlyphIsAbsentWithoutRealPricing() {
        XCTAssertNil(NativeModelPresentation.costGlyph(nil))
        XCTAssertEqual(
            NativeModelPresentation.costGlyph(
                NativeModelPricing(
                    priceClass: "premium", inputPerMillion: 3,
                    outputPerMillion: 15, currency: "USD"
                )
            ),
            "$$$"
        )
    }

    // MARK: Fixtures

    private func assertMalformed(_ client: NativeChatAPIClient) async {
        do {
            _ = try await client.modelCatalog(for: accountID)
            XCTFail("Expected the manifest to be rejected")
        } catch {
            XCTAssertEqual(error as? NativeChatAPIError, .malformedResponse)
        }
    }

    private func client(body: String) -> NativeChatAPIClient {
        NativeChatAPIClient(
            sender: RecordingModelSender(body: body),
            streamer: UnusedChatStreamer()
        )
    }

    private func manifest(models: [String]) -> String {
        """
        {"manifestVersion":"v1-test",
         "contractDigest":"\(String(repeating: "a", count: 64))",
         "generatedAt":"2026-07-22T00:00:00.000Z",
         "models":[\(models.joined(separator: ","))]}
        """
    }

    private let fullModel = """
    {
      "id": "moonshot:kimi-k3",
      "provider": {"id":"moonshot","displayName":"Moonshot · Kimi"},
      "displayName": "Kimi K3",
      "description": "Moonshot's flagship reasoner.",
      "highlights": null,
      "lifecycle": "active",
      "availability": "available",
      "minimumPlan": "free",
      "requiredPlan": "pro",
      "modalities": {"input":["text","image"],"output":["text"]},
      "contextWindowTokens": 1000000,
      "pricing": {"class":"premium","inputPerMillion":2.4,"outputPerMillion":10,"currency":"USD","source":"official"},
      "metrics": {"speed":2,"intelligence":10},
      "supportedReasoningEfforts": ["low","high","max"],
      "reasoning": {"supported":true,"canDisable":false,"onOffOnly":false,"automatic":false,"supportsProMode":true},
      "capabilities": {"tools":true,"vision":true,"webSearch":true,"attachments":true,"streaming":true},
      "fastMode": {"rateMultiplier":2.5},
      "deprecationNote": null
    }
    """

    private let autoModel = """
    {
      "id": "juno:auto",
      "provider": {"id":"juno","displayName":"Juno"},
      "displayName": "Auto",
      "description": "Picks the cheapest model and thinking depth for each prompt.",
      "highlights": ["Short asks go to budget models."],
      "lifecycle": "active",
      "availability": "available",
      "minimumPlan": "free",
      "requiredPlan": "free",
      "modalities": {"input":["text","image"],"output":["text"]},
      "contextWindowTokens": null,
      "pricing": null,
      "metrics": null,
      "supportedReasoningEfforts": [],
      "reasoning": {"supported":true,"canDisable":true,"onOffOnly":false,"automatic":true},
      "capabilities": {"tools":true,"vision":true,"webSearch":true,"attachments":true,"streaming":true},
      "deprecationNote": null
    }
    """

    private let gatedModel = """
    {
      "id": "xai:grok-5",
      "provider": {"id":"xai","displayName":"xAI · Grok"},
      "displayName": "Grok 5",
      "description": null,
      "highlights": null,
      "lifecycle": "active",
      "availability": "requires_plan",
      "minimumPlan": "free",
      "requiredPlan": "max",
      "modalities": {"input":["text"],"output":["text"]},
      "contextWindowTokens": 256000,
      "pricing": {"class":"premium","inputPerMillion":5,"outputPerMillion":15,"currency":"USD","source":"official"},
      "metrics": {"speed":5,"intelligence":9},
      "supportedReasoningEfforts": ["low","high"],
      "reasoning": {"supported":true,"canDisable":true,"onOffOnly":false,"automatic":false},
      "capabilities": {"tools":true,"vision":false,"webSearch":true,"attachments":true,"streaming":true},
      "deprecationNote": null
    }
    """
}

private actor UnusedChatStreamer: NativeAuthenticatedByteStreaming {
    func stream(_: NativeBearerRequest, for _: AccountID) async throws
        -> HTTPByteStreamResponse
    {
        throw NativeChatAPIError.malformedResponse
    }
}

private actor RecordingModelSender: NativeAuthenticatedRequestSending {
    private let body: String

    init(body: String) { self.body = body }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        HTTPResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            body: Data(body.utf8)
        )
    }
}
