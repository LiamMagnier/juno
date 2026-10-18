import Foundation
import XCTest
@testable import JunoChatKit

/// Images made in chat (G04): the `imageGeneration` card on an activity row,
/// read tolerantly; the same row replacing itself as the call moves; and the
/// composer's "Create image" switch — which model it picks (the web's
/// `src/lib/router/image-route.ts` ranking) and which it gives back.
final class NativeImageGenerationTests: XCTestCase {
    private func decode(_ json: String) throws -> NativeChatActivity {
        let wire = try JSONDecoder().decode(NativeActivityWire.self, from: Data(json.utf8))
        return try XCTUnwrap(wire.activity(parseDate: { _ in nil }))
    }

    private func row(id: String = "img-row", _ generation: String) -> String {
        #"{"id":""# + id + #"","kind":"tool","title":"Creating an image","imageGeneration":"# + generation + "}"
    }

    private let generating = #"""
    {"v":1,"callId":"image-abc123-1","status":"generating","prompt":"A lighthouse at dusk","modelId":null,
     "modelName":null,"auto":true,"aspect":"16:9","count":1,"referenceAttachmentId":null,"attachmentIds":[],"failure":null}
    """#

    private let done = #"""
    {"v":1,"callId":"image-abc123-1","status":"done","prompt":"A lighthouse at dusk","modelId":"google:gemini-nano-banana-2.1",
     "modelName":"Nano Banana 2.1","auto":true,"aspect":"16:9","count":2,"referenceAttachmentId":null,
     "attachmentIds":["att_1","att_2"],
     "images":[{"id":"att_1","kind":"IMAGE","fileName":"lighthouse.png","mimeType":"image/png","size":48211,"url":"/api/files/k1","width":1024,"height":576},
               {"id":"att_2","kind":"IMAGE","fileName":"lighthouse-2.png","mimeType":"image/png","size":48000,"url":"/api/files/k2"},
               {"id":"att_bad","kind":"FILE","fileName":"x.tiff","mimeType":"image/tiff","size":1}]}
    """#

    // MARK: Decoding

    func testAGeneratingRowCarriesTheCard() throws {
        let activity = try decode(row(generating))
        let generation = try XCTUnwrap(activity.imageGeneration)
        XCTAssertEqual(generation.callID, "image-abc123-1")
        XCTAssertEqual(generation.status, .generating)
        XCTAssertEqual(generation.prompt, "A lighthouse at dusk")
        XCTAssertNil(generation.modelName)
        XCTAssertEqual(generation.aspect, "16:9")
        XCTAssertEqual(generation.count, 1)
        XCTAssertTrue(generation.attachmentIDs.isEmpty)
        XCTAssertNil(generation.failure)
        XCTAssertEqual(generation.mediaProgress, NativeMediaProgress(modality: .image, stage: "generating", pct: nil))
    }

    func testADoneRowCarriesItsFilesAndDropsWhatItCannotDraw() throws {
        let generation = try XCTUnwrap(decode(row(done)).imageGeneration)
        XCTAssertEqual(generation.status, .done)
        XCTAssertEqual(generation.attachmentIDs, ["att_1", "att_2"])
        XCTAssertEqual(generation.images.map(\.id), ["att_1", "att_2"])
        XCTAssertEqual(generation.images.first?.url, "/api/files/k1")
        XCTAssertEqual(generation.images.first?.width, 1024)
        XCTAssertEqual(generation.caption, .autoPicked(model: "Nano Banana 2.1"))
    }

    func testAFailedRowNamesItsCause() throws {
        let failed = #"""
        {"v":1,"callId":"c","status":"failed","prompt":"p","modelId":"openai:gpt-image-2.5-sunburst","modelName":"GPT Image 2.5 Sunburst",
         "auto":false,"aspect":null,"count":1,"referenceAttachmentId":null,"attachmentIds":[],
         "failure":{"code":"plan_required","message":"GPT Image 2.5 Sunburst needs the Pro plan.","model":"GPT Image 2.5 Sunburst","plan":"Pro"}}
        """#
        let generation = try XCTUnwrap(decode(row(failed)).imageGeneration)
        XCTAssertEqual(generation.failure?.code, .planRequired)
        XCTAssertEqual(generation.failureSentence, .plan(model: "GPT Image 2.5 Sunburst", plan: "Pro"))
        XCTAssertNil(generation.caption)
    }

    func testAnUnknownFailureCodeDecodesAndFallsBackToTheServersWords() throws {
        let failed = #"""
        {"v":1,"callId":"c","status":"failed","failure":{"code":"solar_flare","message":"The sun got in the way."}}
        """#
        let generation = try XCTUnwrap(decode(row(failed)).imageGeneration)
        XCTAssertEqual(generation.failure?.code, .unknown("solar_flare"))
        XCTAssertEqual(generation.failureSentence, .message("The sun got in the way."))
    }

    func testASentenceThatNeedsAModelBorrowsTheCallsAndFallsBackWithoutOne() throws {
        let withModel = NativeImageGeneration(
            callID: "c", status: .failed, modelName: "Grok Imagine 2.0",
            failure: .init(code: .providerUnavailable, message: "down")
        )
        XCTAssertEqual(withModel.failureSentence, .unavailable(model: "Grok Imagine 2.0"))
        let withoutModel = NativeImageGeneration(
            callID: "c", status: .failed,
            failure: .init(code: .providerUnavailable, message: "No image model could be reached.")
        )
        XCTAssertEqual(withoutModel.failureSentence, .message("No image model could be reached."))
    }

    func testMissingOptionalFieldsTakeTheirDefaults() throws {
        let generation = try XCTUnwrap(decode(row(#"{"callId":"c","status":"done"}"#)).imageGeneration)
        XCTAssertEqual(generation.prompt, "")
        XCTAssertTrue(generation.auto)
        XCTAssertEqual(generation.count, 1)
        XCTAssertTrue(generation.images.isEmpty)
        XCTAssertNil(generation.caption)
    }

    func testAWrongTypedFieldCostsTheFieldNotTheRow() throws {
        let odd = #"{"callId":"c","status":"done","modelName":42,"count":"two","attachmentIds":"att_1","auto":"yes","images":7}"#
        let generation = try XCTUnwrap(decode(row(odd)).imageGeneration)
        XCTAssertNil(generation.modelName)
        XCTAssertEqual(generation.count, 1)
        XCTAssertTrue(generation.attachmentIDs.isEmpty)
        XCTAssertTrue(generation.auto)
    }

    func testAMalformedCardCostsTheCardNotTheRow() throws {
        let noCallID = try decode(row(#"{"status":"done"}"#))
        XCTAssertEqual(noCallID.title, "Creating an image")
        XCTAssertNil(noCallID.imageGeneration)
        let unknownStatus = try decode(row(#"{"callId":"c","status":"queued"}"#))
        XCTAssertNil(unknownStatus.imageGeneration)
        let notAnObject = try decode(row(#""generating""#))
        XCTAssertNil(notAnObject.imageGeneration)
    }

    // MARK: On screen

    func testAFinishedMessageNeverLeavesAPictureSpinning() {
        let lingering = NativeImageGeneration(callID: "c", status: .generating, modelName: "Nano Banana 2.1")
        XCTAssertEqual(lingering.settled(live: true).status, .generating)
        let settled = lingering.settled(live: false)
        XCTAssertEqual(settled.status, .failed)
        XCTAssertEqual(settled.failureSentence, .provider(model: "Nano Banana 2.1"))
    }

    func testLivePicturesAreDrawnOnlyUntilTheAnswerCarriesThem() throws {
        let generation = try XCTUnwrap(decode(row(done)).imageGeneration)
        XCTAssertEqual(generation.liveImages(answerAttachmentIDs: []).map(\.id), ["att_1", "att_2"])
        XCTAssertEqual(generation.liveImages(answerAttachmentIDs: ["att_1"]).map(\.id), ["att_2"])
        XCTAssertTrue(generation.liveImages(answerAttachmentIDs: ["att_1", "att_2"]).isEmpty)
    }

    func testTheSameRowReSentReplacesItselfInPlace() throws {
        var stream = NativeTurnStream()
        stream.apply(.activity(try decode(row(id: "a-ctx", #"{"callId":"other","status":"done"}"#))))
        stream.apply(.activity(try decode(row(generating))))
        stream.apply(.activity(try decode(row(done))))
        XCTAssertEqual(stream.activity.count, 2)
        XCTAssertEqual(stream.activity.last?.imageGeneration?.status, .done)
        let generations = NativeChatActivity.imageGenerations(in: stream.activity, live: true)
        XCTAssertEqual(generations.map(\.callID), ["other", "image-abc123-1"])
    }

    // MARK: The run row

    private func call(_ status: String, error: String = "") throws -> NativeToolCall {
        let json = #"{"id":"r","kind":"tool","title":"Creating an image","call":{"callId":"c1","tool":"generate_image","status":""#
            + status + #"""# + error + "}}"
        return try XCTUnwrap(decode(json).call)
    }

    func testTheRunRowSpeaksForAPictureNotAConnector() throws {
        let running = try call("running")
        XCTAssertEqual(NativeToolPresentation.runningLine(running).text, "Creating an image")
        XCTAssertEqual(NativeToolPresentation.iconName(running), "image")
        XCTAssertEqual(NativeToolPresentation.doneLine(try call("succeeded")).text, "Created an image")
        let failed = try call("failed", error: #","error":{"code":"provider_error"}"#)
        XCTAssertEqual(NativeToolPresentation.failedLine(failed).text, "Image not created")
        XCTAssertEqual(NativeRunPhase.phase(of: running), .tool)
    }

    // MARK: Create image

    private func model(
        _ id: String,
        modality: String = "image",
        price: String = "standard",
        released: String? = nil,
        availability: String = "available",
        lifecycle: String = "active",
        legacy: Bool = false
    ) -> NativeChatModelOption {
        NativeChatModelOption(
            id: id,
            providerID: "lab",
            providerName: "Lab",
            displayName: id,
            minimumPlan: "free",
            availability: availability,
            lifecycle: lifecycle,
            modality: modality,
            isLegacy: legacy,
            released: released,
            pricing: NativeModelPricing(priceClass: price, inputPerMillion: 0, outputPerMillion: 0, currency: "USD"),
            supportedReasoningEfforts: [],
            canDisableReasoning: false,
            supportsStreaming: modality == "chat"
        )
    }

    private var catalog: [NativeChatModelOption] {
        [
            model("auto", modality: "chat"),
            model("anthropic:claude-sonnet", modality: "chat"),
            model("openai:gpt-image-2.5-sunburst", price: "premium", released: "2026-09"),
            model("openai:gpt-image-2.5-flare", price: "standard", released: "2026-09"),
            model("google:gemini-3-pro-image", price: "premium", released: "2025-11"),
            model("google:gemini-nano-banana-2.1", price: "standard", released: "2026-10"),
            model("google:gemini-3.1-flash-lite-image", price: "economy", released: "2026-04"),
            model("meta:muse-image-1.0", price: "economy", released: "2026-08"),
            model("openai:gpt-image-2", price: "premium", released: "2026-05", lifecycle: "legacy", legacy: true),
            model("openai:gpt-image-1", price: "standard", lifecycle: "deprecated"),
            model("xai:grok-imagine-image-2.0", availability: "requires_plan"),
            model("google:veo", modality: "video"),
        ]
    }

    func testTheDefaultIsTheBestPictureForItsCostAmongUsableModels() {
        // Nano Banana 2.1 and Flare tie at 8 − 2.4; the newer release wins.
        XCTAssertEqual(NativeImageMode.defaultImageModel(catalog: catalog, lastUsedID: nil)?.id, "google:gemini-nano-banana-2.1")
        XCTAssertEqual(
            NativeImageMode.usableImageModels(in: catalog).map(\.id).sorted(),
            [
                "google:gemini-3-pro-image", "google:gemini-3.1-flash-lite-image", "google:gemini-nano-banana-2.1",
                "meta:muse-image-1.0", "openai:gpt-image-2.5-flare", "openai:gpt-image-2.5-sunburst",
            ]
        )
    }

    func testTheLastUsedModelWinsWhileItIsStillUsable() {
        XCTAssertEqual(
            NativeImageMode.defaultImageModel(catalog: catalog, lastUsedID: "meta:muse-image-1.0")?.id,
            "meta:muse-image-1.0"
        )
        // Superseded, deprecated, locked or not a picture model: the ranking decides.
        for stale in ["openai:gpt-image-2", "openai:gpt-image-1", "xai:grok-imagine-image-2.0", "google:veo", "gone"] {
            XCTAssertEqual(
                NativeImageMode.defaultImageModel(catalog: catalog, lastUsedID: stale)?.id,
                "google:gemini-nano-banana-2.1",
                stale
            )
        }
    }

    func testNoUsableImageModelMeansNoDefault() {
        let chatOnly = catalog.filter { $0.modality != "image" || $0.isLegacy }
        XCTAssertNil(NativeImageMode.defaultImageModel(catalog: chatOnly, lastUsedID: nil))
    }

    func testTheRankingMirrorsTheWebsFamilies() {
        XCTAssertEqual(NativeImageMode.quality(of: model("openai:gpt-image-2.5-sunburst")), 9)
        XCTAssertEqual(NativeImageMode.quality(of: model("openai:gpt-image-1-mini")), 5)
        XCTAssertEqual(NativeImageMode.quality(of: model("google:gemini-3-pro-image")), 9)
        XCTAssertEqual(NativeImageMode.quality(of: model("google:gemini-3.1-flash-lite-image")), 5)
        XCTAssertEqual(NativeImageMode.quality(of: model("xai:grok-imagine-image-2.0")), 7)
        XCTAssertEqual(NativeImageMode.quality(of: model("xai:grok-imagine-image")), 5)
        XCTAssertEqual(NativeImageMode.quality(of: model("zhipu:glm-image")), 6)
        XCTAssertEqual(NativeImageMode.quality(of: model("minimax:image-01-live")), 6)
        XCTAssertEqual(NativeImageMode.quality(of: model("someone:new-picture-model")), 5.5)
        XCTAssertEqual(NativeImageMode.costTier(of: model("x", price: "economy")), 1)
        XCTAssertEqual(NativeImageMode.costTier(of: model("x", price: "premium")), 3)
    }

    func testLeavingImageModeRestoresTheChatModelItInterrupted() {
        var mode = NativeImageMode()
        let picked = mode.enter(currentModelID: "anthropic:claude-sonnet", catalog: catalog, lastUsedImageModelID: nil)
        XCTAssertEqual(picked, "google:gemini-nano-banana-2.1")
        // Switching image models in the picker does not forget the chat model.
        mode.observe(selectedModelID: "openai:gpt-image-2.5-flare", catalog: catalog)
        XCTAssertEqual(mode.exit(catalog: catalog), "anthropic:claude-sonnet")
    }

    func testLeavingWithoutARememberedChatModelFallsBackToTheFirstSendableOne() {
        let mode = NativeImageMode()
        XCTAssertEqual(mode.exit(catalog: catalog), "auto")
        let gone = NativeImageMode(lastChatModelID: "retired:model")
        XCTAssertEqual(gone.exit(catalog: catalog), "auto")
        XCTAssertNil(NativeImageMode().exit(catalog: catalog.filter { $0.modality != "chat" }))
    }
}
