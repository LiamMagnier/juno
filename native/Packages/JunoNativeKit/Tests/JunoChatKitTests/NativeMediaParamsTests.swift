import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// The composer tray's generation choices: the catalogue's `mediaParams`
/// decoded, and the web's rules (`media-params.ts`) ported faithfully —
/// defaults, cross-option rules, "the picked value wins", carrying choices
/// across a model switch, chip words — plus the per-model memory and the
/// `/api/generate` body.
///
/// The schemas are read from the generated preview fixture
/// (`scripts/generate-native-media-params-fixtures.ts`, built by the server's
/// own `nativeMediaParams`), so these tests run against what the catalogue
/// actually publishes rather than a hand copy.
@MainActor
final class NativeMediaParamsTests: XCTestCase {
    static func schema(_ id: String, file: StaticString = #filePath) throws -> NativeMediaParamSchema {
        let root = URL(fileURLWithPath: "\(file)")
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: root.appendingPathComponent("Sources/JunoPreviewSupport/Generated/PreviewMediaParams.swift"),
            encoding: .utf8
        )
        let marker = "\"\(id)\": ####\"\"\"\n"
        let start = try XCTUnwrap(source.range(of: marker), "no fixture for \(id)").upperBound
        let end = try XCTUnwrap(source.range(of: "\n\"\"\"####", range: start..<source.endIndex)).lowerBound
        return try XCTUnwrap(NativeMediaParamSchema.decode(Data(source[start..<end].utf8)))
    }

    func testDecodesTheCatalogueSchemaInTheWebRowsOrder() throws {
        let sunburst = try Self.schema("openai:gpt-image-2.5-sunburst")
        XCTAssertEqual(sunburst.kind, "image")
        XCTAssertEqual(sunburst.options.map(\.key), ["aspect", "resolution", "quality", "count", "background", "outputFormat"])
        XCTAssertEqual(sunburst.options.map(\.control), [.aspect, .segmented, .menu, .menu, .menu, .menu])
        XCTAssertEqual(sunburst.defaults(), [
            "aspect": .string("1:1"), "resolution": .string("1K"), "quality": .auto,
            "count": .number(1), "background": .auto, "outputFormat": .string("png"),
        ])
    }

    /// The screenshot's tray, word for word: "1:1", "Auto quality", "1 image",
    /// "Auto background", "PNG".
    func testChipsSayWhatTheWebSays() throws {
        let sunburst = try Self.schema("openai:gpt-image-2.5-sunburst")
        let chips = Dictionary(uniqueKeysWithValues: sunburst.controls(sunburst.defaults()).map { ($0.key, $0.chip) })
        XCTAssertEqual(chips["aspect"], "1:1")
        XCTAssertEqual(chips["quality"], "Auto quality")
        XCTAssertEqual(chips["count"], "1 image")
        XCTAssertEqual(chips["background"], "Auto background")
        XCTAssertEqual(chips["outputFormat"], "PNG")
        let three = sunburst.applying("count", .number(3), to: sunburst.defaults())
        XCTAssertEqual(sunburst.controls(three).first { $0.key == "count" }?.chip, "3 images")

        let seedance = try Self.schema("seedance:dreamina-seedance-2-5-260628")
        XCTAssertEqual(seedance.controls(seedance.defaults()).first { $0.key == "durationSec" }?.chip, "Auto length")
    }

    /// The picked value wins and what blocked it moves: 4K on a 1:1 picture
    /// widens the frame back to the default rather than refusing.
    func testThePickedValueWinsAndTheBlockerMoves() throws {
        let sunburst = try Self.schema("openai:gpt-image-2.5-sunburst")
        let square = sunburst.defaults()
        XCTAssertFalse(sunburst.allowedValues("resolution", in: square).contains(.string("4K")))
        let control = try XCTUnwrap(sunburst.controls(square).first { $0.key == "resolution" })
        let fourK = try XCTUnwrap(control.choices.first { $0.value == .string("4K") })
        XCTAssertTrue(fourK.conflict)
        // Parity with the web's applyParamChange: the picked 4K is kept, and
        // the aspect moves only to a ratio that has 4K, the closest to 1:1
        // (16:9 and 9:16 tie; the option's order picks 16:9). Never 2:3,
        // which would cap the resolution at 1K and lose the pick.
        XCTAssertEqual(fourK.consequence, "Aspect ratio becomes Widescreen")
        let moved = sunburst.applying("resolution", .string("4K"), to: square)
        XCTAssertEqual(moved["aspect"], .string("16:9"))
        XCTAssertEqual(moved["resolution"], .string("4K"))

        // A tall frame stays tall: 2:3 → 4K lands on 9:16; 2:3 → 2K on 1:1.
        let portrait = sunburst.applying("aspect", .string("2:3"), to: square)
        let tall4K = sunburst.applying("resolution", .string("4K"), to: portrait)
        XCTAssertEqual(tall4K["aspect"], .string("9:16"))
        XCTAssertEqual(tall4K["resolution"], .string("4K"))
        let portrait2K = sunburst.applying("resolution", .string("2K"), to: portrait)
        XCTAssertEqual(portrait2K["aspect"], .string("1:1"))
        XCTAssertEqual(portrait2K["resolution"], .string("2K"))

        // From a wide frame, 4K simply applies.
        let wide = sunburst.applying("resolution", .string("4K"), to: sunburst.applying("aspect", .string("16:9"), to: square))
        XCTAssertEqual(wide["resolution"], .string("4K"))
        XCTAssertEqual(wide["aspect"], .string("16:9"))

        // Transparent needs PNG or WebP: JPG moves to the nearest allowed.
        let jpg = sunburst.applying("outputFormat", .string("jpg"), to: square)
        let transparent = sunburst.applying("background", .string("transparent"), to: jpg)
        XCTAssertEqual(transparent["outputFormat"], .string("png"))

        // Veo: 4s at 1080p drops the resolution, not the length.
        let veo = try Self.schema("google:veo-3.1-generate-preview")
        let tall = veo.applying("resolution", .string("1080p"), to: veo.defaults())
        let short = veo.applying("durationSec", .number(4), to: tall)
        XCTAssertEqual(short["durationSec"], .number(4))
        XCTAssertEqual(short["resolution"], .string("720p"))
        XCTAssertEqual(veo.facts, ["With sound"])
    }

    func testNormalisingCleansWhatAClientCannotSend() throws {
        let seedance = try Self.schema("seedance:dreamina-seedance-2-5-260628")
        let cleaned = seedance.normalized([
            "durationSec": .number(99), "aspect": .string("7:5"), "bogus": .bool(true),
        ])
        XCTAssertEqual(cleaned["durationSec"], .number(30), "a number out of range is clamped")
        XCTAssertEqual(cleaned["aspect"], .auto, "an unknown ratio falls back to the default")
        XCTAssertNil(cleaned["bogus"])
        XCTAssertEqual(cleaned["audio"], .bool(true))
    }

    func testAModelSwitchCarriesWhatStillFits() throws {
        let veo = try Self.schema("google:veo-3.1-generate-preview")
        let omni = try Self.schema("google:gemini-omni-1.1-flash")
        let picked = veo.applying("aspect", .string("9:16"), to: veo.defaults())
        let carried = omni.carried(from: picked)
        XCTAssertEqual(carried["aspect"], .string("9:16"))
        XCTAssertEqual(carried["resolution"], .string("720p"))
        XCTAssertNil(carried["durationSec"], "Omni has no length control")
    }

    func testTheMemoryKeepsTheLastPickPerModelAndCarriesToTheNext() throws {
        let suite = "NativeMediaParamsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let veo = try Self.schema("google:veo-3.1-generate-preview")
        let omni = try Self.schema("google:gemini-omni-1.1-flash")

        let memory = NativeMediaParamsMemory(defaults: defaults)
        memory.activate("google:veo-3.1-generate-preview", schema: veo)
        memory.set("aspect", .string("9:16"), for: "google:veo-3.1-generate-preview", schema: veo)
        memory.activate("google:gemini-omni-1.1-flash", schema: omni)
        XCTAssertEqual(memory.params(for: "google:gemini-omni-1.1-flash", schema: omni)["aspect"], .string("9:16"))

        let reopened = NativeMediaParamsMemory(defaults: defaults)
        XCTAssertEqual(reopened.params(for: "google:veo-3.1-generate-preview", schema: veo)["aspect"], .string("9:16"))
        XCTAssertEqual(defaults.data(forKey: NativeMediaParamsMemory.defaultsKey).map { !$0.isEmpty }, true)
    }

    /// `/api/generate` gets the web's body: `params` beside the prompt, whole
    /// numbers as integers, and no key at all when there is nothing to choose.
    func testTheGenerateBodyCarriesParamsInTheWebsShape() async throws {
        let streamer = ParamsBodyStreamer()
        let client = NativeChatAPIClient(sender: ParamsNoSender(), streamer: streamer)
        let lyria = try Self.schema("google:lyria-3.5")
        let params = lyria.applying("instrumental", .bool(true), to: lyria.defaults())
        for request in [
            NativeMediaGenerationRequest(conversationID: "conv_12345678", prompt: "A song", modelID: "google:lyria-3.5", modality: .audio, params: params),
            NativeMediaGenerationRequest(conversationID: "conv_12345678", prompt: "A song", modelID: "google:lyria-3.5", modality: .audio),
        ] {
            for try await _ in try await client.mediaGenerationEvents(request, for: try AccountID("account-a")) {}
        }
        let bodies = await streamer.bodies
        XCTAssertEqual(bodies.count, 2)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: bodies[0]) as? [String: Any])
        XCTAssertEqual(sent["params"] as? [String: AnyHashable], ["instrumental": true, "outputFormat": "mp3"])
        let bare = try XCTUnwrap(JSONSerialization.jsonObject(with: bodies[1]) as? [String: Any])
        XCTAssertNil(bare["params"])

        let sunburst = try Self.schema("openai:gpt-image-2.5-sunburst")
        let data = try JSONEncoder().encode(sunburst.applying("count", .number(4), to: sunburst.defaults()))
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains(#""count":4"#))
    }

    func testAMediaModelIsSendableAndAudioCounts() {
        let lyria = NativeChatModelOption(
            id: "google:lyria-3.5", providerID: "google", providerName: "Google", displayName: "Lyria 3.5",
            minimumPlan: "free", availability: "available", modality: "audio",
            supportedReasoningEfforts: [], canDisableReasoning: true, supportsStreaming: false
        )
        XCTAssertTrue(lyria.isMediaGeneration)
        XCTAssertTrue(lyria.isAvailable)
    }
}

private actor ParamsBodyStreamer: NativeAuthenticatedByteStreaming {
    private(set) var bodies: [Data] = []

    func stream(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
        if let body = request.body { bodies.append(body) }
        let done = Data("""
        data: {"type":"done","message":{"id":"assistant_12345678","role":"ASSISTANT","content":"","reasoning":null,"model":"google:lyria-3.5","createdAt":"2026-10-10T00:02:00.000Z","sources":[],"attachments":[]},"finishReason":"stop"}


        """.utf8)
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try HTTPHeaders(["content-type": "text/event-stream; charset=utf-8"]),
            bytes: AsyncThrowingStream { continuation in
                for byte in done { continuation.yield(byte) }
                continuation.finish()
            }
        )
    }
}

private struct ParamsNoSender: NativeAuthenticatedRequestSending, Sendable {
    func send(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}
