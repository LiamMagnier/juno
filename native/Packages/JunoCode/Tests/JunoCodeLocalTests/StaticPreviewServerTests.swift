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
        XCTAssertEqual(httpResponse.value(forHTTPHeaderField: "Access-Control-Allow-Origin"), "*")
        let html = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(html.contains("Hello Juno"))
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

    func testStaticPreviewServerRejectsPathTraversal() async throws {
        try writeFile("index.html", contents: "<html>Home</html>")

        let parentDir = workspaceURL.deletingLastPathComponent()
        let secretFile = parentDir.appendingPathComponent("secret-\(UUID().uuidString).txt")
        try "SUPER_SECRET".write(to: secretFile, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: secretFile) }

        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        let traversalURL = server.url.appendingPathComponent("..").appendingPathComponent(secretFile.lastPathComponent)
        do {
            let (data, response) = try await URLSession.shared.data(from: traversalURL)
            let http = response as? HTTPURLResponse
            XCTAssertTrue(http?.statusCode == 403 || http?.statusCode == 404)
            if let body = String(data: data, encoding: .utf8) {
                XCTAssertFalse(body.contains("SUPER_SECRET"))
            }
        } catch {
            // A closed socket or connection reset is also safe refusal
        }
    }

    func testStaticPreviewServerHEADRequest() async throws {
        let content = "body content for head test"
        try writeFile("index.html", contents: content)

        let server = try StaticPreviewServer(staticRootURL: workspaceURL)
        defer { server.stop() }

        var request = URLRequest(url: server.url)
        request.httpMethod = "HEAD"

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200)
        XCTAssertEqual(http.value(forHTTPHeaderField: "Content-Length"), "\(content.utf8.count)")
        XCTAssertTrue(data.isEmpty)
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
}
