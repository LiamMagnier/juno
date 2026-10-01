import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// Bring your own MCP server: the wire, the paths and the two flows.
final class NativeCustomConnectorTests: XCTestCase {
    private let account = try! AccountID("account-custom-mcp")

    // MARK: Directory

    func testTheDirectoryDecodesCustomServersAsTheirOwnSource() async throws {
        let transport = MemoryTransport(routes: ["GET /api/connectors": .json(directoryJSON)])
        let (connectors, _) = try await NativeConnectorClient(sender: transport).connectors(for: account)
        let custom = try XCTUnwrap(connectors.first { $0.id == "mcp:abc123def4" })
        XCTAssertEqual(custom.source, .custom)
        XCTAssertTrue(custom.isCustom)
        XCTAssertEqual(custom.url, "https://mcp.linear.app/mcp")
        XCTAssertEqual(custom.toolCount, 12)
        XCTAssertEqual(custom.accountLabel, "mcp.linear.app")
        XCTAssertEqual(custom.detail, "Issues and projects", "the server's own line, not the capability sentence")
        XCTAssertTrue(custom.canConnect)
        XCTAssertNil(custom.blockedReason)

        let unlisted = try XCTUnwrap(connectors.first { $0.id == "mcp:zzz9990000" })
        XCTAssertNil(unlisted.toolCount, "never listed stays nil, not zero")
        XCTAssertFalse(unlisted.connected)

        let github = try XCTUnwrap(connectors.first { $0.id == "github" })
        XCTAssertEqual(github.source, .native)
        XCTAssertNil(github.url)
        XCTAssertNil(github.toolCount)
    }

    func testSigningOutACustomServerUsesTheSharedRouteWithTheColonEncoded() async throws {
        let transport = MemoryTransport(routes: ["DELETE /api/connectors/mcp%3Aabc123def4": .json(#"{"ok":true}"#)])
        let connector = NativeConnector(
            id: "mcp:abc123def4", source: .custom, kind: "custom_mcp", label: "Linear", detail: "", connected: true
        )
        try await NativeConnectorClient(sender: transport).disconnect(connector, for: account)
        let requests = await transport.recorded()
        XCTAssertEqual(requests.map(\.path), ["/api/connectors/mcp%3Aabc123def4"])
    }

    // MARK: Paths

    func testPathsEncodeLikeEncodeURIComponent() throws {
        XCTAssertEqual(NativeCustomConnectorPath.encode("mcp:abc123def4"), "mcp%3Aabc123def4")
        XCTAssertEqual(NativeCustomConnectorPath.encode("a/b c"), "a%2Fb%20c")
        XCTAssertEqual(NativeCustomConnectorPath.resource("mcp:x"), "/api/connectors/custom/mcp%3Ax")
        XCTAssertEqual(NativeCustomConnectorPath.tools("mcp:x"), "/api/connectors/custom/mcp%3Ax/tools")
        XCTAssertEqual(NativeCustomConnectorPath.signOut("mcp:x"), "/api/connectors/mcp%3Ax")

        let backend = try XCTUnwrap(URL(string: "https://juno.example"))
        XCTAssertEqual(
            NativeCustomConnectorPath.connectURL(backend: backend, id: "mcp:abc123def4")?.absoluteString,
            "https://juno.example/api/connectors/custom/mcp%3Aabc123def4/connect",
            "the encoded colon is not escaped a second time"
        )
        let slashed = try XCTUnwrap(URL(string: "https://juno.example/"))
        XCTAssertEqual(
            NativeCustomConnectorPath.connectURL(backend: slashed, id: "mcp:a")?.absoluteString,
            "https://juno.example/api/connectors/custom/mcp%3Aa/connect"
        )
    }

    func testMonogramIsTheFirstLetterOrDigit() {
        XCTAssertEqual(NativeCustomConnectorPath.monogram("linear"), "L")
        XCTAssertEqual(NativeCustomConnectorPath.monogram("  #1 tools"), "1")
        XCTAssertEqual(NativeCustomConnectorPath.monogram("élan"), "É")
        XCTAssertEqual(NativeCustomConnectorPath.monogram("—"), "M")
    }

    // MARK: Client

    func testProbeReadsReadyAndRefusedAnswers() async throws {
        let ready = MemoryTransport(routes: ["POST /api/connectors/custom/probe": .json(readyJSON)])
        let client = NativeConnectorClient(sender: ready)
        let answer = try await client.probeCustomConnector(url: "mcp.linear.app/mcp", for: account)
        XCTAssertEqual(
            answer,
            .ready(
                NativeCustomConnectorCandidate(
                    url: "https://mcp.linear.app/mcp", host: "mcp.linear.app", authHost: "linear.app",
                    suggestedName: "Linear"
                )
            )
        )
        let sent = await ready.recorded()
        XCTAssertEqual(sent.first?.method, .post)
        XCTAssertEqual(try object(sent[0])["url"], .string("mcp.linear.app/mcp"))

        let refused = MemoryTransport(routes: ["POST /api/connectors/custom/probe": .json(refusedJSON)])
        let no = try await NativeConnectorClient(sender: refused).probeCustomConnector(url: "x", for: account)
        XCTAssertEqual(
            no,
            .refused(reason: "no_oauth", message: "This server doesn't sign in with OAuth, so Juno can't connect to it yet.")
        )
    }

    func testCreateGetPatchRemoveAndRefreshAddressTheEncodedResource() async throws {
        let transport = MemoryTransport(routes: [
            "POST /api/connectors/custom": .json(#"{"connector":\#(connectorJSON),"connectUrl":"/api/connectors/custom/mcp%3Aabc123def4/connect"}"#, status: 201),
            "GET /api/connectors/custom/mcp%3Aabc123def4": .json(#"{"connector":\#(connectorJSON)}"#),
            "PATCH /api/connectors/custom/mcp%3Aabc123def4": .json(#"{"connector":\#(connectorJSON)}"#),
            "POST /api/connectors/custom/mcp%3Aabc123def4/tools": .json(#"{"connector":\#(connectorJSON)}"#),
            "DELETE /api/connectors/custom/mcp%3Aabc123def4": .json(#"{"ok":true}"#),
        ])
        let client = NativeConnectorClient(sender: transport)
        let created = try await client.createCustomConnector(url: "https://mcp.linear.app/mcp", name: "Linear", for: account)
        XCTAssertFalse(created.existing)
        XCTAssertEqual(created.connector.id, "mcp:abc123def4")
        XCTAssertEqual(created.connector.reads.map(\.name), ["list_issues"])
        XCTAssertEqual(created.connector.changes.map(\.name), ["create_issue", "mystery"], "unknown groups with changes")
        XCTAssertEqual(created.connector.enabledCount, 2)
        XCTAssertEqual(created.connector.tools?.last?.access, .unknown, "a value from the future is unknown")
        XCTAssertEqual(created.connector.tools?.first?.displayName, "List issues")
        XCTAssertEqual(created.connector.tools?[1].displayName, "create_issue", "no title falls back to the name")

        _ = try await client.customConnector(id: "mcp:abc123def4", for: account)
        _ = try await client.updateCustomConnector(id: "mcp:abc123def4", disabledTools: ["mystery"], for: account)
        _ = try await client.updateCustomConnector(id: "mcp:abc123def4", name: "Work Linear", for: account)
        _ = try await client.refreshCustomConnectorTools(id: "mcp:abc123def4", for: account)
        try await client.removeCustomConnector(id: "mcp:abc123def4", for: account)

        let requests = await transport.recorded()
        XCTAssertEqual(
            requests.map { "\($0.method.rawValue) \($0.path)" },
            [
                "POST /api/connectors/custom",
                "GET /api/connectors/custom/mcp%3Aabc123def4",
                "PATCH /api/connectors/custom/mcp%3Aabc123def4",
                "PATCH /api/connectors/custom/mcp%3Aabc123def4",
                "POST /api/connectors/custom/mcp%3Aabc123def4/tools",
                "DELETE /api/connectors/custom/mcp%3Aabc123def4",
            ]
        )
        XCTAssertEqual(try object(requests[0]), ["url": .string("https://mcp.linear.app/mcp"), "name": .string("Linear")])
        XCTAssertEqual(try object(requests[2]), ["disabledTools": .array([.string("mystery")])], "only what changed is sent")
        XCTAssertEqual(try object(requests[3]), ["name": .string("Work Linear")])
    }

    func testRefusalsCarryTheServersSentenceAndBareCodesDoNot() async throws {
        let transport = MemoryTransport(routes: [
            "POST /api/connectors/custom": .json(#"{"error":"limit","message":"You can add up to 20 servers. Remove one to add another."}"#, status: 409),
            "GET /api/connectors/custom/mcp%3Agone": .json(#"{"error":"not_found"}"#, status: 404),
        ])
        let client = NativeConnectorClient(sender: transport)
        do {
            _ = try await client.createCustomConnector(url: "https://a.example", name: "A", for: account)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error.localizedDescription, "You can add up to 20 servers. Remove one to add another.")
        }
        do {
            _ = try await client.customConnector(id: "mcp:gone", for: account)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error.localizedDescription, "This server isn’t in your connections any more.")
        }
    }

    // MARK: Add flow

    @MainActor
    func testDraftChecksNamesAndCreates() async throws {
        let transport = MemoryTransport(routes: [
            "POST /api/connectors/custom/probe": .json(readyJSON),
            "POST /api/connectors/custom": .json(#"{"connector":\#(connectorJSON),"connectUrl":"/x"}"#, status: 201),
        ])
        let draft = NativeCustomConnectorDraft(client: NativeConnectorClient(sender: transport), accountID: account)
        XCTAssertFalse(draft.canCheck)
        draft.address = "  https://mcp.linear.app/mcp "
        XCTAssertEqual(draft.checkingHost, "mcp.linear.app")
        await draft.check()
        XCTAssertEqual(draft.candidate?.authHost, "linear.app")
        XCTAssertEqual(draft.name, "Linear")
        draft.name = String(repeating: "n", count: 80)
        XCTAssertEqual(draft.name.count, 60, "the route's limit, held in the field")
        draft.name = "  "
        XCTAssertFalse(draft.canContinue, "a blank name cannot continue")
        draft.name = "Work Linear"
        let created = await draft.create()
        XCTAssertEqual(created?.id, "mcp:abc123def4")
        XCTAssertTrue(draft.isCreating, "held while the browser opens")
        let requests = await transport.recorded()
        XCTAssertEqual(try object(requests[1])["name"], .string("Work Linear"))
    }

    @MainActor
    func testDraftShowsRefusalsVerbatimAndClearsThemOnEdit() async throws {
        let transport = MemoryTransport(routes: ["POST /api/connectors/custom/probe": .json(refusedJSON)])
        let draft = NativeCustomConnectorDraft(client: NativeConnectorClient(sender: transport), accountID: account)
        draft.address = "plain.example"
        XCTAssertEqual(draft.checkingHost, "plain.example")
        await draft.check()
        XCTAssertEqual(draft.step, .address)
        XCTAssertEqual(draft.refusal, "This server doesn't sign in with OAuth, so Juno can't connect to it yet.")
        draft.address = "plain.example/mcp"
        XCTAssertNil(draft.refusal)
    }

    @MainActor
    func testDraftOffersTheExistingNameAndSaysWhySavingFailed() async throws {
        let transport = MemoryTransport(routes: [
            "POST /api/connectors/custom/probe": .json(#"{"ok":true,"url":"https://a.example/mcp","host":"a.example","authHost":"a.example","suggestedName":"A","existing":{"id":"mcp:aaaaaaaaaa","name":"Mine"}}"#),
            "POST /api/connectors/custom": .json(#"{"error":"unreachable","message":"Juno couldn't reach that server."}"#, status: 422),
        ])
        let draft = NativeCustomConnectorDraft(client: NativeConnectorClient(sender: transport), accountID: account)
        draft.address = "a.example/mcp"
        await draft.check()
        XCTAssertEqual(draft.candidate?.isExisting, true)
        XCTAssertEqual(draft.name, "Mine")
        let created = await draft.create()
        XCTAssertNil(created)
        XCTAssertFalse(draft.isCreating)
        XCTAssertEqual(draft.refusal, "Juno couldn't reach that server.")
        draft.back()
        XCTAssertEqual(draft.step, .address)
        XCTAssertNil(draft.refusal)
    }

    // MARK: Manage flow

    @MainActor
    func testEditorListsUnlistedToolsOnLoadAndTogglesOptimistically() async throws {
        let unlisted = connectorJSON.replacingOccurrences(of: #""tools":["#, with: #""toolsX":["#)
        let transport = MemoryTransport(routes: [
            "GET /api/connectors/custom/mcp%3Aabc123def4": .json(#"{"connector":\#(unlisted)}"#),
            "POST /api/connectors/custom/mcp%3Aabc123def4/tools": .json(#"{"connector":\#(connectorJSON)}"#),
            "PATCH /api/connectors/custom/mcp%3Aabc123def4": .json(#"{"connector":\#(connectorJSON.replacingOccurrences(of: #""disabledTools":["mystery"]"#, with: #""disabledTools":["mystery","create_issue"]"#))}"#),
        ])
        var changes = 0
        let editor = NativeCustomConnectorEditor(
            id: "mcp:abc123def4", client: NativeConnectorClient(sender: transport), accountID: account
        ) { changes += 1 }
        await editor.load()
        XCTAssertEqual(editor.connector?.tools?.count, 3, "a connected server with no list is asked on open")
        XCTAssertEqual(changes, 1)

        let error = await editor.setTools(["create_issue"], enabled: false)
        XCTAssertNil(error)
        XCTAssertEqual(editor.connector?.disabledTools, ["mystery", "create_issue"])
        XCTAssertEqual(changes, 2)
        let requests = await transport.recorded()
        XCTAssertEqual(try object(requests.last!), ["disabledTools": .array([.string("mystery"), .string("create_issue")])])
    }

    @MainActor
    func testEditorRollsBackAFailedSaveAndRemoves() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/connectors/custom/mcp%3Aabc123def4": .json(#"{"connector":\#(connectorJSON)}"#),
            "PATCH /api/connectors/custom/mcp%3Aabc123def4": .json(#"{"error":"invalid_body"}"#, status: 400),
            "DELETE /api/connectors/mcp%3Aabc123def4": .json(#"{"ok":true}"#),
            "DELETE /api/connectors/custom/mcp%3Aabc123def4": .json(#"{"ok":true}"#),
        ])
        let editor = NativeCustomConnectorEditor(
            id: "mcp:abc123def4", client: NativeConnectorClient(sender: transport), accountID: account
        )
        await editor.load()
        let failed = await editor.rename("  Renamed  ")
        XCTAssertEqual(failed, "Something went wrong (400). Try again.")
        XCTAssertEqual(editor.connector?.name, "Linear", "rolled back")
        let unchanged = await editor.rename("Linear")
        XCTAssertNil(unchanged, "the same name sends nothing")

        let signedOut = await editor.signOut()
        XCTAssertNil(signedOut)
        XCTAssertEqual(editor.connector?.connected, false)
        let removed = await editor.remove()
        XCTAssertNil(removed)
        let paths = await transport.recorded().map { "\($0.method.rawValue) \($0.path)" }
        XCTAssertEqual(paths.filter { $0.hasPrefix("PATCH") }.count, 1)
        XCTAssertEqual(paths.suffix(2), ["DELETE /api/connectors/mcp%3Aabc123def4", "DELETE /api/connectors/custom/mcp%3Aabc123def4"])
    }

    private func object(_ request: NativeBearerRequest) throws -> [String: JunoJSONValue] {
        let data = try XCTUnwrap(request.body)
        guard case .object(let object) = try JSONDecoder().decode(JunoJSONValue.self, from: data) else {
            throw XCTSkip("not an object")
        }
        return object
    }
}

private let directoryJSON = #"""
{"connectors":[
  {"id":"github","kind":"oauth_app","label":"GitHub","description":"Pull requests.","capability":"Let the model read your repositories.","configured":true,"connected":true,"accountLabel":"liam"},
  {"id":"mcp:abc123def4","kind":"custom_mcp","label":"Linear","description":"Issues and projects","capability":"Let the model use the tools on mcp.linear.app.","configured":true,"connected":true,"accountLabel":"mcp.linear.app","connectedAt":"2026-09-27T10:00:00.000Z","url":"https://mcp.linear.app/mcp","toolCount":12},
  {"id":"mcp:zzz9990000","kind":"custom_mcp","label":"Docs","description":"MCP server at docs.example","capability":"x","configured":true,"connected":false,"accountLabel":"docs.example","connectedAt":null,"url":"https://docs.example/mcp","toolCount":null}
],"composioConfigured":false}
"""#

private let readyJSON = #"{"ok":true,"url":"https://mcp.linear.app/mcp","host":"mcp.linear.app","authHost":"linear.app","suggestedName":"Linear","existing":null}"#

private let refusedJSON = #"{"ok":false,"url":"https://plain.example/","reason":"no_oauth","message":"This server doesn't sign in with OAuth, so Juno can't connect to it yet."}"#

private let connectorJSON = #"{"id":"mcp:abc123def4","name":"Linear","url":"https://mcp.linear.app/mcp","host":"mcp.linear.app","description":"Issues and projects","serverName":"linear-mcp","connected":true,"connectedAt":"2026-09-27T10:00:00.000Z","disabledTools":["mystery"],"tools":[{"name":"list_issues","title":"List issues","description":"Lists issues.","access":"read"},{"name":"create_issue","access":"write"},{"name":"mystery","access":"sideways"}],"toolsCheckedAt":"2026-09-27T10:00:01.000Z","createdAt":"2026-09-27T09:59:00.000Z"}"#
