import Darwin
import Foundation
import JunoCodeCore

/// What the development server process is actually doing.
///
/// Every case is a fact about a real child process: `.running` carries the URL
/// the server listens on, and it is unreachable until both a live process and
/// an address its own process group listens on exist. There is no case meaning
/// "a URL has been typed somewhere", because a typed URL is not a running
/// server.
public enum DevServerState: Equatable, Sendable {
    /// No process. The initial state, and the state after ``DevServerService/stop()``.
    case stopped
    /// The process is alive and nothing it owns answers yet.
    case starting
    /// The process is alive and answered at this address.
    case running(URL)
    /// The process never served an address — it exited immediately, could not be
    /// launched, or was refused. `reason` carries the output that explains it.
    case failed(reason: String)
    /// The process served an address and then ended on its own.
    case exited(code: Int32)

    /// The observed address, or nil in every state where there is not one.
    public var url: URL? {
        if case let .running(url) = self { return url }
        return nil
    }

    /// True only while a child process is alive.
    public var isLive: Bool {
        switch self {
        case .starting, .running: true
        case .stopped, .failed, .exited: false
        }
    }
}

/// One line of the server's output.
///
/// Identified by a monotonic counter rather than the text, because a dev server
/// prints the same line hundreds of times and `ForEach` needs them distinct.
public struct DevServerLogLine: Identifiable, Equatable, Sendable {
    public let id: Int
    public let channel: ToolOutputChannel
    public let text: String

    public init(id: Int, channel: ToolOutputChannel, text: String) {
        self.id = id
        self.channel = channel
        self.text = text
    }
}

public enum DevServerEvent: Equatable, Sendable {
    case state(DevServerState)
    case line(DevServerLogLine)
}

/// Everything one start needs, resolved from a launch configuration.
public struct DevServerLaunch: Sendable {
    /// What the shell runs. `juno:static [folder]` runs Juno's own static
    /// server instead.
    public var commandLine: String
    /// The folder it runs in, inside the workspace.
    public var workingDirectory: URL
    /// Added to the scrubbed environment: the configuration's non-secret
    /// values and `PORT`.
    public var environment: [String: String]
    /// The port the server must listen on, when known. Readiness then probes
    /// it directly instead of waiting for a printed address.
    public var port: Int?
    /// The path a readiness request must answer.
    public var readyPath: String

    public init(
        commandLine: String,
        workingDirectory: URL,
        environment: [String: String] = [:],
        port: Int? = nil,
        readyPath: String = "/"
    ) {
        self.commandLine = commandLine
        self.workingDirectory = workingDirectory
        self.environment = environment
        self.port = port
        self.readyPath = readyPath
    }
}

/// Runs a long-lived development server for the preview.
///
/// It is a separate service from ``CommandExecutionService`` because the two want
/// opposite things from a process. The command executor is deliberately one-shot:
/// it applies a wall-clock timeout, caps total output, and terminates the process
/// group when it is done — which is exactly right for `npm test` and fatal for
/// `npm run dev`. A dev server has to outlive its own first second of output,
/// keep printing for hours, and stay up until the reader stops it.
///
/// What it keeps from the executor is the safety model, unchanged: the working
/// directory is pinned to the workspace, the environment is built from scratch so
/// no account token can reach the child, output is redacted on the way out, the
/// classifier's refusals are honoured, and termination signals the whole process
/// group so a shell's grandchildren die with it.
///
/// **URL truth** (CODE_AGENT_SPEC §4.2, PV-8, PV-9). A printed address is only a
/// candidate. It counts once a socket listening on its port belongs to this
/// server's process group and answers an HTTP request; a proxy target or a
/// sibling app's URL printed first is ignored, and later candidates are still
/// considered. When the configuration names a port, that port is probed
/// directly. A LAN address is rewritten to loopback only when the group also
/// listens on loopback or the wildcard address.
///
/// One service instance owns at most one server. Starting a second stops the
/// first, so a caller can never leak a process it has lost track of.
public final class DevServerService: @unchecked Sendable {
    private let lock = NSLock()
    private var run: DevServerRun?
    private var staticServer: StaticPreviewServer?
    private let classifier = CommandClassifier()
    private let redactor = SecretRedactor()
    /// A descendant can inherit one of the output pipes after the leader exits.
    /// Never let that keep the stream (or a replacement start) blocked forever.
    private static let drainTimeout: TimeInterval = 1.0
    /// Give a cooperative process a chance to leave before escalating the whole
    /// process group. This is deliberately independent of leader liveness.
    private static let processGroupKillDelay: TimeInterval = 2.0
    /// A replacement start waits for the old stream to finish, with a hard
    /// upper bound if a platform pipe or child misbehaves.
    private static let cleanupWaitTimeout: TimeInterval = 4.0
    /// Optional kernel containment for the long-lived child.
    private let sandbox: CommandSandboxProfile?

    public init(sandbox: CommandSandboxProfile? = nil) {
        self.sandbox = sandbox
    }

    /// Creates a preview server with the same workspace boundary as regular
    /// local commands. Network stays off by default: a local preview should be
    /// able to serve its files without silently turning into an outbound
    /// process. If sandbox-exec is unavailable the service remains usable,
    /// and isContained reports the weaker runtime honestly.
    public static func contained(
        workspaceRootURL: URL,
        allowsNetwork: Bool = false,
        allowsLocalhost: Bool = true
    ) -> DevServerService {
        guard CommandSandboxProfile.isAvailable else {
            return DevServerService()
        }
        return DevServerService(
            sandbox: CommandSandboxProfile(
                workspaceRoot: workspaceRootURL,
                filesystem: .readWrite,
                allowsNetwork: allowsNetwork,
                allowsLocalhost: allowsLocalhost
            )
        )
    }

    /// Whether the current service applies a kernel-enforced boundary.
    public var isContained: Bool { sandbox != nil }

    /// Whether the kernel boundary lets the server reach the internet.
    public var allowsNetwork: Bool { sandbox?.allowsNetwork ?? true }

    /// A dev server left running is a port held hostage and a file watcher
    /// burning CPU until the Mac is restarted. Releasing the service kills it.
    deinit {
        stop()
    }

    /// True while a child process or native static server is alive.
    public var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return staticServer != nil || (run?.isProcessRunning ?? false)
    }

    /// The command of the server currently running, or nil.
    public var runningCommand: String? {
        lock.lock()
        defer { lock.unlock() }
        if staticServer != nil { return "Static Preview" }
        return run?.isProcessRunning == true ? run?.command : nil
    }

    /// The running child's process group and pid, for the server ledger. Nil
    /// for the static server and before launch.
    public var processIdentity: (pgid: Int32, pid: Int32)? {
        lock.lock()
        let current = run
        lock.unlock()
        return current?.identity
    }

    /// The static server's live-reload hook, when the static server runs.
    public func notifyStaticReload() {
        lock.lock()
        let server = staticServer
        lock.unlock()
        server?.notifyReload()
    }

    /// Starts `launch` and streams what happens to it, after the previous
    /// server (if any) is fully gone. Waiting happens off the caller's actor,
    /// so a restart never blocks the main thread (PV-17).
    public func start(_ launch: DevServerLaunch) async -> AsyncStream<DevServerEvent> {
        await Task.detached(priority: .userInitiated) { [self] in
            stopAndWait()
        }.value
        return makeStream(launch)
    }

    /// Starts `command` in `workspaceRoot`. Blocks while a previous server
    /// stops; prefer ``start(_:)`` from an actor.
    public func start(command: String, workspaceRoot: URL) -> AsyncStream<DevServerEvent> {
        stopAndWait()
        return makeStream(DevServerLaunch(commandLine: command, workingDirectory: workspaceRoot))
    }

    /// The stream for one launch. It never throws: a launch failure, a refusal
    /// and an immediate exit are all *states*, not errors. It ends when the
    /// process is gone; cancelling the consuming task terminates the group.
    private func makeStream(_ launch: DevServerLaunch) -> AsyncStream<DevServerEvent> {
        let commandLine = launch.commandLine.trimmingCharacters(in: .whitespacesAndNewlines)

        if commandLine == DevServerCommand.staticPreviewCommandLine || commandLine.hasPrefix("juno:static") {
            return staticStream(commandLine: commandLine, launch: launch)
        }

        let redactor = self.redactor
        let classifier = self.classifier

        // Bounded so a server in a rebuild loop cannot grow the buffer without
        // limit when the consumer is busy; the newest output is what matters.
        return AsyncStream(bufferingPolicy: .bufferingNewest(4_096)) { continuation in
            guard !commandLine.isEmpty else {
                continuation.yield(.state(.failed(reason: "No command to run.")))
                continuation.finish()
                return
            }
            // Defense in depth, as in the command executor: the refusal list
            // does not depend on who asked. A configured preview server is the
            // one place a static file server *is* the job, so that refusal
            // (which exists to keep servers out of one-shot commands) does not
            // apply here.
            if case let .forbidden(reason) = classifier.classify(commandLine),
               !reason.contains(CommandClassifier.previewServerRefusalMarker)
            {
                continuation.yield(.state(.failed(reason: reason)))
                continuation.finish()
                return
            }

            let invocation = self.sandbox?.wrap(command: commandLine)
                ?? (executable: "/bin/zsh", arguments: ["-c", commandLine])
            let process = Process()
            process.executableURL = URL(fileURLWithPath: invocation.executable)
            process.arguments = invocation.arguments
            process.currentDirectoryURL = launch.workingDirectory
            var environment = Self.serverEnvironment(workspaceRoot: launch.workingDirectory.path)
            for (key, value) in launch.environment where !Self.protectedEnvironmentNames.contains(key) {
                environment[key] = value
            }
            if let port = launch.port {
                environment["PORT"] = String(port)
            }
            process.environment = environment
            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe
            // No PTY and no input: this is a log surface, not a terminal.
            process.standardInput = FileHandle.nullDevice

            let drainGroup = DispatchGroup()
            let termination = DevServerTermination(
                drainGroup: drainGroup,
                drainTimeout: Self.drainTimeout
            )

            let run = DevServerRun(
                process: process,
                command: commandLine,
                redactor: redactor,
                termination: termination,
                processGroupKillDelay: Self.processGroupKillDelay,
                expectedPort: launch.port,
                readyPath: launch.readyPath
            )
            self.lock.lock()
            self.run = run
            self.lock.unlock()

            let emit: @Sendable (DevServerEvent) -> Void = { continuation.yield($0) }

            for (handle, channel) in [
                (stdoutPipe.fileHandleForReading, ToolOutputChannel.stdout),
                (stderrPipe.fileHandleForReading, ToolOutputChannel.stderr),
            ] {
                drainGroup.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    defer {
                        for line in run.flush(channel: channel) {
                            continuation.yield(.line(line))
                        }
                        drainGroup.leave()
                    }
                    while true {
                        let data = handle.availableData
                        guard !data.isEmpty else { return }
                        for line in run.ingest(data, channel: channel) {
                            continuation.yield(.line(line))
                        }
                    }
                }
            }

            // Servers that print nothing recognisable are common enough (a bare
            // `node server.js`) that silence needs an explanation rather than an
            // indefinite spinner.
            run.setSilenceNotice(
                Task {
                    try? await Task.sleep(for: .seconds(25))
                    guard !Task.isCancelled,
                          run.isProcessRunning,
                          !run.isReady
                    else { return }
                    continuation.yield(
                        .line(
                            run.note(
                                "Nothing this process started answers yet. If it serves on a known port, set \"port\" in .juno/launch.json."
                            )
                        )
                    )
                }
            )

            process.terminationHandler = { finished in
                run.cancelSilenceNotice()
                run.cancelReadinessProbe()
                // Signal the recorded group even though the leader is gone, so
                // descendants that inherited the pipes cannot keep it alive.
                run.terminateGroup()
                let status = finished.terminationStatus
                let wasSignal = finished.terminationReason == .uncaughtSignal
                termination.finishAfterDrain(onTimeout: { run.forceKillGroup() }) {
                    for channel in [ToolOutputChannel.stdout, .stderr] {
                        for line in run.flush(channel: channel) {
                            continuation.yield(.line(line))
                        }
                    }
                    let snapshot = run.snapshot()
                    let final: DevServerState
                    if snapshot.stopRequested {
                        final = .stopped
                    } else if snapshot.printedURL == nil, !snapshot.wasReady {
                        // Nothing ever served: whatever the command printed on
                        // its way out *is* the explanation.
                        final = .failed(
                            reason: Self.failureReason(
                                exitCode: status,
                                wasSignal: wasSignal,
                                recent: snapshot.recent
                            )
                        )
                    } else if wasSignal {
                        final = .failed(
                            reason: "The development server was terminated by signal \(status)."
                        )
                    } else {
                        final = .exited(code: status)
                    }
                    self.forget(run)
                    continuation.yield(.state(final))
                    continuation.finish()
                }
            }

            continuation.onTermination = { termination in
                // The consumer went away. Nothing is watching this server any
                // more, so it must not keep running.
                guard case .cancelled = termination else { return }
                run.markStopRequested()
                run.cancelSilenceNotice()
                run.cancelReadinessProbe()
                run.terminateGroup()
            }

            do {
                // Launch before publishing `.starting`, so a replacement start
                // that reacts to it always finds a pid and a group to stop.
                try process.run()
                run.didLaunch()
                continuation.yield(.state(.starting))
                run.startReadinessProbe(emit: emit)
            } catch {
                run.cancelSilenceNotice()
                run.cancelReadinessProbe()
                try? stdoutPipe.fileHandleForWriting.close()
                try? stderrPipe.fileHandleForWriting.close()
                termination.finishAfterDrain {
                    for channel in [ToolOutputChannel.stdout, .stderr] {
                        for line in run.flush(channel: channel) {
                            continuation.yield(.line(line))
                        }
                    }
                    self.forget(run)
                    continuation.yield(
                        .state(.failed(reason: "\(commandLine) could not be launched: \(error.localizedDescription)"))
                    )
                    continuation.finish()
                }
            }
        }
    }

    /// `juno:static` serves the working directory; `juno:static <folder>`
    /// serves that folder inside it (PV-16).
    private func staticStream(commandLine: String, launch: DevServerLaunch) -> AsyncStream<DevServerEvent> {
        AsyncStream(bufferingPolicy: .bufferingNewest(4_096)) { continuation in
            let argument = commandLine.dropFirst("juno:static".count).trimmingCharacters(in: .whitespaces)
            let root = argument.isEmpty
                ? launch.workingDirectory
                : launch.workingDirectory.appendingPathComponent(argument, isDirectory: true)
            let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
            let canonicalBase = launch.workingDirectory.resolvingSymlinksInPath().standardizedFileURL
            guard canonicalRoot.path == canonicalBase.path || canonicalRoot.path.hasPrefix(canonicalBase.path + "/") else {
                continuation.yield(.state(.failed(reason: "The static folder \(argument) is outside the workspace.")))
                continuation.finish()
                return
            }
            do {
                let server = try StaticPreviewServer(staticRootURL: canonicalRoot)
                self.lock.lock()
                self.staticServer = server
                self.lock.unlock()

                continuation.yield(.state(.starting))
                continuation.yield(.line(DevServerLogLine(
                    id: 1,
                    channel: .stdout,
                    text: "Juno Static Preview serving \(canonicalRoot.path) at \(server.url.absoluteString)"
                )))
                continuation.yield(.state(.running(server.url)))

                continuation.onTermination = { [weak self] _ in
                    self?.stopStaticServer()
                }
            } catch {
                continuation.yield(
                    .state(.failed(reason: "Could not start Juno static preview server: \(error.localizedDescription)"))
                )
                continuation.finish()
            }
        }
    }

    /// Stops the running server, if there is one.
    ///
    /// Signals the process group rather than the process: `zsh -c "npm run dev"`
    /// makes at least three processes, and killing only the shell leaves the node
    /// server holding the port.
    public func stop() {
        stopStaticServer()
        _ = requestStop()
    }

    /// Stops the running server and waits until its group is gone, off the
    /// caller's actor.
    public func stopAndWaitAsync() async {
        await Task.detached(priority: .userInitiated) { [self] in
            stopAndWait()
        }.value
    }

    private func stopStaticServer() {
        lock.lock()
        let server = staticServer
        staticServer = nil
        lock.unlock()
        server?.stop()
    }

    private func stopAndWait() {
        stopStaticServer()
        guard let current = requestStop() else { return }
        _ = current.waitForCleanup(timeout: Self.cleanupWaitTimeout)
        if !current.waitForCleanup(timeout: 0) {
            current.forceKillGroup()
            _ = current.waitForCleanup(timeout: Self.drainTimeout)
        }
        forget(current)
    }

    private func requestStop() -> DevServerRun? {
        lock.lock()
        let current = run
        lock.unlock()
        guard let current else { return nil }
        // Recorded before the signal so the termination handler reports `.stopped`
        // rather than mistaking a requested stop for a crash.
        current.markStopRequested()
        current.cancelSilenceNotice()
        current.cancelReadinessProbe()
        current.terminateGroup()
        return current
    }

    private func forget(_ finished: DevServerRun) {
        lock.lock()
        if run === finished { run = nil }
        lock.unlock()
    }

    // MARK: - Environment

    /// Variables a configuration's `env` may not replace: the scrubbed
    /// environment's own guarantees.
    static let protectedEnvironmentNames: Set<String> = ["HOME", "TMPDIR", "PWD", "USER", "LOGNAME", "SHELL"]

    /// The command executor's scrubbed environment, plus the two variables that
    /// stop a dev server from taking over the reader's machine.
    static func serverEnvironment(workspaceRoot: String) -> [String: String] {
        var environment = CommandExecutionService.minimalEnvironment(
            workspaceRoot: workspaceRoot
        )
        // Create React App and `vite --open` launch the default browser on start.
        environment["BROWSER"] = "none"
        // Belt and braces with NO_COLOR: several tools honour only one of them.
        environment["FORCE_COLOR"] = "0"
        return environment
    }

    // MARK: - Helpers

    /// The reason a command that was supposed to serve something did not: the
    /// command's own output, verbatim, plus one note when the scrubbed `PATH`
    /// is the likely cause.
    static func failureReason(
        exitCode: Int32,
        wasSignal: Bool,
        recent: [String]
    ) -> String {
        var parts: [String] = [
            wasSignal
                ? "Terminated by signal \(exitCode) without serving an address."
                : "Exited with code \(exitCode) without serving an address.",
        ]
        let tail = recent.suffix(12).filter {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if !tail.isEmpty {
            parts.append(tail.joined(separator: "\n"))
        }
        if recent.contains(where: {
            $0.contains("command not found") || $0.contains("not recognized")
        }) {
            parts.append(
                "Juno runs commands with a scrubbed PATH (\(ToolchainEnvironment.defaultBasePATH) and standard user toolchain shims). A toolchain installed by nvm, asdf or mise is searched automatically."
            )
        }
        return parts.joined(separator: "\n\n")
    }
}

/// Owns the one-shot completion gate for one server run.
private final class DevServerTermination: @unchecked Sendable {
    private let drainGroup: DispatchGroup
    private let drainTimeout: TimeInterval
    private let completion = DispatchGroup()
    private let lock = NSLock()
    private var didFinish = false

    init(drainGroup: DispatchGroup, drainTimeout: TimeInterval) {
        self.drainGroup = drainGroup
        self.drainTimeout = drainTimeout
        completion.enter()
    }

    func finishAfterDrain(
        onTimeout: @escaping @Sendable () -> Void = {},
        _ action: @escaping @Sendable () -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            if drainGroup.wait(timeout: .now() + drainTimeout) == .timedOut {
                onTimeout()
            }
            finishOnce(action)
        }
    }

    func wait(timeout: TimeInterval) -> Bool {
        completion.wait(timeout: .now() + timeout) == .success
    }

    private func finishOnce(_ action: @escaping @Sendable () -> Void) {
        lock.lock()
        guard !didFinish else {
            lock.unlock()
            return
        }
        didFinish = true
        lock.unlock()

        action()
        completion.leave()
    }
}

/// Refuses redirects, so a readiness probe never follows a loopback server's
/// redirect to another host.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// One server's mutable state, shared between the two drain queues, the
/// readiness probe, the termination handler and `stop()`.
private final class DevServerRun: @unchecked Sendable {
    let command: String

    private let process: Process
    private let redactor: SecretRedactor
    private let termination: DevServerTermination
    private let processGroupKillDelay: TimeInterval
    private let expectedPort: Int?
    private let readyPath: String
    private let lock = NSLock()
    private var nextLineID = 0
    private var partials: [ToolOutputChannel: String] = [:]
    /// Every distinct address printed so far, in order.
    private var candidates: [URL] = []
    private var printedURL: URL?
    private var recent: [String] = []
    private var stopRequested = false
    private var silenceNotice: Task<Void, Never>?
    private var readinessProbe: Task<Void, Never>?
    private var didPublishHTTPReady = false
    private var processGroupID: Int32 = 0
    private var didSignalProcessGroup = false
    private var notedForeignPorts: Set<Int> = []
    private var launchedAt = Date()

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 0.75
        configuration.connectionProxyDictionary = [:]
        return URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }()

    /// A minified bundle or a base64 payload printed to stdout arrives as one
    /// enormous "line"; past this it is truncated rather than held whole.
    private static let maximumLineLength = 4_096
    /// Enough context to explain a failure without keeping the whole session.
    private static let retainedLineCount = 40

    init(
        process: Process,
        command: String,
        redactor: SecretRedactor,
        termination: DevServerTermination,
        processGroupKillDelay: TimeInterval,
        expectedPort: Int?,
        readyPath: String
    ) {
        self.process = process
        self.command = command
        self.redactor = redactor
        self.termination = termination
        self.processGroupKillDelay = processGroupKillDelay
        self.expectedPort = expectedPort
        self.readyPath = readyPath.hasPrefix("/") ? readyPath : "/" + readyPath
    }

    var isReady: Bool {
        lock.lock()
        defer { lock.unlock() }
        return didPublishHTTPReady
    }

    var isProcessRunning: Bool {
        process.isRunning
    }

    var identity: (pgid: Int32, pid: Int32)? {
        lock.lock()
        defer { lock.unlock() }
        guard processGroupID > 0 else { return nil }
        return (processGroupID, process.processIdentifier)
    }

    func didLaunch() {
        lock.lock()
        processGroupID = process.processIdentifier
        launchedAt = Date()
        let shouldTerminate = stopRequested
        lock.unlock()
        if shouldTerminate { terminateGroup() }
    }

    /// The whole process group, not the process.
    func terminateGroup() {
        lock.lock()
        if processGroupID == 0 {
            processGroupID = process.processIdentifier
        }
        let groupID = processGroupID
        guard groupID > 0, !didSignalProcessGroup else {
            lock.unlock()
            return
        }
        didSignalProcessGroup = true
        lock.unlock()

        _ = kill(-groupID, SIGTERM)
        DispatchQueue.global(qos: .userInitiated).asyncAfter(
            deadline: .now() + processGroupKillDelay
        ) { [weak self] in
            self?.forceKillGroup(groupID: groupID)
        }
    }

    func forceKillGroup() {
        lock.lock()
        if processGroupID == 0 {
            processGroupID = process.processIdentifier
        }
        let groupID = processGroupID
        lock.unlock()
        forceKillGroup(groupID: groupID)
    }

    private func forceKillGroup(groupID: Int32) {
        guard groupID > 0 else { return }
        _ = kill(-groupID, SIGKILL)
    }

    func setSilenceNotice(_ task: Task<Void, Never>) {
        lock.lock()
        silenceNotice = task
        lock.unlock()
    }

    func cancelSilenceNotice() {
        lock.lock()
        let task = silenceNotice
        silenceNotice = nil
        lock.unlock()
        task?.cancel()
    }

    // MARK: - Readiness

    /// One loop for the life of the process: it looks at the candidates, checks
    /// which port the group owns, and asks it for a page.
    func startReadinessProbe(emit: @escaping @Sendable (DevServerEvent) -> Void) {
        lock.lock()
        guard !stopRequested, readinessProbe == nil else {
            lock.unlock()
            return
        }
        let task: Task<Void, Never> = Task { [weak self] in
            await self?.probeUntilReady(emit: emit)
        }
        readinessProbe = task
        lock.unlock()
    }

    func cancelReadinessProbe() {
        lock.lock()
        let task = readinessProbe
        readinessProbe = nil
        lock.unlock()
        task?.cancel()
    }

    private func probeUntilReady(emit: @escaping @Sendable (DevServerEvent) -> Void) async {
        while !Task.isCancelled {
            guard process.isRunning, !isStopRequested else { return }
            if let ready = await findReadyURL(emit: emit) {
                guard markHTTPReady() else { return }
                emit(.state(.running(ready)))
                return
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
    }

    /// The first candidate the group owns and that answers HTTP.
    private func findReadyURL(emit: @escaping @Sendable (DevServerEvent) -> Void) async -> URL? {
        let (group, printed, sinceLaunch) = probeInputs()
        guard group > 0 else { return nil }
        let sockets = ListeningSocketOwnership.listeningSockets(inProcessGroup: group)

        var candidates: [URL] = []
        if let expectedPort {
            candidates = [Self.loopbackURL(port: expectedPort)]
        } else {
            candidates = printed
            // A server that prints nothing usable: the ports its group
            // listens on are the truth.
            if candidates.isEmpty, sinceLaunch > 1.5 {
                candidates = Array(Set(sockets.filter(\.isReachableOnLoopback).map(\.port)))
                    .sorted()
                    .map(Self.loopbackURL(port:))
            }
        }

        for candidate in candidates {
            guard let port = candidate.port ?? DevServerRun.defaultPort(candidate) else { continue }
            let owned = sockets.filter { $0.port == port }
            guard !owned.isEmpty else {
                noteForeignIfNeeded(candidate, port: port, sinceLaunch: sinceLaunch, groupListens: !sockets.isEmpty, emit: emit)
                continue
            }
            let url: URL
            if owned.contains(where: \.isReachableOnLoopback) {
                url = Self.loopbackOrigin(for: candidate, port: port)
            } else {
                // Bound to a LAN interface only: the reader can open it, the
                // agent's loopback-only browser cannot (PV-9).
                noteLANOnly(candidate, port: port, emit: emit)
                url = candidate
            }
            if await answersHTTP(url) { return url }
        }
        return nil
    }

    private func probeInputs() -> (Int32, [URL], TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        return (processGroupID, candidates, Date().timeIntervalSince(launchedAt))
    }

    private func answersHTTP(_ origin: URL) async -> Bool {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return false }
        components.path = readyPath
        guard let url = components.url else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 0.75
        do {
            let (_, response) = try await Self.session.data(for: request)
            return response is HTTPURLResponse
        } catch {
            return false
        }
    }

    private func noteForeignIfNeeded(
        _ candidate: URL,
        port: Int,
        sinceLaunch: TimeInterval,
        groupListens: Bool,
        emit: @Sendable (DevServerEvent) -> Void
    ) {
        // Give a server a moment between printing and binding; once its group
        // listens elsewhere, or a few seconds pass, the address is not its own.
        guard groupListens || sinceLaunch > 4 else { return }
        lock.lock()
        let isNew = notedForeignPorts.insert(port).inserted
        lock.unlock()
        guard isNew else { return }
        let owner = ListeningSocketOwnership.owner(ofPort: port).map { " It belongs to \($0.sentence)." } ?? ""
        emit(.line(note(
            "Juno is not using \(candidate.absoluteString): no process of this server listens on port \(port).\(owner)"
        )))
    }

    private func noteLANOnly(_ candidate: URL, port: Int, emit: @Sendable (DevServerEvent) -> Void) {
        lock.lock()
        let isNew = notedForeignPorts.insert(-port).inserted
        lock.unlock()
        guard isNew else { return }
        emit(.line(note(
            "This server listens on \(candidate.host ?? "a LAN address") only, so Juno's agent cannot use it. Bind it to 127.0.0.1 or 0.0.0.0 to let Juno check the page."
        )))
    }

    static func loopbackURL(port: Int) -> URL {
        URL(string: "http://localhost:\(port)/")!
    }

    /// The candidate's origin on loopback: a LAN or wildcard host becomes
    /// `localhost`; a printed `127.0.0.1` stays as printed.
    static func loopbackOrigin(for candidate: URL, port: Int) -> URL {
        var components = URLComponents()
        components.scheme = candidate.scheme ?? "http"
        let host = candidate.host ?? "localhost"
        components.host = PreviewOrigin.isLoopbackHost(host) ? host : "localhost"
        components.port = port
        components.path = "/"
        return components.url ?? loopbackURL(port: port)
    }

    static func defaultPort(_ url: URL) -> Int? {
        switch url.scheme?.lowercased() {
        case "http": 80
        case "https": 443
        default: nil
        }
    }

    private var isStopRequested: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopRequested
    }

    private func markHTTPReady() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !stopRequested, !didPublishHTTPReady, process.isRunning else { return false }
        didPublishHTTPReady = true
        return true
    }

    // MARK: - Output

    /// Splits `data` into complete lines, holding any trailing fragment until
    /// the rest of it arrives.
    func ingest(_ data: Data, channel: ToolOutputChannel) -> [DevServerLogLine] {
        guard let text = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin1)
        else { return [] }

        lock.lock()
        defer { lock.unlock() }
        var buffer = (partials[channel] ?? "") + text
        var completed: [String] = []
        while let breakIndex = buffer.firstIndex(of: "\n") {
            completed.append(String(buffer[buffer.startIndex..<breakIndex]))
            buffer = String(buffer[buffer.index(after: breakIndex)...])
        }
        if buffer.count > Self.maximumLineLength {
            completed.append(String(buffer.prefix(Self.maximumLineLength)) + " …")
            buffer = ""
        }
        partials[channel] = buffer
        return completed.map { makeLine($0, channel: channel) }
    }

    /// The last fragment, when a process exits without a trailing newline.
    func flush(channel: ToolOutputChannel) -> [DevServerLogLine] {
        lock.lock()
        defer { lock.unlock() }
        guard let remainder = partials[channel], !remainder.isEmpty else { return [] }
        partials[channel] = ""
        return [makeLine(remainder, channel: channel)]
    }

    /// A line Juno wrote itself, marked `.log` so the view can tint it as
    /// commentary and never mistake it for the server's own output.
    func note(_ text: String) -> DevServerLogLine {
        lock.lock()
        defer { lock.unlock() }
        let id = nextLineID
        nextLineID += 1
        return DevServerLogLine(id: id, channel: .log, text: text)
    }

    func markStopRequested() {
        lock.lock()
        stopRequested = true
        lock.unlock()
    }

    func waitForCleanup(timeout: TimeInterval) -> Bool {
        termination.wait(timeout: timeout)
    }

    func snapshot() -> (printedURL: URL?, wasReady: Bool, stopRequested: Bool, recent: [String]) {
        lock.lock()
        defer { lock.unlock() }
        return (printedURL, didPublishHTTPReady, stopRequested, recent)
    }

    /// Caller holds the lock.
    private func makeLine(_ raw: String, channel: ToolOutputChannel) -> DevServerLogLine {
        let cleaned = redactor.redact(DevServerOutputSanitizer.sanitize(raw))
        let id = nextLineID
        nextLineID += 1
        recent.append(cleaned)
        if recent.count > Self.retainedLineCount {
            recent.removeFirst(recent.count - Self.retainedLineCount)
        }
        // Every printed address is a candidate; none wins by printing first.
        for detected in DevServerURLDetector.detectAll(in: cleaned) {
            if printedURL == nil { printedURL = detected }
            if !candidates.contains(where: { $0.port == detected.port && $0.host == detected.host }) {
                candidates.append(detected)
            }
        }
        return DevServerLogLine(id: id, channel: channel, text: cleaned)
    }
}
