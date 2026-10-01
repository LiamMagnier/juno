import Darwin
import Foundation
import JunoCodeCore

// The Preview belongs to the session, not the view (CODE_AGENT_SPEC §4.1).
//
// One registry owns every preview server, keyed by checkout and configuration
// name. Sessions hold leases; views only look. A server stops when its last
// lease ends, when the reader or the agent stops it, or after 30 minutes with
// no lease and no view — never because a view disappeared (PV-1, PV-3). Two
// sessions on one checkout share a server; a worktree is another checkout and
// gets its own.

/// Which preview: a checkout and a configuration name.
public struct PreviewKey: Hashable, Codable, Sendable, CustomStringConvertible {
    public let checkoutRoot: String
    public let name: String

    public init(checkoutRoot: URL, name: String) {
        self.checkoutRoot = checkoutRoot.resolvingSymlinksInPath().standardizedFileURL.path
        self.name = name
    }

    public var checkoutURL: URL { URL(fileURLWithPath: checkoutRoot, isDirectory: true) }

    public var description: String { "\(name) in \(checkoutURL.lastPathComponent)" }
}

/// What a preview server is doing, as facts.
public enum PreviewServerPhase: Equatable, Sendable {
    case stopped
    case starting
    /// A process Juno started answered at this address.
    case running(URL)
    /// A server Juno did not start (a configured `url`, a durable shell)
    /// answered at this address.
    case attached(URL)
    case failed(String)
    case exited(Int32)

    public var url: URL? {
        switch self {
        case let .running(url), let .attached(url): url
        default: nil
        }
    }

    public var isLive: Bool {
        switch self {
        case .starting, .running, .attached: true
        case .stopped, .failed, .exited: false
        }
    }
}

/// A preview server as the pane and the tools see it.
public struct PreviewServerSnapshot: Equatable, Sendable, Identifiable {
    public var key: PreviewKey
    public var configuration: ResolvedPreviewConfiguration?
    /// `pnpm run dev`, `juno:static`, or the attached address.
    public var displayCommand: String
    public var workingDirectoryDisplay: String
    public var phase: PreviewServerPhase
    public var port: Int?
    public var network: PreviewNetworkPolicy
    public var isContained: Bool
    public var startedAt: Date?
    public var leaseHolders: Set<CodeSessionID>
    public var viewerCount: Int
    public var lastLogID: Int
    public var logLineCount: Int
    /// A host the server tried and failed to reach while offline.
    public var blockedOutboundHost: String?
    /// The durable shell this preview was attached from.
    public var shellID: String?
    /// The configuration's port was taken and its file leaves `autoPort`
    /// unset: the pane asks once whether to use a free port (PV-15).
    public var portConflict: PreviewPortConflict?

    public var id: PreviewKey { key }

    /// The address the agent may use: loopback only (D-023).
    public var agentURL: URL? {
        guard let url = phase.url, PreviewOrigin.isLoopback(url) else { return nil }
        return url
    }

    /// Why the agent cannot use a live server, when it cannot.
    public var agentUnavailableReason: String? {
        guard let url = phase.url, agentURL == nil else { return nil }
        return "It listens on \(url.host ?? "a LAN address") only; Juno's agent uses loopback addresses."
    }

    /// The pane's subtitle: state in words, no badge (§4.7).
    public var statusSentence: String {
        let place = workingDirectoryDisplay == "." ? "" : " in \(workingDirectoryDisplay)"
        let containment = isContained ? (network == .internet ? " · online" : " · offline") : ""
        switch phase {
        case .stopped:
            return "Stopped · \(displayCommand)\(place)"
        case .starting:
            return "Starting \(displayCommand)\(place)\(containment)"
        case let .running(url):
            let portText = url.port.map { " on :\($0)" } ?? ""
            return "Running \(displayCommand)\(place)\(portText)\(containment)"
        case let .attached(url):
            return "Using the server at \(url.absoluteString)"
        case let .failed(reason):
            let first = reason.split(separator: "\n").first.map(String.init) ?? reason
            return "\(displayCommand) did not start: \(first)"
        case let .exited(code):
            return "\(displayCommand) stopped on its own (exit code \(code))"
        }
    }
}

/// A taken port the reader has not said what to do about.
public struct PreviewPortConflict: Equatable, Sendable {
    public var port: Int
    /// "node (pid 4211)", when Juno can see who holds it.
    public var owner: String?
}

/// How a start went, for the tool result and the pane.
public struct PreviewStartOutcome: Sendable {
    public enum Result: Equatable, Sendable {
        /// Ready at this address (or already was).
        case ready(URL, alreadyRunning: Bool)
        /// The server failed or exited; the reason in words.
        case failed(String)
        /// Still starting after the configuration's readiness timeout.
        case timedOut(seconds: Int)
    }

    public var result: Result
    public var snapshot: PreviewServerSnapshot
    /// The last log lines, on failure or timeout.
    public var recentLog: [String]
}

/// A change the registry tells its observers about.
public enum PreviewRegistryChange: Sendable {
    case changed(PreviewServerSnapshot)
    case removed(PreviewKey)
}

/// One running server process, as the registry drives it. ``DevServerService``
/// in the app; a fake in tests.
public protocol PreviewServerProcess: AnyObject, Sendable {
    func start(_ launch: DevServerLaunch) async -> AsyncStream<DevServerEvent>
    func stopAndWaitAsync() async
    var processIdentity: (pgid: Int32, pid: Int32)? { get }
    var isContained: Bool { get }
    func notifyStaticReload()
}

extension DevServerService: PreviewServerProcess {}

/// Makes server processes with the right containment.
public protocol PreviewServerLaunching: Sendable {
    func makeProcess(checkoutRoot: URL, network: PreviewNetworkPolicy) -> any PreviewServerProcess
}

/// Kernel-contained dev servers: the workspace boundary, loopback unless the
/// configuration (or the reader's answer) allows the internet.
public struct DevServerLauncher: PreviewServerLaunching {
    public init() {}

    public func makeProcess(checkoutRoot: URL, network: PreviewNetworkPolicy) -> any PreviewServerProcess {
        DevServerService.contained(workspaceRootURL: checkoutRoot, allowsNetwork: network == .internet)
    }
}

/// Answers "does anything serve at this URL" for attach; a fake in tests.
public protocol PreviewHTTPProbing: Sendable {
    func answers(_ url: URL) async -> Bool
}

public struct URLSessionPreviewProbe: PreviewHTTPProbing {
    public init() {}

    public func answers(_ url: URL) async -> Bool {
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        do {
            let (_, response) = try await session.data(for: request)
            return response is HTTPURLResponse
        } catch {
            return false
        }
    }
}

/// Every preview server, leased by sessions (§4.1).
public actor PreviewRegistry {
    /// Whether this process is a test run, which must never touch the
    /// reader's real ledger or signal their processes.
    static var isTestProcess: Bool {
        NSClassFromString("XCTestCase") != nil
    }

    /// The app's server ledger (`~/Library/Application Support/Juno/preview-servers.json`);
    /// a throwaway file in a test run.
    public static let sharedLedger: PreviewServerLedger = isTestProcess
        ? PreviewServerLedger(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-preview-ledger-\(getpid()).json"))
        : PreviewServerLedger()

    public static let shared: PreviewRegistry = {
        let ledger = sharedLedger
        // Servers a crashed Juno left behind hold ports until reaped.
        if !isTestProcess { ledger.reapOrphans() }
        let registry = PreviewRegistry(
            ledger: ledger,
            settings: .shared
        )
        Task { await registry.startSweeping() }
        return registry
    }()

    /// A server with no lease and no view stops after this long.
    public static let defaultIdleTimeout: TimeInterval = 30 * 60

    private final class Entry {
        var key: PreviewKey
        var configuration: ResolvedPreviewConfiguration?
        var displayCommand: String
        var workingDirectoryDisplay: String
        var phase: PreviewServerPhase = .stopped
        var port: Int?
        var network: PreviewNetworkPolicy = .loopback
        var isContained = false
        var startedAt: Date?
        var leases: Set<CodeSessionID> = []
        var viewers = 0
        var idleSince: Date?
        var log = PreviewLogBuffer()
        var process: (any PreviewServerProcess)?
        var pump: Task<Void, Never>?
        var generation = 0
        var ledgerGroup: Int32?
        var blockedOutboundHost: String?
        var shellID: String?
        var portConflict: PreviewPortConflict?
        /// Server secret values, scrubbed from every log line.
        var secretValues: [String] = []

        init(key: PreviewKey, displayCommand: String, workingDirectoryDisplay: String) {
            self.key = key
            self.displayCommand = displayCommand
            self.workingDirectoryDisplay = workingDirectoryDisplay
        }
    }

    private let launcher: any PreviewServerLaunching
    private let ledger: PreviewServerLedger?
    private let probe: any PreviewHTTPProbing
    private let clock: @Sendable () -> Date
    private let idleTimeout: TimeInterval
    private let settings: PreviewLocalSettings?
    private let secretEnvironment: any PreviewSecretEnvironmentProviding
    private var entries: [PreviewKey: Entry] = [:]
    private var observers: [UUID: @Sendable (PreviewRegistryChange) -> Void] = [:]
    private var pendingLogNotifications: Set<PreviewKey> = []
    private var sweeper: Task<Void, Never>?

    public init(
        launcher: any PreviewServerLaunching = DevServerLauncher(),
        ledger: PreviewServerLedger? = nil,
        probe: any PreviewHTTPProbing = URLSessionPreviewProbe(),
        settings: PreviewLocalSettings? = .shared,
        secretEnvironment: (any PreviewSecretEnvironmentProviding)? = nil,
        idleTimeout: TimeInterval = PreviewRegistry.defaultIdleTimeout,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.launcher = launcher
        self.ledger = ledger
        self.probe = probe
        self.settings = settings
        self.secretEnvironment = secretEnvironment
            ?? (Self.isTestProcess ? NoPreviewEnvironmentSecrets() : KeychainPreviewEnvironment())
        self.idleTimeout = idleTimeout
        self.clock = clock
    }

    // MARK: - Observation

    @discardableResult
    public func addObserver(_ observer: @escaping @Sendable (PreviewRegistryChange) -> Void) -> UUID {
        let id = UUID()
        observers[id] = observer
        return id
    }

    public func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }

    private func notify(_ key: PreviewKey) {
        guard let entry = entries[key] else {
            for observer in observers.values { observer(.removed(key)) }
            return
        }
        let snapshot = makeSnapshot(entry)
        for observer in observers.values { observer(.changed(snapshot)) }
    }

    /// Log lines arrive in bursts; observers hear about them at most four
    /// times a second.
    private func notifyLogSoon(_ key: PreviewKey) {
        guard pendingLogNotifications.insert(key).inserted else { return }
        Task {
            try? await Task.sleep(for: .milliseconds(250))
            self.flushLogNotification(key)
        }
    }

    private func flushLogNotification(_ key: PreviewKey) {
        pendingLogNotifications.remove(key)
        notify(key)
    }

    // MARK: - Reading

    public func snapshot(_ key: PreviewKey) -> PreviewServerSnapshot? {
        entries[key].map(makeSnapshot)
    }

    /// Every preview of `checkoutRoot`, by name.
    public func snapshots(checkoutRoot: URL) -> [PreviewServerSnapshot] {
        let path = PreviewKey(checkoutRoot: checkoutRoot, name: "").checkoutRoot
        return entries.values
            .filter { $0.key.checkoutRoot == path }
            .sorted { $0.key.name < $1.key.name }
            .map(makeSnapshot)
    }

    public func allSnapshots() -> [PreviewServerSnapshot] {
        entries.values.sorted { $0.key.description < $1.key.description }.map(makeSnapshot)
    }

    /// The previews `session` holds a lease on.
    public func leasedKeys(session: CodeSessionID) -> [PreviewKey] {
        entries.values.filter { $0.leases.contains(session) }.map(\.key).sorted { $0.description < $1.description }
    }

    public func logs(
        _ key: PreviewKey,
        level: PreviewLogBuffer.Level = .all,
        search: String? = nil,
        since: Int? = nil,
        limit: Int = 120
    ) -> PreviewLogBuffer.Page? {
        entries[key]?.log.page(since: since, level: level, search: search, limit: limit)
    }

    /// Log lines after `since` that read as compile errors.
    public func compileErrors(_ key: PreviewKey, since: Int) -> [PreviewLogBuffer.Entry] {
        entries[key]?.log.compileErrors(since: since) ?? []
    }

    /// Error lines after `since`.
    public func logErrors(_ key: PreviewKey, since: Int) -> [PreviewLogBuffer.Entry] {
        entries[key]?.log.errors(since: since) ?? []
    }

    public func lastLogID(_ key: PreviewKey) -> Int {
        entries[key]?.log.lastID ?? 0
    }

    private func makeSnapshot(_ entry: Entry) -> PreviewServerSnapshot {
        PreviewServerSnapshot(
            key: entry.key,
            configuration: entry.configuration,
            displayCommand: entry.displayCommand,
            workingDirectoryDisplay: entry.workingDirectoryDisplay,
            phase: entry.phase,
            port: entry.port,
            network: entry.network,
            isContained: entry.isContained,
            startedAt: entry.startedAt,
            leaseHolders: entry.leases,
            viewerCount: entry.viewers,
            lastLogID: entry.log.lastID,
            logLineCount: entry.log.entries.count,
            blockedOutboundHost: entry.blockedOutboundHost,
            shellID: entry.shellID,
            portConflict: entry.portConflict
        )
    }

    // MARK: - Leases and viewers

    /// `session` uses this preview; it keeps running while any session does.
    public func lease(_ key: PreviewKey, session: CodeSessionID) {
        guard let entry = entries[key] else { return }
        entry.leases.insert(session)
        refreshIdle(entry)
        notify(key)
    }

    /// `session` no longer uses this preview. The server stops when that was
    /// the last lease and no view shows it.
    public func release(_ key: PreviewKey, session: CodeSessionID) async {
        guard let entry = entries[key] else { return }
        entry.leases.remove(session)
        refreshIdle(entry)
        notify(key)
        if entry.leases.isEmpty, entry.viewers == 0, entry.phase.isLive {
            await stop(key)
        }
    }

    /// The session ended (archived or deleted): every lease it held ends.
    public func releaseAll(session: CodeSessionID) async {
        for key in entries.values.filter({ $0.leases.contains(session) }).map(\.key) {
            await release(key, session: session)
        }
    }

    /// A pane or window shows this preview. Views never stop a server; they
    /// only keep an unleased one from idling out while it is on screen.
    public func addViewer(_ key: PreviewKey) {
        guard let entry = entries[key] else { return }
        entry.viewers += 1
        refreshIdle(entry)
        notify(key)
    }

    public func removeViewer(_ key: PreviewKey) {
        guard let entry = entries[key] else { return }
        entry.viewers = max(0, entry.viewers - 1)
        refreshIdle(entry)
        notify(key)
    }

    private func refreshIdle(_ entry: Entry) {
        if entry.leases.isEmpty, entry.viewers == 0 {
            if entry.idleSince == nil { entry.idleSince = clock() }
        } else {
            entry.idleSince = nil
        }
    }

    /// Stops servers idle (no lease, no view) for longer than the timeout.
    public func sweepIdle() async {
        let now = clock()
        let expired = entries.values.filter { entry in
            guard entry.phase.isLive, let since = entry.idleSince else { return false }
            return now.timeIntervalSince(since) >= idleTimeout
        }.map(\.key)
        for key in expired {
            await stop(key, note: "Stopped after \(Int(idleTimeout / 60)) minutes with no session or view using it.")
        }
    }

    func startSweeping() {
        guard sweeper == nil else { return }
        sweeper = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                await self?.sweepIdle()
            }
        }
    }

    // MARK: - Starting

    /// Starts `configuration` in `checkoutRoot` (or returns the server already
    /// running with the same bytes), leased to `session`, and waits until it
    /// is ready or has failed when `waitUntilReady` is set.
    public func start(
        _ configuration: ResolvedPreviewConfiguration,
        checkoutRoot: URL,
        session: CodeSessionID?,
        waitUntilReady: Bool = true
    ) async -> PreviewStartOutcome {
        let key = PreviewKey(checkoutRoot: checkoutRoot, name: configuration.name)
        let entry = entries[key] ?? Entry(
            key: key,
            displayCommand: configuration.displayArgv.joined(separator: " "),
            workingDirectoryDisplay: configuration.workingDirectoryDisplay
        )
        entries[key] = entry
        if let session { entry.leases.insert(session) }
        refreshIdle(entry)

        if entry.phase.isLive, entry.configuration?.contentHash == configuration.contentHash {
            notify(key)
            guard waitUntilReady else { return outcome(entry, alreadyRunning: true) }
            return await waitForSettle(key, generation: entry.generation, timeout: configuration.readyTimeoutSeconds, alreadyRunning: true)
        }
        if entry.phase.isLive {
            // The bytes changed: the old server goes before the new one starts.
            await stopProcess(entry, note: "Restarting: the configuration changed.")
        }

        entry.configuration = configuration
        entry.displayCommand = configuration.isStatic
            ? "Juno's static server"
            : configuration.commandLine() ?? configuration.displayArgv.joined(separator: " ")
        entry.workingDirectoryDisplay = configuration.workingDirectoryDisplay
        entry.blockedOutboundHost = nil
        entry.shellID = nil
        entry.portConflict = nil
        entry.generation += 1
        let generation = entry.generation

        if case let .attach(url) = configuration.kind {
            return await attach(entry, url: url, generation: generation, ownerGroup: nil)
        }

        // Ports (PV-15). Server secrets from the Keychain go to the child
        // only, and their values are scrubbed from its log.
        var environment = configuration.environment
        let secrets = secretEnvironment.environment(for: configuration, checkoutRoot: checkoutRoot)
        environment.merge(secrets) { _, secret in secret }
        entry.secretValues = secrets.values.filter { $0.count >= 4 }
        var expectedPort: Int?
        var resolvedPort = configuration.port
        let argvUsesPort = configuration.displayArgv.contains { $0.contains("${port}") }
            || {
                if case let .command(argv) = configuration.kind { return argv.contains { $0.contains("${port}") } }
                return false
            }()
        // The file's `autoPort`, else the reader's saved answer (PV-15).
        let autoPort = settings?.effectiveAutoPort(for: configuration, in: checkoutRoot) ?? configuration.autoPort
        if !configuration.isStatic {
            if autoPort == true {
                guard let port = PreviewPorts.freePort(preferring: configuration.port) else {
                    return fail(entry, "No free port was found on this Mac.")
                }
                resolvedPort = port
                environment["PORT"] = String(port)
                expectedPort = (configuration.port != nil || argvUsesPort) ? port : nil
            } else if let port = configuration.port {
                guard PreviewPorts.isFree(port) else {
                    let holder = ListeningSocketOwnership.owner(ofPort: port)?.sentence
                    let owner = holder.map { "by \($0)" } ?? "by another process"
                    let unanswered = autoPort == nil
                        && (settings?.shouldAskAboutPort(for: configuration, in: checkoutRoot) ?? true)
                    if unanswered { entry.portConflict = PreviewPortConflict(port: port, owner: holder) }
                    return fail(
                        entry,
                        unanswered
                            ? "Port \(port) is already in use \(owner). The Preview pane asks the reader whether to use a free port for \(configuration.name) from now on; or stop that process, or set \"autoPort\" in .juno/launch.json."
                            : "Port \(port) is already in use \(owner). Stop it, or set \"autoPort\": true in .juno/launch.json so Juno picks a free port."
                    )
                }
                environment["PORT"] = String(port)
                expectedPort = port
            } else if argvUsesPort {
                guard let port = PreviewPorts.freePort() else {
                    return fail(entry, "No free port was found on this Mac.")
                }
                resolvedPort = port
                environment["PORT"] = String(port)
                expectedPort = port
            }
        }
        entry.port = resolvedPort

        let network = settings?.effectiveNetwork(for: configuration, in: checkoutRoot) ?? configuration.network
        entry.network = network
        let process = launcher.makeProcess(checkoutRoot: checkoutRoot, network: network)
        entry.process = process
        entry.isContained = process.isContained
        entry.phase = .starting
        entry.startedAt = clock()
        entry.log.append(channel: .log, text: "Starting \(configuration.commandLine(port: resolvedPort) ?? configuration.name) in \(configuration.workingDirectoryDisplay)", at: clock())
        notify(key)

        let launch: DevServerLaunch
        switch configuration.kind {
        case let .staticSite(root):
            launch = DevServerLaunch(commandLine: ResolvedPreviewConfiguration.staticExecutable, workingDirectory: root)
        default:
            launch = DevServerLaunch(
                commandLine: configuration.commandLine(port: resolvedPort) ?? "",
                workingDirectory: configuration.workingDirectory,
                environment: environment,
                port: expectedPort,
                readyPath: configuration.readyPath
            )
        }
        let stream = await process.start(launch)
        guard entry.generation == generation else {
            // A stop, restart or changed start won while this one launched.
            // Its process is no longer the entry's, so nothing else will stop
            // it, and its stream is never read (nor its group recorded in the
            // ledger): stop it here rather than leave a server holding a port.
            await process.stopAndWaitAsync()
            return outcome(entry, alreadyRunning: false)
        }
        entry.pump = Task { [weak self] in
            for await event in stream {
                await self?.handle(event, key: key, generation: generation)
            }
            await self?.streamEnded(key: key, generation: generation)
        }
        guard waitUntilReady else { return outcome(entry, alreadyRunning: false) }
        return await waitForSettle(key, generation: generation, timeout: configuration.readyTimeoutSeconds, alreadyRunning: false)
    }

    /// Stops and starts again with the same configuration (re-read by the
    /// caller, so a changed file is honoured).
    public func restart(
        _ configuration: ResolvedPreviewConfiguration,
        checkoutRoot: URL,
        session: CodeSessionID?
    ) async -> PreviewStartOutcome {
        let key = PreviewKey(checkoutRoot: checkoutRoot, name: configuration.name)
        if let entry = entries[key], entry.phase.isLive {
            await stopProcess(entry, note: "Restarting.")
        }
        return await start(configuration, checkoutRoot: checkoutRoot, session: session)
    }

    /// Uses a server a durable shell started: its group must listen on the
    /// URL's port, and the URL must answer (§4.1, PV-5).
    public func attachShell(
        shellID: String,
        url: URL,
        processGroup: pid_t?,
        checkoutRoot: URL,
        session: CodeSessionID?
    ) async -> PreviewStartOutcome {
        let key = PreviewKey(checkoutRoot: checkoutRoot, name: "shell \(shellID)")
        let entry = entries[key] ?? Entry(key: key, displayCommand: "shell \(shellID)", workingDirectoryDisplay: ".")
        entries[key] = entry
        if let session { entry.leases.insert(session) }
        refreshIdle(entry)
        entry.generation += 1
        entry.shellID = shellID
        entry.configuration = nil
        return await attach(entry, url: url, generation: entry.generation, ownerGroup: processGroup)
    }

    private func attach(_ entry: Entry, url: URL, generation: Int, ownerGroup: pid_t?) async -> PreviewStartOutcome {
        guard PreviewOrigin.isLoopback(url) else {
            return fail(entry, "\(url.absoluteString) is not on this Mac; the Preview only uses loopback addresses.")
        }
        if let ownerGroup, let port = url.port,
           !ListeningSocketOwnership.groupListens(port: port, processGroup: ownerGroup)
        {
            return fail(entry, "No process of that shell listens on port \(port), so \(url.absoluteString) is not its server.")
        }
        entry.phase = .starting
        entry.port = url.port
        entry.displayCommand = entry.shellID.map { "shell \($0)" } ?? url.absoluteString
        notify(entry.key)
        var answered = false
        for attempt in 0..<4 {
            if await probe.answers(url) {
                answered = true
                break
            }
            if attempt < 3 { try? await Task.sleep(for: .milliseconds(500)) }
        }
        guard entry.generation == generation else { return outcome(entry, alreadyRunning: false) }
        guard answered else {
            return fail(entry, "Nothing answers at \(url.absoluteString). Start that server first.")
        }
        entry.phase = .attached(url)
        entry.startedAt = clock()
        entry.log.append(channel: .log, text: "Using the server at \(url.absoluteString); Juno did not start it and will not stop it.", at: clock())
        notify(entry.key)
        return outcome(entry, alreadyRunning: false)
    }

    private func fail(_ entry: Entry, _ reason: String) -> PreviewStartOutcome {
        entry.phase = .failed(reason)
        entry.log.append(channel: .log, text: reason, at: clock())
        notify(entry.key)
        return PreviewStartOutcome(result: .failed(reason), snapshot: makeSnapshot(entry), recentLog: recentLog(entry))
    }

    private func handle(_ event: DevServerEvent, key: PreviewKey, generation: Int) {
        guard let entry = entries[key], entry.generation == generation else { return }
        switch event {
        case let .line(line):
            var text = line.text
            for secret in entry.secretValues where text.contains(secret) {
                text = text.replacingOccurrences(of: secret, with: "••••")
            }
            entry.log.append(channel: line.channel, text: text, at: clock())
            if entry.network == .loopback, entry.isContained, entry.blockedOutboundHost == nil,
               let host = PreviewNetworkHints.blockedHost(in: text)
            {
                entry.blockedOutboundHost = host
                notify(key)
            } else {
                notifyLogSoon(key)
            }
        case let .state(state):
            switch state {
            case .stopped: entry.phase = .stopped
            case .starting:
                entry.phase = .starting
                if let identity = entry.process?.processIdentity, let configuration = entry.configuration {
                    entry.ledgerGroup = identity.pgid
                    ledger?.record(
                        pgid: identity.pgid,
                        pid: identity.pid,
                        cwd: configuration.workingDirectory.path,
                        configHash: configuration.contentHash,
                        name: configuration.name
                    )
                }
            case let .running(url):
                entry.phase = .running(url)
                entry.port = url.port ?? entry.port
            case let .failed(reason): entry.phase = .failed(reason)
            case let .exited(code): entry.phase = .exited(code)
            }
            if !state.isLive { forgetLedger(entry) }
            notify(key)
        }
    }

    private func streamEnded(key: PreviewKey, generation: Int) {
        guard let entry = entries[key], entry.generation == generation else { return }
        if entry.phase.isLive, entry.shellID == nil, !(entry.configuration?.isAttach ?? false) {
            entry.phase = .stopped
        }
        forgetLedger(entry)
        entry.process = nil
        notify(key)
    }

    private func forgetLedger(_ entry: Entry) {
        if let group = entry.ledgerGroup {
            ledger?.remove(pgid: group)
            entry.ledgerGroup = nil
        }
    }

    private func waitForSettle(
        _ key: PreviewKey,
        generation: Int,
        timeout: Int,
        alreadyRunning: Bool
    ) async -> PreviewStartOutcome {
        let deadline = Date().addingTimeInterval(TimeInterval(timeout))
        while Date() < deadline {
            guard let entry = entries[key] else { break }
            if entry.generation != generation { return outcome(entry, alreadyRunning: alreadyRunning) }
            switch entry.phase {
            case .running, .attached, .failed, .exited, .stopped:
                return outcome(entry, alreadyRunning: alreadyRunning)
            case .starting:
                break
            }
            try? await Task.sleep(for: .milliseconds(50))
        }
        guard let entry = entries[key] else {
            return PreviewStartOutcome(
                result: .failed("The preview went away."),
                snapshot: PreviewServerSnapshot(
                    key: key, configuration: nil, displayCommand: key.name, workingDirectoryDisplay: ".",
                    phase: .stopped, port: nil, network: .loopback, isContained: false, startedAt: nil,
                    leaseHolders: [], viewerCount: 0, lastLogID: 0, logLineCount: 0
                ),
                recentLog: []
            )
        }
        if case .starting = entry.phase {
            return PreviewStartOutcome(result: .timedOut(seconds: timeout), snapshot: makeSnapshot(entry), recentLog: recentLog(entry))
        }
        return outcome(entry, alreadyRunning: alreadyRunning)
    }

    private func outcome(_ entry: Entry, alreadyRunning: Bool) -> PreviewStartOutcome {
        let snapshot = makeSnapshot(entry)
        switch entry.phase {
        case let .running(url), let .attached(url):
            return PreviewStartOutcome(result: .ready(url, alreadyRunning: alreadyRunning), snapshot: snapshot, recentLog: [])
        case let .failed(reason):
            return PreviewStartOutcome(result: .failed(reason), snapshot: snapshot, recentLog: recentLog(entry))
        case let .exited(code):
            return PreviewStartOutcome(
                result: .failed("It exited on its own with code \(code)."), snapshot: snapshot, recentLog: recentLog(entry)
            )
        case .stopped:
            return PreviewStartOutcome(result: .failed("It was stopped."), snapshot: snapshot, recentLog: recentLog(entry))
        case .starting:
            return PreviewStartOutcome(
                result: .timedOut(seconds: entry.configuration?.readyTimeoutSeconds ?? 0),
                snapshot: snapshot,
                recentLog: recentLog(entry)
            )
        }
    }

    private func recentLog(_ entry: Entry) -> [String] {
        entry.log.entries.suffix(40).map(\.text)
    }

    // MARK: - Stopping

    /// Stops the server (or forgets an attached one) and keeps its log.
    public func stop(_ key: PreviewKey, note: String? = nil) async {
        guard let entry = entries[key] else { return }
        await stopProcess(entry, note: note ?? "Stopped.")
        notify(key)
    }

    private func stopProcess(_ entry: Entry, note: String) async {
        entry.generation += 1
        let process = entry.process
        let pump = entry.pump
        entry.process = nil
        entry.pump = nil
        if entry.phase.isLive {
            entry.log.append(channel: .log, text: note, at: clock())
        }
        entry.phase = .stopped
        await process?.stopAndWaitAsync()
        pump?.cancel()
        forgetLedger(entry)
    }

    /// Removes a stopped preview from the list.
    public func remove(_ key: PreviewKey) async {
        guard let entry = entries[key] else { return }
        await stopProcess(entry, note: "Removed.")
        entries.removeValue(forKey: key)
        notify(key)
    }

    /// The app is quitting: every server Juno started stops.
    public func stopAll() async {
        for key in Array(entries.keys) {
            await stop(key, note: "Juno is quitting.")
        }
    }

    /// Pushes a reload to the static server's pages, when that is what runs.
    public func notifyStaticReload(_ key: PreviewKey) {
        entries[key]?.process?.notifyStaticReload()
    }
}
