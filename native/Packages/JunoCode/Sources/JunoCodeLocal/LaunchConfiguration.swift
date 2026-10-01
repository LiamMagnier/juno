import Foundation
import JunoCodeCore

// `.juno/launch.json`: how this project's preview servers start
// (CODE_AGENT_SPEC §4.2). Claude Code's `.claude/launch.json` field set, so a
// file written for one works in the other, plus Juno's `network`, `ready` and
// top-level `autoVerify`. A `.claude/launch.json` is imported read-only for any
// name the Juno file does not define.
//
// The file is repository-authored data. It can never grant a permission: a new
// or changed configuration is asked about by its exact bytes (the hash below)
// before Juno runs it.

/// Whether a dev server may reach past loopback.
public enum PreviewNetworkPolicy: String, Codable, CaseIterable, Sendable {
    /// Loopback only, enforced by the kernel sandbox. The default.
    case loopback
    /// The server may reach the internet (SSR fetches, web fonts).
    case internet
}

/// When a server counts as ready.
public struct PreviewReadiness: Codable, Hashable, Sendable {
    /// The path an HTTP request must answer, `/` when absent.
    public var path: String?
    /// How long to wait for it, 90 seconds when absent.
    public var timeoutSeconds: Int?

    public init(path: String? = nil, timeoutSeconds: Int? = nil) {
        self.path = path
        self.timeoutSeconds = timeoutSeconds
    }

    public static let defaultTimeoutSeconds = 90
}

/// One configuration as the file spells it.
public struct PreviewLaunchConfiguration: Codable, Hashable, Sendable {
    public var name: String
    public var runtimeExecutable: String?
    public var runtimeArgs: [String]?
    public var program: String?
    public var args: [String]?
    public var cwd: String?
    /// Non-secret values only; secrets come from the Keychain.
    public var env: [String: String]?
    public var port: Int?
    /// True: Juno picks a free port and passes it as `PORT` (and `${port}`).
    /// False: the port must be free, or the start fails naming its owner.
    /// Absent: as false, and the pane offers to choose.
    public var autoPort: Bool?
    /// With no command, attach to a server Juno did not start.
    public var url: String?
    public var network: PreviewNetworkPolicy?
    public var ready: PreviewReadiness?
    /// External origins the page may navigate to and come back from (OAuth),
    /// approved with the configuration.
    public var allowedExternalOrigins: [String]?

    public init(
        name: String,
        runtimeExecutable: String? = nil,
        runtimeArgs: [String]? = nil,
        program: String? = nil,
        args: [String]? = nil,
        cwd: String? = nil,
        env: [String: String]? = nil,
        port: Int? = nil,
        autoPort: Bool? = nil,
        url: String? = nil,
        network: PreviewNetworkPolicy? = nil,
        ready: PreviewReadiness? = nil,
        allowedExternalOrigins: [String]? = nil
    ) {
        self.name = name
        self.runtimeExecutable = runtimeExecutable
        self.runtimeArgs = runtimeArgs
        self.program = program
        self.args = args
        self.cwd = cwd
        self.env = env
        self.port = port
        self.autoPort = autoPort
        self.url = url
        self.network = network
        self.ready = ready
        self.allowedExternalOrigins = allowedExternalOrigins
    }
}

/// The file.
public struct PreviewLaunchFile: Codable, Hashable, Sendable {
    public var version: String?
    /// Whether UI edits are checked in the running preview. True when absent.
    public var autoVerify: Bool?
    public var configurations: [PreviewLaunchConfiguration]

    public init(version: String? = "0.0.1", autoVerify: Bool? = nil, configurations: [PreviewLaunchConfiguration]) {
        self.version = version
        self.autoVerify = autoVerify
        self.configurations = configurations
    }

    /// The file as Juno writes it: pretty, keys sorted, so a diff reads well.
    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(self)
        data.append(0x0A)
        return data
    }
}

/// Where a configuration came from.
public enum PreviewConfigurationSource: String, Codable, Sendable {
    /// `.juno/launch.json`.
    case juno
    /// `.claude/launch.json`, imported read-only.
    case claude
    /// Proposed by discovery; no file names it yet.
    case discovered

    public var displayName: String {
        switch self {
        case .juno: ".juno/launch.json"
        case .claude: ".claude/launch.json"
        case .discovered: "found in the project"
        }
    }
}

/// What a configuration runs.
public enum PreviewLaunchKind: Hashable, Sendable {
    /// A process: the argv, with `${port}` still unexpanded.
    case command(argv: [String])
    /// Juno's in-process static server over this folder.
    case staticSite(root: URL)
    /// A server Juno did not start, at this loopback origin.
    case attach(url: URL)
}

/// A configuration checked and resolved against the workspace: what the
/// registry runs and what an approval card shows.
public struct ResolvedPreviewConfiguration: Hashable, Sendable, Identifiable {
    /// The executable that names Juno's own static server.
    public static let staticExecutable = "juno:static"

    public var name: String
    public var source: PreviewConfigurationSource
    public var kind: PreviewLaunchKind
    /// Absolute, inside the workspace.
    public var workingDirectory: URL
    /// The folder relative to the workspace root, `.` for the root.
    public var workingDirectoryDisplay: String
    /// Non-secret values from the file, with `${workspaceFolder}` expanded.
    public var environment: [String: String]
    public var port: Int?
    public var autoPort: Bool?
    public var network: PreviewNetworkPolicy
    public var readyPath: String
    public var readyTimeoutSeconds: Int
    public var allowedExternalOrigins: [URL]
    /// SHA-256 of the configuration's bytes as written (and its source), so an
    /// approval covers exactly what was shown.
    public var contentHash: String
    /// Things worth saying on the approval card, in words.
    public var warnings: [String]

    public var id: String { name }

    /// The approval key: the name and the bytes.
    public var approvalKey: String { "\(name)#\(contentHash)" }

    /// The command line Juno runs, with `${port}` expanded when a port is
    /// known. Nil for attach.
    public func commandLine(port resolvedPort: Int? = nil) -> String? {
        switch kind {
        case let .command(argv):
            return ShellWords.join(argv.map { Self.expandingPort($0, resolvedPort ?? port) })
        case .staticSite:
            return Self.staticExecutable
        case .attach:
            return nil
        }
    }

    /// The argv shown on the card, with `${port}` left as written when no
    /// port is known yet.
    public var displayArgv: [String] {
        switch kind {
        case let .command(argv): argv.map { Self.expandingPort($0, port) }
        case .staticSite: [Self.staticExecutable]
        case let .attach(url): ["attach", url.absoluteString]
        }
    }

    /// The environment keys the child receives from the file. Values are never
    /// shown to the model or on a card.
    public var environmentKeys: [String] { environment.keys.sorted() }

    public var isAttach: Bool {
        if case .attach = kind { return true }
        return false
    }

    public var isStatic: Bool {
        if case .staticSite = kind { return true }
        return false
    }

    static func expandingPort(_ value: String, _ port: Int?) -> String {
        guard let port else { return value }
        return value.replacingOccurrences(of: "${port}", with: String(port))
    }
}

/// A problem with the launch files, in words.
public struct PreviewLaunchIssue: Hashable, Sendable {
    public var source: PreviewConfigurationSource
    /// The configuration it concerns, when it concerns one.
    public var configuration: String?
    public var message: String

    public init(source: PreviewConfigurationSource, configuration: String? = nil, message: String) {
        self.source = source
        self.configuration = configuration
        self.message = message
    }
}

/// Every configuration a workspace has, from its files or from discovery.
public struct PreviewLaunchCatalog: Hashable, Sendable {
    public var configurations: [ResolvedPreviewConfiguration]
    public var issues: [PreviewLaunchIssue]
    public var autoVerify: Bool
    public var hasJunoFile: Bool
    public var hasClaudeFile: Bool

    public init(
        configurations: [ResolvedPreviewConfiguration],
        issues: [PreviewLaunchIssue] = [],
        autoVerify: Bool = true,
        hasJunoFile: Bool = false,
        hasClaudeFile: Bool = false
    ) {
        self.configurations = configurations
        self.issues = issues
        self.autoVerify = autoVerify
        self.hasJunoFile = hasJunoFile
        self.hasClaudeFile = hasClaudeFile
    }

    public func configuration(named name: String) -> ResolvedPreviewConfiguration? {
        configurations.first { $0.name == name }
    }

    /// The configuration a bare start uses: the only one, else the first
    /// that is not an attach.
    public var defaultConfiguration: ResolvedPreviewConfiguration? {
        configurations.first { !$0.isAttach } ?? configurations.first
    }
}

/// Reads the launch files of a workspace.
public enum LaunchConfigurationStore {
    public static let junoRelativePath = ".juno/launch.json"
    public static let claudeRelativePath = ".claude/launch.json"

    /// The catalog for `workspaceRoot`: `.juno/launch.json`, then any name
    /// only `.claude/launch.json` defines; discovery when neither file
    /// exists. Never throws: a broken file is an issue in words.
    public static func load(
        workspaceRoot: URL,
        discover: Bool = true
    ) -> PreviewLaunchCatalog {
        let root = workspaceRoot.resolvingSymlinksInPath().standardizedFileURL
        var issues: [PreviewLaunchIssue] = []
        var configurations: [ResolvedPreviewConfiguration] = []
        var autoVerify = true

        let junoURL = root.appendingPathComponent(junoRelativePath)
        let claudeURL = root.appendingPathComponent(claudeRelativePath)
        let hasJuno = FileManager.default.fileExists(atPath: junoURL.path)
        let hasClaude = FileManager.default.fileExists(atPath: claudeURL.path)

        if hasJuno {
            switch read(junoURL) {
            case let .success(file):
                autoVerify = file.autoVerify ?? true
                let resolved = resolve(file.configurations, source: .juno, workspaceRoot: root)
                configurations += resolved.configurations
                issues += resolved.issues
            case let .failure(message):
                issues.append(PreviewLaunchIssue(source: .juno, message: message))
            }
        }
        if hasClaude {
            switch read(claudeURL) {
            case let .success(file):
                let taken = Set(configurations.map(\.name))
                let imported = file.configurations.filter { !taken.contains($0.name) }
                let resolved = resolve(imported, source: .claude, workspaceRoot: root)
                configurations += resolved.configurations
                issues += resolved.issues
            case let .failure(message):
                issues.append(PreviewLaunchIssue(source: .claude, message: message))
            }
        }
        if !hasJuno, !hasClaude, discover {
            let proposed = LaunchConfigurationDiscovery.propose(workspaceRoot: root)
            let resolved = resolve(proposed.configurations, source: .discovered, workspaceRoot: root)
            configurations = resolved.configurations
            issues += resolved.issues
        }
        return PreviewLaunchCatalog(
            configurations: configurations,
            issues: issues,
            autoVerify: autoVerify,
            hasJunoFile: hasJuno,
            hasClaudeFile: hasClaude
        )
    }

    enum ReadResult {
        case success(PreviewLaunchFile)
        case failure(String)
    }

    static func read(_ url: URL) -> ReadResult {
        guard let data = try? Data(contentsOf: url) else {
            return .failure("\(url.lastPathComponent) could not be read.")
        }
        return decode(data, name: url.deletingLastPathComponent().lastPathComponent + "/" + url.lastPathComponent)
    }

    static func decode(_ data: Data, name: String) -> ReadResult {
        do {
            return .success(try JSONDecoder().decode(PreviewLaunchFile.self, from: data))
        } catch let DecodingError.keyNotFound(key, _) {
            return .failure("\(name) is missing \"\(key.stringValue)\".")
        } catch let DecodingError.typeMismatch(_, context) {
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return .failure("\(name) has the wrong type at \"\(path)\".")
        } catch {
            return .failure("\(name) is not valid JSON.")
        }
    }

    /// Checks each configuration and resolves it against `workspaceRoot`.
    public static func resolve(
        _ configurations: [PreviewLaunchConfiguration],
        source: PreviewConfigurationSource,
        workspaceRoot: URL
    ) -> (configurations: [ResolvedPreviewConfiguration], issues: [PreviewLaunchIssue]) {
        var resolved: [ResolvedPreviewConfiguration] = []
        var issues: [PreviewLaunchIssue] = []
        var seen: Set<String> = []
        for configuration in configurations {
            let name = configuration.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else {
                issues.append(PreviewLaunchIssue(source: source, message: "A configuration has no name."))
                continue
            }
            guard seen.insert(name).inserted else {
                issues.append(PreviewLaunchIssue(
                    source: source, configuration: name, message: "\"\(name)\" is defined twice; the first is used."
                ))
                continue
            }
            switch resolve(configuration, source: source, workspaceRoot: workspaceRoot) {
            case let .success(value): resolved.append(value)
            case let .failure(message):
                issues.append(PreviewLaunchIssue(source: source, configuration: name, message: message))
            }
        }
        return (resolved, issues)
    }

    enum ResolveResult {
        case success(ResolvedPreviewConfiguration)
        case failure(String)
    }

    static func resolve(
        _ configuration: PreviewLaunchConfiguration,
        source: PreviewConfigurationSource,
        workspaceRoot root: URL
    ) -> ResolveResult {
        let name = configuration.name
        func expand(_ value: String) -> String {
            value.replacingOccurrences(of: "${workspaceFolder}", with: root.path)
        }

        // Working directory: inside the workspace, always.
        let cwdText = configuration.cwd.map(expand) ?? root.path
        let cwdURL = (cwdText.hasPrefix("/")
            ? URL(fileURLWithPath: cwdText, isDirectory: true)
            : root.appendingPathComponent(cwdText, isDirectory: true))
            .resolvingSymlinksInPath()
            .standardizedFileURL
        guard cwdURL.path == root.path || cwdURL.path.hasPrefix(root.path + "/") else {
            return .failure("\"\(name)\": cwd \(cwdText) is outside the workspace.")
        }
        let cwdDisplay = cwdURL.path == root.path ? "." : String(cwdURL.path.dropFirst(root.path.count + 1))

        if let port = configuration.port, !(1...65_535).contains(port) {
            return .failure("\"\(name)\": port \(port) is not a TCP port.")
        }

        var warnings: [String] = []
        let environment = (configuration.env ?? [:]).mapValues(expand)
        for key in environment.keys.sorted() where Self.looksSecret(key) {
            warnings.append("env \(key) looks like a secret; keep secrets in Settings, not in the file.")
        }
        for key in environment.keys where !Self.isEnvironmentName(key) {
            return .failure("\"\(name)\": env name \(key) is not a valid variable name.")
        }

        var origins: [URL] = []
        for text in configuration.allowedExternalOrigins ?? [] {
            guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
                  scheme == "https" || scheme == "http", url.host != nil,
                  url.path.isEmpty || url.path == "/", url.query == nil
            else {
                return .failure("\"\(name)\": allowedExternalOrigins entry \(text) is not an origin.")
            }
            origins.append(url)
        }

        let kind: PreviewLaunchKind
        let executable = configuration.runtimeExecutable?.trimmingCharacters(in: .whitespaces)
        let program = configuration.program?.trimmingCharacters(in: .whitespaces)
        if executable == ResolvedPreviewConfiguration.staticExecutable {
            kind = .staticSite(root: cwdURL)
        } else if let executable, !executable.isEmpty {
            var argv = [expand(executable)] + (configuration.runtimeArgs ?? []).map(expand)
            if let program, !program.isEmpty { argv.append(expand(program)) }
            argv += (configuration.args ?? []).map(expand)
            kind = .command(argv: argv)
        } else if let program, !program.isEmpty {
            kind = .command(argv: [expand(program)] + (configuration.args ?? []).map(expand))
        } else if let text = configuration.url {
            switch Self.attachURL(text, port: configuration.port) {
            case let .success(url): kind = .attach(url: url)
            case let .failure(message): return .failure("\"\(name)\": \(message)")
            }
        } else {
            return .failure("\"\(name)\" has no runtimeExecutable, program or url.")
        }

        if case .command = kind, let text = configuration.url {
            // A command with a url opens the page there; it must still be
            // this server's loopback origin.
            if case let .failure(message) = Self.attachURL(text, port: configuration.port) {
                return .failure("\"\(name)\": \(message)")
            }
        }

        let readyPath = configuration.ready?.path.map { $0.hasPrefix("/") ? $0 : "/" + $0 } ?? "/"
        let timeout = min(max(configuration.ready?.timeoutSeconds ?? PreviewReadiness.defaultTimeoutSeconds, 5), 600)

        return .success(ResolvedPreviewConfiguration(
            name: name,
            source: source,
            kind: kind,
            workingDirectory: cwdURL,
            workingDirectoryDisplay: cwdDisplay,
            environment: environment,
            port: configuration.port,
            autoPort: configuration.autoPort,
            network: configuration.network ?? .loopback,
            readyPath: readyPath,
            readyTimeoutSeconds: timeout,
            allowedExternalOrigins: origins,
            contentHash: contentHash(configuration, source: source),
            warnings: warnings
        ))
    }

    enum AttachResult {
        case success(URL)
        case failure(String)
    }

    /// A configured `url` must be a loopback origin with nothing after it,
    /// and agree with `port` when both are given.
    static func attachURL(_ text: String, port: Int?) -> AttachResult {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = url.host
        else {
            return .failure("url \(text) is not an http address.")
        }
        guard PreviewOrigin.isLoopbackHost(host) else {
            return .failure("url \(text) is not on this Mac; the Preview only opens loopback addresses.")
        }
        guard url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil, url.user == nil else {
            return .failure("url \(text) must be an origin only, like http://localhost:3000.")
        }
        if let port, let urlPort = url.port, urlPort != port {
            return .failure("url port \(urlPort) does not match port \(port).")
        }
        if url.port == nil, port == nil {
            return .failure("url \(text) needs a port.")
        }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = url.port ?? port
        components.path = "/"
        return components.url.map(AttachResult.success) ?? .failure("url \(text) could not be read.")
    }

    /// The bytes an approval covers.
    public static func contentHash(_ configuration: PreviewLaunchConfiguration, source: PreviewConfigurationSource) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let body = (try? encoder.encode(configuration)) ?? Data()
        return Digests.sha256Hex(Data(source.rawValue.utf8) + Data([0x0A]) + body)
    }

    static func looksSecret(_ key: String) -> Bool {
        let upper = key.uppercased()
        return ["SECRET", "TOKEN", "PASSWORD", "PASSWD", "PRIVATE", "API_KEY", "ACCESS_KEY", "CREDENTIAL"]
            .contains { upper.contains($0) }
    }

    static func isEnvironmentName(_ key: String) -> Bool {
        guard let first = key.unicodeScalars.first,
              CharacterSet.letters.contains(first) || first == "_"
        else { return false }
        return key.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == "_"
        } && key.allSatisfy(\.isASCII)
    }
}

/// Loopback origin rules shared by the registry, the tools and the page.
public enum PreviewOrigin {
    /// `localhost`, `127.x.x.x` or `::1`, spelled exactly. Never resolved
    /// through DNS: a lookup would make the decision depend on mutable network
    /// state.
    ///
    /// Two spellings are refused on purpose. `app.localhost` is a name the
    /// system resolver may send to DNS, so a hostile network could answer it
    /// with any address. And an octet with a leading zero or a sign (`0127`,
    /// `+127`) reads as 127 to Swift but as octal (87) to WebKit's URL parser,
    /// so the check and the load would disagree about the host.
    public static func isLoopbackHost(_ host: String) -> Bool {
        let normalized = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if normalized == "localhost" || normalized == "::1" {
            return true
        }
        let octets = normalized.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4 else { return false }
        var values: [Int] = []
        for octet in octets {
            guard !octet.isEmpty, octet.count <= 3, octet.allSatisfy({ ("0"..."9").contains($0) }),
                  octet == "0" || octet.first != "0",
                  let value = Int(octet), (0...255).contains(value)
            else { return false }
            values.append(value)
        }
        return values[0] == 127
    }

    /// Whether `url` is an http(s) address on this Mac, without credentials.
    public static func isLoopback(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.user == nil, url.password == nil, let host = url.host
        else { return false }
        return isLoopbackHost(host)
    }

    /// Whether two URLs share scheme, host and port.
    public static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
        guard left.scheme?.lowercased() == right.scheme?.lowercased(),
              normalizedHost(left) == normalizedHost(right)
        else { return false }
        return effectivePort(left) == effectivePort(right)
    }

    /// `localhost` and `127.0.0.1` are the same machine; a page may move
    /// between them with the same port.
    public static func sameLoopbackServer(_ left: URL, _ right: URL) -> Bool {
        guard isLoopback(left), isLoopback(right),
              left.scheme?.lowercased() == right.scheme?.lowercased()
        else { return false }
        return effectivePort(left) == effectivePort(right)
    }

    static func normalizedHost(_ url: URL) -> String? {
        url.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
    }

    public static func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }
}

/// POSIX shell quoting for one argv.
public enum ShellWords {
    /// `argv` as one command line a POSIX shell splits back into the same
    /// words.
    public static func join(_ argv: [String]) -> String {
        argv.map(quote).joined(separator: " ")
    }

    public static func quote(_ word: String) -> String {
        guard !word.isEmpty else { return "''" }
        let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./:=@%+,")
        if word.unicodeScalars.allSatisfy({ safe.contains($0) }) { return word }
        return "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
