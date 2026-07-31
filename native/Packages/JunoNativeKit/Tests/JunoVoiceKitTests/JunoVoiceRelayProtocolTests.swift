import XCTest
@testable import JunoVoiceKit

/// The two halves of the wire that a native mistake makes invisible rather than
/// loud: a `session.ready` this client refuses to decode, and a `video.frame`
/// the relay silently drops. Neither produces an error anywhere — the session
/// simply connects and then does nothing — so both are pinned here.
final class JunoVoiceRelayProtocolTests: XCTestCase {

    // MARK: Capabilities

    /// The relay's registry omits `screenInput` for the providers that never
    /// grew a screen path. With a synthesized decoder that omission fails the
    /// whole frame, taking the provider, the capabilities and the transition to
    /// `live` with it.
    func testCapabilitiesDecodeWithoutScreenInput() throws {
        let json = """
            {"videoInput":true,"trueS2S":true,"needsClientTranscript":false,"maxSessionSec":900}
            """
        let capabilities = try JSONDecoder().decode(
            JunoVoiceCapabilities.self, from: Data(json.utf8)
        )
        XCTAssertTrue(capabilities.videoInput)
        XCTAssertFalse(capabilities.screenInput, "absent must read as false, not as a failure")
        XCTAssertEqual(capabilities.maxSessionSec, 900)
    }

    func testCapabilitiesDecodeWithScreenInput() throws {
        let json = """
            {"videoInput":true,"screenInput":true,"trueS2S":true,\
            "needsClientTranscript":false,"maxSessionSec":900}
            """
        let capabilities = try JSONDecoder().decode(
            JunoVoiceCapabilities.self, from: Data(json.utf8)
        )
        XCTAssertTrue(capabilities.screenInput)
    }

    /// The whole `session.ready` frame, because that is the shape that actually
    /// arrives — decoding the nested struct alone would still pass if the outer
    /// message stopped carrying it.
    func testSessionReadyDecodesForAProviderWithoutScreenInput() throws {
        let text = """
            {"type":"session.ready","provider":"openai","capabilities":\
            {"videoInput":true,"trueS2S":true,"needsClientTranscript":false,"maxSessionSec":900}}
            """
        guard case .sessionReady(let provider, let capabilities)? =
            JunoVoiceRelayMessage.decode(fromText: text)
        else { return XCTFail("session.ready must decode without screenInput") }
        XCTAssertEqual(provider, .openai)
        XCTAssertTrue(capabilities.videoInput)
        XCTAssertFalse(capabilities.screenInput)
    }

    /// The cost split is optional on the wire. A usage frame that fails to
    /// decode takes the running total with it, which is the number the session
    /// budget is read from.
    func testUsageDecodesWithAndWithoutTheCostSplit() throws {
        let bare = """
            {"type":"usage","provider":"gemini","audioInSec":12,"audioOutSec":8,"estCostUsd":0.04}
            """
        guard case .usage(let plain)? = JunoVoiceRelayMessage.decode(fromText: bare) else {
            return XCTFail("usage must decode without the split")
        }
        XCTAssertNil(plain.estCostInUsd)
        XCTAssertNil(plain.estCostOutUsd)

        let split = """
            {"type":"usage","provider":"gemini","audioInSec":12,"audioOutSec":8,\
            "estCostUsd":0.04,"estCostInUsd":0.01,"estCostOutUsd":0.03}
            """
        guard case .usage(let detailed)? = JunoVoiceRelayMessage.decode(fromText: split) else {
            return XCTFail("usage must decode with the split")
        }
        XCTAssertEqual(detailed.estCostInUsd, 0.01)
        XCTAssertEqual(detailed.estCostOutUsd, 0.03)
    }

    // MARK: Client messages

    private func object(_ message: JunoVoiceClientMessage) throws -> [String: Any] {
        let text = try XCTUnwrap(message.jsonText)
        let parsed = try JSONSerialization.jsonObject(with: Data(text.utf8))
        return try XCTUnwrap(parsed as? [String: Any])
    }

    /// Exactly two keys, exactly these names. The relay reads `jpegBase64` and
    /// nothing else; a frame with an extra or renamed key is forwarded to no one
    /// and reported by no one.
    func testVideoFrameEncodesToTheWireShape() throws {
        let frame = try object(.videoFrame(jpegBase64: "/9j/4AAQSkZJRg=="))
        XCTAssertEqual(Set(frame.keys), ["type", "jpegBase64"])
        XCTAssertEqual(frame["type"] as? String, "video.frame")
        XCTAssertEqual(frame["jpegBase64"] as? String, "/9j/4AAQSkZJRg==")
    }

    /// The recognizer's call site sends a bare `.inputText(text)`, and the relay
    /// treats a present `turnId` as "this turn is already on screen" — so an
    /// always-encoded id would suppress the echo that puts the user's own words
    /// in the transcript.
    func testInputTextOmitsTheComposedTurnFieldsUnlessGiven() throws {
        let bare = try object(.inputText("what's the weather"))
        XCTAssertEqual(Set(bare.keys), ["type", "text"])
        XCTAssertEqual(bare["type"] as? String, "input.text")

        let composed = try object(
            .inputText("look at this", turnId: "turn-1", displayText: "Shared an image")
        )
        XCTAssertEqual(Set(composed.keys), ["type", "text", "turnId", "displayText"])
        XCTAssertEqual(composed["turnId"] as? String, "turn-1")
        XCTAssertEqual(composed["displayText"] as? String, "Shared an image")
    }

    // MARK: Frame ceiling

    /// The relay forwards a frame only while its base64 payload is under two
    /// million characters. Sending a larger one costs the uplink a second of
    /// bandwidth for something the model never sees.
    func testOversizeFramesAreDroppedBeforeTheyReachTheRelay() {
        XCTAssertNil(JunoRealtimeVoiceController.relayFrame(Data()))
        // Base64 is a third larger than the bytes it encodes, so the ceiling has
        // to be measured on the encoded string: this one is under the limit as
        // bytes and over it as a frame.
        let justUnderAsBytes = Data(repeating: 0xFF, count: 1_800_000)
        XCTAssertNil(JunoRealtimeVoiceController.relayFrame(justUnderAsBytes))
        let small = Data(repeating: 0xFF, count: 64_000)
        XCTAssertNotNil(JunoRealtimeVoiceController.relayFrame(small))
    }
}
