import Darwin
import Foundation
import JunoCodeCore

/// A small, pure-Swift HTTP server for previewing a static site.
///
/// It runs in-process with no external dependencies, binds only to
/// `127.0.0.1` on an ephemeral port, and knows its own URL. What it serves is
/// project output, and the port is reachable by every page open in every
/// browser on the Mac, so it is built to give away nothing that is not the
/// site (CODE_AGENT_SPEC §4.5, PV-29…32):
///
/// - Secrets never leave: dotfiles and dot-folders, `node_modules`, `.git`,
///   `*.pem`, `*.key` and `.env*` answer 404, checked on the path asked for and
///   on the path a symlink resolves to.
/// - No other origin can read a response: there is no
///   `Access-Control-Allow-Origin`, and a request whose `Host` is not this
///   server's own loopback authority is refused, which also stops DNS
///   rebinding.
/// - A browser that hangs up mid-file cannot kill Juno: every socket carries
///   `SO_NOSIGPIPE`, so a write to a closed peer is an error, not a signal.
/// - Large files arrive whole: writes wait with `poll` until the peer can take
///   more, files are streamed in chunks rather than read whole, and `Range` is
///   answered so a video can seek.
/// - Saving a file reloads the page: served HTML carries a one-line
///   Server-Sent Events client, and a change under the root pushes a reload.
public final class StaticPreviewServer: @unchecked Sendable {
    public let staticRootURL: URL
    public let port: UInt16
    public let url: URL

    /// The event stream the injected client listens to.
    public static let liveReloadPath = "/__juno/live-reload"
    /// The attribute on the injected `<script>`, so a test or the pane can
    /// recognise it.
    public static let liveReloadMarker = "data-juno-live-reload"

    private let listeningSocket: Int32
    private let dispatchSource: DispatchSourceRead
    private let lock = NSLock()
    private var isRunning = true
    private var activeClientSockets: Set<Int32> = []
    private var eventStreamClients: Set<Int32> = []
    private var watcher: Task<Void, Never>?
    private let changeDetector: WorkspaceChangeDetector
    /// How often the root is rescanned while a page is listening for reloads.
    private let watchInterval: Duration

    /// Bytes per write while streaming a file.
    static let chunkSize = 64 * 1_024
    /// How long one write may wait for a slow reader before the transfer is
    /// abandoned.
    static let writeTimeoutMilliseconds: Int32 = 10_000
    /// How long a client has to send its request line and headers.
    static let readTimeoutMilliseconds: Int32 = 5_000
    /// HTML above this is served as-is, without the live-reload client.
    static let maximumInjectedHTMLBytes = 8 * 1_024 * 1_024

    public init(staticRootURL: URL, watchInterval: Duration = .seconds(1)) throws {
        let root = staticRootURL.resolvingSymlinksInPath().standardizedFileURL
        self.staticRootURL = root
        self.watchInterval = watchInterval
        self.changeDetector = WorkspaceChangeDetector(rootURL: root, fileCeiling: 5_000)

        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else {
            throw StaticPreviewServerError.socketCreationFailed(errno: errno)
        }

        var one: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

        let flags = fcntl(sock, F_GETFL, 0)
        _ = fcntl(sock, F_SETFL, flags | O_NONBLOCK)

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockAddrPtr in
                Darwin.bind(sock, sockAddrPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            Darwin.close(sock)
            throw StaticPreviewServerError.bindFailed(errno: errno)
        }

        guard Darwin.listen(sock, 128) == 0 else {
            Darwin.close(sock)
            throw StaticPreviewServerError.listenFailed(errno: errno)
        }

        var boundAddr = sockaddr_in()
        var boundAddrLen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let sockNameResult = withUnsafeMutablePointer(to: &boundAddr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockAddrPtr in
                Darwin.getsockname(sock, sockAddrPtr, &boundAddrLen)
            }
        }
        guard sockNameResult == 0 else {
            Darwin.close(sock)
            throw StaticPreviewServerError.getsocknameFailed(errno: errno)
        }

        let allocatedPort = UInt16(bigEndian: boundAddr.sin_port)
        self.listeningSocket = sock
        self.port = allocatedPort
        guard let serverURL = URL(string: "http://127.0.0.1:\(allocatedPort)/") else {
            Darwin.close(sock)
            throw StaticPreviewServerError.invalidURLGenerated(port: allocatedPort)
        }
        self.url = serverURL

        let source = DispatchSource.makeReadSource(
            fileDescriptor: sock,
            queue: DispatchQueue.global(qos: .userInitiated)
        )
        self.dispatchSource = source

        source.setEventHandler { [weak self] in
            self?.acceptConnections()
        }
        source.setCancelHandler {
            Darwin.close(sock)
        }
        source.resume()
    }

    deinit {
        stop()
    }

    public func stop() {
        lock.lock()
        guard isRunning else {
            lock.unlock()
            return
        }
        isRunning = false
        let clients = activeClientSockets.union(eventStreamClients)
        activeClientSockets.removeAll()
        eventStreamClients.removeAll()
        let watcher = self.watcher
        self.watcher = nil
        lock.unlock()

        watcher?.cancel()
        dispatchSource.cancel()
        for clientSock in clients {
            Darwin.close(clientSock)
        }
    }

    /// Pages currently listening for reloads.
    public var liveReloadClientCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return eventStreamClients.count
    }

    /// Tells every listening page to reload now.
    public func notifyReload() {
        lock.lock()
        let clients = eventStreamClients
        lock.unlock()
        let message = Data("event: reload\ndata: reload\n\n".utf8)
        for client in clients where !Self.writeAll(message, to: client) {
            dropEventStream(client)
        }
    }

    // MARK: - Accepting

    private func acceptConnections() {
        while true {
            var clientAddr = sockaddr_in()
            var clientAddrLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientSock = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockAddrPtr in
                    Darwin.accept(listeningSocket, sockAddrPtr, &clientAddrLen)
                }
            }
            guard clientSock >= 0 else { break }

            // A peer that hangs up must produce EPIPE, never SIGPIPE: the
            // default action of SIGPIPE terminates the whole app (PV-30).
            var one: Int32 = 1
            setsockopt(clientSock, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            let flags = fcntl(clientSock, F_GETFL, 0)
            _ = fcntl(clientSock, F_SETFL, flags | O_NONBLOCK)

            guard track(clientSock) else {
                Darwin.close(clientSock)
                break
            }
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else {
                    Darwin.close(clientSock)
                    return
                }
                let keepOpen = self.handleClient(clientSock)
                self.untrack(clientSock, closing: !keepOpen)
            }
        }
    }

    private func track(_ sock: Int32) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard isRunning else { return false }
        activeClientSockets.insert(sock)
        return true
    }

    private func untrack(_ sock: Int32, closing: Bool) {
        lock.lock()
        let wasTracked = activeClientSockets.remove(sock) != nil
        lock.unlock()
        // `stop()` already closed it when it is no longer tracked.
        if closing, wasTracked {
            Darwin.close(sock)
        }
    }

    // MARK: - Requests

    struct Request: Equatable {
        var method: String
        var target: String
        var headers: [String: String]
    }

    /// Reads one request and answers it. Returns true when the socket now
    /// belongs to the live-reload stream and must stay open.
    private func handleClient(_ clientSock: Int32) -> Bool {
        guard let raw = Self.readRequestHead(from: clientSock) else { return false }
        guard let request = Self.parseRequest(raw) else {
            respond(clientSock, status: 400, text: "Bad Request")
            return false
        }
        return route(request, on: clientSock)
    }

    /// Reads until the blank line that ends the headers, waiting with `poll`
    /// rather than spinning. Nil when the peer sends nothing usable in time.
    static func readRequestHead(from sock: Int32) -> String? {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        let maximum = 64 * 1_024
        let deadline = Date().addingTimeInterval(Double(readTimeoutMilliseconds) / 1_000)
        while Date() < deadline {
            let count = Darwin.read(sock, &buffer, buffer.count)
            if count > 0 {
                data.append(buffer, count: count)
                if data.count > maximum { return nil }
                if let text = String(data: data, encoding: .utf8),
                   text.contains("\r\n\r\n") || text.contains("\n\n")
                {
                    return text
                }
            } else if count == 0 {
                return nil
            } else if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR {
                let remaining = Int32(max(1, deadline.timeIntervalSinceNow * 1_000))
                var descriptor = pollfd(fd: sock, events: Int16(POLLIN), revents: 0)
                if poll(&descriptor, 1, remaining) <= 0 { return nil }
            } else {
                return nil
            }
        }
        return nil
    }

    static func parseRequest(_ raw: String) -> Request? {
        let lines = raw.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        guard let first = lines.first else { return nil }
        let parts = first.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if line.isEmpty { break }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        return Request(method: String(parts[0]).uppercased(), target: String(parts[1]), headers: headers)
    }

    /// Whether `host` is this server's own loopback authority. Anything else is
    /// another site's page (or a rebound DNS name) reaching for the port.
    func acceptsHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "127.0.0.1:\(port)" || host == "localhost:\(port)"
    }

    private func route(_ request: Request, on clientSock: Int32) -> Bool {
        guard acceptsHost(request.headers["host"]) else {
            respond(clientSock, status: 421, text: "Misdirected Request")
            return false
        }
        guard request.method == "GET" || request.method == "HEAD" else {
            respond(clientSock, status: 405, text: "Method Not Allowed", extraHeaders: ["Allow": "GET, HEAD"])
            return false
        }

        let rawPath = request.target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? request.target
        if rawPath == Self.liveReloadPath {
            return openEventStream(clientSock)
        }
        guard let decodedPath = rawPath.removingPercentEncoding else {
            respond(clientSock, status: 400, text: "Invalid URL Encoding")
            return false
        }
        if decodedPath.contains("\0") {
            respond(clientSock, status: 400, text: "Null byte in path")
            return false
        }

        let components = decodedPath.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if components.contains("..") || components.contains(".") {
            respond(clientSock, status: 403, text: "Forbidden: Directory traversal is not permitted")
            return false
        }
        if Self.isDenied(components) {
            respond(clientSock, status: 404, text: "Not Found")
            return false
        }

        let relativePath = components.isEmpty ? "index.html" : components.joined(separator: "/")
        guard let fileURL = resolve(relativePath) else {
            respond(clientSock, status: 404, text: "Not Found")
            return false
        }
        serveFile(at: fileURL, request: request, on: clientSock)
        return false
    }

    /// Paths that are never served, whatever the root: secrets and the
    /// machinery around a project, not its site. Checked per path component.
    static func isDenied(_ components: [String]) -> Bool {
        for component in components {
            let lowered = component.lowercased()
            // `.well-known` is site content by definition; every other dot
            // name (`.env`, `.git`, `.npmrc`, `.ssh`) is not.
            if lowered.hasPrefix("."), lowered != ".well-known" { return true }
            if lowered == "node_modules" { return true }
        }
        guard let last = components.last?.lowercased() else { return false }
        if last.hasPrefix(".env") { return true }
        return ["pem", "key", "p12", "pfx"].contains((last as NSString).pathExtension)
    }

    /// The file `relativePath` names inside the root, following an
    /// `index.html` for a folder and a `.html` for an extensionless page. Nil
    /// when there is none, or when a symlink would lead outside the root or to
    /// a denied path.
    private func resolve(_ relativePath: String) -> URL? {
        let canonicalRoot = staticRootURL
        func inside(_ url: URL) -> URL? {
            let resolved = url.resolvingSymlinksInPath().standardizedFileURL
            guard resolved.path == canonicalRoot.path || resolved.path.hasPrefix(canonicalRoot.path + "/") else {
                return nil
            }
            let relative = resolved.path == canonicalRoot.path
                ? []
                : String(resolved.path.dropFirst(canonicalRoot.path.count + 1)).split(separator: "/").map(String.init)
            return Self.isDenied(relative) ? nil : resolved
        }

        let candidate = canonicalRoot.appendingPathComponent(relativePath)
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) {
            guard let resolved = inside(candidate) else { return nil }
            if isDirectory.boolValue {
                let index = resolved.appendingPathComponent("index.html")
                return FileManager.default.fileExists(atPath: index.path) ? inside(index) : nil
            }
            return resolved
        }
        guard candidate.pathExtension.isEmpty else { return nil }
        let html = candidate.appendingPathExtension("html")
        return FileManager.default.fileExists(atPath: html.path) ? inside(html) : nil
    }

    // MARK: - Responses

    private static let commonHeaders: [String: String] = [
        "Connection": "close",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "X-Content-Type-Options": "nosniff",
    ]

    private func respond(
        _ sock: Int32,
        status: Int,
        text: String,
        extraHeaders: [String: String] = [:]
    ) {
        let body = Data("\(status) \(text)".utf8)
        var headers = Self.commonHeaders.merging(extraHeaders) { _, new in new }
        headers["Content-Type"] = "text/plain; charset=utf-8"
        headers["Content-Length"] = "\(body.count)"
        _ = Self.writeAll(Self.head(status: status, reason: text, headers: headers), to: sock)
        _ = Self.writeAll(body, to: sock)
    }

    static func head(status: Int, reason: String, headers: [String: String]) -> Data {
        var text = "HTTP/1.1 \(status) \(reason)\r\n"
        for name in headers.keys.sorted() {
            text += "\(name): \(headers[name] ?? "")\r\n"
        }
        text += "\r\n"
        return Data(text.utf8)
    }

    private func serveFile(at fileURL: URL, request: Request, on sock: Int32) {
        let mimeType = Self.mimeType(for: fileURL.pathExtension.lowercased())
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let size = (attributes[.size] as? NSNumber)?.intValue
        else {
            respond(sock, status: 500, text: "Could not read file")
            return
        }
        var headers = Self.commonHeaders
        headers["Content-Type"] = mimeType
        let isHead = request.method == "HEAD"

        // HTML gets the live-reload client, so it is served whole.
        if mimeType.hasPrefix("text/html"), size <= Self.maximumInjectedHTMLBytes,
           let data = try? Data(contentsOf: fileURL)
        {
            let body = Self.injectingLiveReload(into: data)
            headers["Content-Length"] = "\(body.count)"
            guard Self.writeAll(Self.head(status: 200, reason: "OK", headers: headers), to: sock), !isHead else { return }
            _ = Self.writeAll(body, to: sock)
            return
        }

        headers["Accept-Ranges"] = "bytes"
        var range = 0..<size
        var status = 200
        var reason = "OK"
        if let header = request.headers["range"] {
            switch Self.parseRange(header, size: size) {
            case let .satisfiable(requested):
                range = requested
                status = 206
                reason = "Partial Content"
                headers["Content-Range"] = "bytes \(requested.lowerBound)-\(requested.upperBound - 1)/\(size)"
            case .unsatisfiable:
                headers["Content-Range"] = "bytes */\(size)"
                headers["Content-Length"] = "0"
                _ = Self.writeAll(Self.head(status: 416, reason: "Range Not Satisfiable", headers: headers), to: sock)
                return
            case .ignored:
                break
            }
        }
        headers["Content-Length"] = "\(range.count)"
        guard Self.writeAll(Self.head(status: status, reason: reason, headers: headers), to: sock), !isHead else { return }
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: UInt64(range.lowerBound))
            var remaining = range.count
            while remaining > 0 {
                guard let chunk = try handle.read(upToCount: min(Self.chunkSize, remaining)), !chunk.isEmpty else { return }
                guard Self.writeAll(chunk, to: sock) else { return }
                remaining -= chunk.count
            }
        } catch {
            return
        }
    }

    enum RangeRequest: Equatable {
        case satisfiable(Range<Int>)
        case unsatisfiable
        /// Not a single byte range Juno answers; the whole file is sent.
        case ignored
    }

    /// One `bytes=` range: `a-b`, `a-` or `-n`. Multiple ranges are ignored,
    /// which RFC 9110 allows.
    static func parseRange(_ header: String, size: Int) -> RangeRequest {
        let value = header.trimmingCharacters(in: .whitespaces)
        guard value.lowercased().hasPrefix("bytes="), !value.contains(",") else { return .ignored }
        let spec = value.dropFirst(6)
        let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return .ignored }
        let first = parts[0].trimmingCharacters(in: .whitespaces)
        let second = parts[1].trimmingCharacters(in: .whitespaces)
        if first.isEmpty {
            guard let suffix = Int(second), suffix > 0, size > 0 else { return .unsatisfiable }
            return .satisfiable(max(0, size - suffix)..<size)
        }
        guard let start = Int(first), start >= 0 else { return .ignored }
        guard start < size else { return .unsatisfiable }
        if second.isEmpty { return .satisfiable(start..<size) }
        guard let end = Int(second), end >= start else { return .ignored }
        return .satisfiable(start..<min(end + 1, size))
    }

    /// `html` with the one-line live-reload client before `</body>`, or at
    /// the end when there is none.
    static func injectingLiveReload(into html: Data) -> Data {
        let script = "<script \(liveReloadMarker)>(()=>{try{const s=new EventSource(\"\(liveReloadPath)\");s.addEventListener(\"reload\",()=>location.reload());}catch(_){}})();</script>"
        guard let text = String(data: html, encoding: .utf8) else { return html }
        if let range = text.range(of: "</body>", options: [.caseInsensitive, .backwards]) {
            var copy = text
            copy.insert(contentsOf: script, at: range.lowerBound)
            return Data(copy.utf8)
        }
        return Data((text + script).utf8)
    }

    // MARK: - Live reload

    private func openEventStream(_ sock: Int32) -> Bool {
        var headers = Self.commonHeaders
        headers["Connection"] = "keep-alive"
        headers["Content-Type"] = "text/event-stream"
        guard Self.writeAll(Self.head(status: 200, reason: "OK", headers: headers), to: sock),
              Self.writeAll(Data(": connected\n\n".utf8), to: sock)
        else { return false }
        lock.lock()
        guard isRunning else {
            lock.unlock()
            return false
        }
        activeClientSockets.remove(sock)
        eventStreamClients.insert(sock)
        let startWatcher = watcher == nil
        lock.unlock()
        if startWatcher { startWatching() }
        return true
    }

    private func dropEventStream(_ sock: Int32) {
        lock.lock()
        let removed = eventStreamClients.remove(sock) != nil
        lock.unlock()
        if removed { Darwin.close(sock) }
    }

    /// Rescans the root while a page listens, and pushes a reload when a file
    /// changed. Stops itself when the last listener leaves.
    private func startWatching() {
        let detector = changeDetector
        let interval = watchInterval
        let task = Task.detached(priority: .utility) { [weak self] in
            var previous = await detector.snapshot()
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard let self, !Task.isCancelled else { return }
                if self.liveReloadClientCount == 0 {
                    self.clearWatcher()
                    return
                }
                let next = await detector.snapshot()
                if WorkspaceChangeReport.comparing(before: previous, after: next).isEmpty {
                    // A comment line finds peers that went away.
                    self.heartbeat()
                } else {
                    self.notifyReload()
                }
                previous = next
            }
        }
        lock.lock()
        watcher = task
        lock.unlock()
    }

    private func clearWatcher() {
        lock.lock()
        watcher = nil
        lock.unlock()
    }

    private func heartbeat() {
        lock.lock()
        let clients = eventStreamClients
        lock.unlock()
        for client in clients where !Self.writeAll(Data(": ping\n\n".utf8), to: client) {
            dropEventStream(client)
        }
    }

    // MARK: - Writing

    /// Writes every byte of `data`, waiting with `poll` whenever the socket's
    /// buffer is full. False when the peer went away or stalled past the
    /// timeout; never raises SIGPIPE (the socket carries `SO_NOSIGPIPE`).
    static func writeAll(_ data: Data, to sock: Int32) -> Bool {
        data.withUnsafeBytes { buffer -> Bool in
            guard let base = buffer.baseAddress else { return true }
            var written = 0
            let total = buffer.count
            while written < total {
                let count = Darwin.write(sock, base + written, total - written)
                if count > 0 {
                    written += count
                    continue
                }
                if count < 0, errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR {
                    var descriptor = pollfd(fd: sock, events: Int16(POLLOUT), revents: 0)
                    let ready = poll(&descriptor, 1, writeTimeoutMilliseconds)
                    if ready <= 0 || descriptor.revents & Int16(POLLERR | POLLHUP | POLLNVAL) != 0 {
                        return false
                    }
                    continue
                }
                return false
            }
            return true
        }
    }

    static func mimeType(for fileExtension: String) -> String {
        switch fileExtension {
        case "html", "htm": return "text/html; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "avif": return "image/avif"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "wasm": return "application/wasm"
        case "txt": return "text/plain; charset=utf-8"
        case "xml": return "application/xml; charset=utf-8"
        case "pdf": return "application/pdf"
        case "mp4": return "video/mp4"
        case "webm": return "video/webm"
        case "mp3": return "audio/mpeg"
        default: return "application/octet-stream"
        }
    }
}

public enum StaticPreviewServerError: Error, LocalizedError, Sendable {
    case socketCreationFailed(errno: Int32)
    case bindFailed(errno: Int32)
    case listenFailed(errno: Int32)
    case getsocknameFailed(errno: Int32)
    case invalidURLGenerated(port: UInt16)

    public var errorDescription: String? {
        switch self {
        case let .socketCreationFailed(err):
            return "Failed to create local preview socket (errno: \(err))."
        case let .bindFailed(err):
            return "Failed to bind local loopback port for preview server (errno: \(err))."
        case let .listenFailed(err):
            return "Failed to listen on preview socket (errno: \(err))."
        case let .getsocknameFailed(err):
            return "Failed to retrieve allocated ephemeral port (errno: \(err))."
        case let .invalidURLGenerated(port):
            return "Invalid preview URL generated for port \(port)."
        }
    }
}
