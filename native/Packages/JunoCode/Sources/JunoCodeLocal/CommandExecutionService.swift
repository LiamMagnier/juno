import Foundation
import JunoCodeCore

/// Local subprocess execution with a scrubbed environment, streamed bounded
/// output, wall-clock timeout, and process-group termination.
public final class CommandExecutionService: CommandExecuting, Sendable {
    private let workspaceRootURL: URL
    private let classifier = CommandClassifier()
    private let redactor = SecretRedactor()

    public init(workspaceRootURL: URL) {
        self.workspaceRootURL = workspaceRootURL
    }

    public func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        AsyncThrowingStream { continuation in
            // Defense in depth: the runtime checks the classifier before
            // proposing the command; refuse forbidden commands here too.
            if case let .forbidden(reason) = classifier.classify(commandLine) {
                continuation.finish(
                    throwing: CommandExecutionError.forbidden(reason: reason)
                )
                return
            }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-c", commandLine]
            process.currentDirectoryURL = workspaceRootURL
            process.environment = Self.minimalEnvironment(
                workspaceRoot: workspaceRootURL.path
            )

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe
            process.standardInput = FileHandle.nullDevice

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
                continuation.finish(
                    throwing: CommandExecutionError.launchFailed(
                        message: String(describing: error)
                    )
                )
            }
        }
    }

    // MARK: - Environment

    /// A fresh minimal environment. Nothing is inherited from the app
    /// process, so account tokens and provider keys can never leak into
    /// child processes.
    static func minimalEnvironment(workspaceRoot: String) -> [String: String] {
        var environment: [String: String] = [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
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
