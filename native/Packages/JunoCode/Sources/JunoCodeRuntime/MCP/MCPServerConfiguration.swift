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
    /// Where it was declared (§5.8): the project's `.mcp.json` or
    /// `.juno/mcp.json`, the reader's `~/.juno/mcp.json`, or Claude Code's
    /// `~/.claude.json`. Decides whose consent starts it; not part of the
    /// consent digest, which is about what the server is.
    public private(set) var scope: ExtensionScope = .project

    /// The same declaration, as read from `scope`.
    public func scoped(_ scope: ExtensionScope) -> MCPServerConfiguration {
        var copy = self
        copy.scope = scope
        return copy
    }

    /// The file a reader would open to change it.
    public var declaredIn: String {
        switch scope {
        case .project: ".mcp.json or .juno/mcp.json"
        case .user: "~/.juno/mcp.json"
        case .claudeImport: "~/.claude.json"
        }
    }

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

    /// Every server a session can see, with where each came from (§5.8):
    /// the project's files, the reader's `~/.juno/mcp.json`, and the
    /// `mcpServers` of Claude Code's `~/.claude.json`, read only.
    ///
    /// One name declared in more than one place resolves to the project's,
    /// then the reader's, then the import; the others are kept in
    /// `overridden` so a list can show both. A broken file of the reader's
    /// own is reported in `problems` without taking the project's servers
    /// down; a broken project file still throws, as it always has.
    public static func loadAll(
        from workspace: any WorkspaceAccessing,
        userConfigurationFile: URL?,
        claudeConfigurationFile: URL?
    ) throws -> MCPConfigurationSet {
        var byName: [String: MCPServerConfiguration] = [:]
        var overridden: [MCPServerConfiguration] = []
        var problems: [String] = []

        func add(_ servers: [MCPServerConfiguration], scope: ExtensionScope) {
            for server in servers.map({ $0.scoped(scope) }) {
                if let existing = byName[server.name] {
                    if server.scope < existing.scope {
                        overridden.append(existing)
                        byName[server.name] = server
                    } else {
                        overridden.append(server)
                    }
                } else {
                    byName[server.name] = server
                }
            }
        }

        add(try load(from: workspace), scope: .project)
        for (file, scope) in [(userConfigurationFile, ExtensionScope.user), (claudeConfigurationFile, .claudeImport)] {
            guard let file, FileManager.default.fileExists(atPath: file.path) else { continue }
            do {
                // `~/.claude.json` keeps Claude Code's per-project history
                // beside its servers and grows past a megabyte on a busy Mac;
                // the reader's own `mcp.json` is servers alone.
                let limit = scope == .claudeImport ? 16 * 1_024 * 1_024 : 1_024 * 1_024
                let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                guard size <= limit else {
                    problems.append("\(file.lastPathComponent) is larger than Juno reads.")
                    continue
                }
                let data = try Data(contentsOf: file)
                guard data.count <= limit else {
                    problems.append("\(file.lastPathComponent) is larger than Juno reads.")
                    continue
                }
                // `~/.claude.json` holds much more than servers; only its
                // top-level `mcpServers` are the reader's user scope.
                add(try parse(data: data, path: file.path, keys: scope == .claudeImport ? ["mcpServers"] : ["mcpServers", "servers"]), scope: scope)
            } catch let MCPError.invalidConfiguration(path, reason) {
                problems.append("\((path as NSString).lastPathComponent): \(reason)")
            } catch {
                problems.append("\(file.lastPathComponent) could not be read.")
            }
        }
        return MCPConfigurationSet(
            servers: byName.values.sorted { $0.name < $1.name },
            overridden: overridden.sorted { $0.name == $1.name ? $0.scope < $1.scope : $0.name < $1.name },
            problems: problems
        )
    }

    private static func parse(data: Data, path: String) throws -> [MCPServerConfiguration] {
        try parse(data: data, path: path, keys: ["mcpServers", "servers"])
    }

    private static func parse(data: Data, path: String, keys: [String]) throws -> [MCPServerConfiguration] {
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
        for key in keys {
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

/// Every MCP server a session can see, by where it was declared. See
/// ``MCPConfigurationLoader/loadAll(from:userConfigurationFile:claudeConfigurationFile:)``.
public struct MCPConfigurationSet: Equatable, Sendable {
    /// One per name: the declaration that wins.
    public let servers: [MCPServerConfiguration]
    /// Declarations a same-named one outranks, kept for the list.
    public let overridden: [MCPServerConfiguration]
    /// The reader's own files that could not be read, in words.
    public let problems: [String]

    public init(servers: [MCPServerConfiguration], overridden: [MCPServerConfiguration] = [], problems: [String] = []) {
        self.servers = servers
        self.overridden = overridden
        self.problems = problems
    }
}
