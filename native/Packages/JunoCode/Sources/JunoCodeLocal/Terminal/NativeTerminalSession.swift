import Foundation

#if canImport(Darwin)
import Darwin
#endif

/// An actor-isolated, persistent PTY session for native JunoCode.
///
/// A session launches exactly the executable and argv supplied in
/// ``NativeTerminalCommand``. It never constructs or invokes a shell command
/// string. On macOS the child owns a controlling terminal and a process group,
/// so interactive programs, signals, resize notifications and descendants all
/// behave like a real terminal session.
public actor NativeTerminalSession {
    public let limits: NativeTerminalLimits

    public private(set) var state: NativeTerminalState = .idle

    private var transcriptBuffer: NativeTerminalTranscript
    private var continuation: AsyncThrowingStream<NativeTerminalEvent, Error>.Continuation?

    #if canImport(Darwin)
    private var masterFileDescriptor: Int32 = -1
    private var childProcessID: Int32?
    private var readSource: DispatchSourceRead?
    private var outputByteCount = 0
    private var didObserveEOF = false
    private var waitStatus: Int32?
    private var terminationReason: NativeTerminalExitReason = .processStatus
    private var lifetimeTask: Task<Void, Never>?
    private var forceKillTask: Task<Void, Never>?
    private var exitWaiters: [CheckedContinuation<NativeTerminalExit, Error>] = []
    #endif

    public init(limits: NativeTerminalLimits = NativeTerminalLimits()) {
        self.limits = limits
        self.transcriptBuffer = NativeTerminalTranscript(
            maximumBytes: limits.maximumTranscriptBytes
        )
    }

    deinit {
        #if canImport(Darwin)
        // A session can outlive its stream consumer. Keep the last-resort
        // cleanup synchronous so dropping the actor cannot orphan a child
        // process group while no actor remains to service termination tasks.
        if let processID = childProcessID {
            _ = kill(-processID, SIGTERM)
            _ = kill(-processID, SIGKILL)
        }
        readSource?.cancel()
        if readSource == nil, masterFileDescriptor >= 0 {
            close(masterFileDescriptor)
        }
        #endif
    }

    /// Starts a new invocation and returns its bounded event stream.
    public func start(
        _ command: NativeTerminalCommand,
        size: NativeTerminalSize = .default
    ) throws -> AsyncThrowingStream<NativeTerminalEvent, Error> {
        guard !state.isRunning else {
            throw NativeTerminalError.alreadyRunning
        }
        guard isValid(size: size) else {
            throw NativeTerminalError.invalidSize
        }

        var streamContinuation: AsyncThrowingStream<NativeTerminalEvent, Error>.Continuation!
        // `maximumPendingEvents` is a caller-provided lower bound, not a hard
        // cap that is allowed to discard terminal output. The child is already
        // stopped once `maximumOutputBytes` is reached, so the complete output
        // can occupy at most this many chunks. Reserve room for those chunks
        // and the six lifecycle events (starting, running, stopping, EOF,
        // exited state and exited value) before applying the requested floor.
        // Without this, a slow consumer could silently lose a chunk from a
        // bounded command while the transcript still retained it.
        let outputEventCapacity =
            limits.maximumOutputBytes / limits.maximumOutputChunkBytes
            + (limits.maximumOutputBytes % limits.maximumOutputChunkBytes == 0 ? 0 : 1)
        let lifecycleEventCapacity = 6
        let boundedOutputAndLifecycleCapacity = outputEventCapacity > Int.max - lifecycleEventCapacity
            ? Int.max
            : outputEventCapacity + lifecycleEventCapacity
        let streamCapacity = max(
            limits.maximumPendingEvents,
            boundedOutputAndLifecycleCapacity
        )
        let stream = AsyncThrowingStream<NativeTerminalEvent, Error>(
            bufferingPolicy: .bufferingNewest(streamCapacity)
        ) { continuation in
            streamContinuation = continuation
        }
        continuation = streamContinuation
        streamContinuation.onTermination = { [weak self] termination in
            guard case .cancelled = termination else { return }
            Task { [weak self] in
                await self?.cancelFromStream()
            }
        }

        state = .starting
        transcriptBuffer = NativeTerminalTranscript(
            maximumBytes: limits.maximumTranscriptBytes
        )
        streamContinuation.yield(.state(.starting))

        #if canImport(Darwin)
        do {
            try launch(command: command, size: size)
        } catch let error as NativeTerminalError {
            fail(error)
        } catch {
            fail(.launchFailed(errno: EINVAL))
        }
        #else
        fail(.unsupportedPlatform)
        #endif

        return stream
    }

    /// Writes literal bytes, including control bytes, to the PTY input.
    public func write(_ data: Data) throws {
        #if canImport(Darwin)
        guard let processID = childProcessID, masterFileDescriptor >= 0 else {
            throw NativeTerminalError.notRunning
        }
        guard data.count <= limits.maximumInputBytes else {
            throw NativeTerminalError.inputTooLarge
        }
        guard !data.isEmpty else { return }

        var offset = 0
        while offset < data.count {
            let written = data.withUnsafeBytes { rawBuffer -> Int in
                guard let baseAddress = rawBuffer.baseAddress else { return 0 }
                return Darwin.write(
                    masterFileDescriptor,
                    baseAddress.advanced(by: offset),
                    data.count - offset
                )
            }
            if written > 0 {
                offset += written
                continue
            }
            if written < 0, errno == EINTR { continue }
            if written < 0, errno == EAGAIN || errno == EWOULDBLOCK {
                var descriptor = pollfd(
                    fd: masterFileDescriptor,
                    events: Int16(POLLOUT),
                    revents: 0
                )
                let result = Darwin.poll(&descriptor, 1, 250)
                if result > 0 { continue }
                throw NativeTerminalError.writeFailed(
                    errno: result == 0 ? ETIMEDOUT : errno
                )
            }
            throw NativeTerminalError.writeFailed(errno: errno)
        }
        _ = processID // Keeps the lifecycle guard explicit at the call site.
        #else
        throw NativeTerminalError.unsupportedPlatform
        #endif
    }

    public func write(_ text: String) throws {
        try write(Data(text.utf8))
    }

    public func resize(to size: NativeTerminalSize) throws {
        #if canImport(Darwin)
        guard isValid(size: size) else {
            throw NativeTerminalError.invalidSize
        }
        guard masterFileDescriptor >= 0 else {
            throw NativeTerminalError.notRunning
        }
        var window = winsize(
            ws_row: size.rows,
            ws_col: size.columns,
            ws_xpixel: 0,
            ws_ypixel: 0
        )
        guard ioctl(masterFileDescriptor, TIOCSWINSZ, &window) == 0 else {
            throw NativeTerminalError.resizeFailed(errno: errno)
        }
        #else
        throw NativeTerminalError.unsupportedPlatform
        #endif
    }

    public func send(signal: NativeTerminalSignal) throws {
        #if canImport(Darwin)
        guard let processID = childProcessID else {
            throw NativeTerminalError.notRunning
        }
        guard kill(-processID, signal.rawValue) == 0 else {
            throw NativeTerminalError.signalFailed(signal: signal.rawValue, errno: errno)
        }
        #else
        throw NativeTerminalError.unsupportedPlatform
        #endif
    }

    public func interrupt() throws {
        try send(signal: .interrupt)
    }

    /// Requests group termination and waits until the child has been reaped.
    public func terminate() async throws {
        #if canImport(Darwin)
        guard childProcessID != nil else { return }
        requestTermination(reason: .terminated)
        _ = try? await waitForExit()
        #else
        throw NativeTerminalError.unsupportedPlatform
        #endif
    }

    /// Waits for a running child to exit. Cancellation also terminates and
    /// reaps the process group before the waiter returns.
    public func waitForExit() async throws -> NativeTerminalExit {
        #if canImport(Darwin)
        if case let .exited(exit) = state { return exit }
        guard childProcessID != nil else {
            throw NativeTerminalError.notRunning
        }

        let exit = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if let exit = self.completedExitIfAvailable() {
                    continuation.resume(returning: exit)
                } else {
                    self.exitWaiters.append(continuation)
                }
            }
        } onCancel: {
            Task { [weak self] in
                await self?.cancelFromWaiter()
            }
        }
        if Task.isCancelled { throw CancellationError() }
        return exit
        #else
        throw NativeTerminalError.unsupportedPlatform
        #endif
    }

    public var transcript: String {
        transcriptBuffer.text
    }

    public var transcriptData: Data {
        transcriptBuffer.data
    }

    public var transcriptWasTruncated: Bool {
        transcriptBuffer.didTruncate
    }

    #if canImport(Darwin)
    private func launch(command: NativeTerminalCommand, size: NativeTerminalSize) throws {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(
            atPath: command.workingDirectory.path,
            isDirectory: &isDirectory
        ), isDirectory.boolValue else {
            throw NativeTerminalError.workingDirectoryUnavailable
        }

        var environment = command.environment
        environment["TERM", default: "xterm-256color"] = "xterm-256color"
        environment["COLUMNS"] = String(size.columns)
        environment["LINES"] = String(size.rows)
        let environmentBytes = environment.reduce(0) {
            $0 + $1.key.utf8.count + 1 + $1.value.utf8.count + 1
        }
        guard environment.count <= 256, environmentBytes <= 256 * 1024 else {
            throw NativeTerminalError.launchFailed(errno: E2BIG)
        }

        var window = winsize(
            ws_row: size.rows,
            ws_col: size.columns,
            ws_xpixel: 0,
            ws_ypixel: 0
        )
        let argv = command.argv
        let envp = environment.keys.sorted().map {
            "\($0)=\(environment[$0] ?? "")"
        }

        var master: Int32 = -1
        let child: Int32 = try withCStringArray(argv) { argvPointers in
            try withCStringArray(envp) { environmentPointers in
                let child = forkpty(&master, nil, nil, &window)
                guard child >= 0 else {
                    throw NativeTerminalError.launchFailed(errno: errno)
                }
                if child == 0 {
                    // forkpty gives the child the slave as its controlling tty.
                    // A private process group lets the parent signal descendants
                    // without touching unrelated app processes.
                    _ = setpgid(0, 0)
                    _ = chdir(command.workingDirectory.path)
                    execve(command.executable, argvPointers, environmentPointers)
                    _exit(127)
                }
                _ = setpgid(child, child)
                return child
            }
        }

        guard master >= 0 else {
            throw NativeTerminalError.launchFailed(errno: EIO)
        }
        let flags = fcntl(master, F_GETFL)
        if flags >= 0 { _ = fcntl(master, F_SETFL, flags | O_NONBLOCK) }

        masterFileDescriptor = master
        childProcessID = child
        outputByteCount = 0
        didObserveEOF = false
        waitStatus = nil
        terminationReason = .processStatus
        state = .running(processID: child)
        continuation?.yield(.state(state))

        let source = DispatchSource.makeReadSource(
            fileDescriptor: master,
            queue: DispatchQueue.global(qos: .userInitiated)
        )
        source.setEventHandler { [weak self] in
            Task { [weak self] in await self?.readAvailable() }
        }
        source.setCancelHandler { close(master) }
        readSource = source
        source.resume()

        DispatchQueue.global(qos: .utility).async { [weak self] in
            var status: Int32 = 0
            var result: Int32
            repeat {
                result = waitpid(child, &status, 0)
            } while result < 0 && errno == EINTR
            let waitErrno = result < 0 ? errno : 0
            Task { [weak self] in
                await self?.processDidExit(
                    processID: child,
                    status: status,
                    waitErrno: waitErrno
                )
            }
        }

        if limits.maximumLifetimeNanoseconds > 0 {
            let lifetime = limits.maximumLifetimeNanoseconds
            lifetimeTask = Task { [weak self] in
                do {
                    try await Task.sleep(nanoseconds: lifetime)
                } catch {
                    return
                }
                await self?.lifetimeExpired(processID: child)
            }
        }
    }

    private func readAvailable() {
        guard masterFileDescriptor >= 0 else { return }
        while true {
            let remaining = limits.maximumOutputBytes - outputByteCount
            guard remaining > 0 else {
                // Stop dispatching read callbacks as soon as the byte budget
                // is exhausted. Leaving the source armed here can enqueue an
                // unbounded stream of actor jobs while the child is being
                // terminated, preventing the waitpid callback from finalizing
                // the session.
                if case .running = state {
                    requestTermination(reason: .outputLimit)
                }
                observeEOF()
                return
            }
            let readSize = min(limits.maximumOutputChunkBytes, remaining)
            var buffer = [UInt8](repeating: 0, count: readSize)
            let count = Darwin.read(masterFileDescriptor, &buffer, readSize)
            if count > 0 {
                let data = Data(buffer.prefix(count))
                outputByteCount += count
                transcriptBuffer.append(data)
                continuation?.yield(.output(data))
                continue
            }
            if count < 0, errno == EINTR { continue }
            if count < 0, errno == EAGAIN || errno == EWOULDBLOCK { return }
            observeEOF()
            return
        }
    }

    private func observeEOF() {
        guard !didObserveEOF else { return }
        didObserveEOF = true
        continuation?.yield(.eof)
        let source = readSource
        readSource = nil
        masterFileDescriptor = -1
        source?.cancel()
        finalizeIfReady()
    }

    private func processDidExit(processID: Int32, status: Int32, waitErrno: Int32) {
        guard childProcessID == processID else { return }
        guard waitErrno == 0 else {
            _ = kill(-processID, SIGTERM)
            _ = kill(-processID, SIGKILL)
            fail(.waitFailed(errno: waitErrno))
            return
        }
        waitStatus = status
        // Drain data already queued by the PTY before waiting for the EOF
        // notification. PTYs report EIO rather than a conventional zero-byte
        // read when their slave closes.
        readAvailable()
        if !didObserveEOF {
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 250_000_000)
                await self?.forceEOFIfNeeded(processID: processID)
            }
        }
        finalizeIfReady()
    }

    private func forceEOFIfNeeded(processID: Int32) {
        guard childProcessID == processID, waitStatus != nil, !didObserveEOF else {
            return
        }
        readAvailable()
        if !didObserveEOF { observeEOF() }
    }

    private func finalizeIfReady() {
        guard let processID = childProcessID,
              let status = waitStatus,
              didObserveEOF
        else { return }

        lifetimeTask?.cancel()
        lifetimeTask = nil
        forceKillTask?.cancel()
        forceKillTask = nil
        readSource?.cancel()
        readSource = nil
        masterFileDescriptor = -1
        childProcessID = nil

        let exit = NativeTerminalExit(
            processID: processID,
            waitStatus: status,
            reason: terminationReason
        )
        state = .exited(exit)
        continuation?.yield(.state(state))
        continuation?.yield(.exited(exit))
        continuation?.finish()
        continuation = nil
        let waiters = exitWaiters
        exitWaiters.removeAll()
        waiters.forEach { $0.resume(returning: exit) }
    }

    private func requestTermination(reason: NativeTerminalExitReason) {
        guard let processID = childProcessID else { return }
        terminationReason = reason
        if case .running = state {
            state = .stopping
            continuation?.yield(.state(.stopping))
        }
        _ = kill(-processID, SIGTERM)
        forceKillTask?.cancel()
        forceKillTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            await self?.forceKill(processID: processID)
        }
    }

    private func forceKill(processID: Int32) {
        guard childProcessID == processID, waitStatus == nil else { return }
        _ = kill(-processID, SIGKILL)
    }

    private func lifetimeExpired(processID: Int32) {
        guard childProcessID == processID else { return }
        requestTermination(reason: .lifetimeLimit)
    }

    private func cancelFromStream() {
        requestTermination(reason: .cancelled)
    }

    private func cancelFromWaiter() {
        requestTermination(reason: .cancelled)
    }

    private func completedExitIfAvailable() -> NativeTerminalExit? {
        guard case let .exited(exit) = state else { return nil }
        return exit
    }

    private func fail(_ error: NativeTerminalError) {
        #if canImport(Darwin)
        if let processID = childProcessID {
            _ = kill(-processID, SIGTERM)
            _ = kill(-processID, SIGKILL)
        }
        childProcessID = nil
        lifetimeTask?.cancel()
        lifetimeTask = nil
        forceKillTask?.cancel()
        forceKillTask = nil
        let source = readSource
        readSource = nil
        let descriptor = masterFileDescriptor
        masterFileDescriptor = -1
        source?.cancel()
        if source == nil, descriptor >= 0 { close(descriptor) }
        let waiters = exitWaiters
        exitWaiters.removeAll()
        waiters.forEach { $0.resume(throwing: error) }
        #endif
        state = .failed(error)
        continuation?.yield(.state(state))
        continuation?.finish(throwing: error)
        continuation = nil
    }

    private func isValid(size: NativeTerminalSize) -> Bool {
        size.columns > 0 && size.rows > 0
            && size.columns <= 1_000 && size.rows <= 1_000
    }

    /// Allocates stable C strings for the fork/exec window, then frees them
    /// in the parent. The child either execs immediately or exits; it does not
    /// run Swift code after fork.
    private func withCStringArray<T>(
        _ values: [String],
        _ body: (UnsafePointer<UnsafeMutablePointer<CChar>?>) throws -> T
    ) rethrows -> T {
        let allocated = values.map { strdup($0) }
        defer { allocated.forEach { if let pointer = $0 { free(pointer) } } }
        var pointers: [UnsafeMutablePointer<CChar>?] = allocated
        pointers.append(nil)
        return try pointers.withUnsafeBufferPointer { buffer in
            try body(buffer.baseAddress!)
        }
    }
    #else
    private func fail(_ error: NativeTerminalError) {
        state = .failed(error)
        continuation?.yield(.state(state))
        continuation?.finish(throwing: error)
        continuation = nil
    }

    private func isValid(size: NativeTerminalSize) -> Bool {
        size.columns > 0 && size.rows > 0
    }
    #endif
}
