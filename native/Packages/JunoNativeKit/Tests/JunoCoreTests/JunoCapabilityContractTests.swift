import XCTest
@testable import JunoCore

/// The Swift half of the capability manifest.
///
/// Generated from `contracts/capabilities/juno-capabilities-v1.json`, which the
/// TypeScript half also derives from — so these do not check that two
/// hand-written enums agree (they cannot disagree), they check the properties
/// the generator is supposed to give the Swift side: an ordering that matches
/// the server's, and decoding that survives a newer server.
final class JunoCapabilityContractTests: XCTestCase {
    func testReasoningOrdersLowestToHighest() {
        XCTAssertLessThan(JunoReasoningLevel.minimal, JunoReasoningLevel.low)
        XCTAssertLessThan(JunoReasoningLevel.low, JunoReasoningLevel.medium)
        XCTAssertLessThan(JunoReasoningLevel.medium, JunoReasoningLevel.high)
        XCTAssertLessThan(JunoReasoningLevel.high, JunoReasoningLevel.xhigh)
        XCTAssertLessThan(JunoReasoningLevel.xhigh, JunoReasoningLevel.max)
    }

    /// "Is this above the model's ceiling" has to be answered the same way on
    /// both platforms, or a level the server clamps is one the client shows as
    /// honoured.
    func testTheOrderMatchesTheManifestOrder() {
        XCTAssertEqual(
            JunoReasoningLevel.allCases.map(\.rawValue),
            ["minimal", "low", "medium", "high", "xhigh", "max"]
        )
    }

    func testEveryDegradationKindTheServerCanSendIsRepresented() {
        let kinds = Set(JunoDegradationKind.allCases.map(\.rawValue))
        for expected in [
            "model_substituted",
            "reasoning_clamped",
            "reasoning_unsupported",
            "web_search_unavailable",
            "fast_mode_unavailable",
            "vision_unavailable",
            "connectors_unavailable",
            "pro_mode_unavailable",
            // A connector action needed a person and this client had nowhere to
            // ask. The broker holds the tool call until somebody answers, so a
            // client that cannot name this degradation shows a turn that simply
            // stopped, with no reason a reader could act on.
            "action_approval_unavailable",
        ] {
            XCTAssertTrue(kinds.contains(expected), "missing degradation kind \(expected)")
        }
    }

    func testAnUndegradedResultDecodes() throws {
        let json = """
        {"version":1,"modelId":"claude-opus-5","provider":"anthropic","reasoning":"high",
         "webSearch":true,"fastMode":false,"vision":true,"connectors":false,"degradations":[]}
        """
        let result = try JSONDecoder().decode(
            JunoEffectiveCapabilities.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(result.reasoning, .high)
        XCTAssertFalse(result.wasDegraded)
    }

    func testADegradedResultCarriesItsReason() throws {
        let json = """
        {"version":1,"modelId":"tiny","provider":"deepseek","reasoning":null,
         "webSearch":false,"fastMode":false,"vision":false,"connectors":false,
         "degradations":[{"kind":"reasoning_unsupported","requested":"high",
         "effective":"none","reason":"tiny does not support a reasoning effort."}]}
        """
        let result = try JSONDecoder().decode(
            JunoEffectiveCapabilities.self,
            from: Data(json.utf8)
        )
        XCTAssertTrue(result.wasDegraded)
        XCTAssertEqual(result.degradations.first?.kind, .reasoningUnsupported)
        XCTAssertEqual(result.degradations.first?.requested, "high")
    }

    /// The property that matters for a shipped client: a server on a newer
    /// manifest sends a kind this build has never heard of. Dropping that entry
    /// is one missing line of explanation; failing the decode is a reply that
    /// will not load at all.
    func testANewerServersUnknownDegradationDoesNotBreakTheDecode() throws {
        let json = """
        {"version":99,"modelId":"m","provider":"p","reasoning":"low",
         "webSearch":false,"fastMode":false,"vision":false,"connectors":false,
         "degradations":[{"kind":"something_invented_later","requested":"a",
         "effective":"b","reason":"from the future"},
         {"kind":"reasoning_clamped","requested":"max","effective":"low",
         "reason":"clamped"}]}
        """
        let result = try JSONDecoder().decode(
            JunoEffectiveCapabilities.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(result.version, 99, "the newer version is reported, not clamped")
        XCTAssertEqual(
            result.degradations.map(\.kind),
            [.reasoningClamped],
            "the unknown entry is dropped and the known one survives"
        )
    }

    /// Missing booleans decode as false rather than throwing, so a field added
    /// later does not break an older client.
    func testAbsentFlagsDefaultToFalse() throws {
        let json = """
        {"version":1,"modelId":"m","provider":"p","degradations":[]}
        """
        let result = try JSONDecoder().decode(
            JunoEffectiveCapabilities.self,
            from: Data(json.utf8)
        )
        XCTAssertFalse(result.webSearch)
        XCTAssertNil(result.reasoning)
    }

    /// Deliberately not pinned to a literal version.
    ///
    /// It was, and it went stale twice without anyone noticing — the manifest
    /// reached 2 and then 3 while this still asserted 1, so the one test meant
    /// to prove the generated contract is current was itself the thing out of
    /// date. A literal here tests nothing about the contract: the number is
    /// generated from the manifest and cannot disagree with it. What is worth
    /// asserting is that the generator ran and stamped a real manifest, which
    /// `npm run capabilities:check` enforces byte-for-byte on the other side.
    func testTheContractReportsTheManifestItWasBuiltFrom() {
        XCTAssertGreaterThanOrEqual(JunoCapabilityContract.version, 1)
        XCTAssertEqual(JunoCapabilityContract.digest.count, 64, "a SHA-256 hex digest")
        XCTAssertTrue(
            JunoCapabilityContract.digest.allSatisfy { $0.isHexDigit },
            "the digest must be hex, not a placeholder"
        )
    }
}
