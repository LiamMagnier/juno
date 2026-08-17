import Foundation
import JunoCodeCore

/// What the development server process is actually doing.
///
/// Every case is a fact about a real child process: `.running` carries the URL
/// the server itself printed, and it is unreachable until both a live process
/// and an observed address exist. There is no case meaning "a URL has been typed
/// somewhere", because a typed URL is not a running server.
public enum DevServerState: Equatable, Sendable {
    /// No process. The initial state, and the state after ``DevServerService/stop()``.
    case stopped
    /// The process is alive and has not yet printed an address.
    case starting
    /// The process is alive and told us where it is listening.
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
/// directory is pinned to the workspace root, the environment is built from
/// scratch so no account token can reach the child, output is redacted on the way
/// out, the classifier's refusals are honoured, and termination signals the whole
/// process group so a shell's grandchildren die with it.
///
/// One service instance owns at most one server. Starting a second stops the
/// first, so a window can never leak a process it has lost track of.
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
    /// The synchronous `start`/`stop` API waits for the old stream to finish, but
    /// still has a hard upper bound if a platform pipe or child misbehaves.
    private static let cleanupWaitTimeout: TimeInterval = 4.0
    /// Optional kernel containment for the long-lived child. The preview
    /// service cannot reuse the one-shot executor, but it should still inherit
    /// its filesystem and network boundary.
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

    /// Starts `command` in `workspaceRoot` and streams what happens to it.
    ///
    /// The stream never throws: a launch failure, a refusal and an immediate exit
    /// are all *states* the preview shows, not errors the caller has to translate
    /// into one. It ends when the process is gone; cancelling the consuming task
    /// terminates the process group, so closing the window stops the server.
    public func start(command: String, workspaceRoot: URL) -> AsyncStream<DevServerEvent> {
        // `start` is intentionally synchronous for API compatibility. Waiting
        // here is what makes a replacement safe: the previous process group and
        // its inherited pipes are cleaned up before a new server is launched.
        stopAndWait()

        let commandLine = command.trimmingCharacters(in: .whitespacesAndNewlines)

        if commandLine == DevServerCommand.staticPreviewCommandLine || commandLine.hasPrefix("juno:static") {
            return AsyncStream(bufferingPolicy: .bufferingNewest(4_096)) { continuation in
                do {
                    let server = try StaticPreviewServer(staticRootURL: workspaceRoot)
                    self.lock.lock()
                    self.staticServer = server
                    self.lock.unlock()

                    continuation.yield(.state(.starting))
                    let logLine = DevServerLogLine(
                        id: 1,
                        channel: .stdout,
                        text: "Juno Static Preview serving \(workspaceRoot.path) at \(server.url.absoluteString)"
                    )
                    continuation.yield(.line(logLine))
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

        let redactor = self.redactor
        let classifier = self.classifier

        // Bounded so a server in a rebuild loop cannot grow the buffer without
        // limit when the UI is busy; the newest output is the output that matters.
        // The consumer is a `for await` that only appends to an array, so the
        // buffer is never approached in practice — and if it ever were, a dropped
        // event leaves the preview showing "starting" with the address visible in
        // the log, which is understated rather than wrong.
        return AsyncStream(bufferingPolicy: .bufferingNewest(4_096)) { continuation in
            guard !commandLine.isEmpty else {
                continuation.yield(.state(.failed(reason: "No command to run.")))
                continuation.finish()
                return
            }
            // Defense in depth, exactly as in the command executor: the reader
            // chose this script from their own package.json, but the refusal list
            // does not depend on who asked.
            if case let .forbidden(reason) = classifier.classify(commandLine) {
                continuation.yield(.state(.failed(reason: reason)))
                continuation.finish()
                return
            }

            let invocation = sandbox?.wrap(command: commandLine)
                ?? (executable: "/bin/zsh", arguments: ["-c", commandLine])
            let process = Process()
            process.executableURL = URL(fileURLWithPath: invocation.executable)
            process.arguments = invocation.arguments
            process.currentDirectoryURL = workspaceRoot
            process.environment = Self.serverEnvironment(workspaceRoot: workspaceRoot.path)
            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe
            // No PTY and no input: this is a log surface, not a terminal. A dev
            // server that wants a keypress will wait forever, which is visible in
            // the log rather than hidden behind a stalled pipe.
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
                processGroupKillDelay: Self.processGroupKillDelay
            )
            self.lock.lock()
            self.run = run
            self.lock.unlock()

            let publishReadiness: @Sendable (URL) -> Void = { url in
                continuation.yield(.state(.running(url)))
            }

            for (handle, channel) in [
                (stdoutPipe.fileHandleForReading, ToolOutputChannel.stdout),
                (stderrPipe.fileHandleForReading, ToolOutputChannel.stderr),
            ] {
                drainGroup.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    defer {
                        let flushed = run.flush(channel: channel)
                        for line in flushed.lines {
                            continuation.yield(.line(line))
                        }
                        if let url = flushed.url {
                            run.startReadinessProbe(for: url, onReady: publishReadiness)
                        }
                        drainGroup.leave()
                    }
                    while true {
                        let data = handle.availableData
                        guard !data.isEmpty else { return }
                        let ingested = run.ingest(data, channel: channel)
                        for line in ingested.lines {
                            continuation.yield(.line(line))
                        }
                        if let url = ingested.url {
                            // A printed URL is only a hint. The process must still
                            // be alive and answer an HTTP request before it can
                            // become the public `.running` state.
                            run.startReadinessProbe(for: url, onReady: publishReadiness)
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
                          run.detectedURL == nil
                    else { return }
                    continuation.yield(
                        .line(
                            run.note(
                                "This process has not printed an address Juno recognises. If you know it, type it in the address field."
                            )
                        )
                    )
                }
            )

            process.terminationHandler = { finished in
                run.cancelSilenceNotice()
                run.cancelReadinessProbe()
                // The leader may already be gone by the time this callback runs.
                // Signal its recorded process group anyway so descendants that
                // inherited the pipes cannot keep the run alive.
                run.terminateGroup()
                let status = finished.terminationStatus
                // Reduced to a Bool here rather than captured: the enum crosses a
                // concurrency boundary into the notify block.
                let wasSignal = finished.terminationReason == .uncaughtSignal
                termination.finishAfterDrain(onTimeout: { run.forceKillGroup() }) {
                    // The normal reader path already flushed both channels. This
                    // second flush is the bounded-timeout path: it preserves a
                    // final unterminated URL/log fragment even if a descendant
                    // kept a pipe open after the leader exited.
                    for channel in [ToolOutputChannel.stdout, .stderr] {
                        let flushed = run.flush(channel: channel)
                        for line in flushed.lines {
                            continuation.yield(.line(line))
                        }
                    }
                    let snapshot = run.snapshot()
                    let final: DevServerState
                    if snapshot.stopRequested {
                        final = .stopped
                    } else if snapshot.url == nil {
                        // Nothing ever served: whatever the command printed on its
                        // way out *is* the explanation, so it is the reason.
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
                // The consumer went away — the window closed, or its task was
                // cancelled. Nothing is watching this server any more, so it must
                // not keep running.
                guard case .cancelled = termination else { return }
                run.markStopRequested()
                run.cancelSilenceNotice()
                run.cancelReadinessProbe()
                run.terminateGroup()
            }

            do {
                // Launch before publishing `.starting`. AsyncStream may resume
                // its iterator synchronously from `yield`; publishing first
                // allowed a replacement start to call `stop()` before the
                // process had a PID or a private process group to terminate.
                try process.run()
                run.didLaunch()
                continuation.yield(.state(.starting))
            } catch {
                run.cancelSilenceNotice()
                run.cancelReadinessProbe()
                // Unblock the drain readers before finishing, or they sit on a
                // pipe that will never see EOF.
                try? stdoutPipe.fileHandleForWriting.close()
                try? stderrPipe.fileHandleForWriting.close()
                termination.finishAfterDrain {
                    for channel in [ToolOutputChannel.stdout, .stderr] {
                        let flushed = run.flush(channel: channel)
                        for line in flushed.lines {
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

    /// Stops the running server, if there is one.
    ///
    /// Signals the process group rather than the process: `zsh -c "npm run dev"`
    /// makes at least three processes, and killing only the shell leaves the node
    /// server holding the port.
    public func stop() {
        stopStaticServer()
        _ = requestStop()
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
            // The normal escalation is scheduled by `terminateGroup`. This is a
            // final bounded fallback for a leader whose termination callback was
            // delayed by the platform.
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

    /// The command executor's scrubbed environment, plus the two variables that
    /// stop a dev server from taking over the reader's machine.
    ///
    /// Nothing is inherited from the app process — see
    /// ``CommandExecutionService/minimalEnvironment(workspaceRoot:)`` — which also
    /// means a toolchain installed by nvm, asdf or mise is not on `PATH`. When
    /// that is why a command fails, the failure reason says so.
    static func serverEnvironment(workspaceRoot: String) -> [String: String] {
        var environment = CommandExecutionService.minimalEnvironment(
            workspaceRoot: workspaceRoot
        )
        // Create React App and `vite --open` launch the default browser on start.
        // The preview *is* the browser here; a second window opening behind the
        // app is not something the reader asked for.
        environment["BROWSER"] = "none"
        // Belt and braces with NO_COLOR: several tools honour only one of them,
        // and this log pane interprets no escape sequences.
        environment["FORCE_COLOR"] = "0"
        return environment
    }

    // MARK: - Helpers

    /// The reason a command that was supposed to serve something did not.
    ///
    /// The command's own output, verbatim, because it is already the best
    /// explanation that exists: `sh: vite: command not found`, `Error: listen
    /// EADDRINUSE`, a stack trace. Juno adds one note, and only when the output
    /// shows the scrubbed `PATH` is the likely cause.
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
///
/// The process termination callback, stream cancellation, and launch failure can
/// all race. The gate is also what makes the drain wait bounded: a descendant
/// that inherited a pipe cannot prevent the stream from finishing forever.
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

/// One server's mutable state, shared between the two drain queues, the
/// termination handler and `stop()`.
///
/// There is deliberately no total output budget. The one-shot executor caps
/// output because a runaway command must not flood the transcript; a dev server
/// prints for as long as the reader works, and cutting it off at half a megabyte
/// would silence exactly the recompile errors the preview exists to show. What is
/// bounded instead is a single line's length, the buffer of lines kept for a
/// failure reason, and the stream itself.
private final class DevServerRun: @unchecked Sendable {
    let command: String

    private let process: Process
    private let redactor: SecretRedactor
    private let termination: DevServerTermination
    private let processGroupKillDelay: TimeInterval
    private let lock = NSLock()
    private var nextLineID = 0
    private var partials: [ToolOutputChannel: String] = [:]
    private var url: URL?
    private var recent: [String] = []
    private var stopRequested = false
    private var silenceNotice: Task<Void, Never>?
    private var readinessProbe: Task<Void, Never>?
    private var didPublishHTTPReady = false
    private var processGroupID: Int32 = 0
    private var didSignalProcessGroup = false

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
        processGroupKillDelay: TimeInterval
    ) {
        self.process = process
        self.command = command
        self.redactor = redactor
        self.termination = termination
        self.processGroupKillDelay = processGroupKillDelay
    }

    var detectedURL: URL? {
        lock.lock()
        defer { lock.unlock() }
        return url
    }

    var isProcessRunning: Bool {
        process.isRunning
    }

    func didLaunch() {
        lock.lock()
        processGroupID = process.processIdentifier
        let shouldTerminate = stopRequested
        lock.unlock()
        if shouldTerminate { terminateGroup() }
    }

    /// The whole process group, not the process: `zsh -c "npm run dev"` is a
    /// shell, a package manager and a server, and signalling only the shell
    /// leaves the server holding the port. `Process` spawns the child into its
    /// own group, so a negative pid reaches all three — the same mechanism
    /// ``CommandExecutionService`` uses on cancellation.
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

    /// Escalation intentionally does not inspect the leader. A process group can
    /// remain populated after its group leader has already been reaped.
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

    /// Written once at launch and cancelled from the termination handler, the
    /// stream's cancellation and `stop()` — three different threads, so it is
    /// behind the same lock as everything else here.
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

    func startReadinessProbe(
        for url: URL,
        onReady: @escaping @Sendable (URL) -> Void
    ) {
        lock.lock()
        guard !stopRequested,
              !didPublishHTTPReady,
              readinessProbe == nil,
              process.isRunning
        else {
            lock.unlock()
            return
        }
        let task: Task<Void, Never> = Task { [weak self] in
            guard let self else { return }
            await self.probeUntilHTTPReady(url: url, onReady: onReady)
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

    private func probeUntilHTTPReady(
        url: URL,
        onReady: @escaping @Sendable (URL) -> Void
    ) async {
        defer {
            clearReadinessProbe()
        }

        while !Task.isCancelled {
            guard process.isRunning, !isStopRequested else { return }

            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 0.75

            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                guard response is HTTPURLResponse else { return }
                guard markHTTPReady(url) else { return }
                onReady(url)
                return
            } catch {
                // A server may announce its port before it finishes compiling.
                // Keep polling while the process remains alive; the request
                // timeout and cancellation path bound each attempt.
            }

            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    private func clearReadinessProbe() {
        lock.lock()
        readinessProbe = nil
        lock.unlock()
    }

    private var isStopRequested: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopRequested
    }

    func markHTTPReady(_ url: URL) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !stopRequested,
              !didPublishHTTPReady,
              self.url == url,
              process.isRunning
        else { return false }
        didPublishHTTPReady = true
        return true
    }

    /// Splits `data` into complete lines, holding any trailing fragment until the
    /// rest of it arrives — a server's ready line and its URL frequently land in
    /// two different reads.
    func ingest(
        _ data: Data,
        channel: ToolOutputChannel
    ) -> (lines: [DevServerLogLine], url: URL?) {
        guard let text = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin1)
        else { return ([], nil) }

        lock.lock()
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

        var lines: [DevServerLogLine] = []
        var found: URL?
        for raw in completed {
            let line = makeLine(raw, channel: channel)
            lines.append(line)
            if url == nil, let detected = DevServerURLDetector.detect(in: line.text) {
                url = detected
                found = detected
            }
        }
        lock.unlock()
        return (lines, found)
    }

    /// The last fragment, when a process exits without a trailing newline — which
    /// is exactly how a crash message usually arrives.
    func flush(channel: ToolOutputChannel) -> (lines: [DevServerLogLine], url: URL?) {
        lock.lock()
        defer { lock.unlock() }
        guard let remainder = partials[channel], !remainder.isEmpty else {
            return ([], nil)
        }
        partials[channel] = ""
        let line = makeLine(remainder, channel: channel)
        // A short-lived server can print its complete ready line without a
        // trailing newline. It is still a real served address, so preserve that
        // fact before the termination handler snapshots the run; otherwise a
        // clean exit is incorrectly reported as "never served an address".
        var found: URL?
        if url == nil, let detected = DevServerURLDetector.detect(in: line.text) {
            url = detected
            found = detected
        }
        return ([line], found)
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

    func snapshot() -> (url: URL?, stopRequested: Bool, recent: [String]) {
        lock.lock()
        defer { lock.unlock() }
        return (url, stopRequested, recent)
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
        return DevServerLogLine(id: id, channel: channel, text: cleaned)
    }
}
