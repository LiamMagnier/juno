import Foundation
import XCTest
@testable import JunoCodeLocal

/// Auto-detection of a runnable dev server when no file says how, with the
/// framework's port; and finding the port a server prints.
final class LaunchDiscoveryTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("alevr-discovery-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = root.resolvingSymlinksInPath().standardizedFileURL
    }

    override func tearDownWithError() throws {
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    private func project(_ files: [String: String]) throws -> [PreviewLaunchConfiguration] {
        try? FileManager.default.removeItem(at: root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for (path, text) in files {
            let url = root.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try text.write(to: url, atomically: true, encoding: .utf8)
        }
        return LaunchConfigurationDiscovery.propose(workspaceRoot: root).configurations
    }

    // MARK: - package.json

    func testViteGetsItsDefaultPortAndAFreeOneThroughItsFlag() throws {
        let npm = try project(["package.json": #"{"scripts":{"dev":"vite","build":"vite build","preview":"vite preview"}}"#, "package-lock.json": "{}"])
        XCTAssertEqual(npm.map(\.name), ["dev", "preview"])
        XCTAssertEqual(npm[0].runtimeArgs, ["run", "dev", "--", "--port", "${port}"])
        XCTAssertEqual(npm[0].port, 5173)
        XCTAssertEqual(npm[0].autoPort, true)
        XCTAssertEqual(npm[1].port, 4173)

        // pnpm passes flags on as they are; a `--` would end vite's options.
        let pnpm = try project(["package.json": #"{"scripts":{"dev":"vite --host"}}"#, "pnpm-lock.yaml": ""])
        XCTAssertEqual(pnpm.first?.runtimeArgs, ["run", "dev", "--port", "${port}"])
        let yarn = try project(["package.json": #"{"scripts":{"dev":"vite"}}"#, "yarn.lock": ""])
        XCTAssertEqual(yarn.first?.runtimeArgs, ["dev", "--port", "${port}"])
    }

    func testAPortTheScriptOrConfigPinsIsKept() throws {
        let flagged = try project(["package.json": #"{"scripts":{"dev":"next dev -p 4000"}}"#])
        XCTAssertEqual(flagged.first?.port, 4000)
        XCTAssertNil(flagged.first?.autoPort, "a pinned port asks when it is taken")
        XCTAssertEqual(flagged.first?.runtimeArgs, ["run", "dev"])

        let configured = try project([
            "package.json": #"{"scripts":{"dev":"vite"}}"#,
            "vite.config.ts": "export default defineConfig({ plugins: [react()], server: { host: true, port: 3001 } })",
        ])
        XCTAssertEqual(configured.first?.port, 3001)
        XCTAssertEqual(configured.first?.runtimeArgs, ["run", "dev"])

        let astro = try project([
            "package.json": #"{"scripts":{"dev":"astro dev"}}"#,
            "astro.config.mjs": "export default defineConfig({ server: { port: 4400 } })",
        ])
        XCTAssertEqual(astro.first?.port, 4400)
    }

    func testFrameworkDefaults() throws {
        let cases: [(String, Int, Bool)] = [
            ("next dev", 3000, false),
            ("astro dev", 4321, true),
            ("react-scripts start", 3000, false),
            ("ng serve", 4200, true),
            ("nuxi dev", 3000, false),
            ("gatsby develop", 8000, true),
            ("webpack serve --mode development", 8080, true),
            ("storybook dev", 6006, true),
        ]
        for (script, port, flag) in cases {
            let found = try project(["package.json": #"{"scripts":{"dev":"\#(script)"}}"#])
            XCTAssertEqual(found.first?.port, port, script)
            XCTAssertEqual(found.first?.runtimeArgs?.contains("${port}"), flag, script)
        }
        // A script that runs several commands gets no flag appended.
        let chained = try project(["package.json": #"{"scripts":{"dev":"concurrently \"vite\" \"node api.js\""}}"#])
        XCTAssertEqual(chained.first?.runtimeArgs, ["run", "dev"])
        // An unknown server: Alevr reads the port it prints.
        let plain = try project(["package.json": #"{"scripts":{"start":"node server.js"}}"#])
        XCTAssertNil(plain.first?.port)
        XCTAssertEqual(plain.first?.autoPort, true)
    }

    // MARK: - Other stacks

    func testOtherStacks() throws {
        XCTAssertEqual(try project(["manage.py": "", "requirements.txt": "django\n"]).first?.name, "django")
        XCTAssertEqual(try project(["app.py": "from flask import Flask\napp = Flask(__name__)"]).first?.name, "flask")
        XCTAssertEqual(try project(["Gemfile": "gem \"rails\"\n"]).first?.name, "rails")
        XCTAssertEqual(try project(["go.mod": "module x", "main.go": "http.ListenAndServe(\":8080\", nil)"]).first?.name, "go")
        let site = try project(["index.html": "<h1>hi</h1>"])
        XCTAssertEqual(site.first?.runtimeExecutable, ResolvedPreviewConfiguration.staticExecutable)
    }

    func testAnXcodeProjectIsOfferedTheSimulator() throws {
        _ = try project(["App/App.xcodeproj/project.pbxproj": ""])
        XCTAssertTrue(LaunchDiscoveryHelpers.catalog(root).hasXcodeProject)
        XCTAssertTrue(LaunchDiscoveryHelpers.catalog(root).configurations.isEmpty)
        _ = try project(["index.html": "<h1>hi</h1>"])
        XCTAssertFalse(LaunchDiscoveryHelpers.catalog(root).hasXcodeProject)
    }

    // MARK: - Port detection

    func testPortsArePickedOutOfServerOutput() {
        let lines: [(String, Int)] = [
            ("  ➜  Local:   http://localhost:5173/", 5173),
            ("   ▲ Next.js 15.0.0\n   - Local:        http://localhost:3000", 3000),
            (" ┃ Local    http://localhost:4321/", 4321),
            ("Starting development server at http://127.0.0.1:8000/", 8000),
            (" * Running on http://127.0.0.1:5000", 5000),
            ("* Listening on http://127.0.0.1:3000", 3000),
            ("Serving HTTP on 127.0.0.1 port 8000 (http://127.0.0.1:8000/) ...", 8000),
            ("2026/10/10 12:00:00 listening on :8080", 8080),
            ("server started on [::]:9000", 9000),
            ("Web server listening at localhost:4200", 4200),
            ("Server running on port 3333", 3333),
        ]
        for (line, port) in lines {
            XCTAssertEqual(DevServerURLDetector.detect(in: line)?.port, port, line)
        }
        XCTAssertNil(DevServerURLDetector.detect(in: "added 312 packages in 4s; node v24.1.0"))
        XCTAssertNil(DevServerURLDetector.detect(in: "pid 4123 exited"))
    }
}

enum LaunchDiscoveryHelpers {
    static func catalog(_ root: URL) -> PreviewLaunchCatalog {
        LaunchConfigurationStore.load(workspaceRoot: root)
    }
}
