import Foundation
import Security

/// The local environment server, run as a child of the Mac app (Code v2
/// SPEC §2, §6 "env").
///
/// The env server (`runner/env-server`) is what starts each vendor's own agent
/// runtime — the user's `claude`, `codex app-server`, ACP agents — so a
/// subscription's sign-in, billing and limits stay with the vendor. The Mac
/// launches it, owns its lifetime, and talks to it over a loopback WebSocket
/// guarded by a bearer token it generates per launch.
///
/// **Launch contract** (documented for the env lane in
/// `docs/code-v2/ENV-SIDECAR.md`):
/// - `node <entry> --host 127.0.0.1 --port <n>`, where `<entry>` is the bundled
///   `Resources/env-server/main.mjs` or, in development, the repo's
///   `runner/env-server/dist/main.js` (or `src/main.ts` through `tsx`).
/// - Environment: `ALEVR_ENV_TOKEN` (the bearer token, never on the command
///   line where `ps` shows it), `ALEVR_ENV_HOST`, `ALEVR_ENV_PORT`,
///   `ALEVR_ENV_DATA_DIR`, `ALEVR_CLIENT=mac`, plus a sanitised `PATH` that
///   finds the vendor CLIs. `HOME` is the user's own: vendor CLIs keep their
///   credentials in the login Keychain and their config under it.
/// - Readiness: the server prints one line `ALEVR_ENV_READY {"port":n}` on
///   stdout once it listens. Without it, the Mac treats a successful TCP
///   connect to the port as ready.
/// - Clients connect to `ws://127.0.0.1:<port>/` with
///   `Authorization: Bearer <token>`.
public struct EnvServerLaunch: Equatable, Sendable {
    public var executable: URL
    public var arguments: [String]
    public var environment: [String: String]
    public var workingDirectory: URL?
    public var host: String
    public var port: Int
    public var token: String

    public var webSocketURL: URL { URL(string: "ws://\(host):\(port)/")! }
}

/// Where the env server's entry script lives.
public struct EnvServerEntry: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// A built JavaScript entry, run with `node`.
        case javascript
        /// A TypeScript source, run with `node --import tsx` (development).
        case typescript
    }

    public var url: URL
    public var kind: Kind
    /// The package root (`runner/env-server`), the working directory.
    public var packageRoot: URL

    /// Resolves the entry, first match wins:
    /// 1. `ALEVR_ENV_SERVER_ENTRY` (a path to a .js/.mjs/.ts file),
    /// 2. the app bundle's `Resources/env-server/main.mjs` (or `dist/main.js`),
    /// 3. a repo checkout found by walking up from `searchRoots`
    ///    (`runner/env-server/dist/main.js`, then `src/main.ts`).
    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundleResources: URL? = Bundle.main.resourceURL,
        searchRoots: [URL] = defaultSearchRoots(),
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> EnvServerEntry? {
        if let override = environment["ALEVR_ENV_SERVER_ENTRY"], !override.isEmpty, fileExists(override) {
            let url = URL(fileURLWithPath: override)
            return EnvServerEntry(url: url, kind: url.pathExtension == "ts" ? .typescript : .javascript, packageRoot: packageRoot(of: url))
        }
        if let resources = bundleResources {
            for relative in ["env-server/main.mjs", "env-server/dist/main.js", "env-server/main.js"] {
                let url = resources.appendingPathComponent(relative)
                if fileExists(url.path) {
                    return EnvServerEntry(url: url, kind: .javascript, packageRoot: resources.appendingPathComponent("env-server"))
                }
            }
        }
        for root in searchRoots {
            var directory = root.standardizedFileURL
            for _ in 0..<12 {
                let package = directory.appendingPathComponent("runner/env-server")
                for (relative, kind) in [("dist/main.js", Kind.javascript), ("dist/index.js", .javascript), ("src/main.ts", .typescript), ("src/index.ts", .typescript)] {
                    let url = package.appendingPathComponent(relative)
                    if fileExists(url.path) { return EnvServerEntry(url: url, kind: kind, packageRoot: package) }
                }
                let parent = directory.deletingLastPathComponent()
                if parent.path == directory.path { break }
                directory = parent
            }
        }
        return nil
    }

    /// The app bundle's folder (a debug build sits in the checkout's derived
    /// data, which is not under the repo) and the current directory.
    public static func defaultSearchRoots() -> [URL] {
        var roots = [Bundle.main.bundleURL, URL(fileURLWithPath: FileManager.default.currentDirectoryPath)]
        if let repo = ProcessInfo.processInfo.environment["ALEVR_REPO_ROOT"] { roots.insert(URL(fileURLWithPath: repo), at: 0) }
        return roots
    }

    static func packageRoot(of entry: URL) -> URL {
        var directory = entry.deletingLastPathComponent()
        for _ in 0..<4 where !FileManager.default.fileExists(atPath: directory.appendingPathComponent("package.json").path) {
            directory = directory.deletingLastPathComponent()
        }
        return directory
    }
}

public enum EnvServerSidecarError: Error, Equatable, LocalizedError, Sendable {
    case entryNotFound
    case nodeNotFound
    case launchFailed(String)
    case notReady
    case exited(Int32)

    public var errorDescription: String? {
        switch self {
        case .entryNotFound: "Alevr could not find its local environment server in this build."
        case .nodeNotFound: "Alevr needs Node.js to start subscriptions on this Mac. Install Node 20 or later."
        case let .launchFailed(reason): "The local environment server did not start: \(reason)"
        case .notReady: "The local environment server started but did not answer."
        case let .exited(code): "The local environment server stopped (exit \(code))."
        }
    }
}

public enum EnvServerLaunchPlanner {
    public static let readyPrefix = "ALEVR_ENV_READY"

    /// 32 random bytes, base64url, no padding: 43 characters.
    public static func makeToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// A free loopback port, found by binding port 0 and reading it back.
    public static func freePort() -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { return nil }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard named == 0 else { return nil }
        return Int(UInt16(bigEndian: address.sin_port))
    }

    /// The first `node` on the sanitised toolchain PATH.
    public static func findNode(
        path: String = ToolchainEnvironment.resolvedPATH(),
        isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> URL? {
        for directory in path.split(separator: ":") {
            let candidate = "\(directory)/node"
            if isExecutable(candidate) { return URL(fileURLWithPath: candidate) }
        }
        return nil
    }

    /// The environment the server runs with: the user's identity and a
    /// toolchain PATH, nothing else from the app's own environment.
    public static func environment(
        token: String, host: String, port: Int, dataDirectory: URL,
        base: [String: String] = ProcessInfo.processInfo.environment,
        path: String = ToolchainEnvironment.resolvedPATH()
    ) -> [String: String] {
        var env: [String: String] = [:]
        for key in ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING"] {
            if let value = base[key] { env[key] = value }
        }
        env["PATH"] = path
        env["ALEVR_ENV_TOKEN"] = token
        env["ALEVR_ENV_HOST"] = host
        env["ALEVR_ENV_PORT"] = String(port)
        env["ALEVR_ENV_DATA_DIR"] = dataDirectory.path
        env["ALEVR_CLIENT"] = "mac"
        env["NODE_ENV"] = "production"
        return env
    }

    public static func plan(
        entry: EnvServerEntry, node: URL, port: Int, token: String, dataDirectory: URL,
        host: String = "127.0.0.1",
        base: [String: String] = ProcessInfo.processInfo.environment,
        path: String = ToolchainEnvironment.resolvedPATH()
    ) -> EnvServerLaunch {
        var arguments: [String] = []
        if entry.kind == .typescript { arguments += ["--import", "tsx"] }
        arguments += [entry.url.path, "--host", host, "--port", String(port)]
        return EnvServerLaunch(
            executable: node,
            arguments: arguments,
            environment: environment(token: token, host: host, port: port, dataDirectory: dataDirectory, base: base, path: path),
            workingDirectory: entry.packageRoot,
            host: host,
            port: port,
            token: token
        )
    }

    /// The port in a ready line, or nil when the line is not one.
    public static func readyPort(in line: String) -> Int? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(readyPrefix) else { return nil }
        let json = trimmed.dropFirst(readyPrefix.count).trimmingCharacters(in: .whitespaces)
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = object["port"] as? Int, (1...65_535).contains(port)
        else { return nil }
        return port
    }

    /// Restart delays after an unexpected exit: 1, 2, 4, 8, 16 s, then stop.
    public static func restartDelay(attempt: Int) -> TimeInterval? {
        guard attempt >= 1, attempt <= 5 else { return nil }
        return pow(2, Double(attempt - 1))
    }

    /// `~/Library/Application Support/Alevr/env-server`.
    public static func defaultDataDirectory() -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Alevr/env-server", isDirectory: true)
    }
}

/// Runs and supervises the env server process.
public actor EnvServerSidecar {
    public enum State: Equatable, Sendable {
        case stopped
        case starting
        case running(EnvServerLaunch)
        case failed(EnvServerSidecarError)
    }

    private var process: Process?
    private var launch: EnvServerLaunch?
    private var state: State = .stopped
    private var restartAttempt = 0
    private var wantsRunning = false
    private var continuations: [UUID: AsyncStream<State>.Continuation] = [:]
    private var readyContinuation: CheckedContinuation<Int?, Never>?
    private var logTail: [String] = []

    private let resolveEntry: @Sendable () -> EnvServerEntry?
    private let resolveNode: @Sendable () -> URL?
    private let dataDirectory: URL
    private let readinessTimeout: Duration

    public init(
        resolveEntry: @escaping @Sendable () -> EnvServerEntry? = { EnvServerEntry.resolve() },
        resolveNode: @escaping @Sendable () -> URL? = { EnvServerLaunchPlanner.findNode() },
        dataDirectory: URL = EnvServerLaunchPlanner.defaultDataDirectory(),
        readinessTimeout: Duration = .seconds(20)
    ) {
        self.resolveEntry = resolveEntry
        self.resolveNode = resolveNode
        self.dataDirectory = dataDirectory
        self.readinessTimeout = readinessTimeout
    }

    public var currentState: State { state }

    /// The last lines the server printed, for "Open logs".
    public var recentLog: [String] { logTail }

    public func states() -> AsyncStream<State> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<State>.makeStream()
        continuation.yield(state)
        continuations[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeContinuation(id) }
        }
        return stream
    }

    private func removeContinuation(_ id: UUID) { continuations[id] = nil }

    private func set(_ newState: State) {
        state = newState
        for continuation in continuations.values { continuation.yield(newState) }
    }

    /// Starts the server if it is not running and waits until it is ready.
    @discardableResult
    public func start() async throws -> EnvServerLaunch {
        wantsRunning = true
        if case let .running(launch) = state { return launch }
        return try await spawn()
    }

    public func stop() {
        wantsRunning = false
        restartAttempt = 0
        guard let process else {
            set(.stopped)
            return
        }
        self.process = nil
        if process.isRunning {
            process.terminate()
            let pid = process.processIdentifier
            // SIGKILL if it ignores SIGTERM for three seconds.
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
            }
        }
        set(.stopped)
    }

    private func spawn() async throws -> EnvServerLaunch {
        set(.starting)
        guard let entry = resolveEntry() else {
            set(.failed(.entryNotFound))
            throw EnvServerSidecarError.entryNotFound
        }
        guard let node = resolveNode() else {
            set(.failed(.nodeNotFound))
            throw EnvServerSidecarError.nodeNotFound
        }
        try? FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        guard let port = EnvServerLaunchPlanner.freePort() else {
            set(.failed(.launchFailed("no free port")))
            throw EnvServerSidecarError.launchFailed("no free port")
        }
        var plan = EnvServerLaunchPlanner.plan(
            entry: entry, node: node, port: port, token: EnvServerLaunchPlanner.makeToken(), dataDirectory: dataDirectory
        )

        let process = Process()
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        process.environment = plan.environment
        process.currentDirectoryURL = plan.workingDirectory
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = FileHandle.nullDevice
        attach(stdout, isStdout: true)
        attach(stderr, isStdout: false)
        process.terminationHandler = { [weak self] finished in
            let code = finished.terminationStatus
            Task { await self?.processExited(finished, code: code) }
        }
        do {
            try process.run()
        } catch {
            set(.failed(.launchFailed(error.localizedDescription)))
            throw EnvServerSidecarError.launchFailed(error.localizedDescription)
        }
        self.process = process

        let announced = await waitForReady(port: port)
        guard self.process === process, process.isRunning else {
            let code = process.isRunning ? 0 : process.terminationStatus
            set(.failed(.exited(code)))
            throw EnvServerSidecarError.exited(code)
        }
        guard let readyPort = announced else {
            set(.failed(.notReady))
            process.terminate()
            self.process = nil
            throw EnvServerSidecarError.notReady
        }
        plan.port = readyPort
        launch = plan
        restartAttempt = 0
        set(.running(plan))
        return plan
    }

    private nonisolated func attach(_ pipe: Pipe, isStdout: Bool) {
        let buffer = LineBuffer()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            for line in buffer.append(data) {
                Task { await self?.received(line: line, isStdout: isStdout) }
            }
        }
    }

    private func received(line: String, isStdout: Bool) {
        logTail.append(line)
        if logTail.count > 200 { logTail.removeFirst(logTail.count - 200) }
        if isStdout, let port = EnvServerLaunchPlanner.readyPort(in: line), let continuation = readyContinuation {
            readyContinuation = nil
            continuation.resume(returning: port)
        }
    }

    /// The announced port, or the planned one once a TCP connect succeeds, or
    /// nil at the timeout.
    private func waitForReady(port: Int) async -> Int? {
        let timeout = readinessTimeout
        return await withCheckedContinuation { (continuation: CheckedContinuation<Int?, Never>) in
            readyContinuation = continuation
            Task {
                let clock = ContinuousClock()
                let deadline = clock.now.advanced(by: timeout)
                // Give the ready line a head start before probing the port.
                try? await Task.sleep(for: .milliseconds(300))
                while clock.now < deadline {
                    if self.readyContinuation == nil { return }
                    if Self.canConnect(port: port) {
                        self.resolveReady(port)
                        return
                    }
                    try? await Task.sleep(for: .milliseconds(200))
                }
                self.resolveReady(nil)
            }
        }
    }

    private func resolveReady(_ port: Int?) {
        guard let continuation = readyContinuation else { return }
        readyContinuation = nil
        continuation.resume(returning: port)
    }

    static func canConnect(port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        return result == 0
    }

    private func processExited(_ finished: Process, code: Int32) async {
        resolveReady(nil)
        guard process === finished else { return }
        process = nil
        launch = nil
        guard wantsRunning else {
            set(.stopped)
            return
        }
        restartAttempt += 1
        guard let delay = EnvServerLaunchPlanner.restartDelay(attempt: restartAttempt) else {
            set(.failed(.exited(code)))
            return
        }
        set(.failed(.exited(code)))
        try? await Task.sleep(for: .seconds(delay))
        guard wantsRunning, process == nil else { return }
        _ = try? await spawn()
    }
}

/// Splits a byte stream into lines across reads.
final class LineBuffer: @unchecked Sendable {
    private var pending = Data()
    private let lock = NSLock()

    func append(_ data: Data) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        pending.append(data)
        var lines: [String] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            let lineData = pending[pending.startIndex..<newline]
            lines.append(String(decoding: lineData, as: UTF8.self))
            pending.removeSubrange(pending.startIndex...newline)
        }
        return lines
    }
}
