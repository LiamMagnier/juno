import Foundation
import XCTest

@testable import JunoWorkAutomation

final class SensitiveSurfaceTests: XCTestCase {
    private func field(
        role: String = "AXTextField",
        subrole: String? = nil,
        label: String? = nil,
        secure: Bool = false,
        hint: String? = nil,
        bounds: AutomationRect? = nil
    ) -> AccessibilityFieldDescriptor {
        AccessibilityFieldDescriptor(
            elementID: "0/1",
            role: role,
            subrole: subrole,
            label: label,
            isSecureTextEntry: secure,
            contentHint: hint,
            bounds: bounds
        )
    }

    // MARK: - Fields

    func testAPlatformSecureFieldIsTheStrongestSignal() {
        let surface = SensitiveSurfaceDetector.classify(field(secure: true))
        XCTAssertEqual(surface?.kind, .password)
        XCTAssertEqual(surface?.signal, .secureTextEntry)
        XCTAssertEqual(surface?.elementID, "0/1")
    }

    func testTheAccessibilitySubroleIsRecognisedWithoutTheFlag() {
        let surface = SensitiveSurfaceDetector.classify(
            field(role: "AXTextField", subrole: "AXSecureTextField")
        )
        XCTAssertEqual(surface?.kind, .password)
        XCTAssertEqual(surface?.signal, .secureTextEntry)
    }

    func testDeclaredContentHintsAreRead() {
        XCTAssertEqual(
            SensitiveSurfaceDetector.classify(field(hint: "cc-number"))?.kind, .paymentCard
        )
        XCTAssertEqual(
            SensitiveSurfaceDetector.classify(field(hint: "current-password"))?.kind, .password
        )
        XCTAssertEqual(
            SensitiveSurfaceDetector.classify(field(hint: "one-time-code"))?.kind, .oneTimeCode
        )
        XCTAssertEqual(
            SensitiveSurfaceDetector.classify(field(hint: "cc-number"))?.signal, .declaredAttribute
        )
    }

    /// Stripping punctuation is what makes a short word list workable. Without
    /// it the list has to enumerate every way a designer might punctuate the
    /// same phrase, and the one spelling nobody thought of is the one on the
    /// page that matters.
    func testLabelWordingIsMatchedRegardlessOfPunctuationAndCase() {
        for label in ["Card Number", "card_number", "CARD-NUMBER", "  Card  Number  "] {
            XCTAssertEqual(
                SensitiveSurfaceDetector.classify(field(label: label))?.kind, .paymentCard, label
            )
        }
        XCTAssertEqual(
            SensitiveSurfaceDetector.classify(field(label: "Social Security Number"))?.kind,
            .governmentIdentifier
        )
        XCTAssertEqual(
            SensitiveSurfaceDetector.classify(field(label: "Routing number"))?.kind, .bankAccount
        )
        XCTAssertEqual(
            SensitiveSurfaceDetector.classify(field(label: "API key"))?.kind, .apiCredential
        )
        XCTAssertEqual(
            SensitiveSurfaceDetector.classify(field(label: "CVV"))?.kind, .paymentCard
        )
    }

    func testAnOrdinaryFieldIsNotFlagged() {
        XCTAssertNil(SensitiveSurfaceDetector.classify(field(label: "Search")))
        XCTAssertNil(SensitiveSurfaceDetector.classify(field(role: "AXButton", label: "Send")))
        XCTAssertNil(SensitiveSurfaceDetector.classify(field(label: "Subject")))
    }

    /// "pin" is a substring of "shipping". A word list that matched it would
    /// turn every address form into a password field, and a detector that cries
    /// wolf on address forms is a detector whose refusals get switched off.
    func testAShippingFieldIsNotMistakenForAPasswordField() {
        XCTAssertNil(SensitiveSurfaceDetector.classify(field(label: "Shipping address")))
    }

    // MARK: - Values

    func testACardNumberIsFoundHoweverItIsSpaced() {
        for text in [
            "4111111111111111",
            "4111 1111 1111 1111",
            "4111-1111-1111-1111",
            "Please charge 4111 1111 1111 1111 today",
        ] {
            let found = SensitiveSurfaceDetector.scan(text)
            XCTAssertEqual(found.first?.kind, .paymentCard, text)
            XCTAssertEqual(found.first?.signal, .valueShape, text)
        }
    }

    /// The Luhn check is what keeps the net narrow. A long number that is not a
    /// card is left alone, because flagging every order number teaches whoever
    /// reads the refusals to ignore them.
    func testALongNumberThatFailsLuhnIsNotACardNumber() {
        XCTAssertTrue(SensitiveSurfaceDetector.scan("4111 1111 1111 1112").isEmpty)
        XCTAssertTrue(SensitiveSurfaceDetector.scan("Invoice 900000000000002").isEmpty)
    }

    func testGovernmentIdentifiersAndKeysAreFoundByShape() {
        XCTAssertEqual(
            SensitiveSurfaceDetector.scan("my ssn is 123-45-6789").first?.kind,
            .governmentIdentifier
        )
        XCTAssertEqual(
            SensitiveSurfaceDetector.scan("token sk-abcdefghijklmnopqrstuvwx").first?.kind,
            .apiCredential
        )
        XCTAssertEqual(
            SensitiveSurfaceDetector.scan("AKIAIOSFODNN7EXAMPLE").first?.kind, .apiCredential
        )
    }

    func testOrdinaryProseAndPhoneNumbersAreLeftAlone() {
        XCTAssertTrue(SensitiveSurfaceDetector.scan("Lunch at one, call 555-123-4567").isEmpty)
        XCTAssertTrue(
            SensitiveSurfaceDetector.scan("Reply to the thread when you get a chance.").isEmpty
        )
        XCTAssertTrue(SensitiveSurfaceDetector.scan("sk-short").isEmpty)
    }

    // MARK: - Aggregation

    /// Sensitivity only ever rises: one password field on a page of public
    /// marketing copy makes it a page with a password field on it.
    func testSensitivityRisesToTheHighestSurfaceFound() {
        XCTAssertEqual(SensitiveSurfaceDetector.sensitivity(of: []), .publicContent)
        XCTAssertEqual(
            SensitiveSurfaceDetector.sensitivity(of: [
                SensitiveSurface(kind: .password, signal: .secureTextEntry)
            ]),
            .restricted
        )
        XCTAssertEqual(
            AutomationSensitivity.highest([.publicContent, .confidential, .internalContent]),
            .confidential
        )
    }

    func testEverySecretKindIsRestricted() {
        for kind in SensitiveSurfaceKind.allCases {
            XCTAssertEqual(kind.sensitivity, .restricted, kind.rawValue)
        }
    }

    // MARK: - Redaction planning

    func testOnlySurfacesWithARegionCanBePaintedOver() {
        let placed = SensitiveSurface(
            kind: .password,
            signal: .secureTextEntry,
            region: AutomationRect(x: 10, y: 20, width: 100, height: 30)
        )
        let unplaced = SensitiveSurface(kind: .paymentCard, signal: .labelWording)
        XCTAssertTrue(SensitiveSurfaceDetector.allSurfacesAreRedactable([placed]))
        XCTAssertFalse(SensitiveSurfaceDetector.allSurfacesAreRedactable([placed, unplaced]))
        XCTAssertEqual(SensitiveSurfaceDetector.redactionRegions(of: [placed, unplaced]).count, 1)
    }

    // MARK: - The thing this type is not

    /// Detection is a signal, not a boundary. A page that hides its password box
    /// behind a plain input and a font defeats every check above — and is still
    /// refused, because the site was never on the allowlist. This test exists so
    /// that a future weakening of the detector cannot be mistaken for a
    /// weakening of the containment.
    func testAFieldTheDetectorMissesIsStillOutOfReachOfThePermissionGate() {
        let disguised = field(role: "AXTextField", label: "Enter the thing")
        XCTAssertNil(SensitiveSurfaceDetector.classify(disguised))

        let permission = AutomationPermission(
            automationEnabled: true,
            allowsBrowserControl: true,
            allowedDomains: [".example.com"]
        )
        XCTAssertEqual(permission.permits(domain: "bank.invalid").refusal?.code, .notConsidered)
        XCTAssertEqual(
            permission.permits(domain: "pay.google.com").refusal?.code, .restrictedCategory
        )
    }
}
