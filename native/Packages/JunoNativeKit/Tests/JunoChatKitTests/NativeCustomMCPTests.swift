import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest
@testable import JunoChatKit

final class NativeCustomMCPTests: XCTestCase {
    private let account = try! AccountID("account-mcp")

    func testCustomServerMetadataDecodesWithoutReturningTheCredential() async throws {
        let sender = MCPTestSender(list: #"{"connectors":[{"id":"user_mcp:server-a","kind":"user_mcp","label":"My tools","description":"Remote tools","capability":"Tools","configured":true,"connected":false,"url":"https://example.com/mcp","hasAuthHeader":true,"toolCount":2,"status":"ok"}]}"#)
        let result = try await NativeConnectorClient(sender: sender).connectors(for: account)
        let server = try XCTUnwrap(result.connectors.first)
        XCTAssertTrue(server.isCustomMCP)
        XCTAssertEqual(server.mcpRowID, "server-a")
        XCTAssertEqual(server.mcpURL, "https://example.com/mcp")
        XCTAssertTrue(server.hasAuthHeader)
        XCTAssertEqual(server.toolCount, 2)
        XCTAssertFalse(server.connected)
    }

    func testMCPMutationsUseServerRoutesAndExplicitCredentialSemantics() async throws {
        let sender = MCPTestSender()
        let client = NativeConnectorClient(sender: sender)
        let server = NativeConnector(id: "user_mcp:server-a", source: .native, kind: "user_mcp", label: "My tools", detail: "", connected: true)
        try await client.saveMCP(name: "My tools", url: "https://example.com/new", authHeader: nil, editing: server, for: account)
        _ = try await client.testMCP(url: "https://example.com/new", authHeader: nil, clearAuth: true, editing: server, for: account)
        try await client.setMCPEnabled(server, enabled: false, for: account)
        try await client.disconnect(server, for: account)
        let requests = await sender.requests
        XCTAssertEqual(requests.map(\.path), ["/api/mcp/servers/server-a", "/api/mcp/servers/server-a/test", "/api/mcp/servers/server-a", "/api/mcp/servers/server-a"])
        XCTAssertEqual(requests.map(\.method), [.patch, .post, .patch, .delete])
        let bodies = try requests.prefix(3).map { request -> [String: JunoJSONValue] in
            let data = try XCTUnwrap(request.body)
            guard case .object(let value) = try JSONDecoder().decode(JunoJSONValue.self, from: data) else { throw URLError(.badServerResponse) }
            return value
        }
        XCTAssertNil(bodies[0]["authHeader"], "omission keeps the saved credential")
        XCTAssertEqual(bodies[1]["authHeader"], .null, "null explicitly clears the saved credential for the draft test")
        XCTAssertEqual(bodies[1]["url"], .string("https://example.com/new"))
        XCTAssertEqual(bodies[2], ["enabled": .bool(false)])
    }
}

private actor MCPTestSender: NativeAuthenticatedRequestSending {
    private let list: String
    private(set) var requests: [NativeBearerRequest] = []
    init(list: String = "{}") { self.list = list }
    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        let body = request.method == .get ? list : #"{"result":{"ok":true,"toolNames":["search"]}}"#
        return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}
