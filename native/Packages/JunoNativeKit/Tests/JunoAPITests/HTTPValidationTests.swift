import Foundation
import XCTest
@testable import JunoAPI

final class HTTPValidationTests: XCTestCase {
    func testOriginRequiresHTTPSAndRejectsCredentials() throws {
        XCTAssertThrowsError(try APIOrigin(URL(string: "http://api.juno.test")!)) { error in
            XCTAssertEqual(error as? HTTPValidationError, .insecureScheme)
        }
        XCTAssertThrowsError(
            try APIOrigin(URL(string: "https://user:secret@api.juno.test")!)
        ) { error in
            XCTAssertEqual(error as? HTTPValidationError, .credentialsInURL)
        }

        let origin = try APIOrigin(URL(string: "https://API.JUNO.test:443/")!)
        XCTAssertEqual(origin.baseURL.absoluteString, "https://api.juno.test/")
    }

    func testEndpointConstructionDoesNotAcceptOriginOrTraversal() throws {
        let origin = try APIOrigin(URL(string: "https://api.juno.test")!)
        XCTAssertThrowsError(try origin.endpoint(path: "https://evil.test/steal"))
        XCTAssertThrowsError(try origin.endpoint(path: "/v1/../admin"))

        let endpoint = try origin.endpoint(
            path: "/api/v1/entities",
            queryItems: [URLQueryItem(name: "ids", value: "a,b")]
        )
        XCTAssertEqual(
            endpoint.absoluteString,
            "https://api.juno.test/api/v1/entities?ids=a,b"
        )
    }

    func testHeaderValidationRejectsInjectionAndCaseInsensitiveDuplicates() {
        XCTAssertThrowsError(try HTTPHeaders(["X-Test": "ok\r\nX-Forged: yes"]))
        XCTAssertThrowsError(try HTTPHeaders(["X-Test": "one", "x-test": "two"]))
        XCTAssertThrowsError(try HTTPHeaders(["bad header": "value"]))
    }

    func testBoundedClientChecksRequestAndResponseBeforeReturning() async throws {
        let origin = try APIOrigin(URL(string: "https://api.juno.test")!)
        let limits = try HTTPMessageLimits(
            maximumRequestBodyBytes: 4,
            maximumResponseBodyBytes: 5,
            maximumHeaderCount: 4,
            maximumHeaderBytes: 200
        )
        let oversized = HTTPResponse(
            statusCode: 200,
            headers: HTTPHeaders(),
            body: Data(repeating: 0, count: 6)
        )
        let client = BoundedHTTPClient(
            origin: origin,
            limits: limits,
            transport: StubTransport(response: oversized)
        )

        XCTAssertThrowsError(
            try client.makeRequest(
                path: "/api/v1/mutations",
                method: .post,
                body: Data(repeating: 0, count: 5)
            )
        ) { error in
            XCTAssertEqual(
                error as? HTTPValidationError,
                .requestBodyTooLarge(maximumBytes: 4)
            )
        }

        let request = try client.makeRequest(path: "/api/v1/bootstrap", method: .get)
        do {
            _ = try await client.send(request)
            XCTFail("Expected the oversized response to be rejected")
        } catch {
            XCTAssertEqual(
                error as? HTTPValidationError,
                .responseBodyTooLarge(maximumBytes: 5)
            )
        }
    }

    func testClientRejectsCrossOriginRequestsAndRedirects() async throws {
        let origin = try APIOrigin(URL(string: "https://api.juno.test")!)
        let redirect = HTTPResponse(
            statusCode: 302,
            headers: try HTTPHeaders(["location": "https://evil.test"]),
            body: Data()
        )
        let client = BoundedHTTPClient(origin: origin, transport: StubTransport(response: redirect))

        let crossOrigin = HTTPRequest(
            url: URL(string: "https://evil.test/api/v1/bootstrap")!,
            method: .get
        )
        do {
            _ = try await client.send(crossOrigin)
            XCTFail("Expected cross-origin validation to fail")
        } catch {
            XCTAssertEqual(error as? HTTPValidationError, .crossOriginRequest)
        }

        let request = try client.makeRequest(path: "/api/v1/bootstrap", method: .get)
        do {
            _ = try await client.send(request)
            XCTFail("Expected redirect rejection")
        } catch {
            XCTAssertEqual(
                error as? HTTPValidationError,
                .redirectRejected(statusCode: 302)
            )
        }
    }
}

private struct StubTransport: HTTPTransport {
    let response: HTTPResponse

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        response
    }
}
