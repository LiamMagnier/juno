import Foundation

/// The MCP stdio transport. It launches the configured command directly via
/// `/usr/bin/env` (never a shell), sends one UTF-8 JSON-RPC line per request,
/// drains stderr, and exposes stdout one line at a time.
public actor MCPStdioTransport: MCPLineTransport {
    private let configuration: MCPServerConfiguration
    private let workspaceRootURL: URL

    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var errorOutput: FileHandle?
    private var incomingInbox: MCPLineInbox?
    private var readTask: Task<Void, Never>?
    private var stderrTask: Task<Void, Never>?

    public init(configuration: MCPServerConfiguration, workspaceRootURL: URL) {
        self.configuration = configuration
        self.workspaceRootURL = workspaceRootURL.standardizedFileURL
    }

    deinit {
        readTask?.cancel()
        stderrTask?.cancel()
        input?.closeFile()
        output?.closeFile()
        errorOutput?.closeFile()
        if let process, process.isRunning {
            process.terminate()
        }
    }

    public func start() async throws {
        guard process == nil else { throw MCPError.alreadyConnected }
        guard configuration.enabled else {
            throw MCPError.disabledServer(configuration.name)
        }

        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [configuration.command] + configuration.arguments
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        // Never hand a repository-declared program Juno's complete process
        // environment. In particular, API tokens and deployment credentials
        // may be present on the desktop process even though this MCP definition
        // came from an untrusted checkout. Keep only normal execution locale /
        // path values, then add the values the reader reviewed in the config.
        let inherited = ProcessInfo.processInfo.environment
        var environment: [String: String] = [:]
        for key in ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] {
            if let value = inherited[key], !value.isEmpty {
                environment[key] = value
            }
        }
        environment["PATH"] = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        for (key, value) in configuration.environment {
            environment[key] = value
        }
        process.environment = environment

        if let workingDirectory = configuration.workingDirectory {
            process.currentDirectoryURL = workspaceRootURL.appendingPathComponent(
                workingDirectory,
                isDirectory: true
            )
        } else {
            process.currentDirectoryURL = workspaceRootURL
        }

        do {
            try process.run()
        } catch {
            throw MCPError.transportFailure(
                "could not start '\(configuration.command)': \(error.localizedDescription)"
            )
        }

        self.process = process
        self.input = inputPipe.fileHandleForWriting
        self.output = outputPipe.fileHandleForReading
        self.errorOutput = errorPipe.fileHandleForReading

        let inbox = MCPLineInbox()
        incomingInbox = inbox

        let outputHandle = outputPipe.fileHandleForReading
        readTask = Task.detached(priority: .utility) {
            await Self.readLines(from: outputHandle, inbox: inbox)
        }

        let errorHandle = errorPipe.fileHandleForReading
        stderrTask = Task.detached(priority: .utility) {
            Self.drain(handle: errorHandle)
        }
    }

    public func send(line: String) async throws {
        guard process != nil, let input else { throw MCPError.notConnected }
        guard !line.contains("\n"), !line.contains("\r") else {
            throw MCPError.malformedMessage("stdio messages may not contain embedded newlines")
        }
        guard let data = (line + "\n").data(using: .utf8) else {
            throw MCPError.transportFailure("message was not valid UTF-8")
        }
        do {
            try input.write(contentsOf: data)
        } catch {
            throw MCPError.transportFailure("could not write to MCP stdin: \(error.localizedDescription)")
        }
    }

    public func receiveLine() async throws -> String? {
        guard process != nil, let incomingInbox else {
            throw MCPError.notConnected
        }
        return try await incomingInbox.next()
    }

    public func close() async {
        readTask?.cancel()
        stderrTask?.cancel()
        await incomingInbox?.finish(error: .transportClosed)
        incomingInbox = nil

        input?.closeFile()
        output?.closeFile()
        errorOutput?.closeFile()
        input = nil
        output = nil
        errorOutput = nil

        if let process, process.isRunning {
            process.terminate()
        }
        self.process = nil
        readTask = nil
        stderrTask = nil
    }

    private static func readLines(
        from handle: FileHandle,
        inbox: MCPLineInbox
    ) async {
        var buffer = Data()
        do {
            while !Task.isCancelled {
                guard let chunk = try handle.read(upToCount: 16 * 1024), !chunk.isEmpty else {
                    break
                }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0A) {
                    var lineData = buffer.subdata(in: 0..<newline)
                    buffer.removeSubrange(0...newline)
                    if lineData.last == 0x0D { lineData.removeLast() }
                    guard let line = String(data: lineData, encoding: .utf8) else {
                        await inbox.finish(
                            error: .transportFailure("MCP stdout was not UTF-8")
                        )
                        return
                    }
                    await inbox.yield(line)
                }
            }

            if !buffer.isEmpty, let line = String(data: buffer, encoding: .utf8) {
                await inbox.yield(line)
            }
            await inbox.finish()
        } catch {
            if !Task.isCancelled {
                await inbox.finish(
                    error: .transportFailure(error.localizedDescription)
                )
            } else {
                await inbox.finish()
            }
        }
    }

    private static func drain(handle: FileHandle) {
        do {
            while !Task.isCancelled {
                guard let chunk = try handle.read(upToCount: 16 * 1024), !chunk.isEmpty else { break }
            }
        } catch {
            // stderr is diagnostic-only; a closed pipe is expected during shutdown.
        }
    }
}

/// Owns the non-Sendable `AsyncThrowingStream` replacement used by the stdio
/// reader. Keeping the waiters and buffered lines in an actor avoids sending a
/// stream iterator out of `MCPStdioTransport`'s isolation region under Swift 6.
private actor MCPLineInbox {
    private var bufferedLines: [String] = []
    private var waiters: [CheckedContinuation<String?, Error>] = []
    private var terminalError: MCPError?
    private var isFinished = false

    func yield(_ line: String) {
        guard !isFinished else { return }
        if let waiter = waiters.first {
            waiters.removeFirst()
            waiter.resume(returning: line)
        } else {
            bufferedLines.append(line)
        }
    }

    func next() async throws -> String? {
        if !bufferedLines.isEmpty {
            return bufferedLines.removeFirst()
        }
        if let terminalError { throw terminalError }
        if isFinished { return nil }
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String?, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiters.append(continuation)
                }
            }
        }, onCancel: {
            Task { await self.cancelNextWaiter() }
        })
    }

    private func cancelNextWaiter() {
        guard !waiters.isEmpty else { return }
        let waiter = waiters.removeFirst()
        waiter.resume(throwing: CancellationError())
    }

    func finish(error: MCPError? = nil) {
        guard !isFinished else { return }
        isFinished = true
        terminalError = error
        let pending = waiters
        waiters.removeAll(keepingCapacity: false)
        for waiter in pending {
            if let error {
                waiter.resume(throwing: error)
            } else {
                waiter.resume(returning: nil)
            }
        }
    }
}
