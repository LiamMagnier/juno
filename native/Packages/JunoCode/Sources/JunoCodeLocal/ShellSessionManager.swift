import Foundation
import JunoCodeCore

/// Background processes the agent starts — dev servers, watchers, long jobs —
/// kept alive across tool calls and turns, and stopped when their session
/// ends or the app quits.
///
/// Every process is prepared by the workspace's ``CommandExecutionService``,
/// so it runs under exactly the sandbox profile, scrubbed environment and
/// reader's variables `run_command` uses. What differs is the lifetime and
/// the plumbing: standard input stays open, and output goes to a spill file
/// the agent reads incrementally instead of into one bounded result.
public final class ShellSessionManager: ShellSessionManaging, @unchecked Sendable {
    /// Running shells one session may hold at once.
    public static let maximumRunningPerSession = 8
    /// Ended shells one session keeps, newest first, for their exit status
    /// and last output. Each holds a log of up to `retainedBytes` on disk and
    /// a few descriptors, so an agent starting short jobs in a loop must not
    /// pile them up until the app runs out of either.
    public static let maximumEndedPerSession = 16
    /// How much of one shell's output its spill file keeps. Past this the
    /// oldest half is dropped; offsets stay logical, so a reader holding an
    /// old offset learns how much it missed.
    public static let defaultRetainedBytes = 16 * 1_024 * 1_024

    private let executor: CommandExecutionService
    private let logDirectory: URL
    private let retainedBytes: Int
    private let redactor = SecretRedactor()
    private let lock = NSLock()
    private var shells: [String: Shell] = [:]
    /// Sessions whose shells were stopped because the session ended. A start
    /// still under way for one of them stops its process instead of keeping
    /// it, or it would run on with nothing left to stop it.
    private var endedSessions: Set<CodeSessionID> = []
    private var nextNumber = 1
    private var terminationObserver: (any NSObjectProtocol)?

    public init(
        executor: CommandExecutionService,
        logDirectory: URL,
        retainedBytes: Int = ShellSessionManager.defaultRetainedBytes
    ) {
        self.executor = executor
        self.logDirectory = logDirectory
        self.retainedBytes = max(4_096, retainedBytes)
        // A child in its own process group outlives the app unless it is
        // stopped: quitting must take every server with it. By name, so this
        // target needs no AppKit.
        terminationObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("NSApplicationWillTerminateNotification"),
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.terminateAllNow()
        }
    }

    deinit {
        if let terminationObserver {
            NotificationCenter.default.removeObserver(terminationObserver)
        }
        terminateAllNow()
    }

    // MARK: - Starting

    public func start(
        command: String,
        workingDirectory: WorkspacePath?,
        name: String?,
        ownerSessionID: CodeSessionID,
        risk: ActionRisk
    ) async throws -> ShellSessionInfo {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw ShellSessionError.launchFailed(message: "The command is empty.")
        }
        guard !lock.withLock({ endedSessions.contains(ownerSessionID) }) else {
            throw ShellSessionError.launchFailed(message: "The session has ended.")
        }
        let running = sessions(ownedBy: ownerSessionID).filter(\.state.isRunning).count
        guard running < Self.maximumRunningPerSession else {
            throw ShellSessionError.tooManySessions(limit: Self.maximumRunningPerSession)
        }
        let prepared: CommandExecutionService.PreparedCommand
        do {
            prepared = try executor.prepare(trimmed, workingDirectory: workingDirectory)
        } catch let error as CommandExecutionError {
            if case let .forbidden(reason) = error { throw ShellSessionError.forbidden(reason: reason) }
            throw ShellSessionError.launchFailed(message: String(describing: error))
        }

        let id = allocateID()
        let log: SpillLog
        do {
            try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
            log = try SpillLog(
                url: logDirectory.appendingPathComponent("\(id).log"),
                retainedBytes: retainedBytes
            )
        } catch {
            throw ShellSessionError.launchFailed(message: "Its output log could not be created: \(error)")
        }

        let process = Process()
        process.executableURL = prepared.executableURL
        process.arguments = prepared.arguments
        process.environment = prepared.environment
        process.currentDirectoryURL = prepared.currentDirectoryURL
        let stdout = Pipe()
        let stderr = Pipe()
        let stdin = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = stdin

        let shell = Shell(
            info: ShellSessionInfo(
                id: id,
                name: name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                command: trimmed,
                workingDirectory: workingDirectory,
                ownerSessionID: ownerSessionID,
                startedAt: Date(),
                state: .failed(reason: "not started"),
                outputBytes: 0,
                risk: risk
            ),
            process: process,
            input: stdin.fileHandleForWriting,
            log: log
        )
        let redactor = self.redactor
        for pipe in [stdout, stderr] {
            let decoder = UTF8StreamDecoder()
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else {
                    // End of file: the process closed this stream.
                    handle.readabilityHandler = nil
                    if let rest = decoder.finish() { log.append(Data(redactor.redact(rest).utf8)) }
                    return
                }
                if let text = decoder.decode(data) {
                    log.append(Data(redactor.redact(text).utf8))
                }
            }
        }
        process.terminationHandler = { finished in
            let state: ShellSessionState = finished.terminationReason == .uncaughtSignal
                ? .signalled(signal: finished.terminationStatus)
                : .exited(code: finished.terminationStatus)
            shell.setState(state)
        }

        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            log.remove()
            throw ShellSessionError.launchFailed(message: error.localizedDescription)
        }
        // Writes to a process that is not reading must fail, not block the
        // caller or raise SIGPIPE in the app.
        let descriptor = stdin.fileHandleForWriting.fileDescriptor
        _ = fcntl(descriptor, F_SETNOSIGPIPE, 1)
        _ = fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK)
        shell.setStateIfUnset(.running(processID: process.processIdentifier))

        let (admitted, evicted) = lock.withLock { () -> (Bool, [Shell]) in
            guard !endedSessions.contains(ownerSessionID) else { return (false, []) }
            shells[id] = shell
            // The oldest ended shells past the allowance go, logs and all.
            let ended = shells.values
                .filter { $0.ownerSessionID == ownerSessionID && !$0.snapshot().state.isRunning }
                .sorted { $0.startedAt > $1.startedAt }
            let evicted = Array(ended.dropFirst(Self.maximumEndedPerSession))
            for old in evicted { shells.removeValue(forKey: old.id) }
            return (true, evicted)
        }
        for old in evicted { old.release() }
        guard admitted else {
            await stop([shell])
            throw ShellSessionError.launchFailed(message: "The session ended while the process was starting.")
        }
        return shell.snapshot()
    }

    private func allocateID() -> String {
        lock.lock()
        defer { lock.unlock() }
        let id = "sh-\(nextNumber)"
        nextNumber += 1
        return id
    }

    // MARK: - Reading

    public func output(
        id: String,
        ownerSessionID: CodeSessionID,
        since: Int?,
        tailLines: Int?,
        maximumBytes: Int,
        waitSeconds: Double
    ) async throws -> ShellOutputChunk {
        let shell = try owned(id, by: ownerSessionID, forWriting: false)
        let budget = max(256, maximumBytes)
        if let tailLines {
            if waitSeconds > 0 {
                await waitForOutput(shell, after: shell.log.endOffset, seconds: waitSeconds)
            }
            let (data, start) = shell.log.tail(maximumBytes: budget)
            let text = Self.lastLines(String(decoding: data, as: UTF8.self), count: max(1, tailLines))
            let end = start + data.count
            shell.markRead(end)
            return ShellOutputChunk(
                info: shell.snapshot(),
                text: text,
                startOffset: max(start, end - text.utf8.count),
                nextOffset: end
            )
        }
        // An explicit offset is a page; none means "what is new since I last
        // looked", with the middle left out of a burst too big to show.
        let explicit = since != nil
        let from = max(0, since ?? shell.lastRead)
        if waitSeconds > 0 {
            await waitForOutput(shell, after: from, seconds: waitSeconds)
        }
        if explicit {
            let page = shell.log.read(from: from, maximumBytes: budget)
            let next = page.start + page.data.count
            shell.markRead(next)
            return ShellOutputChunk(
                info: shell.snapshot(),
                text: String(decoding: page.data, as: UTF8.self),
                startOffset: page.start,
                nextOffset: next,
                droppedBytes: page.dropped
            )
        }
        let available = shell.log.read(from: from, maximumBytes: .max)
        // Marked up to what this read returned, not the log's end sampled
        // apart from it: output landing in between is next read's news.
        shell.markRead(available.start + available.data.count)
        guard available.data.count > budget else {
            return ShellOutputChunk(
                info: shell.snapshot(),
                text: String(decoding: available.data, as: UTF8.self),
                startOffset: available.start,
                nextOffset: available.start + available.data.count,
                droppedBytes: available.dropped
            )
        }
        let headCount = Self.boundary(in: available.data, near: budget / 4)
        let tailStart = Self.boundary(in: available.data, near: available.data.count - (budget - headCount))
        let head = String(decoding: available.data[..<headCount], as: UTF8.self)
        let tail = String(decoding: available.data[tailStart...], as: UTF8.self)
        return ShellOutputChunk(
            info: shell.snapshot(),
            text: head + "\n… [omitted] …\n" + tail,
            startOffset: available.start,
            nextOffset: available.start + available.data.count,
            droppedBytes: available.dropped,
            omittedBytes: tailStart - headCount
        )
    }

    private func waitForOutput(_ shell: Shell, after offset: Int, seconds: Double) async {
        let deadline = Date().addingTimeInterval(min(seconds, 60))
        while Date() < deadline, shell.log.endOffset <= offset, shell.snapshot().state.isRunning {
            guard !Task.isCancelled else { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        // Output written just before exit may still be draining.
        if !shell.snapshot().state.isRunning {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    /// An index at or after `offset` that does not split a UTF-8 character.
    static func boundary(in data: Data, near offset: Int) -> Int {
        var index = min(max(0, offset), data.count)
        while index < data.count, index > 0, data[data.startIndex + index] & 0xC0 == 0x80 {
            index += 1
        }
        return index
    }

    static func lastLines(_ text: String, count: Int) -> String {
        var lines = text.components(separatedBy: "\n")
        let endsWithNewline = lines.last == ""
        if endsWithNewline { lines.removeLast() }
        return lines.suffix(count).joined(separator: "\n") + (endsWithNewline ? "\n" : "")
    }

    // MARK: - Input

    public func write(id: String, ownerSessionID: CodeSessionID, text: String) async throws -> Int {
        let shell = try owned(id, by: ownerSessionID, forWriting: true)
        let data = Data(text.utf8)
        guard !data.isEmpty else { return 0 }
        let written = shell.writeInput(data)
        guard written > 0 else { throw ShellSessionError.notReading(id: id) }
        return written
    }

    // MARK: - Stopping

    public func kill(id: String, ownerSessionID: CodeSessionID, signal: ShellSignal) async throws -> ShellSessionInfo {
        let shell = try owned(id, by: ownerSessionID, forWriting: false)
        guard shell.snapshot().state.isRunning else { return shell.snapshot() }
        Self.signal(shell.process, signal.rawSignal)
        let deadline = Date().addingTimeInterval(signal == .kill ? 1 : 2)
        while Date() < deadline, shell.snapshot().state.isRunning {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return shell.snapshot()
    }

    public func info(id: String) -> ShellSessionInfo? {
        lock.lock()
        let shell = shells[id]
        lock.unlock()
        return shell?.snapshot()
    }

    public func sessions(ownedBy sessionID: CodeSessionID) -> [ShellSessionInfo] {
        lock.lock()
        let owned = shells.values.filter { $0.ownerSessionID == sessionID }
        lock.unlock()
        return owned.map { $0.snapshot() }.sorted { $0.startedAt < $1.startedAt }
    }

    public func terminateAll(ownedBy sessionID: CodeSessionID) async {
        let owned = lock.withLock {
            endedSessions.insert(sessionID)
            let owned = shells.values.filter { $0.ownerSessionID == sessionID }
            for shell in owned { shells.removeValue(forKey: shell.id) }
            return owned
        }
        await stop(owned)
    }

    public func terminateAll() async {
        let all = lock.withLock {
            let all = Array(shells.values)
            shells.removeAll()
            return all
        }
        await stop(all)
    }

    /// Ended shells a session still holds; for tests.
    func retainedShellCount(ownedBy sessionID: CodeSessionID) -> Int {
        lock.withLock { shells.values.filter { $0.ownerSessionID == sessionID }.count }
    }

    /// SIGTERM to every group, a moment to exit cleanly, then SIGKILL.
    private func stop(_ targets: [Shell]) async {
        let running = targets.filter { $0.snapshot().state.isRunning }
        for shell in running { Self.signal(shell.process, SIGTERM) }
        let deadline = Date().addingTimeInterval(1.5)
        while Date() < deadline, running.contains(where: { $0.snapshot().state.isRunning }) {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        for shell in running where shell.snapshot().state.isRunning {
            Self.signal(shell.process, SIGKILL)
        }
        for shell in targets { shell.release() }
    }

    /// For app termination and deinit, where nothing may be awaited.
    private func terminateAllNow() {
        lock.lock()
        let all = Array(shells.values)
        shells.removeAll()
        lock.unlock()
        for shell in all where shell.snapshot().state.isRunning {
            Self.signal(shell.process, SIGTERM)
        }
        let deadline = Date().addingTimeInterval(0.3)
        while Date() < deadline, all.contains(where: { $0.snapshot().state.isRunning }) {
            usleep(20_000)
        }
        for shell in all where shell.snapshot().state.isRunning {
            Self.signal(shell.process, SIGKILL)
        }
        for shell in all { shell.release() }
    }

    /// The whole process group — a dev server's own children included — or
    /// the process alone if it has none.
    private static func signal(_ process: Process, _ signal: Int32) {
        let pid = process.processIdentifier
        guard pid > 0 else { return }
        if Darwin.kill(-pid, signal) != 0 {
            _ = Darwin.kill(pid, signal)
        }
    }

    private func owned(_ id: String, by sessionID: CodeSessionID, forWriting: Bool) throws -> Shell {
        lock.lock()
        let shell = shells[id]
        lock.unlock()
        guard let shell else { throw ShellSessionError.unknownSession(id: id) }
        guard shell.ownerSessionID == sessionID else { throw ShellSessionError.notOwned(id: id) }
        if forWriting {
            let state = shell.snapshot().state
            guard state.isRunning else { throw ShellSessionError.notRunning(id: id, state: state) }
        }
        return shell
    }
}

/// One running (or finished) process and its log.
private final class Shell: @unchecked Sendable {
    private let lock = NSLock()
    private var info: ShellSessionInfo
    private var readOffset = 0
    let process: Process
    let log: SpillLog
    /// The process's standard input, written and closed only under
    /// `inputLock`: a descriptor closed while a write was using it could be
    /// reused by then for another file, which would receive the text.
    private let input: FileHandle
    private let inputLock = NSLock()
    private var inputClosed = false
    /// Copied out of `info` so reading them never races a state change.
    let id: String
    let ownerSessionID: CodeSessionID
    let startedAt: Date

    init(info: ShellSessionInfo, process: Process, input: FileHandle, log: SpillLog) {
        self.info = info
        self.process = process
        self.input = input
        self.log = log
        self.id = info.id
        self.ownerSessionID = info.ownerSessionID
        self.startedAt = info.startedAt
    }

    /// Writes as much of `data` as the process takes without blocking.
    func writeInput(_ data: Data) -> Int {
        inputLock.lock()
        defer { inputLock.unlock() }
        guard !inputClosed else { return 0 }
        let descriptor = input.fileDescriptor
        return data.withUnsafeBytes { buffer -> Int in
            guard let base = buffer.baseAddress else { return 0 }
            var total = 0
            while total < buffer.count {
                let result = Darwin.write(descriptor, base + total, buffer.count - total)
                if result > 0 {
                    total += result
                } else if result < 0, errno == EINTR {
                    continue
                } else {
                    break
                }
            }
            return total
        }
    }

    /// Closes its input and deletes its log: the shell is gone from the
    /// manager and nothing will read or write either again.
    func release() {
        inputLock.lock()
        if !inputClosed {
            inputClosed = true
            try? input.close()
        }
        inputLock.unlock()
        log.remove()
    }

    var lastRead: Int {
        lock.lock()
        defer { lock.unlock() }
        return readOffset
    }

    func markRead(_ offset: Int) {
        lock.lock()
        readOffset = max(readOffset, offset)
        lock.unlock()
    }

    func setState(_ state: ShellSessionState) {
        lock.lock()
        info.state = state
        lock.unlock()
    }

    /// Records the running state unless the process already ended — a
    /// command that exits at once can finish before `run()` returns.
    func setStateIfUnset(_ state: ShellSessionState) {
        lock.lock()
        if case .failed = info.state { info.state = state }
        lock.unlock()
    }

    func snapshot() -> ShellSessionInfo {
        lock.lock()
        var copy = info
        lock.unlock()
        copy.outputBytes = log.endOffset
        return copy
    }
}

/// A shell's output on disk: appended as it arrives, read by logical offset,
/// and trimmed from the front when it outgrows its budget.
final class SpillLog: @unchecked Sendable {
    private let lock = NSLock()
    private let url: URL
    private let handle: FileHandle
    private let retainedBytes: Int
    /// Every byte ever appended.
    private var end = 0
    /// The logical offset of the file's first byte.
    private var fileStart = 0
    private var removed = false

    init(url: URL, retainedBytes: Int) throws {
        self.url = url
        self.retainedBytes = retainedBytes
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try FileHandle(forUpdating: url)
    }

    var endOffset: Int {
        lock.lock()
        defer { lock.unlock() }
        return end
    }

    func append(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        guard !removed else { return }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            end += data.count
            if end - fileStart > retainedBytes { try compact() }
        } catch {
            // A full disk loses output, never the process.
        }
    }

    /// Keeps the newest half of the budget.
    private func compact() throws {
        let keep = retainedBytes / 2
        let fileLength = end - fileStart
        try handle.seek(toOffset: UInt64(fileLength - keep))
        let kept = try handle.read(upToCount: keep) ?? Data()
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: kept)
        fileStart = end - kept.count
    }

    /// Up to `maximumBytes` from `offset`, or from the oldest byte still kept
    /// when `offset` is older than that — `dropped` says how much was lost.
    func read(from offset: Int, maximumBytes: Int) -> (data: Data, start: Int, dropped: Int) {
        lock.lock()
        defer { lock.unlock() }
        let start = min(max(offset, fileStart), end)
        let dropped = max(0, fileStart - offset)
        let count = min(maximumBytes, end - start)
        guard count > 0, !removed else { return (Data(), start, dropped) }
        do {
            try handle.seek(toOffset: UInt64(start - fileStart))
            let data = try handle.read(upToCount: count) ?? Data()
            return (data, start, dropped)
        } catch {
            return (Data(), start, dropped)
        }
    }

    /// The newest bytes, at most `maximumBytes`.
    func tail(maximumBytes: Int) -> (data: Data, start: Int) {
        let from = max(0, endOffset - maximumBytes)
        let page = read(from: from, maximumBytes: maximumBytes)
        return (page.data, page.start)
    }

    func remove() {
        lock.lock()
        defer { lock.unlock() }
        guard !removed else { return }
        removed = true
        try? handle.close()
        try? FileManager.default.removeItem(at: url)
    }
}

/// Turns a byte stream into text without splitting a character across two
/// chunks: an incomplete sequence at the end of one read waits for the next.
final class UTF8StreamDecoder: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = Data()

    func decode(_ data: Data) -> String? {
        lock.lock()
        defer { lock.unlock() }
        var bytes = pending + data
        pending = Data()
        // Hold back a trailing incomplete sequence (at most three bytes).
        var cut = bytes.count
        var back = 0
        while back < 3, cut > 0 {
            let byte = bytes[bytes.startIndex + cut - 1]
            if byte & 0xC0 == 0x80 {
                cut -= 1
                back += 1
                continue
            }
            if byte & 0x80 != 0 {
                let needed = byte & 0xE0 == 0xC0 ? 2 : byte & 0xF0 == 0xE0 ? 3 : byte & 0xF8 == 0xF0 ? 4 : 1
                if needed > back + 1 {
                    pending = bytes.suffix(back + 1)
                    bytes = bytes.prefix(cut - 1)
                }
            }
            break
        }
        guard !bytes.isEmpty else { return nil }
        if let text = String(data: bytes, encoding: .utf8) { return text }
        return String(decoding: bytes, as: UTF8.self)
    }

    func finish() -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard !pending.isEmpty else { return nil }
        let text = String(decoding: pending, as: UTF8.self)
        pending = Data()
        return text
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
