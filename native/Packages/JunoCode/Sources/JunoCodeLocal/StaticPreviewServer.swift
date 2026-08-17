import Darwin
import Foundation

/// A lightweight, pure-Swift HTTP server for serving local static websites in
/// Juno Code.
///
/// It runs in-process with zero external dependencies (no Python, no Node, no
/// npx), binds exclusively to loopback (`127.0.0.1`) on an OS-allocated
/// ephemeral port, enforces strict directory containment against path traversal
/// attacks, and provides immediate authoritative URL knowledge.
public final class StaticPreviewServer: @unchecked Sendable {
    public let staticRootURL: URL
    public let port: UInt16
    public let url: URL

    private let listeningSocket: Int32
    private let dispatchSource: DispatchSourceRead
    private let isRunningLock = NSLock()
    private var isRunning = true
    private let activeClientsLock = NSLock()
    private var activeClientSockets: Set<Int32> = []

    public init(staticRootURL: URL) throws {
        self.staticRootURL = staticRootURL.resolvingSymlinksInPath().standardizedFileURL

        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else {
            throw StaticPreviewServerError.socketCreationFailed(errno: errno)
        }

        var opt: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))

        // Set non-blocking on listening socket
        let flags = fcntl(sock, F_GETFL, 0)
        _ = fcntl(sock, F_SETFL, flags | O_NONBLOCK)

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0 // Ephemeral port assigned by OS
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
        isRunningLock.lock()
        guard isRunning else {
            isRunningLock.unlock()
            return
        }
        isRunning = false
        isRunningLock.unlock()

        dispatchSource.cancel()

        activeClientsLock.lock()
        let clients = activeClientSockets
        activeClientSockets.removeAll()
        activeClientsLock.unlock()

        for clientSock in clients {
            Darwin.close(clientSock)
        }
    }

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

            // Ensure non-blocking on client socket
            let flags = fcntl(clientSock, F_GETFL, 0)
            _ = fcntl(clientSock, F_SETFL, flags | O_NONBLOCK)

            trackClient(clientSock)
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.handleClient(clientSock)
            }
        }
    }

    private func trackClient(_ sock: Int32) {
        activeClientsLock.lock()
        activeClientSockets.insert(sock)
        activeClientsLock.unlock()
    }

    private func untrackClient(_ sock: Int32) {
        activeClientsLock.lock()
        activeClientSockets.remove(sock)
        activeClientsLock.unlock()
    }

    private func handleClient(_ clientSock: Int32) {
        defer {
            untrackClient(clientSock)
            Darwin.close(clientSock)
        }

        var requestData = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        let maxRequestSize = 64 * 1024
        let deadline = Date().addingTimeInterval(2.0)

        while Date() < deadline {
            let bytesRead = Darwin.read(clientSock, &buffer, buffer.count)
            if bytesRead > 0 {
                requestData.append(buffer, count: bytesRead)
                if requestData.count > maxRequestSize {
                    sendResponse(
                        clientSock: clientSock,
                        statusCode: 413,
                        statusText: "Payload Too Large",
                        headers: ["Connection": "close"],
                        body: Data("413 Payload Too Large".utf8)
                    )
                    return
                }
                if let requestString = String(data: requestData, encoding: .utf8),
                   requestString.contains("\r\n\r\n") || requestString.contains("\n\n")
                {
                    processRequest(requestString: requestString, clientSock: clientSock)
                    return
                }
            } else if bytesRead == 0 {
                return
            } else {
                if errno == EAGAIN || errno == EWOULDBLOCK {
                    usleep(5_000)
                    continue
                } else {
                    return
                }
            }
        }
    }

    private func processRequest(requestString: String, clientSock: Int32) {
        guard let firstLine = requestString.components(separatedBy: "\r\n").first
            ?? requestString.components(separatedBy: "\n").first
        else {
            sendResponse(
                clientSock: clientSock,
                statusCode: 400,
                statusText: "Bad Request",
                headers: ["Connection": "close"],
                body: Data("400 Bad Request".utf8)
            )
            return
        }

        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2 else {
            sendResponse(
                clientSock: clientSock,
                statusCode: 400,
                statusText: "Bad Request",
                headers: ["Connection": "close"],
                body: Data("400 Bad Request".utf8)
            )
            return
        }

        let method = String(parts[0]).uppercased()
        let rawTarget = String(parts[1])

        guard method == "GET" || method == "HEAD" else {
            sendResponse(
                clientSock: clientSock,
                statusCode: 405,
                statusText: "Method Not Allowed",
                headers: [
                    "Allow": "GET, HEAD",
                    "Connection": "close",
                ],
                body: Data("405 Method Not Allowed".utf8)
            )
            return
        }

        let rawPath = rawTarget.split(separator: "?").first.map(String.init) ?? rawTarget
        guard let decodedPath = rawPath.removingPercentEncoding else {
            sendResponse(
                clientSock: clientSock,
                statusCode: 400,
                statusText: "Bad Request",
                headers: ["Connection": "close"],
                body: Data("400 Invalid URL Encoding".utf8)
            )
            return
        }

        // Security check: reject null bytes or path traversal
        if decodedPath.contains("\0") || decodedPath.contains("%00") {
            sendResponse(
                clientSock: clientSock,
                statusCode: 400,
                statusText: "Bad Request",
                headers: ["Connection": "close"],
                body: Data("400 Null byte in path".utf8)
            )
            return
        }

        let pathComponents = decodedPath.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if pathComponents.contains("..") || pathComponents.contains(".") {
            sendResponse(
                clientSock: clientSock,
                statusCode: 403,
                statusText: "Forbidden",
                headers: ["Connection": "close"],
                body: Data("403 Forbidden: Directory traversal is not permitted".utf8)
            )
            return
        }

        var relativePath = pathComponents.joined(separator: "/")
        if relativePath.isEmpty {
            relativePath = "index.html"
        }

        let candidateURL = staticRootURL.appendingPathComponent(relativePath)
        let resolvedURL = candidateURL.resolvingSymlinksInPath().standardizedFileURL
        let canonicalRoot = staticRootURL.resolvingSymlinksInPath().standardizedFileURL

        // Strict boundary confinement check
        guard resolvedURL.path == canonicalRoot.path || resolvedURL.path.hasPrefix(canonicalRoot.path + "/") else {
            sendResponse(
                clientSock: clientSock,
                statusCode: 403,
                statusText: "Forbidden",
                headers: ["Connection": "close"],
                body: Data("403 Forbidden".utf8)
            )
            return
        }

        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: resolvedURL.path, isDirectory: &isDir) {
            if isDir.boolValue {
                // If requested a directory, look for index.html inside it
                let dirIndexURL = resolvedURL.appendingPathComponent("index.html")
                if FileManager.default.fileExists(atPath: dirIndexURL.path) {
                    serveFile(at: dirIndexURL, method: method, clientSock: clientSock)
                } else {
                    sendResponse(
                        clientSock: clientSock,
                        statusCode: 404,
                        statusText: "Not Found",
                        headers: ["Connection": "close"],
                        body: Data("404 Directory Index Not Found".utf8)
                    )
                }
            } else {
                serveFile(at: resolvedURL, method: method, clientSock: clientSock)
            }
        } else {
            // If file without extension, try appending .html
            if !resolvedURL.pathExtension.isEmpty {
                sendResponse(
                    clientSock: clientSock,
                    statusCode: 404,
                    statusText: "Not Found",
                    headers: ["Connection": "close"],
                    body: Data("404 Not Found".utf8)
                )
            } else {
                let htmlURL = resolvedURL.appendingPathExtension("html")
                if FileManager.default.fileExists(atPath: htmlURL.path) {
                    serveFile(at: htmlURL, method: method, clientSock: clientSock)
                } else {
                    sendResponse(
                        clientSock: clientSock,
                        statusCode: 404,
                        statusText: "Not Found",
                        headers: ["Connection": "close"],
                        body: Data("404 Not Found".utf8)
                    )
                }
            }
        }
    }

    private func serveFile(at fileURL: URL, method: String, clientSock: Int32) {
        guard let data = try? Data(contentsOf: fileURL) else {
            sendResponse(
                clientSock: clientSock,
                statusCode: 500,
                statusText: "Internal Server Error",
                headers: ["Connection": "close"],
                body: Data("500 Could not read file".utf8)
            )
            return
        }

        let mimeType = mimeTypeFor(fileExtension: fileURL.pathExtension.lowercased())
        let headers: [String: String] = [
            "Content-Type": mimeType,
            "Content-Length": "\(data.count)",
            "Connection": "close",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Access-Control-Allow-Origin": "*",
        ]

        if method == "HEAD" {
            sendResponse(
                clientSock: clientSock,
                statusCode: 200,
                statusText: "OK",
                headers: headers,
                body: nil
            )
        } else {
            sendResponse(
                clientSock: clientSock,
                statusCode: 200,
                statusText: "OK",
                headers: headers,
                body: data
            )
        }
    }

    private func sendResponse(
        clientSock: Int32,
        statusCode: Int,
        statusText: String,
        headers: [String: String],
        body: Data?
    ) {
        var headerString = "HTTP/1.1 \(statusCode) \(statusText)\r\n"
        for (name, value) in headers {
            headerString += "\(name): \(value)\r\n"
        }
        if body != nil && headers["Content-Length"] == nil {
            headerString += "Content-Length: \(body?.count ?? 0)\r\n"
        }
        headerString += "\r\n"

        var responseData = Data(headerString.utf8)
        if let body {
            responseData.append(body)
        }

        responseData.withUnsafeBytes { ptr in
            guard let base = ptr.baseAddress else { return }
            var written = 0
            let total = responseData.count
            while written < total {
                let count = Darwin.write(clientSock, base + written, total - written)
                if count <= 0 { break }
                written += count
            }
        }
    }

    private func mimeTypeFor(fileExtension: String) -> String {
        switch fileExtension {
        case "html", "htm":
            return "text/html; charset=utf-8"
        case "css":
            return "text/css; charset=utf-8"
        case "js", "mjs":
            return "text/javascript; charset=utf-8"
        case "json":
            return "application/json; charset=utf-8"
        case "svg":
            return "image/svg+xml"
        case "png":
            return "image/png"
        case "jpg", "jpeg":
            return "image/jpeg"
        case "gif":
            return "image/gif"
        case "webp":
            return "image/webp"
        case "ico":
            return "image/x-icon"
        case "woff":
            return "font/woff"
        case "woff2":
            return "font/woff2"
        case "ttf":
            return "font/ttf"
        case "otf":
            return "font/otf"
        case "wasm":
            return "application/wasm"
        case "txt":
            return "text/plain; charset=utf-8"
        case "xml":
            return "application/xml; charset=utf-8"
        case "pdf":
            return "application/pdf"
        case "mp4":
            return "video/mp4"
        case "webm":
            return "video/webm"
        case "mp3":
            return "audio/mpeg"
        case "map":
            return "application/json; charset=utf-8"
        default:
            return "application/octet-stream"
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
