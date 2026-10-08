import Foundation
import JunoCodeCore
import JunoScreenControl
#if canImport(Darwin)
import Darwin
#endif

/// What answers a bridge request; ``ComputerBridgeExecutor`` in the app.
public protocol ComputerBridgeHandling: Sendable {
    func handle(_ request: CodeV2.ComputerBridgeRequest) async -> CodeV2.ComputerBridgeResponse
}

/// The Mac end of the env server's computer bridge (Code v2 SPEC §3.12).
///
/// Subscription agents (Claude through the reader's own `claude`, Codex, ACP
/// agents) run in the env server and call Alevr's `computer_use` MCP tool;
/// the env server forwards each call here, because this app is what holds
/// Screen Recording and Accessibility, the grants, the cards and the stop.
///
/// A Unix socket in a 0700 folder (`bridge.sock`), one JSON
/// `ComputerBridgeRequest` per line in, one `ComputerBridgeResponse` per
/// line out, and a fresh random token in `bridge.token` (0600) on every
/// start that each request must carry: only this user's processes can read
/// it, and a stale env server from before a restart is refused.
public final class ComputerBridgeServer: @unchecked Sendable {
    public let directory: URL
    public var socketURL: URL { directory.appendingPathComponent("bridge.sock") }
    public var tokenURL: URL { directory.appendingPathComponent("bridge.token") }

    private let handler: any ComputerBridgeHandling
    private let lock = NSLock()
    private var listener: Int32 = -1
    private var token = ""
    private var running = false

    public init(directory: URL = DesktopLockFile.defaultDirectory, handler: any ComputerBridgeHandling) {
        self.directory = directory
        self.handler = handler
    }

    deinit { stop() }

    public enum StartError: Error, LocalizedError {
        case pathTooLong(String)
        case socket(String)

        public var errorDescription: String? {
            switch self {
            case let .pathTooLong(path): "The computer bridge socket path is too long: \(path)"
            case let .socket(message): "The computer bridge could not start: \(message)"
            }
        }
    }

    public var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return running
    }

    public func start() throws {
        lock.lock()
        defer { lock.unlock() }
        guard !running else { return }
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)

        token = Self.randomToken()
        let tokenData = Data(token.utf8)
        try? fm.removeItem(at: tokenURL)
        guard fm.createFile(atPath: tokenURL.path, contents: tokenData, attributes: [.posixPermissions: 0o600]) else {
            throw StartError.socket("cannot write \(tokenURL.path)")
        }

        let path = socketURL.path
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw StartError.socket(String(cString: strerror(errno))) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard path.utf8.count < capacity else {
            close(fd)
            throw StartError.pathTooLong(path)
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: path.utf8)
            raw[path.utf8.count] = 0
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, listen(fd, 16) == 0 else {
            let message = String(cString: strerror(errno))
            close(fd)
            throw StartError.socket(message)
        }
        chmod(path, 0o600)
        listener = fd
        running = true
        let thread = Thread { [weak self] in self?.acceptLoop(fd) }
        thread.name = "Alevr computer bridge"
        thread.start()
    }

    public func stop() {
        lock.lock()
        let fd = listener
        let wasRunning = running
        listener = -1
        running = false
        lock.unlock()
        guard wasRunning else { return }
        if fd >= 0 {
            shutdown(fd, SHUT_RDWR)
            close(fd)
        }
        unlink(socketURL.path)
        try? FileManager.default.removeItem(at: tokenURL)
    }

    // MARK: - Connections

    private func acceptLoop(_ fd: Int32) {
        while isRunning {
            let client = accept(fd, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                return
            }
            var on: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            let thread = Thread { [weak self] in self?.serve(client) }
            thread.name = "Alevr computer bridge client"
            thread.start()
        }
    }

    /// One connection: requests in order, each answered before the next is read.
    private func serve(_ client: Int32) {
        defer { close(client) }
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = read(client, &chunk, chunk.count)
            if count <= 0 { return }
            buffer.append(contentsOf: chunk[0..<count])
            if buffer.count > 4 * 1024 * 1024 { return } // nobody sends that much
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<newline]
                buffer.removeSubrange(buffer.startIndex...newline)
                guard !line.allSatisfy({ $0 == 0x20 || $0 == 0x0D }) else { continue }
                let response = answer(Data(line))
                guard var data = try? JSONEncoder().encode(response) else { return }
                data.append(0x0A)
                let written = data.withUnsafeBytes { raw -> Int in
                    var offset = 0
                    while offset < raw.count {
                        let n = write(client, raw.baseAddress! + offset, raw.count - offset)
                        if n <= 0 { return -1 }
                        offset += n
                    }
                    return offset
                }
                if written < 0 { return }
            }
        }
    }

    /// Decodes, checks the token, and waits for the handler on this thread
    /// (a connection thread of our own, never the cooperative pool).
    private func answer(_ line: Data) -> CodeV2.ComputerBridgeResponse {
        guard let request = try? JSONDecoder().decode(CodeV2.ComputerBridgeRequest.self, from: line) else {
            let id = (try? JSONSerialization.jsonObject(with: line) as? [String: Any])?["id"] as? String ?? "?"
            return CodeV2.ComputerBridgeResponse(id: id, ok: false, text: "The request was not a computer bridge request.")
        }
        lock.lock()
        let expected = token
        lock.unlock()
        guard Self.constantTimeEqual(request.token, expected) else {
            return CodeV2.ComputerBridgeResponse(
                id: request.id, ok: false,
                text: "The computer bridge token is out of date. Restart the agent so it reads the new one.",
                endsTurn: true
            )
        }
        let box = ResponseBox()
        let semaphore = DispatchSemaphore(value: 0)
        let handler = self.handler
        Task.detached {
            box.value = await handler.handle(request)
            semaphore.signal()
        }
        semaphore.wait()
        return box.value ?? CodeV2.ComputerBridgeResponse(id: request.id, ok: false, text: "The screen action did not finish.")
    }

    private final class ResponseBox: @unchecked Sendable {
        var value: CodeV2.ComputerBridgeResponse?
    }

    static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        arc4random_buf(&bytes, bytes.count)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8)
        let y = Array(b.utf8)
        guard x.count == y.count, !y.isEmpty else { return false }
        var difference: UInt8 = 0
        for index in x.indices { difference |= x[index] ^ y[index] }
        return difference == 0
    }
}
