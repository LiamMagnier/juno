import Foundation
import XCTest
@testable import JunoAPI

final class APIErrorEnvelopeTests: XCTestCase {
    func testDecodesTypedErrorAndPreservesUnknownCode() throws {
        let data = Data(
            #"{"error":{"code":"future_error","message":"Try later","requestId":"req_123","retryable":true,"retryAfterMs":2500}}"#.utf8
        )
        let envelope = try JSONDecoder().decode(APIErrorEnvelope.self, from: data)

        XCTAssertEqual(envelope.error.code.rawValue, "future_error")
        XCTAssertEqual(envelope.error.requestID.rawValue, "req_123")
        XCTAssertEqual(envelope.error.retryAfterMilliseconds, 2_500)
    }

    func testRejectsUnboundedRetryDelayAndControlCharacters() {
        let delay = Data(
            #"{"error":{"code":"slow","message":"Try later","requestId":"req_123","retryable":true,"retryAfterMs":86400001}}"#.utf8
        )
        XCTAssertThrowsError(try JSONDecoder().decode(APIErrorEnvelope.self, from: delay))

        let message = Data(
            "{\"error\":{\"code\":\"bad\",\"message\":\"forged\\u0000\",\"requestId\":\"req_123\",\"retryable\":false}}".utf8
        )
        XCTAssertThrowsError(try JSONDecoder().decode(APIErrorEnvelope.self, from: message))
    }
}
