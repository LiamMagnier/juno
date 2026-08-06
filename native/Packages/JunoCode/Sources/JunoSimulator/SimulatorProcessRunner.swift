import Foundation
import JunoCodeCore

/// Runs the simulator's child processes, and — more importantly — reliably ends
/// them.
///
/// `xcodebuild` is a build *system*: it spawns compilers, linkers, a build
/// service and script phases. `simctl spawn … log stream` runs a long-lived
/// child inside the simulator's own process world. Signalling only the process
/// Juno launched leaves that whole tree running — a stalled build holding a
/// core, a log stream burning battery — until the Mac restarts. So every launch
/// puts the child in its own process group and every cancellation signals the
/// group.
///
/// Output is redacted on the way out with the same `SecretRedactor` the Code
/// tools use. Build logs routinely contain tokens from `.netrc`, CI environment
/// variables and signing identities; they must not reach the UI, the task
/// event stream, or the model with those intact.
public final class SimulatorProcessRunner: @unchecked Sendable {
    public struct Result: Sendable {
        public let exitCode: Int32
        public let standardOutput: String
        public let standardError: String
        /// True when the run ended because it was cancelled rather than because
        /// the command finished. A cancelled build is not a failed build.
        public let cancelled: Bool

        public var succeeded: Bool { exitCode == 0 && !cancelled }
        public var combined: String {
            standardError.isEmpty ? standardOutput : "\(standardOutput)\n\(standardError)"
        }
    }

    public enum Failure: Error, Equatable, CustomStringConvertible {
        case launchFailed(String)
        case timedOut(seconds: Int)

        public var description: String {
            switch self {
            case .launchFailed(let reason): reason
            case .timedOut(let seconds): "The command did not finish within \(seconds)s."
            }
        }
    }

    private let redactor = SecretRedactor()
    private let lock = NSLock()
    /// Every process this runner has started and not yet reaped, so a workspace
    /// change or a sign-out can end all of them at once.
    private var live: [Int32: Process] = [:]

    public init() {}

    deinit {
        terminateAll()
    }

    /// Run to completion, capturing output.
    ///
    /// Cancelling the surrounding `Task` terminates the process group — so the
    /// pane closing, the session changing, or the app quitting all stop the
    /// build rather than orphaning it.
    public func run(_ invocation: SimulatorCommands.Invocation, timeout: TimeInterval = 900) async throws -> Result {
        let process = try makeProcess(invocation)
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = FileHandle.nullDevice

        let collector = OutputCollector(redactor: redactor)

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Result, Error>) in
                let finished = Finalizer()

                do {
                    try process.run()
                    remember(process)
                } catch {
                    guard finished.claim() else { return }
                    continuation.resume(throwing: Failure.launchFailed(error.localizedDescription))
                    return
                }

                // One dedicated reader per pipe, each reading to EOF, and a
                // group that waits for both before answering.
                //
                // NOT `readabilityHandler` plus a drain on termination: those
                // are two producers appending to one buffer from two queues, so
                // a chunk read by the drain can land *before* one the handler
                // was still delivering. The bytes all arrive and the total
                // length looks right — they are simply in the wrong order, which
                // for `simctl list devices --json` means unparseable JSON and a
                // "no simulators exist" report on a machine full of them.
                let group = DispatchGroup()
                for (pipe, isStandardOutput) in [(stdout, true), (stderr, false)] {
                    group.enter()
                    DispatchQueue.global(qos: .userInitiated).async {
                        defer { group.leave() }
                        while true {
                            let data = pipe.fileHandleForReading.availableData
                            if data.isEmpty { return }
                            collector.append(data, toStandardOutput: isStandardOutput)
                        }
                    }
                }

                group.notify(queue: .global()) { [weak self] in
                    // Both pipes are at EOF, so the child has closed them and is
                    // on its way out; `waitUntilExit` collects the status.
                    process.waitUntilExit()
                    self?.forget(process)
                    guard finished.claim() else { return }
                    continuation.resume(
                        returning: Result(
                            exitCode: process.terminationStatus,
                            standardOutput: collector.stdoutText,
                            standardError: collector.stderrText,
                            cancelled: process.terminationReason == .uncaughtSignal
                        )
                    )
                }

                if timeout > 0 {
                    DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                        guard process.isRunning else { return }
                        self?.terminateGroup(process)
                    }
                }
            }
        } onCancel: {
            self.terminateGroup(process)
        }
    }

    /// Run a long-lived process, streaming redacted lines until it ends or the
    /// consuming task is cancelled. Used for the log stream and for build output.
    public func stream(_ invocation: SimulatorCommands.Invocation) -> AsyncStream<SimulatorProcessLine> {
        AsyncStream { continuation in
            let process: Process
            do {
                process = try makeProcess(invocation)
            } catch {
                continuation.yield(.init(channel: .stderr, text: "\(error)"))
                continuation.yield(.init(channel: .exit, text: "1"))
                continuation.finish()
                return
            }

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr
            process.standardInput = FileHandle.nullDevice

            let redactor = self.redactor
            for (pipe, channel) in [(stdout, SimulatorProcessLine.Channel.stdout), (stderr, .stderr)] {
                let buffer = LineBuffer()
                pipe.fileHandleForReading.readabilityHandler = { handle in
                    let data = handle.availableData
                    guard !data.isEmpty else {
                        handle.readabilityHandler = nil
                        for line in buffer.flush() {
                            continuation.yield(.init(channel: channel, text: redactor.redact(line)))
                        }
                        return
                    }
                    for line in buffer.append(String(decoding: data, as: UTF8.self)) {
                        continuation.yield(.init(channel: channel, text: redactor.redact(line)))
                    }
                }
            }

            process.terminationHandler = { [weak self] finished in
                self?.forget(finished)
                continuation.yield(.init(channel: .exit, text: String(finished.terminationStatus)))
                continuation.finish()
            }

            do {
                try process.run()
                remember(process)
            } catch {
                continuation.yield(.init(channel: .stderr, text: "Could not start \(invocation.executable): \(error.localizedDescription)"))
                continuation.yield(.init(channel: .exit, text: "1"))
                continuation.finish()
                return
            }

            continuation.onTermination = { [weak self] _ in
                self?.terminateGroup(process)
            }
        }
    }

    /// End every process this runner started. Called when the workspace changes,
    /// the Code session changes, the user signs out, or Juno quits.
    public func terminateAll() {
        lock.lock()
        let processes = Array(live.values)
        live.removeAll()
        lock.unlock()
        for process in processes { terminateGroup(process) }
    }

    public var liveProcessCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return live.count
    }

    // MARK: - Internals

    private func makeProcess(_ invocation: SimulatorCommands.Invocation) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: invocation.executable)
        process.arguments = invocation.arguments
        if let directory = invocation.currentDirectory {
            process.currentDirectoryURL = URL(fileURLWithPath: directory)
        }
        // A deliberately minimal environment: nothing from the user's shell
        // profile, no account token, no API key. Xcode needs DEVELOPER_DIR to
        // be absent (it resolves through xcode-select) and a sane PATH.
        process.environment = [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": NSHomeDirectory(),
            "LANG": "en_US.UTF-8",
            // Deterministic, machine-readable output where xcodebuild offers it.
            "NSUnbufferedIO": "YES",
        ]
        return process
    }

    private func remember(_ process: Process) {
        lock.lock()
        live[process.processIdentifier] = process
        lock.unlock()
    }

    private func forget(_ process: Process) {
        lock.lock()
        live.removeValue(forKey: process.processIdentifier)
        lock.unlock()
    }

    /// Signal the whole group, then escalate.
    ///
    /// `Process` puts the child in its own process group, so a negative pid
    /// reaches the child and everything it spawned — which for `xcodebuild` is
    /// the difference between stopping a build and orphaning a compiler farm.
    private func terminateGroup(_ process: Process) {
        guard process.isRunning else { return }
        let pid = process.processIdentifier
        kill(-pid, SIGTERM)
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            if process.isRunning { kill(-pid, SIGKILL) }
        }
    }
}

public struct SimulatorProcessLine: Sendable, Equatable {
    public enum Channel: String, Sendable, Equatable { case stdout, stderr, exit }
    public let channel: Channel
    public let text: String

    public init(channel: Channel, text: String) {
        self.channel = channel
        self.text = text
    }
}

/// Splits a byte stream into whole lines. A `readabilityHandler` hands over
/// arbitrary chunks, so without this a log line is routinely reported in two
/// halves — which is exactly the kind of output nobody can grep.
final class LineBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = ""

    func append(_ chunk: String) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        pending += chunk
        var lines: [String] = []
        while let index = pending.firstIndex(of: "\n") {
            lines.append(String(pending[pending.startIndex..<index]))
            pending = String(pending[pending.index(after: index)...])
        }
        // Bounded: a process that never emits a newline must not grow this
        // without limit.
        if pending.count > 64_000 {
            lines.append(pending)
            pending = ""
        }
        return lines
    }

    func flush() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        guard !pending.isEmpty else { return [] }
        let last = pending
        pending = ""
        return [last]
    }
}

/// Accumulates a completed run's output, bounded so a runaway build cannot
/// exhaust memory. The tail is what matters for a failure, so the head is what
/// gets dropped.
private final class OutputCollector: @unchecked Sendable {
    private let lock = NSLock()
    private let redactor: SecretRedactor
    private var stdoutBytes = Data()
    private var stderrBytes = Data()
    private static let limit = 4_000_000

    init(redactor: SecretRedactor) {
        self.redactor = redactor
    }

    var stdoutText: String {
        lock.lock()
        defer { lock.unlock() }
        return redactor.redact(String(decoding: stdoutBytes, as: UTF8.self))
    }

    var stderrText: String {
        lock.lock()
        defer { lock.unlock() }
        return redactor.redact(String(decoding: stderrBytes, as: UTF8.self))
    }

    /// Accumulate one read.
    ///
    /// Bytes are buffered and decoded once, at the end, rather than decoded per
    /// chunk: a UTF-8 sequence split across a read boundary would otherwise
    /// become a replacement character, which for a device name or a build
    /// diagnostic is silent corruption.
    func append(_ data: Data, toStandardOutput: Bool) {
        guard !data.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        if toStandardOutput {
            stdoutBytes.append(data)
            if stdoutBytes.count > Self.limit { stdoutBytes.removeFirst(stdoutBytes.count - Self.limit) }
        } else {
            stderrBytes.append(data)
            if stderrBytes.count > Self.limit { stderrBytes.removeFirst(stderrBytes.count - Self.limit) }
        }
    }
}

/// One-shot latch. `terminationHandler` and a launch failure can both try to
/// finish the same continuation; resuming twice is a crash.
private final class Finalizer: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}
