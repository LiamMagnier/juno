import Foundation
import JunoCodeCore

public enum MCPServerTransportKind: String, Codable, Sendable {
    case stdio
    case streamableHTTP = "streamable-http"
}

/// A workspace-declared MCP server. Stdio is launched locally; streamable HTTP
/// uses the configured endpoint and remains approval-pinned at the tool layer.
public struct MCPServerConfiguration: Equatable, Sendable {
    public let name: String
    public let command: String
    public let arguments: [String]
    public let environment: [String: String]
    /// A workspace-relative working directory. The root is used when nil.
    public let workingDirectory: String?
    public let enabled: Bool
    public let transport: MCPServerTransportKind
    public let url: URL?
    public let headers: [String: String]

    /// Stable consent key for this exact declaration. It covers the process or
    /// endpoint plus every value that can change its authority; a repository
    /// editing an approved server therefore requires a new reader decision.
    public var consentDigest: String {
        func encode(_ value: String) -> String { "\(value.utf8.count):\(value)" }
        let environment = self.environment.keys.sorted().map { encode($0) + encode(self.environment[$0] ?? "") }.joined()
        let headers = self.headers.keys.sorted().map { encode($0) + encode(self.headers[$0] ?? "") }.joined()
        return Digests.sha256Hex([
            encode(name), encode(transport.rawValue), encode(command),
            arguments.map(encode).joined(), environment, encode(workingDirectory ?? ""),
            encode(url?.absoluteString ?? ""), headers, enabled ? "1" : "0",
        ].joined(separator: "|"))
    }

    public init(
        name: String,
        command: String,
        arguments: [String] = [],
        environment: [String: String] = [:],
        workingDirectory: String? = nil,
        enabled: Bool = true
    ) throws {
        guard Self.isSafeToken(name) else {
            throw MCPError.invalidConfiguration(path: name, reason: "server name is empty or contains control characters")
        }
        guard Self.isSafeToken(command) else {
            throw MCPError.invalidConfiguration(path: name, reason: "command is empty or contains control characters")
        }
        guard arguments.allSatisfy(Self.isSafeToken) else {
            throw MCPError.invalidConfiguration(path: name, reason: "arguments cannot contain control characters")
        }
        guard environment.allSatisfy({ key, value in
            !key.isEmpty && !key.contains("=") && Self.isSafeToken(key) && Self.isSafeToken(value)
        }) else {
            throw MCPError.invalidConfiguration(path: name, reason: "environment keys and values must be safe strings")
        }
        if let workingDirectory {
            guard (try? WorkspacePath(workingDirectory)) != nil else {
                throw MCPError.invalidConfiguration(
                    path: name,
                    reason: "workingDirectory must be a safe workspace-relative path"
                )
            }
        }

        self.name = name
        self.command = command
        self.arguments = arguments
        self.environment = environment
        self.workingDirectory = workingDirectory
        self.enabled = enabled
        self.transport = .stdio
        self.url = nil
        self.headers = [:]
    }

    public init(
        httpName name: String,
        url: URL,
        headers: [String: String] = [:],
        enabled: Bool = true
    ) throws {
        guard Self.isSafeToken(name) else {
            throw MCPError.invalidConfiguration(
                path: name,
                reason: "server name is empty or contains control characters"
            )
        }
        guard let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              url.host != nil
        else {
            throw MCPError.invalidConfiguration(
                path: name,
                reason: "HTTP MCP URL must include an http(s) scheme and host"
            )
        }
        guard headers.allSatisfy({ key, value in
            !key.isEmpty
                && !key.contains(":")
                && Self.isSafeToken(key)
                && Self.isSafeToken(value)
        }) else {
            throw MCPError.invalidConfiguration(
                path: name,
                reason: "HTTP headers must be safe strings"
            )
        }

        self.name = name
        self.command = ""
        self.arguments = []
        self.environment = [:]
        self.workingDirectory = nil
        self.enabled = enabled
        self.transport = .streamableHTTP
        self.url = url
        self.headers = headers
    }

    fileprivate static func isSafeToken(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.allSatisfy {
            !CharacterSet.controlCharacters.contains($0)
        }
    }
}

public enum MCPConfigurationLoader {
    /// `.juno/mcp.json` wins when the same server name is present in both
    /// files, while distinct servers from both files are retained.
    public static let relativeConfigurationPaths = [".mcp.json", ".juno/mcp.json"]

    /// Loads the conventional Claude-compatible `mcpServers` map. A `servers`
    /// alias is accepted as a small convenience for Juno-owned config files.
    /// Both `stdio` and `streamable-http`/`sse` entries are accepted.
    /// Missing files are normal and produce an empty list.
    public static func load(from workspaceRootURL: URL) throws -> [MCPServerConfiguration] {
        let root = workspaceRootURL.standardizedFileURL.resolvingSymlinksInPath()
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else {
            throw MCPError.invalidConfiguration(path: root.path, reason: "workspace root is not a directory")
        }

        var merged: [String: MCPServerConfiguration] = [:]
        for relativePath in relativeConfigurationPaths {
            let candidate = root.appendingPathComponent(relativePath, isDirectory: false)
            guard isContained(candidate, in: root) else {
                throw MCPError.invalidConfiguration(
                    path: relativePath,
                    reason: "configuration path escapes the workspace"
                )
            }
            guard FileManager.default.fileExists(atPath: candidate.path) else { continue }
            var candidateIsDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &candidateIsDirectory),
                  !candidateIsDirectory.boolValue
            else {
                throw MCPError.invalidConfiguration(path: candidate.path, reason: "configuration path is not a file")
            }

            let data: Data
            do {
                data = try Data(contentsOf: candidate)
            } catch {
                throw MCPError.invalidConfiguration(path: candidate.path, reason: error.localizedDescription)
            }
            let servers = try parse(data: data, path: candidate.path)
            for server in servers {
                merged[server.name] = server
            }
        }
        return merged.values.sorted { $0.name < $1.name }
    }

    /// Variant for callers that already hold Juno's containment-enforcing
    /// workspace capability. This keeps configuration discovery usable without
    /// requiring the runtime to depend on the local workspace service.
    public static func load(from workspace: any WorkspaceAccessing) throws -> [MCPServerConfiguration] {
        var merged: [String: MCPServerConfiguration] = [:]
        for relativePath in relativeConfigurationPaths {
            guard let workspacePath = try? WorkspacePath(relativePath),
                  let candidate = try? workspace.resolveForReading(workspacePath),
                  FileManager.default.fileExists(atPath: candidate.path)
            else { continue }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory),
                  !isDirectory.boolValue
            else {
                throw MCPError.invalidConfiguration(path: candidate.path, reason: "configuration path is not a file")
            }
            let data: Data
            do {
                data = try Data(contentsOf: candidate)
            } catch {
                throw MCPError.invalidConfiguration(path: candidate.path, reason: error.localizedDescription)
            }
            for server in try parse(data: data, path: candidate.path) {
                merged[server.name] = server
            }
        }
        return merged.values.sorted { $0.name < $1.name }
    }

    private static func parse(data: Data, path: String) throws -> [MCPServerConfiguration] {
        let root: JSONValue
        do {
            root = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw MCPError.invalidConfiguration(path: path, reason: "invalid JSON: \(error.localizedDescription)")
        }
        guard case let .object(fields) = root else {
            throw MCPError.invalidConfiguration(path: path, reason: "root must be a JSON object")
        }

        var rawServers: [String: JSONValue] = [:]
        for key in ["mcpServers", "servers"] {
            guard let raw = fields[key] else { continue }
            guard case let .object(serverMap) = raw else {
                throw MCPError.invalidConfiguration(path: path, reason: "'\(key)' must be an object")
            }
            for (name, definition) in serverMap {
                rawServers[name] = definition
            }
        }

        var servers: [MCPServerConfiguration] = []
        for name in rawServers.keys.sorted() {
            guard case let .object(fields) = rawServers[name] else {
                throw MCPError.invalidConfiguration(
                    path: "\(path):\(name)",
                    reason: "server definition must be an object"
                )
            }
            let rawType = fields["type"]?.stringValue
                ?? fields["transport"]?.stringValue
                ?? "stdio"
            let type = rawType.lowercased()
            if let rawEnabled = fields["enabled"], rawEnabled.boolValue == nil, !rawEnabled.isNull {
                throw MCPError.invalidConfiguration(
                    path: "\(path):\(name)",
                    reason: "enabled must be a boolean"
                )
            }
            let enabled = fields["enabled"]?.boolValue ?? true
            do {
                switch type {
                case "stdio":
                    guard let command = fields["command"]?.stringValue else {
                        throw MCPError.invalidConfiguration(
                            path: "\(path):\(name)",
                            reason: "server.command must be a string"
                        )
                    }
                    let arguments = try parseStringArray(
                        fields["args"],
                        field: "args",
                        path: path,
                        name: name
                    )
                    let environment = try parseStringMap(
                        fields["env"],
                        field: "env",
                        path: path,
                        name: name
                    )
                    let workingDirectory = fields["cwd"]?.stringValue
                        ?? fields["workingDirectory"]?.stringValue
                    if let rawCWD = fields["cwd"] ?? fields["workingDirectory"],
                       rawCWD.stringValue == nil,
                       !rawCWD.isNull
                    {
                        throw MCPError.invalidConfiguration(
                            path: "\(path):\(name)",
                            reason: "cwd must be a workspace-relative string"
                        )
                    }
                    if let workingDirectory, (try? WorkspacePath(workingDirectory)) == nil {
                        throw MCPError.invalidConfiguration(
                            path: "\(path):\(name)",
                            reason: "cwd must be a workspace-relative path"
                        )
                    }
                    servers.append(try MCPServerConfiguration(
                        name: name,
                        command: command,
                        arguments: arguments,
                        environment: environment,
                        workingDirectory: workingDirectory,
                        enabled: enabled
                    ))
                case "http", "sse", "streamable-http", "streamable_http":
                    guard let rawURL = fields["url"]?.stringValue
                        ?? fields["endpoint"]?.stringValue,
                          let url = URL(string: rawURL)
                    else {
                        throw MCPError.invalidConfiguration(
                            path: "\(path):\(name)",
                            reason: "HTTP MCP server.url must be a valid URL"
                        )
                    }
                    let headers = try parseStringMap(
                        fields["headers"] ?? fields["env"],
                        field: "headers",
                        path: path,
                        name: name
                    )
                    servers.append(try MCPServerConfiguration(
                        httpName: name,
                        url: url,
                        headers: headers,
                        enabled: enabled
                    ))
                default:
                    throw MCPError.invalidConfiguration(
                        path: "\(path):\(name)",
                        reason: "unsupported MCP transport '\(rawType)'"
                    )
                }
            } catch let error as MCPError {
                throw error
            } catch {
                throw MCPError.invalidConfiguration(path: "\(path):\(name)", reason: error.localizedDescription)
            }
        }
        return servers
    }

    private static func parseStringArray(
        _ value: JSONValue?,
        field: String,
        path: String,
        name: String
    ) throws -> [String] {
        guard let value else { return [] }
        guard case let .array(values) = value else {
            throw MCPError.invalidConfiguration(path: "\(path):\(name)", reason: "\(field) must be an array of strings")
        }
        guard values.allSatisfy({ $0.stringValue != nil }) else {
            throw MCPError.invalidConfiguration(path: "\(path):\(name)", reason: "\(field) must be an array of strings")
        }
        return values.compactMap(\.stringValue)
    }

    private static func parseStringMap(
        _ value: JSONValue?,
        field: String,
        path: String,
        name: String
    ) throws -> [String: String] {
        guard let value else { return [:] }
        guard case let .object(values) = value else {
            throw MCPError.invalidConfiguration(path: "\(path):\(name)", reason: "\(field) must be an object of strings")
        }
        guard values.values.allSatisfy({ $0.stringValue != nil }) else {
            throw MCPError.invalidConfiguration(path: "\(path):\(name)", reason: "\(field) must be an object of strings")
        }
        return values.compactMapValues(\.stringValue)
    }

    private static func isContained(_ candidate: URL, in root: URL) -> Bool {
        let rootPath = root.standardizedFileURL.path
        let candidatePath = candidate.resolvingSymlinksInPath().standardizedFileURL.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        return candidatePath == rootPath || candidatePath.hasPrefix(prefix)
    }
}
