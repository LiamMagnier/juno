import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

final class MCPFoundationTests: XCTestCase {
    private var workspaceURL: URL!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-mcp-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    func testMalformedJSONRPCMessagesAreRejected() throws {
        let malformed = [
            "",
            "[]",
            "{\"jsonrpc\":\"1.0\",\"id\":1,\"result\":{}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{},\"error\":{}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"x\",\"params\":true}",
        ]

        for line in malformed {
            XCTAssertThrowsError(try MCPJSONRPCMessage.parse(line: line), line)
        }

        let notification = try MCPJSONRPCMessage.parse(
            line: "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}"
        )
        guard case .notification = notification else {
            return XCTFail("valid notification was not decoded")
        }
    }

    func testClientPerformsInitializeListsToolsAndDecodesToolResult() async throws {
        let transport = QueuedLineTransport(lines: [
            response(id: 1, result: initializeResult()),
            response(id: 2, result: toolListResult()),
            response(id: 3, result: toolCallResult()),
        ])
        let client = MCPClient(transport: transport)

        try await client.connect()
        let tools = try await client.listTools()
        XCTAssertEqual(tools.map { $0.name }, ["search"])
        XCTAssertEqual(tools[0].inputSchema["type"]?.stringValue, "object")

        let result = try await client.callTool(
            name: "search",
            arguments: ["query": "Juno"]
        )
        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.textContent, "Found Juno")
        XCTAssertEqual(result.content.count, 2)
        XCTAssertEqual(result.content[1].type, "image")
        XCTAssertEqual(result.content[1].mimeType, "image/png")
        XCTAssertEqual(result.structuredContent?["count"]?.intValue, 1)

        let sent = await transport.sentLines()
        XCTAssertEqual(sent.count, 4, "initialize, initialized, tools/list, tools/call")
        XCTAssertTrue(sent[0].contains("\"method\":\"initialize\""))
        XCTAssertTrue(sent[1].contains("notifications/initialized"))
        XCTAssertTrue(sent[2].contains("tools/list"))
        XCTAssertTrue(sent[3].contains("tools/call"))
    }

    func testClientSupportsToolListPagination() async throws {
        let firstPage = JSONValue.object([
            "tools": .array([toolDefinition(name: "first")]),
            "nextCursor": .string("page-2"),
        ])
        let secondPage = JSONValue.object([
            "tools": .array([toolDefinition(name: "second")]),
        ])
        let transport = QueuedLineTransport(lines: [
            response(id: 1, result: initializeResult()),
            response(id: 2, result: firstPage),
            response(id: 3, result: secondPage),
        ])
        let client = MCPClient(transport: transport)

        try await client.connect()
        let tools = try await client.listTools()

        XCTAssertEqual(tools.map { $0.name }, ["first", "second"])
        let sent = await transport.sentLines()
        XCTAssertTrue(sent[3].contains("page-2"))
    }

    func testClientTimesOutAndClosesAnUnresponsiveTransport() async throws {
        let transport = QueuedLineTransport(lines: [], blockWhenEmpty: true)
        let client = MCPClient(
            transport: transport,
            configuration: MCPClientConfiguration(requestTimeout: 0.02)
        )

        do {
            try await client.connect()
            XCTFail("expected timeout")
        } catch let error as MCPError {
            guard case .timedOut(method: "initialize") = error else {
                return XCTFail("unexpected MCP error: \(error)")
            }
        }
        let state = await client.state
        XCTAssertTrue(isFailed(state))
    }

    func testClientCancellationPropagatesAndDoesNotHang() async throws {
        let transport = QueuedLineTransport(lines: [], blockWhenEmpty: true)
        let client = MCPClient(
            transport: transport,
            configuration: MCPClientConfiguration(requestTimeout: 10)
        )
        let connection = Task {
            try await client.connect()
        }

        try await Task.sleep(nanoseconds: 20_000_000)
        connection.cancel()

        do {
            _ = try await connection.value
            XCTFail("expected cancellation")
        } catch is CancellationError {
            // Expected.
        } catch {
            XCTFail("unexpected cancellation error: \(error)")
        }

        let state = await client.state
        XCTAssertEqual(state, .closed)
    }

    func testClientStartFailureLeavesAClosedTransportAndFailedState() async throws {
        let transport = FailingStartTransport()
        let client = MCPClient(transport: transport)

        do {
            try await client.connect()
            XCTFail("expected startup failure")
        } catch let error as MCPError {
            XCTAssertEqual(error, .transportFailure("startup failed"))
        }

        let closeCount = await transport.closeCount
        XCTAssertEqual(closeCount, 1)
        let state = await client.state
        guard case .failed = state else {
            return XCTFail("startup failure should be terminal")
        }
    }

    func testMalformedToolListResultClosesTheClient() async throws {
        let transport = QueuedLineTransport(lines: [
            response(id: 1, result: initializeResult()),
            response(id: 2, result: .array([.string("not an object")])),
        ])
        let client = MCPClient(transport: transport)

        try await client.connect()
        do {
            _ = try await client.listTools()
            XCTFail("expected malformed tools/list result")
        } catch let error as MCPError {
            guard case .malformedMessage = error else {
                return XCTFail("unexpected MCP error: \(error)")
            }
        }
        let state = await client.state
        guard case .failed = state else {
            return XCTFail("malformed tools/list should fail the client")
        }
    }

    func testMalformedToolCallResultClosesTheClient() async throws {
        let transport = QueuedLineTransport(lines: [
            response(id: 1, result: initializeResult()),
            response(id: 2, result: toolListResult()),
            response(id: 3, result: ["content": ["bad"]]),
        ])
        let client = MCPClient(transport: transport)

        try await client.connect()
        _ = try await client.listTools()
        do {
            _ = try await client.callTool(name: "search", arguments: ["query": "Juno"])
            XCTFail("expected malformed tools/call result")
        } catch let error as MCPError {
            guard case .invalidToolResult = error else {
                return XCTFail("unexpected MCP error: \(error)")
            }
        }
        let state = await client.state
        guard case .failed = state else {
            return XCTFail("malformed tools/call should fail the client")
        }
    }

    func testStdioTransportReadsARealProcessLine() async throws {
        let configuration = try MCPServerConfiguration(
            name: "printf",
            command: "/usr/bin/printf",
            arguments: ["%s\\n", "stdio-ok"]
        )
        let transport = MCPStdioTransport(configuration: configuration, workspaceRootURL: workspaceURL)

        try await transport.start()
        let line = try await transport.receiveLine()
        XCTAssertEqual(line, "stdio-ok")
        await transport.close()
    }

    func testWorkspaceConfigurationMergesBothSupportedFilesSafely() throws {
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent(".juno", isDirectory: true),
            withIntermediateDirectories: true
        )
        try writeJSON(
            [
                "mcpServers": [
                    "shared": ["command": "from-root"],
                    "root-only": ["command": "root-server"],
                ],
            ],
            to: workspaceURL.appendingPathComponent(".mcp.json")
        )
        try writeJSON(
            [
                "mcpServers": [
                    "shared": ["command": "from-juno"],
                    "juno-only": ["command": "juno-server", "args": ["--stdio"]],
                ],
            ],
            to: workspaceURL.appendingPathComponent(".juno/mcp.json")
        )

        let configurations = try MCPConfigurationLoader.load(from: workspaceURL)
        XCTAssertEqual(configurations.map(\.name), ["juno-only", "root-only", "shared"])
        XCTAssertEqual(configurations.first(where: { $0.name == "shared" })?.command, "from-juno")
        XCTAssertEqual(configurations.first(where: { $0.name == "juno-only" })?.arguments, ["--stdio"])
    }

    func testWorkspaceConfigurationAcceptsStreamableHTTPServers() throws {
        try writeJSON(
            [
                "mcpServers": [
                    "remote": [
                        "type": "streamable-http",
                        "url": "https://mcp.example.test/v1",
                        "headers": ["X-Workspace": "juno"],
                    ],
                ],
            ],
            to: workspaceURL.appendingPathComponent(".mcp.json")
        )

        let configuration = try XCTUnwrap(
            try MCPConfigurationLoader.load(from: workspaceURL).first
        )
        XCTAssertEqual(configuration.transport, .streamableHTTP)
        XCTAssertEqual(configuration.url?.absoluteString, "https://mcp.example.test/v1")
        XCTAssertEqual(configuration.headers["X-Workspace"], "juno")
    }

    func testRegistryRequiresAuthorizationBeforeCallingAConfiguredTool() async throws {
        let configuration = try MCPServerConfiguration(name: "search", command: "fake-server")
        let registry = try MCPToolRegistry(
            workspaceRootURL: workspaceURL,
            configurations: [configuration],
            transportFactory: { _, _ in
                QueuedLineTransport(lines: [
                    response(id: 1, result: initializeResult()),
                    response(id: 2, result: toolListResult()),
                    response(id: 3, result: toolCallResult()),
                ])
            },
            startupAuthorizer: { _ in true }
        )

        let references = try await registry.allTools()
        XCTAssertEqual(references.map { $0.qualifiedName }, ["search/search"])

        let authorization = AuthorizationRecorder()
        let result = try await registry.invoke(
            serverID: "search",
            toolName: "search",
            arguments: ["query": "Juno"],
            authorize: { invocation, definition in
                await authorization.record(invocation: invocation, definition: definition)
            }
        )
        XCTAssertEqual(result.textContent, "Found Juno")
        let recorded = await authorization.value()
        XCTAssertEqual(recorded?.invocation.toolName, "search")
        XCTAssertEqual(recorded?.definition.name, "search")
    }

    func testRegistryDeniesAnUnapprovedServerBeforeCreatingItsTransport() async throws {
        let configuration = try MCPServerConfiguration(name: "search", command: "fake-server")
        let factory = TransportFactoryRecorder()
        let registry = try MCPToolRegistry(
            workspaceRootURL: workspaceURL,
            configurations: [configuration],
            transportFactory: { _, _ in
                factory.recordCreation()
                return QueuedLineTransport(lines: [])
            }
        )

        let tools = try await registry.allTools()
        let state = try await registry.state(for: "search")

        XCTAssertTrue(tools.isEmpty)
        XCTAssertEqual(factory.creationCount(), 0)
        XCTAssertEqual(state, .closed)
    }

    func testToolRegistryCompositionPreservesJunoApprovalForMCPTools() async throws {
        try writeJSON(
            ["mcpServers": ["search": ["command": "fake-server"]]],
            to: workspaceURL.appendingPathComponent(".mcp.json")
        )
        let mcpRegistry = try MCPToolRegistry(
            workspaceRootURL: workspaceURL,
            transportFactory: { _, _ in
                QueuedLineTransport(lines: [
                    response(id: 1, result: initializeResult()),
                    response(id: 2, result: toolListResult()),
                    response(id: 3, result: toolCallResult()),
                ])
            },
            startupAuthorizer: { _ in true }
        )
        let baseRegistry = ToolRegistry(tools: [])
        let activeRegistry = try await baseRegistry.includingMCPTools(from: mcpRegistry)
        let tool = try XCTUnwrap(activeRegistry.tool(named: "mcp__search__search"))
        XCTAssertEqual(tool.approvalPolicy, .alwaysRequiresApproval)

        let sessionID = CodeSessionID()
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let observerID = await permissions.addObserver { update in
            guard case let .requested(request) = update else { return }
            Task {
                await permissions.resolve(
                    approvalID: request.id,
                    decision: .approved
                )
            }
        }
        let context = ToolContext(
            sessionID: sessionID,
            toolCallID: "mcp-call",
            emitOutput: { _, _ in }
        )
        let result = try await activeRegistry.invoke(
            toolName: "mcp__search__search",
            input: ["query": "Juno"],
            context: context,
            permissions: permissions
        )
        await permissions.removeObserver(observerID)

        XCTAssertEqual(result.content, "Found Juno")
        XCTAssertFalse(result.isError)
    }

    func testRegistryShutdownClosesClientsAndDropsCachedTools() async throws {
        let configuration = try MCPServerConfiguration(name: "search", command: "fake-server")
        let registry = try MCPToolRegistry(
            workspaceRootURL: workspaceURL,
            configurations: [configuration],
            transportFactory: { _, _ in
                QueuedLineTransport(lines: [
                    response(id: 1, result: initializeResult()),
                    response(id: 2, result: toolListResult()),
                ])
            },
            startupAuthorizer: { _ in true }
        )

        _ = try await registry.tools(for: "search")
        try await registry.disconnect(serverID: "search")

        let disconnectedState = try await registry.state(for: "search")
        XCTAssertEqual(disconnectedState, .closed)
        await registry.disconnectAll()

        let cached = try await registry.cachedTools(for: "search")
        XCTAssertTrue(cached.isEmpty)
    }

    func testRegistryDoesNotCallAuthorizerForUnknownTool() async throws {
        let configuration = try MCPServerConfiguration(name: "search", command: "fake-server")
        let registry = try MCPToolRegistry(
            workspaceRootURL: workspaceURL,
            configurations: [configuration],
            transportFactory: { _, _ in
                QueuedLineTransport(lines: [
                    response(id: 1, result: initializeResult()),
                    response(id: 2, result: toolListResult()),
                ])
            },
            startupAuthorizer: { _ in true }
        )
        let authorization = AuthorizationRecorder()

        do {
            _ = try await registry.invoke(
                serverID: "search",
                toolName: "missing",
                authorize: { invocation, definition in
                    await authorization.record(invocation: invocation, definition: definition)
                }
            )
            XCTFail("expected unknown tool")
        } catch let error as MCPError {
            guard case .toolNotFound(serverID: "search", name: "missing") = error else {
                return XCTFail("unexpected MCP error: \(error)")
            }
        }
        let recorded = await authorization.value()
        XCTAssertNil(recorded)
    }

    // MARK: - JSON fixtures

    private func writeJSON(_ object: [String: Any], to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try data.write(to: url)
    }

    private func isFailed(_ state: MCPClientState) -> Bool {
        if case .failed = state { return true }
        return false
    }
}

private actor QueuedLineTransport: MCPLineTransport {
    private var lines: [String]
    private let blockWhenEmpty: Bool
    private var sent: [String] = []

    init(lines: [String], blockWhenEmpty: Bool = false) {
        self.lines = lines
        self.blockWhenEmpty = blockWhenEmpty
    }

    func start() async throws {}

    func send(line: String) async throws {
        sent.append(line)
    }

    func receiveLine() async throws -> String? {
        if !lines.isEmpty {
            return lines.removeFirst()
        }
        if blockWhenEmpty {
            while true {
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        return nil
    }

    func close() async {}

    func sentLines() -> [String] { sent }
}

private actor FailingStartTransport: MCPLineTransport {
    private(set) var closeCount = 0

    func start() async throws {
        throw MCPError.transportFailure("startup failed")
    }

    func send(line _: String) async throws {
        throw MCPError.transportFailure("unexpected send")
    }

    func receiveLine() async throws -> String? { nil }

    func close() async {
        closeCount += 1
    }
}

private actor AuthorizationRecorder {
    private var recorded: (invocation: MCPToolInvocation, definition: MCPToolDefinition)?

    func record(invocation: MCPToolInvocation, definition: MCPToolDefinition) {
        recorded = (invocation, definition)
    }

    func value() -> (invocation: MCPToolInvocation, definition: MCPToolDefinition)? {
        recorded
    }
}

private final class TransportFactoryRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var creations = 0

    func recordCreation() {
        lock.lock()
        defer { lock.unlock() }
        creations += 1
    }

    func creationCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return creations
    }
}

private func response(id: Int, result: JSONValue) -> String {
    MCPJSONRPCMessage.response(id: .number(Double(id)), result: result).encodedLine()
}

private func initializeResult() -> JSONValue {
    [
        "protocolVersion": "2025-06-18",
        "capabilities": ["tools": ["listChanged": false]],
        "serverInfo": ["name": "fake-server", "version": "1.0"],
    ]
}

private func toolListResult() -> JSONValue {
    ["tools": [toolDefinition(name: "search")]]
}

private func toolCallResult() -> JSONValue {
    [
        "content": [
            ["type": "text", "text": "Found Juno"],
            ["type": "image", "data": "aGVsbG8=", "mimeType": "image/png"],
        ],
        "isError": false,
        "structuredContent": ["count": 1],
    ]
}

private func toolDefinition(name: String) -> JSONValue {
    [
        "name": .string(name),
        "description": "Search the workspace",
        "inputSchema": [
            "type": "object",
            "properties": ["query": ["type": "string"]],
            "required": ["query"],
        ],
    ]
}
