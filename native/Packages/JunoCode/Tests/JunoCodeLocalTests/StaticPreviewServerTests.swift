import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import JunoCodeLocal

final class StaticPreviewServerTests: XCTestCase {
    private var workspaceURL: URL!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-static-preview-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        if let workspaceURL {
            try? FileManager.default.removeItem(at: workspaceURL)
        }
    }

    private func writeFile(_ relativePath: String, contents: String) throws {
        let fileURL = workspaceURL.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try contents.write(to: fileURL, atomically: true, encoding: .utf8)
    }

    func testStaticPreviewServerStartsOnEphemeralPortAndServesHTML() async throws {
        try writeFile("index.html", contents: "<!doctype html><html><body><h1>Hello Juno</h1></body></html>")

        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        XCTAssertGreaterThan(server.port, 0)
        XCTAssertEqual(server.url.absoluteString, "http://127.0.0.1:\(server.port)/")

        let (data, response) = try await URLSession.shared.data(from: server.url)
        let httpResponse = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(httpResponse.statusCode, 200)
        XCTAssertEqual(httpResponse.value(forHTTPHeaderField: "Content-Type"), "text/html; charset=utf-8")
        XCTAssertEqual(httpResponse.value(forHTTPHeaderField: "Cache-Control"), "no-cache, no-store, must-revalidate")
        let html = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(html.contains("Hello Juno"))
    }

    /// PV-29: no other origin may read what the server answers.
    func testNoResponseCarriesAWildcardCORSHeader() async throws {
        try writeFile("index.html", contents: "<html></html>")
        try writeFile("app.js", contents: "console.log(1)")
        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        for path in ["", "app.js", "missing.png"] {
            let (_, response) = try await URLSession.shared.data(from: server.url.appendingPathComponent(path))
            let http = try XCTUnwrap(response as? HTTPURLResponse)
            XCTAssertNil(http.value(forHTTPHeaderField: "Access-Control-Allow-Origin"), path)
        }
    }

    func testStaticPreviewServerServesMIMETypes() async throws {
        try writeFile("index.html", contents: "<html></html>")
        try writeFile("style.css", contents: "body { background: red; }")
        try writeFile("app.js", contents: "console.log('hi');")
        try writeFile("data.json", contents: "{\"ok\": true}")
        try writeFile("icon.svg", contents: "<svg></svg>")

        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        let cases: [(path: String, mime: String)] = [
            ("style.css", "text/css; charset=utf-8"),
            ("app.js", "text/javascript; charset=utf-8"),
            ("data.json", "application/json; charset=utf-8"),
            ("icon.svg", "image/svg+xml"),
        ]

        for item in cases {
            let url = server.url.appendingPathComponent(item.path)
            let (data, response) = try await URLSession.shared.data(from: url)
            let http = try XCTUnwrap(response as? HTTPURLResponse)
            XCTAssertEqual(http.statusCode, 200)
            XCTAssertEqual(http.value(forHTTPHeaderField: "Content-Type"), item.mime)
            XCTAssertFalse(data.isEmpty)
        }
    }

    /// PV-29: secrets and project machinery are never served.
    func testSecretsAndDotfilesAre404() async throws {
        try writeFile("index.html", contents: "<html></html>")
        try writeFile(".env", contents: "API_KEY=sk-live-secret")
        try writeFile(".env.local", contents: "TOKEN=secret")
        try writeFile(".git/config", contents: "[remote \"origin\"]")
        try writeFile(".npmrc", contents: "//registry.npmjs.org/:_authToken=secret")
        try writeFile("node_modules/pkg/index.js", contents: "module.exports = 1")
        try writeFile("certs/server.pem", contents: "-----BEGIN PRIVATE KEY-----")
        try writeFile("deploy.key", contents: "secret")
        try writeFile(".well-known/security.txt", contents: "Contact: mailto:security@example.com")
        try FileManager.default.createSymbolicLink(
            at: workspaceURL.appendingPathComponent("config.txt"),
            withDestinationURL: workspaceURL.appendingPathComponent(".env")
        )

        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        for path in [".env", ".env.local", ".git/config", ".npmrc", "node_modules/pkg/index.js",
                     "certs/server.pem", "deploy.key", "config.txt"]
        {
            let (data, response) = try await URLSession.shared.data(from: server.url.appendingPathComponent(path))
            let http = try XCTUnwrap(response as? HTTPURLResponse)
            XCTAssertEqual(http.statusCode, 404, path)
            XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("secret"), path)
        }
        let (_, wellKnown) = try await URLSession.shared.data(
            from: server.url.appendingPathComponent(".well-known/security.txt")
        )
        XCTAssertEqual((wellKnown as? HTTPURLResponse)?.statusCode, 200)
    }

    /// PV-29: a page on another origin, or a rebound DNS name, cannot reach the
    /// port by name.
    func testForeignHostIsRefused() throws {
        try writeFile("index.html", contents: "<html>site</html>")
        try writeFile(".env", contents: "SECRET=1")
        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        let foreign = try Self.rawRequest(
            port: server.port,
            "GET / HTTP/1.1\r\nHost: attacker.example:\(server.port)\r\nOrigin: http://attacker.example\r\n\r\n"
        )
        XCTAssertTrue(foreign.hasPrefix("HTTP/1.1 421"), foreign)
        XCTAssertFalse(foreign.contains("site"))

        let missing = try Self.rawRequest(port: server.port, "GET / HTTP/1.1\r\n\r\n")
        XCTAssertTrue(missing.hasPrefix("HTTP/1.1 421"), missing)

        let own = try Self.rawRequest(port: server.port, "GET / HTTP/1.1\r\nHost: localhost:\(server.port)\r\n\r\n")
        XCTAssertTrue(own.hasPrefix("HTTP/1.1 200"), own)
        XCTAssertTrue(own.contains("site"))
    }

    func testStaticPreviewServerRejectsPathTraversal() async throws {
        try writeFile("index.html", contents: "<html>Home</html>")

        let parentDir = workspaceURL.deletingLastPathComponent()
        let secretFile = parentDir.appendingPathComponent("secret-\(UUID().uuidString).txt")
        try "SUPER_SECRET".write(to: secretFile, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: secretFile) }

        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        let raw = try Self.rawRequest(
            port: server.port,
            "GET /../\(secretFile.lastPathComponent) HTTP/1.1\r\nHost: 127.0.0.1:\(server.port)\r\n\r\n"
        )
        XCTAssertTrue(raw.hasPrefix("HTTP/1.1 403") || raw.hasPrefix("HTTP/1.1 404"), raw)
        XCTAssertFalse(raw.contains("SUPER_SECRET"))
    }

    func testStaticPreviewServerHEADRequest() async throws {
        try writeFile("index.html", contents: "body content for head test")
        try writeFile("notes.txt", contents: "plain text")

        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        var request = URLRequest(url: server.url.appendingPathComponent("notes.txt"))
        request.httpMethod = "HEAD"

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200)
        XCTAssertEqual(http.value(forHTTPHeaderField: "Content-Length"), "10")
        XCTAssertTrue(data.isEmpty)
    }

    /// PV-31: a body larger than the socket buffer arrives whole.
    func testTwentyMegabyteFileArrivesWhole() async throws {
        try writeFile("index.html", contents: "<html></html>")
        let payload = Self.payload(bytes: 20 * 1_024 * 1_024)
        try payload.write(to: workspaceURL.appendingPathComponent("big.bin"))
        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        let (data, response) = try await URLSession.shared.data(from: server.url.appendingPathComponent("big.bin"))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(data.count, payload.count)
        XCTAssertEqual(SHA256.hash(data: data), SHA256.hash(data: payload))
    }

    /// PV-30: a browser that hangs up mid-transfer makes the write fail with
    /// EPIPE. Without `SO_NOSIGPIPE` the default SIGPIPE action would end this
    /// test process, so the default action is restored for the duration.
    func testClientClosingMidTransferDoesNotKillTheProcess() async throws {
        try writeFile("index.html", contents: "<html></html>")
        try Self.payload(bytes: 20 * 1_024 * 1_024).write(to: workspaceURL.appendingPathComponent("big.bin"))
        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        let previous = signal(SIGPIPE, SIG_DFL)
        defer { signal(SIGPIPE, previous) }

        for _ in 0..<3 {
            let sock = try Self.connect(port: server.port)
            let request = "GET /big.bin HTTP/1.1\r\nHost: 127.0.0.1:\(server.port)\r\n\r\n"
            _ = request.withCString { Darwin.write(sock, $0, strlen($0)) }
            var buffer = [UInt8](repeating: 0, count: 4_096)
            _ = Darwin.read(sock, &buffer, buffer.count)
            // Reset rather than a graceful close, so the server's next write
            // meets a dead peer at once.
            var lingerOption = linger(l_onoff: 1, l_linger: 0)
            setsockopt(sock, SOL_SOCKET, SO_LINGER, &lingerOption, socklen_t(MemoryLayout<linger>.size))
            Darwin.close(sock)
        }
        try await Task.sleep(for: .milliseconds(500))

        // Still alive, and still serving.
        let (_, response) = try await URLSession.shared.data(from: server.url)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    /// PV-32: `Range` lets a video seek.
    func testRangeRequests() throws {
        try writeFile("index.html", contents: "<html></html>")
        try writeFile("digits.txt", contents: "0123456789abcdefghij")
        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        func get(_ range: String) throws -> String {
            try Self.rawRequest(
                port: server.port,
                "GET /digits.txt HTTP/1.1\r\nHost: 127.0.0.1:\(server.port)\r\nRange: \(range)\r\n\r\n"
            )
        }
        let middle = try get("bytes=10-14")
        XCTAssertTrue(middle.hasPrefix("HTTP/1.1 206"), middle)
        XCTAssertTrue(middle.contains("Content-Range: bytes 10-14/20"))
        XCTAssertTrue(middle.hasSuffix("\r\n\r\nabcde"), middle)

        let suffix = try get("bytes=-3")
        XCTAssertTrue(suffix.hasSuffix("\r\n\r\nhij"), suffix)

        let open = try get("bytes=15-")
        XCTAssertTrue(open.hasSuffix("\r\n\r\nfghij"), open)

        let beyond = try get("bytes=500-")
        XCTAssertTrue(beyond.hasPrefix("HTTP/1.1 416"), beyond)
        XCTAssertTrue(beyond.contains("Content-Range: bytes */20"))

        XCTAssertEqual(StaticPreviewServer.parseRange("bytes=0-1,4-5", size: 20), .ignored)
    }

    /// Saving a file reloads the page: HTML carries the client, and a change
    /// under the root reaches the event stream.
    func testLiveReloadClientIsInjectedAndAChangePushesAReload() async throws {
        try writeFile("index.html", contents: "<html><body><p>v1</p></body></html>")
        let server = try StaticPreviewServer(staticRootURL: workspaceURL, watchInterval: .milliseconds(100))
        defer { server.stop() }

        let (data, _) = try await URLSession.shared.data(from: server.url)
        let html = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(html.contains(StaticPreviewServer.liveReloadMarker))
        XCTAssertTrue(html.contains(StaticPreviewServer.liveReloadPath))
        XCTAssertLessThan(
            try XCTUnwrap(html.range(of: StaticPreviewServer.liveReloadMarker)).lowerBound,
            try XCTUnwrap(html.range(of: "</body>")).lowerBound
        )

        let sock = try Self.connect(port: server.port)
        defer { Darwin.close(sock) }
        let request = "GET \(StaticPreviewServer.liveReloadPath) HTTP/1.1\r\nHost: 127.0.0.1:\(server.port)\r\n\r\n"
        _ = request.withCString { Darwin.write(sock, $0, strlen($0)) }
        let opening = try Self.read(sock, until: ": connected", timeout: 3)
        XCTAssertTrue(opening.contains("text/event-stream"), opening)
        for _ in 0..<30 where server.liveReloadClientCount == 0 {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(server.liveReloadClientCount, 1)

        try await Task.sleep(for: .milliseconds(250))
        try writeFile("index.html", contents: "<html><body><p>v2, longer</p></body></html>")
        let pushed = try Self.read(sock, until: "data: reload", timeout: 5)
        XCTAssertTrue(pushed.contains("event: reload"), pushed)
    }

    func testStaticPreviewServerStop() throws {
        try writeFile("index.html", contents: "<html></html>")
        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        let port = server.port
        server.stop()

        let expectation = expectation(description: "Fetch after stop")
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        let task = URLSession.shared.dataTask(with: url) { _, _, error in
            XCTAssertNotNil(error)
            expectation.fulfill()
        }
        task.resume()
        wait(for: [expectation], timeout: 5.0)
    }

    // MARK: - Helpers

    private static func payload(bytes: Int) -> Data {
        var data = Data(count: bytes)
        data.withUnsafeMutableBytes { buffer in
            for index in 0..<bytes {
                buffer[index] = UInt8(truncatingIfNeeded: index &* 31 &+ index >> 8)
            }
        }
        return data
    }

    static func connect(port: UInt16) throws -> Int32 {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { throw POSIXError(.EIO) }
        var one: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard result == 0 else {
            Darwin.close(sock)
            throw POSIXError(.ECONNREFUSED)
        }
        return sock
    }

    /// Sends `request` and reads until the server closes.
    static func rawRequest(port: UInt16, _ request: String) throws -> String {
        let sock = try connect(port: port)
        defer { Darwin.close(sock) }
        _ = request.withCString { Darwin.write(sock, $0, strlen($0)) }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 8_192)
        while true {
            let count = Darwin.read(sock, &buffer, buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return String(decoding: data, as: UTF8.self)
    }

    static func read(_ sock: Int32, until marker: String, timeout: TimeInterval) throws -> String {
        var text = ""
        var buffer = [UInt8](repeating: 0, count: 4_096)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, !text.contains(marker) {
            let count = Darwin.read(sock, &buffer, buffer.count)
            if count > 0 {
                text += String(decoding: buffer[0..<count], as: UTF8.self)
            } else if count == 0 {
                break
            }
        }
        return text
    }
}
