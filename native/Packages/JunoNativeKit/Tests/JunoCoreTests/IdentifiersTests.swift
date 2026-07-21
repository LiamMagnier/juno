import Foundation
import XCTest
@testable import JunoCore

final class IdentifiersTests: XCTestCase {
    func testIdentifierRoundTripsWithoutLosingItsTag() throws {
        let account = try AccountID("acct_123")
        let encoded = try JSONEncoder().encode(account)
        let decoded = try JSONDecoder().decode(AccountID.self, from: encoded)

        XCTAssertEqual(decoded, account)
        XCTAssertEqual(account.description, "acct_123")
    }

    func testIdentifierRejectsEmptyControlAndOversizedValues() {
        XCTAssertThrowsError(try DeviceID("")) { error in
            XCTAssertEqual(error as? IdentifierValidationError, .empty)
        }
        XCTAssertThrowsError(try DeviceID("device\nforged")) { error in
            XCTAssertEqual(
                error as? IdentifierValidationError,
                .containsControlCharacter
            )
        }
        XCTAssertThrowsError(try DeviceID(String(repeating: "a", count: 257)))
        XCTAssertThrowsError(try DeviceID("device forged")) { error in
            XCTAssertEqual(error as? IdentifierValidationError, .containsWhitespace)
        }
    }

    func testDecoderAppliesIdentifierValidation() {
        let invalid = Data("\"request\\nforged\"".utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(RequestID.self, from: invalid))
    }

    func testBoundedTextAllowsExplicitNewlinesOnly() throws {
        XCTAssertThrowsError(
            try BoundedValue.validateText(
                "line one\nline two",
                field: "message",
                maximumUTF8Bytes: 100
            )
        )
        XCTAssertNoThrow(
            try BoundedValue.validateText(
                "line one\nline two",
                field: "message",
                maximumUTF8Bytes: 100,
                allowsNewlines: true
            )
        )
    }
}
