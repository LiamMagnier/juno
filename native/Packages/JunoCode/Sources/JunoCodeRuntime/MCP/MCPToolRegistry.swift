import Foundation
import JunoCodeCore

public struct MCPToolReference: Equatable, Sendable {
    public let serverID: String
    public let definition: MCPToolDefinition

    public init(serverID: String, definition: MCPToolDefinition) {
        self.serverID = serverID
        self.definition = definition
    }

    /// Stable, collision-free display/integration name for a multi-server
    /// registry. The raw MCP tool name remains in `definition.name`.
    public var qualifiedName: String {
        "\(serverID)/\(definition.name)"
    }
}

public struct MCPToolInvocation: Equatable, Sendable {
    public let serverID: String
    public let toolName: String
    public let arguments: JSONValue

    public init(serverID: String, toolName: String, arguments: JSONValue) {
        self.serverID = serverID
        self.toolName = toolName
        self.arguments = arguments
    }
}

/// The host must authorize every external MCP tool call. The registry never
/// supplies an implicit allow closure, so adding MCP discovery cannot bypass
/// Juno's existing permission coordinator.
public typealias MCPToolInvocationAuthorizer = @Sendable (
    MCPToolInvocation,
    MCPToolDefinition
) async throws -> Void

public typealias MCPTransportFactory = @Sendable (
    MCPServerConfiguration,
    URL
) -> any MCPLineTransport

/// Minimal workspace MCP registry: load configured stdio servers, lazily
/// connect them, discover schema-bearing tools, and invoke only after the host
/// provides an explicit authorization closure.
public actor MCPToolRegistry {
    private let workspaceRootURL: URL
    private let transportFactory: MCPTransportFactory
    private var configurationsByID: [String: MCPServerConfiguration]
    private var clientsByID: [String: MCPClient] = [:]
    private var toolsByServerID: [String: [MCPToolDefinition]] = [:]

    public init(
        workspaceRootURL: URL,
        configurations: [MCPServerConfiguration]? = nil,
        transportFactory: MCPTransportFactory? = nil
    ) throws {
        let resolvedConfigurations: [MCPServerConfiguration]
        if let configurations {
            resolvedConfigurations = configurations
        } else {
            resolvedConfigurations = try MCPConfigurationLoader.load(from: workspaceRootURL)
        }

        var byID: [String: MCPServerConfiguration] = [:]
        for configuration in resolvedConfigurations {
            guard byID[configuration.name] == nil else {
                throw MCPError.invalidConfiguration(
                    path: configuration.name,
                    reason: "server names must be unique"
                )
            }
            byID[configuration.name] = configuration
        }

        self.workspaceRootURL = workspaceRootURL.standardizedFileURL
        self.configurationsByID = byID
        self.transportFactory = transportFactory ?? { configuration, rootURL in
            switch configuration.transport {
            case .stdio:
                MCPStdioTransport(configuration: configuration, workspaceRootURL: rootURL)
            case .streamableHTTP:
                MCPHTTPTransport(configuration: configuration)
            }
        }
    }

    public func serverConfigurations() -> [MCPServerConfiguration] {
        configurationsByID.values.sorted { $0.name < $1.name }
    }

    public func state(for serverID: String) async throws -> MCPClientState {
        guard let configuration = configurationsByID[serverID] else {
            throw MCPError.serverNotFound(serverID)
        }
        guard configuration.enabled else { return .closed }
        guard let client = clientsByID[serverID] else { return .idle }
        return await client.state
    }

    public func connect(serverID: String) async throws {
        let client = try client(for: serverID)
        let state = await client.state
        switch state {
        case .ready:
            return
        case .idle:
            try await client.connect()
        case .failed, .closed, .closing, .connecting:
            throw MCPError.invalidProtocol("server '\(serverID)' is already in state \(state)")
        }
    }

    public func tools(for serverID: String) async throws -> [MCPToolReference] {
        if let cached = toolsByServerID[serverID] {
            return cached.map { MCPToolReference(serverID: serverID, definition: $0) }
        }
        return try await refreshTools(for: serverID)
    }

    /// Re-reads the server's advertised contract. Callers can bind this to a
    /// server `tools/list_changed` notification when notification plumbing is
    /// integrated; ordinary reads use the stable cached contract above.
    public func refreshTools(for serverID: String) async throws -> [MCPToolReference] {
        let client = try client(for: serverID)
        try await connect(serverID: serverID)
        let definitions = try await client.listTools()
        toolsByServerID[serverID] = definitions
        return definitions.map { MCPToolReference(serverID: serverID, definition: $0) }
    }

    public func allTools() async throws -> [MCPToolReference] {
        var result: [MCPToolReference] = []
        for configuration in serverConfigurations() where configuration.enabled {
            result.append(contentsOf: try await tools(for: configuration.name))
        }
        return result.sorted { $0.qualifiedName < $1.qualifiedName }
    }

    public func cachedTools(for serverID: String) throws -> [MCPToolReference] {
        guard configurationsByID[serverID] != nil else {
            throw MCPError.serverNotFound(serverID)
        }
        return (toolsByServerID[serverID] ?? []).map {
            MCPToolReference(serverID: serverID, definition: $0)
        }
    }

    /// Lists the latest server contract before authorizing and invoking. A
    /// caller can use `cachedTools` when it needs a read-only UI snapshot.
    public func invoke(
        serverID: String,
        toolName: String,
        arguments: JSONValue = .object([:]),
        authorize: @escaping MCPToolInvocationAuthorizer
    ) async throws -> MCPToolResult {
        let client = try client(for: serverID)
        let tools = try await tools(for: serverID)
        guard let reference = tools.first(where: { $0.definition.name == toolName }) else {
            throw MCPError.toolNotFound(serverID: serverID, name: toolName)
        }

        let invocation = MCPToolInvocation(
            serverID: serverID,
            toolName: toolName,
            arguments: arguments
        )
        try await authorize(invocation, reference.definition)
        return try await client.callTool(name: toolName, arguments: arguments)
    }

    public func disconnect(serverID: String) async throws {
        guard let client = clientsByID[serverID] else { return }
        await client.disconnect()
        toolsByServerID[serverID] = nil
    }

    public func disconnectAll() async {
        let clients = Array(clientsByID.values)
        for client in clients {
            await client.disconnect()
        }
        clientsByID.removeAll(keepingCapacity: false)
        toolsByServerID.removeAll(keepingCapacity: false)
    }

    private func client(for serverID: String) throws -> MCPClient {
        guard let configuration = configurationsByID[serverID] else {
            throw MCPError.serverNotFound(serverID)
        }
        guard configuration.enabled else {
            throw MCPError.disabledServer(serverID)
        }
        if let client = clientsByID[serverID] {
            return client
        }
        let transport = transportFactory(configuration, workspaceRootURL)
        let client = MCPClient(transport: transport)
        clientsByID[serverID] = client
        return client
    }
}
