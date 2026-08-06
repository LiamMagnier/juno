import Foundation
import JunoCodeCore

#if canImport(Darwin)
import Darwin
#endif

/// The lifecycle of a long-lived, user-owned terminal process.
public enum InteractiveTerminalState: Equatable, Sendable {
    case idle
    case starting
    case running(processID: Int32)
    case exited(code: Int32)
    case failed(reason: String)

    public var isRunning: Bool {
        switch self {
        case .starting, .running: true
        case .idle, .exited, .failed: false
        }
    }
}

public enum InteractiveTerminalEvent: Equatable, Sendable {
    case output(String)
    case state(InteractiveTerminalState)
}

/// A persistent PTY-backed shell for the console.
///
/// ``CommandExecutionService`` remains the right primitive for agent tools:
/// bounded, non-interactive and easy to audit. This service is deliberately a
/// separate capability for the reader: it keeps a real process group alive,
/// accepts stdin, honours terminal resize, and cleans up the entire group when
/// the session is stopped. Output is sanitized before it reaches SwiftUI, but
/// the PTY itself preserves programs that require a tty (watchers, REPLs and
/// interactive installers).
public final class InteractiveTerminalSession: @unchecked Sendable {
    private let lock = NSLock()
    private let workspaceRootURL: URL
    private let sandbox: CommandSandboxProfile?
    private let classifier = CommandClassifier()
    private let redactor = SecretRedactor()
    private var process: Process?
    private var masterFileDescriptor: Int32 = -1
    private var continuation: AsyncStream<InteractiveTerminalEvent>.Continuation?
    private var currentState: InteractiveTerminalState = .idle
    private var readSource: DispatchSourceRead?

    public init(
        workspaceRootURL: URL,
        sandbox: CommandSandboxProfile? = nil
    ) {
        self.workspaceRootURL = workspaceRootURL
        self.sandbox = sandbox
    }

    /// Creates an interactive shell with the same kernel boundary as local
    /// commands. Network is opt-in, matching the regular command and preview
    /// services.
    public static func contained(
        workspaceRootURL: URL,
        allowsNetwork: Bool = false
    ) -> InteractiveTerminalSession {
        guard CommandSandboxProfile.isAvailable else {
            return InteractiveTerminalSession(workspaceRootURL: workspaceRootURL)
        }
        return InteractiveTerminalSession(
            workspaceRootURL: workspaceRootURL,
            sandbox: CommandSandboxProfile(
                workspaceRoot: workspaceRootURL,
                filesystem: .readWrite,
                allowsNetwork: allowsNetwork
            )
        )
    }

    public var isContained: Bool { sandbox != nil }

    public var state: InteractiveTerminalState {
        lock.lock()
        defer { lock.unlock() }
        return currentState
    }

    deinit { stop() }

    /// Starts one command in a new interactive process group. Starting again
    /// first tears down the old process, so closing/reopening the drawer cannot
    /// leak a watcher in the background.
    public func start(
        command: String,
        columns: UInt16 = 120,
        rows: UInt16 = 32
    ) -> AsyncStream<InteractiveTerminalEvent> {
        stop()
        let commandLine = command.trimmingCharacters(in: .whitespacesAndNewlines)
        return AsyncStream(bufferingPolicy: .bufferingNewest(4_096)) { continuation in
            self.lock.lock()
            self.continuation = continuation
            self.currentState = .starting
            continuation.yield(.state(.starting))
            self.lock.unlock()
            continuation.onTermination = { [weak self] _ in
                self?.stop()
            }

            guard !commandLine.isEmpty else {
                self.fail("No command to run.", continuation: continuation)
                return
            }
            if case let .forbidden(reason) = self.classifier.classify(commandLine) {
                self.fail(reason, continuation: continuation)
                return
            }

            #if canImport(Darwin)
            self.launch(
                commandLine: commandLine,
                columns: columns,
                rows: rows,
                continuation: continuation
            )
            #else
            self.fail("Interactive terminals are only available on macOS.", continuation: continuation)
            #endif
        }
    }

    /// Writes literal input to the PTY. Callers append the newline themselves;
    /// this also supports control bytes such as Ctrl-C and arrow-key sequences.
    public func write(_ data: Data) {
        lock.lock()
        let descriptor = masterFileDescriptor
        let isRunning = process?.isRunning == true
        lock.unlock()
        guard descriptor >= 0, isRunning, !data.isEmpty else { return }
        data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            _ = Darwin.write(descriptor, baseAddress, bytes.count)
        }
    }

    public func write(_ text: String) {
        write(Data(text.utf8))
    }

    /// Resizes the pseudo-terminal so full-screen tools and line wrapping keep
    /// matching the visible drawer.
    public func resize(columns: UInt16, rows: UInt16) {
        #if canImport(Darwin)
        lock.lock()
        let descriptor = masterFileDescriptor
        lock.unlock()
        guard descriptor >= 0 else { return }
        var window = winsize(
            ws_row: rows,
            ws_col: columns,
            ws_xpixel: 0,
            ws_ypixel: 0
        )
        _ = ioctl(descriptor, TIOCSWINSZ, &window)
        #endif
    }

    /// Terminates the process group, closes the PTY and finishes the stream.
    public func stop() {
        lock.lock()
        let process = self.process
        let descriptor = masterFileDescriptor
        let source = readSource
        self.process = nil
        self.readSource = nil
        masterFileDescriptor = -1
        let shouldFinish = currentState.isRunning
        currentState = .idle
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()

        source?.cancel()
        if let process, process.isRunning {
            terminateProcessGroup(process)
        }
        // The dispatch source owns the descriptor once it has been installed;
        // its cancel handler closes it. Closing here as well could race with a
        // later file descriptor being reused by another process.
        if source == nil, descriptor >= 0 { close(descriptor) }
        if shouldFinish {
            continuation?.yield(.state(.idle))
        }
        continuation?.finish()
    }

    #if canImport(Darwin)
    private func launch(
        commandLine: String,
        columns: UInt16,
        rows: UInt16,
        continuation: AsyncStream<InteractiveTerminalEvent>.Continuation
    ) {
        let process = Process()
        let invocation = sandbox?.wrap(command: commandLine)
            ?? (executable: "/bin/zsh", arguments: ["-ilc", commandLine])
        process.executableURL = URL(fileURLWithPath: invocation.executable)
        process.arguments = invocation.arguments
        process.currentDirectoryURL = workspaceRootURL
        var environment = CommandExecutionService.minimalEnvironment(
            workspaceRoot: workspaceRootURL.path
        )
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        environment["COLUMNS"] = String(columns)
        environment["LINES"] = String(rows)
        environment["NO_COLOR"] = nil
        process.environment = environment

        var master: Int32 = -1
        var slave: Int32 = -1
        guard openpty(&master, &slave, nil, nil, nil) == 0 else {
            fail("Could not allocate a pseudo-terminal.", continuation: continuation)
            return
        }
        var window = winsize(
            ws_row: rows,
            ws_col: columns,
            ws_xpixel: 0,
            ws_ypixel: 0
        )
        _ = ioctl(slave, TIOCSWINSZ, &window)
        let slaveHandle = FileHandle(fileDescriptor: slave, closeOnDealloc: true)
        process.standardInput = slaveHandle
        process.standardOutput = slaveHandle
        process.standardError = slaveHandle
        process.terminationHandler = { [weak self] process in
            self?.didTerminate(process, continuation: continuation)
        }

        do {
            try process.run()
        } catch {
            close(master)
            fail(
                "Could not launch terminal: " + error.localizedDescription,
                continuation: continuation
            )
            return
        }

        lock.lock()
        self.process = process
        masterFileDescriptor = master
        currentState = .running(processID: process.processIdentifier)
        continuation.yield(.state(currentState))
        lock.unlock()

        let source = DispatchSource.makeReadSource(fileDescriptor: master, queue: .global(qos: .userInitiated))
        source.setEventHandler { [weak self] in
            self?.readOutput(from: master, continuation: continuation)
        }
        source.setCancelHandler {
            close(master)
        }
        lock.lock()
        readSource = source
        lock.unlock()
        source.resume()
    }

    private func readOutput(
        from descriptor: Int32,
        continuation: AsyncStream<InteractiveTerminalEvent>.Continuation
    ) {
        var buffer = [UInt8](repeating: 0, count: 16 * 1_024)
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        guard count > 0 else {
            if count < 0, errno == EAGAIN || errno == EINTR { return }
            readSource?.cancel()
            return
        }
        let raw = String(decoding: buffer.prefix(count), as: UTF8.self)
        let sanitized = redactor.redact(DevServerOutputSanitizer.sanitize(raw))
        if !sanitized.isEmpty { continuation.yield(.output(sanitized)) }
    }

    private func didTerminate(
        _ process: Process,
        continuation: AsyncStream<InteractiveTerminalEvent>.Continuation
    ) {
        lock.lock()
        let wasCurrent = self.process?.processIdentifier == process.processIdentifier
        if wasCurrent {
            self.process = nil
            self.masterFileDescriptor = -1
            self.currentState = .exited(code: process.terminationStatus)
            self.readSource?.cancel()
            self.readSource = nil
        }
        lock.unlock()
        guard wasCurrent else { return }
        continuation.yield(.state(.exited(code: process.terminationStatus)))
        continuation.finish()
    }

    private func terminateProcessGroup(_ process: Process) {
        let pid = process.processIdentifier
        if pid > 0 {
            _ = kill(-pid, SIGTERM)
            usleep(100_000)
            if process.isRunning { _ = kill(-pid, SIGKILL) }
        }
        if process.isRunning { process.terminate() }
    }
    #else
    private func terminateProcessGroup(_ process: Process) {}
    #endif

    private func fail(
        _ reason: String,
        continuation: AsyncStream<InteractiveTerminalEvent>.Continuation
    ) {
        lock.lock()
        currentState = .failed(reason: reason)
        self.continuation = nil
        lock.unlock()
        continuation.yield(.state(.failed(reason: reason)))
        continuation.finish()
    }
}
