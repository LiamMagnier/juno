import XCTest
@testable import JunoAuth

final class PKCETests: XCTestCase {
    func testRFC7636S256Vector() throws {
        let verifier = try PKCECodeVerifier(
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        )
        let challenge = PKCECodeChallenge(verifier: verifier)

        XCTAssertEqual(challenge.value, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testGeneratorUsesIndependentBoundedRandomValues() throws {
        let generator = PKCEGenerator(random: IncrementingRandomBytes())
        let pair = try generator.makePair()
        let state = try generator.makeCorrelationValue()

        XCTAssertEqual(pair.verifier.value.utf8.count, 43)
        XCTAssertEqual(state.value.utf8.count, 43)
        XCTAssertEqual(pair.challenge, PKCECodeChallenge(verifier: pair.verifier))
    }

    func testVerifierRejectsWeakAndIllegalValues() {
        XCTAssertThrowsError(try PKCECodeVerifier("short"))
        XCTAssertThrowsError(try PKCECodeVerifier(String(repeating: "!", count: 43)))
    }
}

private struct IncrementingRandomBytes: RandomByteGenerating {
    func bytes(count: Int) throws -> [UInt8] {
        (0..<count).map { UInt8($0 % 256) }
    }
}
