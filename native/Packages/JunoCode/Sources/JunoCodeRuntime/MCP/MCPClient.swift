import Foundation
import JunoCodeCore

public struct MCPClientConfiguration: Equatable, Sendable {
    public static let defaultProtocolVersion = "2025-06-18"

    public let preferredProtocolVersion: String
    public let supportedProtocolVersions: [String]
    public let clientInfo: MCPImplementation
    public let requestTimeout: TimeInterval

    public init(
        preferredProtocolVersion: String = MCPClientConfiguration.defaultProtocolVersion,
        supportedProtocolVersions: [String] = [MCPClientConfiguration.defaultProtocolVersion],
        clientInfo: MCPImplementation = MCPImplementation(name: "Juno Code", version: "native"),
        requestTimeout: TimeInterval = 30
    ) {
        self.preferredProtocolVersion = preferredProtocolVersion
        self.supportedProtocolVersions = Array(
            Set(supportedProtocolVersions + [preferredProtocolVersion])
        ).sorted()
        self.clientInfo = clientInfo
        self.requestTimeout = max(0, requestTimeout)
    }
}

public enum MCPClientState: Equatable, Sendable {
    case idle
    case connecting
    case ready
    case closing
    case closed
    case failed(reason: String)
}

/// A bounded, serialized MCP client. It implements the 2025-06-18 lifecycle,
/// `tools/list` (including cursors), and `tools/call` over any line transport.
public actor MCPClient {
    private let transport: any MCPLineTransport
    private let configuration: MCPClientConfiguration

    private var currentState: MCPClientState = .idle
    private var nextRequestNumber = 1
    private var requestInFlight = false

    public private(set) var serverInfo: MCPImplementation?
    public private(set) var serverCapabilities: JSONValue?
    public private(set) var negotiatedProtocolVersion: String?

    public init(
        transport: any MCPLineTransport,
        configuration: MCPClientConfiguration = MCPClientConfiguration()
    ) {
        self.transport = transport
        self.configuration = configuration
    }

    public var state: MCPClientState { currentState }

    public func connect() async throws {
        guard currentState == .idle else {
            throw currentState == .ready ? MCPError.alreadyConnected : MCPError.invalidProtocol(
                "client cannot connect from state \(currentState)"
            )
        }
        currentState = .connecting

        do {
            try await transport.start()
            let initializeResult = try await request(
                method: "initialize",
                params: .object([
                    "protocolVersion": .string(configuration.preferredProtocolVersion),
                    "capabilities": .object([:]),
                    "clientInfo": implementationJSON(configuration.clientInfo),
                ])
            )
            let initialized = try MCPInitializeResult(json: initializeResult)
            guard configuration.supportedProtocolVersions.contains(initialized.protocolVersion) else {
                throw MCPError.unsupportedProtocolVersion(initialized.protocolVersion)
            }

            try await transport.send(
                line: MCPJSONRPCMessage.notification(method: "notifications/initialized", params: nil)
                    .encodedLine()
            )
            serverInfo = initialized.serverInfo
            serverCapabilities = initialized.capabilities
            negotiatedProtocolVersion = initialized.protocolVersion
            currentState = .ready
        } catch {
            await transport.close()
            currentState = error is CancellationError
                ? .closed
                : .failed(reason: error.localizedDescription)
            throw error
        }
    }

    public func disconnect() async {
        guard currentState != .closed else { return }
        currentState = .closing
        await transport.close()
        currentState = .closed
    }

    public func listTools() async throws -> [MCPToolDefinition] {
        try requireReady()
        do {
            var tools: [MCPToolDefinition] = []
            var cursor: String?
            var seenCursors: Set<String> = []

            repeat {
                var params: JSONValue?
                if let cursor {
                    params = .object(["cursor": .string(cursor)])
                }
                let result = try await request(method: "tools/list", params: params)
                let page = try MCPToolListPage(json: result)
                tools.append(contentsOf: page.tools)
                cursor = page.nextCursor
                if let cursor {
                    guard seenCursors.insert(cursor).inserted else {
                        throw MCPError.invalidProtocol("tools/list returned a repeated cursor")
                    }
                }
            } while cursor != nil

            return tools
        } catch {
            await closeAfterMalformedPayload(error)
            throw error
        }
    }

    public func callTool(name: String, arguments: JSONValue = .object([:])) async throws -> MCPToolResult {
        try requireReady()
        guard !name.isEmpty else {
            throw MCPError.invalidProtocol("MCP tool name cannot be empty")
        }
        guard arguments.objectValue != nil else {
            throw MCPError.invalidProtocol("MCP tool arguments must be an object")
        }
        do {
            let result = try await request(
                method: "tools/call",
                params: .object([
                    "name": .string(name),
                    "arguments": arguments,
                ])
            )
            return try MCPToolResult(json: result)
        } catch {
            await closeAfterMalformedPayload(error)
            throw error
        }
    }

    private func request(method: String, params: JSONValue?) async throws -> JSONValue {
        guard currentState == .connecting || currentState == .ready else {
            throw MCPError.notConnected
        }
        guard !requestInFlight else { throw MCPError.requestInFlight }
        requestInFlight = true
        defer { requestInFlight = false }

        let requestID = MCPJSONRPCID.number(Double(nextRequestNumber))
        nextRequestNumber += 1
        let line = MCPJSONRPCMessage.request(id: requestID, method: method, params: params).encodedLine()

        do {
            try Task.checkCancellation()
            try await transport.send(line: line)

            while true {
                guard let incoming = try await receiveLineWithTimeout(for: method) else {
                    throw MCPError.transportClosed
                }
                let message = try MCPJSONRPCMessage.parse(line: incoming)
                switch message {
                case .notification:
                    // Logging and progress notifications are safe to ignore in
                    // this foundation; they must not steal a pending response.
                    continue
                case let .response(id, result):
                    guard id == requestID else {
                        throw MCPError.unexpectedResponse(expected: requestID, received: id)
                    }
                    return result
                case let .error(id, error):
                    guard id == requestID else {
                        throw MCPError.unexpectedResponse(expected: requestID, received: id)
                    }
                    throw MCPError.serverError(error)
                case .request:
                    throw MCPError.invalidProtocol("server requests are not supported by this bounded client")
                }
            }
        } catch {
            if shouldClose(after: error) {
                await transport.close()
                currentState = error is CancellationError ? .closed : .failed(
                    reason: error.localizedDescription
                )
            }
            throw error
        }
    }

    private func receiveLineWithTimeout(for method: String) async throws -> String? {
        let transport = self.transport
        return try await withThrowingTaskGroup(of: String?.self) { group in
            group.addTask {
                try await transport.receiveLine()
            }
            group.addTask {
                let nanoseconds = UInt64(min(self.configuration.requestTimeout, 86_400) * 1_000_000_000)
                try await Task.sleep(nanoseconds: nanoseconds)
                throw MCPError.timedOut(method: method)
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else {
                throw MCPError.transportClosed
            }
            return result
        }
    }

    private func requireReady() throws {
        guard currentState == .ready else { throw MCPError.notConnected }
    }

    private func closeAfterMalformedPayload(_ error: Error) async {
        guard let error = error as? MCPError else { return }
        switch error {
        case .malformedMessage, .invalidProtocol, .invalidToolResult:
            break
        default:
            return
        }
        await transport.close()
        currentState = .failed(reason: error.localizedDescription)
    }

    private func shouldClose(after error: Error) -> Bool {
        if error is CancellationError { return true }
        guard let error = error as? MCPError else { return false }
        switch error {
        case .serverError:
            return false
        default:
            return true
        }
    }

    private func implementationJSON(_ implementation: MCPImplementation) -> JSONValue {
        var fields: [String: JSONValue] = [
            "name": .string(implementation.name),
            "version": .string(implementation.version),
        ]
        if let title = implementation.title { fields["title"] = .string(title) }
        return .object(fields)
    }
}
