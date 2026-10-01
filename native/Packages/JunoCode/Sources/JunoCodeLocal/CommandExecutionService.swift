import Foundation
import JunoCodeCore

/// Local subprocess execution with a scrubbed environment, streamed bounded
/// output, wall-clock timeout, and process-group termination.
public final class CommandExecutionService: DirectoryScopedCommandExecuting, Sendable {
    private let workspaceRootURL: URL
    private let classifier = CommandClassifier()
    private let redactor = SecretRedactor()
    /// Kernel-enforced containment, or nil in developer mode.
    ///
    /// Nil means commands run with the app's own file access and network
    /// reachability. That is a real and clearly-labelled choice, not a default:
    /// the classifier above works on the *text* of a command and can be spelled
    /// around, so without a profile there is no boundary at all.
    private let sandbox: CommandSandboxProfile?
    /// Settings-driven variables and network access, read per command.
    private let overrides: CommandRuntimeOverrides?

    public init(
        workspaceRootURL: URL,
        sandbox: CommandSandboxProfile? = nil,
        overrides: CommandRuntimeOverrides? = nil
    ) {
        self.workspaceRootURL = workspaceRootURL
        self.sandbox = sandbox
        self.overrides = overrides
    }

    /// Creates a contained executor: writes confined to the workspace, with
    /// network and localhost reachability selected explicitly by the caller.
    ///
    /// Falls back to unconfined execution when `sandbox-exec` is unavailable,
    /// and says so through `isContained` rather than pretending — a caller
    /// showing a "sandboxed" badge must be able to tell the difference.
    public static func contained(
        workspaceRootURL: URL,
        allowsNetwork: Bool = false,
        allowsLocalhost: Bool = false,
        additionalWritablePaths: [String] = [],
        overrides: CommandRuntimeOverrides? = nil
    ) -> CommandExecutionService {
        guard CommandSandboxProfile.isAvailable else {
            return CommandExecutionService(workspaceRootURL: workspaceRootURL, overrides: overrides)
        }
        return CommandExecutionService(
            workspaceRootURL: workspaceRootURL,
            sandbox: CommandSandboxProfile(
                workspaceRoot: workspaceRootURL,
                filesystem: .readWrite,
                allowsNetwork: allowsNetwork,
                allowsLocalhost: allowsLocalhost,
                additionalWritablePaths: CommandSandboxProfile.defaultWritablePaths
                    + CommandSandboxProfile.toolchainCachePaths
                    + additionalWritablePaths
            ),
            overrides: overrides
        )
    }

    /// The profile for the next command: the base one, with the reader's
    /// network choice and extra writable folders applied.
    private var effectiveSandbox: CommandSandboxProfile? {
        guard let sandbox else { return nil }
        guard let overrides else { return sandbox }
        return CommandSandboxProfile(
            workspaceRoot: sandbox.workspaceRoot,
            filesystem: sandbox.filesystem,
            allowsNetwork: sandbox.allowsNetwork && overrides.allowsNetwork,
            allowsLocalhost: sandbox.allowsLocalhost,
            additionalWritablePaths: sandbox.additionalWritablePaths + overrides.writablePaths,
            protectsPolicyFiles: sandbox.protectsPolicyFiles,
            homeDirectory: sandbox.homeDirectory,
            protectsCredentials: sandbox.protectsCredentials
        )
    }

    /// Whether commands from this executor are kernel-confined.
    public var isContained: Bool { sandbox != nil }

    /// Everything a process needs to run a command under this executor's
    /// rules: the sandbox wrapper, the scrubbed environment with the reader's
    /// variables, and the folder it runs in.
    ///
    /// The one place those rules are applied, so a command run to completion
    /// here and a long-lived one started by ``ShellSessionManager`` cannot
    /// drift apart in what they may reach.
    public struct PreparedCommand: Sendable {
        public let executableURL: URL
        public let arguments: [String]
        public let environment: [String: String]
        public let currentDirectoryURL: URL
    }

    /// - Throws: `CommandExecutionError.forbidden` for a command the
    ///   classifier refuses, `ShellSessionError.invalidWorkingDirectory` for a
    ///   folder that is not one inside the workspace.
    public func prepare(
        _ commandLine: String,
        workingDirectory: WorkspacePath? = nil,
        additionalEnvironment: [String: String] = [:]
    ) throws -> PreparedCommand {
        // Defense in depth: the runtime checks the classifier before
        // proposing the command; refuse forbidden commands here too.
        if case let .forbidden(reason) = classifier.classify(commandLine) {
            throw CommandExecutionError.forbidden(reason: reason)
        }
        let directory = try resolve(workingDirectory)
        let sandbox = effectiveSandbox
        // Under a profile the kernel enforces the workspace boundary; the
        // shell is still zsh, wrapped rather than replaced, so a command
        // behaves identically right up to the point it tries to leave.
        let invocation = sandbox?.wrap(command: commandLine)
            ?? (executable: "/bin/zsh", arguments: ["-c", commandLine])
        var environment = Self.minimalEnvironment(workspaceRoot: directory.path)
        if let sandbox, sandbox.grantsCommandCache {
            // Tools that would write binaries, configuration or extracted
            // sources into the reader's own folders use Juno's instead,
            // which the profile leaves writable and the reader's shell
            // never builds from. Made here, not by the command: the folder
            // above it is not the command's to write, and a cache cleaner
            // may have removed it since the last run.
            try? FileManager.default.createDirectory(
                atPath: CommandSandboxProfile.commandCacheRoot(homeDirectory: sandbox.homeDirectory),
                withIntermediateDirectories: true
            )
            environment.merge(
                CommandSandboxProfile.commandCacheEnvironment(homeDirectory: sandbox.homeDirectory)
            ) { _, juno in juno }
        }
        // The reader's own variables win over the defaults, except the two
        // that would move the command out of its workspace or its toolchain.
        for (name, value) in overrides?.environment ?? [:]
        where name != "PWD" && name != "HOME" {
            environment[name] = value
        }
        for (name, value) in additionalEnvironment {
            environment[name] = value
        }
        return PreparedCommand(
            executableURL: URL(fileURLWithPath: invocation.executable),
            arguments: invocation.arguments,
            environment: environment,
            currentDirectoryURL: directory
        )
    }

    public func validateWorkingDirectory(_ directory: WorkspacePath) throws {
        _ = try resolve(directory)
    }

    /// The folder a command runs in: the root, or a folder inside it with
    /// every link resolved, so a link cannot start a command outside.
    private func resolve(_ directory: WorkspacePath?) throws -> URL {
        guard let directory else { return workspaceRootURL }
        let root = workspaceRootURL.resolvingSymlinksInPath().standardizedFileURL.path
        let url = workspaceRootURL.appendingPathComponent(directory.value, isDirectory: true)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let prefix = root.hasSuffix("/") ? root : root + "/"
        guard url.path == root || url.path.hasPrefix(prefix) else {
            throw ShellSessionError.invalidWorkingDirectory("\(directory.value) leads outside the workspace.")
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw ShellSessionError.invalidWorkingDirectory("\(directory.value) does not exist.")
        }
        guard isDirectory.boolValue else {
            throw ShellSessionError.invalidWorkingDirectory("\(directory.value) is a file, not a folder.")
        }
        return url
    }

    public func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit,
        workingDirectory: WorkspacePath?
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        stream(
            commandLine,
            timeoutSeconds: timeoutSeconds,
            outputLimit: outputLimit,
            standardInput: nil,
            additionalEnvironment: [:],
            workingDirectory: workingDirectory
        )
    }

    public func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        stream(
            commandLine,
            timeoutSeconds: timeoutSeconds,
            outputLimit: outputLimit,
            standardInput: nil,
            additionalEnvironment: [:]
        )
    }

    /// Runs a command that reads its input from standard input — a hook,
    /// which is handed its event as JSON — with a few variables of its own.
    ///
    /// - Parameters:
    ///   - standardInput: Written to the command and then closed, so a reader
    ///     of stdin sees end-of-file. Nil connects stdin to /dev/null, as for
    ///     every agent command.
    ///   - additionalEnvironment: Set after the reader's own variables, so a
    ///     settings file cannot redirect a hook's project folder.
    public func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit,
        standardInput: Data?,
        additionalEnvironment: [String: String],
        workingDirectory: WorkspacePath? = nil
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        AsyncThrowingStream { continuation in
            let prepared: PreparedCommand
            do {
                prepared = try prepare(
                    commandLine,
                    workingDirectory: workingDirectory,
                    additionalEnvironment: additionalEnvironment
                )
            } catch {
                continuation.finish(throwing: error)
                return
            }

            let process = Process()
            process.executableURL = prepared.executableURL
            process.arguments = prepared.arguments
            process.currentDirectoryURL = prepared.currentDirectoryURL
            process.environment = prepared.environment

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe
            let stdinPipe = standardInput.map { _ in Pipe() }
            if let stdinPipe {
                process.standardInput = stdinPipe
            } else {
                process.standardInput = FileHandle.nullDevice
            }

            let state = ExecutionState(limitBytes: outputLimit.maximumBytes)
            let startedAt = DispatchTime.now()
            let redactor = self.redactor

            // Blocking readers on background queues. Each drains its pipe to
            // EOF, so no output can be lost when the process exits quickly;
            // completion waits for both via the group.
            let drainGroup = DispatchGroup()
            for (handle, isStdout) in [
                (stdoutPipe.fileHandleForReading, true),
                (stderrPipe.fileHandleForReading, false),
            ] {
                drainGroup.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    defer { drainGroup.leave() }
                    while true {
                        let data = handle.availableData
                        guard !data.isEmpty else { return }
                        if let text = Self.consume(data, state: state, redactor: redactor) {
                            continuation.yield(isStdout ? .stdout(text) : .stderr(text))
                        }
                        if state.markTruncatedIfNeeded() {
                            Self.terminateProcessGroup(of: process)
                        }
                    }
                }
            }

            let timeoutTask: Task<Void, Never>? = timeoutSeconds > 0
                ? Task {
                    try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                    guard !Task.isCancelled else { return }
                    state.markTimeout()
                    Self.terminateProcessGroup(of: process)
                }
                : nil

            process.terminationHandler = { finished in
                timeoutTask?.cancel()
                let exitCode = finished.terminationStatus
                // Wait for both pipes to reach EOF before completing, so no
                // output is ever dropped behind the completion event.
                drainGroup.notify(queue: .global(qos: .userInitiated)) {
                    let elapsed = Double(
                        DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds
                    ) / 1_000_000_000
                    let snapshot = state.snapshot()
                    continuation.yield(
                        .completed(
                            CommandResult(
                                exitCode: exitCode,
                                wasTimeout: snapshot.timedOut,
                                wasCancelled: snapshot.cancelled,
                                wasTruncated: snapshot.truncated,
                                durationSeconds: elapsed
                            )
                        )
                    )
                    continuation.finish()
                }
            }

            continuation.onTermination = { termination in
                if case .cancelled = termination {
                    state.markCancelled()
                    timeoutTask?.cancel()
                    Self.terminateProcessGroup(of: process)
                }
            }

            do {
                try process.run()
            } catch {
                timeoutTask?.cancel()
                // Unblock the drain readers before finishing.
                try? stdoutPipe.fileHandleForWriting.close()
                try? stderrPipe.fileHandleForWriting.close()
                try? stdinPipe?.fileHandleForWriting.close()
                continuation.finish(
                    throwing: CommandExecutionError.launchFailed(
                        message: String(describing: error)
                    )
                )
                return
            }

            // Written off the caller's thread: a payload larger than the pipe
            // buffer blocks until the command reads it, and a command that
            // never reads it blocks the writer until the command exits or its
            // timeout kills it.
            if let stdinPipe, let standardInput {
                let handle = stdinPipe.fileHandleForWriting
                DispatchQueue.global(qos: .userInitiated).async {
                    Self.writeAll(standardInput, to: handle.fileDescriptor)
                    try? handle.close()
                }
            }
        }
    }

    /// Writes every byte it can, stopping quietly when the reader goes away.
    ///
    /// A hook that exits without reading its input closes the pipe, and a
    /// plain write to a closed pipe raises SIGPIPE, whose default action
    /// would take the whole app down with it. The descriptor is told not to
    /// signal, so that case becomes an EPIPE error, which simply ends the
    /// write.
    private static func writeAll(_ data: Data, to descriptor: Int32) {
        _ = fcntl(descriptor, F_SETNOSIGPIPE, 1)
        data.withUnsafeBytes { buffer in
            guard var pointer = buffer.baseAddress else { return }
            var remaining = buffer.count
            while remaining > 0 {
                let written = Darwin.write(descriptor, pointer, remaining)
                if written > 0 {
                    pointer += written
                    remaining -= written
                } else if written < 0, errno == EINTR {
                    continue
                } else {
                    return
                }
            }
        }
    }

    // MARK: - Environment

    /// A fresh minimal environment. Nothing is inherited from the app
    /// process, so account tokens and provider keys can never leak into
    /// child processes.
    public static func minimalEnvironment(workspaceRoot: String) -> [String: String] {
        var environment: [String: String] = [
            "PATH": ToolchainEnvironment.resolvedPATH(),
            "HOME": NSHomeDirectory(),
            "TMPDIR": NSTemporaryDirectory(),
            "LANG": "en_US.UTF-8",
            "TERM": "dumb",
            "PWD": workspaceRoot,
            "NO_COLOR": "1",
        ]
        // Keep the toolchain selection working inside the child.
        if let developerDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"],
           !SecretRedactor.isSensitiveEnvironmentName("DEVELOPER_DIR")
        {
            environment["DEVELOPER_DIR"] = developerDir
        }
        return environment
    }

    // MARK: - Helpers

    private static func consume(
        _ data: Data,
        state: ExecutionState,
        redactor: SecretRedactor
    ) -> String? {
        guard let accepted = state.accept(byteCount: data.count) else { return nil }
        let slice = accepted < data.count ? data.prefix(accepted) : data
        guard let text = String(data: slice, encoding: .utf8)
            ?? String(data: slice, encoding: .isoLatin1)
        else { return nil }
        return redactor.redact(text)
    }

    private static func terminateProcessGroup(of process: Process) {
        guard process.isRunning else { return }
        let pid = process.processIdentifier
        // Process children are spawned in their own process group; negative
        // pid signals the whole group so grandchildren die too.
        kill(-pid, SIGTERM)
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            if process.isRunning {
                kill(-pid, SIGKILL)
            }
        }
    }
}

/// Thread-safe mutable state shared between pipe handlers, the timeout, and
/// the termination handler.
private final class ExecutionState: @unchecked Sendable {
    private let lock = NSLock()
    private let limitBytes: Int
    private var producedBytes = 0
    private var truncated = false
    private var truncationSignalled = false
    private var timedOut = false
    private var cancelled = false

    init(limitBytes: Int) {
        self.limitBytes = limitBytes
    }

    /// Returns how many bytes of this chunk may be emitted, or nil when the
    /// budget is already exhausted.
    func accept(byteCount: Int) -> Int? {
        lock.lock()
        defer { lock.unlock() }
        guard !truncated else { return nil }
        let remaining = limitBytes - producedBytes
        guard remaining > 0 else {
            truncated = true
            return nil
        }
        let accepted = min(byteCount, remaining)
        producedBytes += accepted
        if accepted < byteCount {
            truncated = true
        }
        return accepted
    }

    /// True exactly once, the first time the limit is crossed.
    func markTruncatedIfNeeded() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard truncated, !truncationSignalled else { return false }
        truncationSignalled = true
        return true
    }

    func markTimeout() {
        lock.lock()
        timedOut = true
        lock.unlock()
    }

    func markCancelled() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    func snapshot() -> (truncated: Bool, timedOut: Bool, cancelled: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (truncated, timedOut, cancelled)
    }
}
