import Foundation
import XCTest
@testable import JunoAuth

final class SecurityKeychainClientErrorTests: XCTestCase {
    /// The regression this guards: the default enum rendering is
    /// "JunoAuth.SecurityKeychainClientError error 0.", which shows the case
    /// index and throws away the OSStatus. That string reached the sign-in
    /// screen verbatim.
    func testDescriptionCarriesTheStatusAndNotTheCaseIndex() {
        let description = (SecurityKeychainClientError.unexpectedStatus(-34018)
            as any LocalizedError).errorDescription
        XCTAssertNotNil(description)
        XCTAssertTrue(
            description!.contains("-34018"),
            "the OSStatus must survive into the message: \(description!)"
        )
        XCTAssertFalse(
            description!.contains("SecurityKeychainClientError"),
            "the Swift type name must not reach the user: \(description!)"
        )
    }

    func testLocalizedDescriptionGoesThroughErrorDescription() {
        // `localizedDescription` is what the UI actually reads.
        let message = SecurityKeychainClientError.unexpectedStatus(-25300)
            .localizedDescription
        XCTAssertTrue(message.contains("-25300"), message)
        XCTAssertFalse(message.contains("error 0"), message)
    }

    func testMissingEntitlementIsExplainedInPlainLanguage() {
        let message = SecurityKeychainClientError
            .unexpectedStatus(errSecMissingEntitlement)
            .localizedDescription
        XCTAssertTrue(message.lowercased().contains("entitled"), message)
    }

    func testKnownStatusesAreNamed() {
        for status in [
            errSecMissingEntitlement,
            errSecInteractionNotAllowed,
            errSecAuthFailed,
            errSecDecode,
            errSecNotAvailable,
            errSecUserCanceled,
        ] {
            XCTAssertNotNil(
                SecurityKeychainClientError.explanation(for: status),
                "status \(status) should have plain-language text"
            )
        }
    }

    func testUnknownStatusStillProducesAUsableMessage() {
        let message = SecurityKeychainClientError.unexpectedStatus(-99999)
            .localizedDescription
        XCTAssertTrue(message.contains("-99999"), message)
        XCTAssertFalse(message.isEmpty)
    }

    func testInvalidResultHasItsOwnMessage() {
        let message = SecurityKeychainClientError.invalidResult.localizedDescription
        XCTAssertFalse(message.contains("error 1"), message)
        XCTAssertTrue(message.lowercased().contains("keychain"), message)
    }
}
