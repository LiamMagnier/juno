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

    /// The relay repeats `turnId` back on its echo of a composed turn, and that
    /// echo is the only thing tying the images a reader attached to the line
    /// they land on — the frames themselves are anonymous bytes. Dropping it in
    /// the decoder loses the pictures from the saved conversation while the
    /// words about them stay.
    func testTranscriptCarriesTheTurnIdWhenTheRelayEchoesOne() throws {
        let echoed = """
            {"type":"transcript","role":"user","text":"Shared an image","final":true,\
            "turnId":"turn-1"}
            """
        guard case .transcript(let role, _, _, let turnId)? =
            JunoVoiceRelayMessage.decode(fromText: echoed)
        else { return XCTFail("a composed turn's echo must decode") }
        XCTAssertEqual(role, .user)
        XCTAssertEqual(turnId, "turn-1")
    }

    /// Every spoken line arrives without one, which is most of them.
    func testTranscriptDecodesWithoutATurnId() throws {
        let spoken = """
            {"type":"transcript","role":"assistant","text":"Paris.","final":true}
            """
        guard case .transcript(_, let text, let final, let turnId)? =
            JunoVoiceRelayMessage.decode(fromText: spoken)
        else { return XCTFail("a spoken line must decode without a turnId") }
        XCTAssertEqual(text, "Paris.")
        XCTAssertTrue(final)
        XCTAssertNil(turnId)
    }

    // MARK: Seeded history

    /// A call opened from an existing chat sends it; one opened from nowhere
    /// sends the same two-key frame it always has.
    func testSessionStartCarriesHistoryOnlyWhenThereIsSome() throws {
        let bare = try object(.sessionStart(provider: .openai))
        XCTAssertEqual(Set(bare.keys), ["type", "provider"])
        XCTAssertEqual(bare["type"] as? String, "session.start")

        let seeded = try object(
            .sessionStart(
                provider: .openai,
                history: [
                    JunoVoiceHistoryEntry(role: .user, text: "Which of the two?"),
                    JunoVoiceHistoryEntry(role: .assistant, text: "The second."),
                ]
            )
        )
        XCTAssertEqual(Set(seeded.keys), ["type", "provider", "history"])
        let history = try XCTUnwrap(seeded["history"] as? [[String: Any]])
        XCTAssertEqual(history.map { $0["role"] as? String }, ["user", "assistant"])
        XCTAssertEqual(history.first?["text"] as? String, "Which of the two?")
        XCTAssertEqual(Set(try XCTUnwrap(history.first).keys), ["role", "text"])
    }

    /// The web sends the last twenty turns, and so does this. Oldest go first:
    /// what the reader is about to talk about is the end of the chat, not the
    /// start of it.
    func testHistoryKeepsTheTwentyMostRecentTurns() {
        let entries = (1...30).map {
            JunoVoiceHistoryEntry(role: .user, text: "turn \($0)")
        }
        let bounded = JunoVoiceHistoryEntry.bounded(entries)
        XCTAssertEqual(bounded.count, JunoVoiceHistoryEntry.maximumTurns)
        XCTAssertEqual(bounded.first?.text, "turn 11")
        XCTAssertEqual(bounded.last?.text, "turn 30")
    }

    /// One pasted document must not spend the whole frame.
    func testASingleLongTurnIsTruncatedToItsOwnCeiling() {
        let bounded = JunoVoiceHistoryEntry.bounded([
            JunoVoiceHistoryEntry(
                role: .user, text: String(repeating: "x", count: 5_000)
            )
        ])
        XCTAssertEqual(
            bounded.first?.text.count, JunoVoiceHistoryEntry.maximumTurnCharacters
        )
    }

    /// The total is the bound that actually protects the frame, and it is spent
    /// backwards — so a chat of long turns keeps the recent ones whole rather
    /// than the old ones.
    func testTheTotalBudgetIsSpentOnTheMostRecentTurns() {
        let entries = (1...10).map { index in
            JunoVoiceHistoryEntry(
                role: .user, text: "[\(index)]" + String(repeating: "x", count: 2_000)
            )
        }
        let bounded = JunoVoiceHistoryEntry.bounded(entries)
        let total = bounded.reduce(0) { $0 + $1.text.utf16.count }
        XCTAssertLessThanOrEqual(total, JunoVoiceHistoryEntry.maximumTotalCharacters)
        // Six turns at the 2,000-character ceiling exhaust the 12,000 total.
        XCTAssertEqual(bounded.count, 6)
        XCTAssertTrue(bounded.last?.text.hasPrefix("[10]") ?? false, "turn 10 must survive")
        XCTAssertTrue(bounded.first?.text.hasPrefix("[5]") ?? false, "turn 4 must not")
    }

    /// Blank turns are dropped rather than sent as empty items the provider has
    /// to read past.
    func testBlankTurnsAreDropped() {
        let bounded = JunoVoiceHistoryEntry.bounded([
            JunoVoiceHistoryEntry(role: .user, text: "   \n "),
            JunoVoiceHistoryEntry(role: .assistant, text: " Paris. "),
        ])
        XCTAssertEqual(bounded.map(\.text), ["Paris."])
    }

    /// The ceiling is counted in UTF-16 units, the way the relay counts it — but
    /// a cut has to fall on a character boundary. Splitting a flag or a family
    /// emoji hands the model replacement characters to interpret.
    func testTruncationNeverSplitsACharacter() throws {
        let bounded = JunoVoiceHistoryEntry.bounded([
            JunoVoiceHistoryEntry(role: .user, text: String(repeating: "🇫🇷", count: 2_000))
        ])
        let text = try XCTUnwrap(bounded.first?.text)
        XCTAssertLessThanOrEqual(
            text.utf16.count, JunoVoiceHistoryEntry.maximumTurnCharacters
        )
        XCTAssertFalse(text.unicodeScalars.contains("\u{FFFD}"))
        // Each flag is one Character and four UTF-16 units, so a cut on a
        // boundary leaves a whole number of flags and nothing half-written.
        XCTAssertEqual(text.count, text.utf16.count / 4)
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
