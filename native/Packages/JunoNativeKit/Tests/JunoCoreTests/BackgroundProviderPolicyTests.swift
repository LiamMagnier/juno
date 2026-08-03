import XCTest
@testable import JunoCore

/// The native half of the background-processing policy.
///
/// Mirrors `src/lib/background-provider-policy.ts`. What matters on a client is
/// narrower than on the server — the client does not decide anything, it
/// *shows* what was decided — so these cover the two ways showing it can go
/// wrong: reading an unknown value as permissive, and failing to display at all.
final class BackgroundProviderPolicyTests: XCTestCase {
    func testTheDefaultIsThePrivacyPreservingMode() {
        XCTAssertEqual(BackgroundProviderMode.default, .sameProvider)
        XCTAssertEqual(BackgroundProviderMode(storedValue: nil), .sameProvider)
    }

    /// The important direction. A value written by a newer build, or a
    /// corrupted one, must never be read as permission to cross providers.
    func testAnUnrecognisedValueResolvesToTheSafeMode() {
        for value in ["", "anything", "walk_everything", "ANY_ALLOWED_PROVIDER"] {
            XCTAssertEqual(
                BackgroundProviderMode(storedValue: value),
                .sameProvider,
                "\(value) must not resolve to a permissive mode"
            )
        }
    }

    func testEveryServerValueRoundTrips() {
        // The raw values are the server's, so a typo here shows as a mode the
        // client silently replaces with the default.
        for (raw, expected) in [
            ("same_provider", BackgroundProviderMode.sameProvider),
            ("selected_provider", .selectedProvider),
            ("any_allowed_provider", .anyAllowedProvider),
            ("local_only", .localOnly),
        ] {
            XCTAssertEqual(BackgroundProviderMode(storedValue: raw), expected)
            XCTAssertEqual(expected.rawValue, raw)
        }
    }

    /// Exactly one mode may cross. Flagging more than one would train the
    /// reader to ignore the flag.
    func testOnlyTheOptedIntoModeIsMarkedAsCrossing() {
        let crossing = BackgroundProviderMode.allCases.filter(\.permitsCrossProvider)
        XCTAssertEqual(crossing, [.anyAllowedProvider])
    }

    /// A mode with no words is a picker row the reader cannot choose between.
    func testEveryModeHasATitleAndAnExplanation() {
        for mode in BackgroundProviderMode.allCases {
            XCTAssertFalse(mode.title.isEmpty, "\(mode) has no title")
            XCTAssertFalse(mode.explanation.isEmpty, "\(mode) has no explanation")
            XCTAssertNotEqual(
                mode.title, mode.rawValue,
                "\(mode) is showing its raw value — the localized key is missing"
            )
        }
    }
}
