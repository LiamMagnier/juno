import Foundation
import XCTest
@testable import JunoCodeLocal

final class DevServerCommandDiscoveryTests: XCTestCase {
    private var workspaceURL: URL!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-preview-discovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    private func writeManifest(_ object: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try data.write(to: workspaceURL.appendingPathComponent("package.json"))
    }

    private func writeFile(_ name: String, contents: String = "") throws {
        let fileURL = workspaceURL.appendingPathComponent(name)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try contents.write(
            to: fileURL,
            atomically: true,
            encoding: .utf8
        )
    }

    func testMissingManifestProducesActionableUnavailableResult() async {
        let result = await DevServerCommandDiscovery.scan(workspaceRoot: workspaceURL)

        XCTAssertTrue(result.commands.isEmpty)
        XCTAssertNil(result.packageManager)
        XCTAssertTrue(result.unavailableReason?.contains("No package.json") == true)
        XCTAssertTrue(result.unavailableReason?.contains(workspaceURL.lastPathComponent) == true)
    }

    func testMalformedManifestReportsThatItCouldNotBeRead() async throws {
        try writeFile("package.json", contents: "{ not valid json\n")

        let result = await DevServerCommandDiscovery.scan(workspaceRoot: workspaceURL)

        XCTAssertTrue(result.commands.isEmpty)
        XCTAssertNil(result.packageManager)
        XCTAssertEqual(result.unavailableReason, "package.json could not be read as JSON.")
    }

    func testScriptsUseTheLockfileManagerAndServerScriptsArePreferred() async throws {
        try writeManifest([
            "scripts": [
                "build": "vite build",
                "dev:web": "vite --host 0.0.0.0",
                "lint": "eslint .",
                "start": "node server.js",
                "test": "vitest run",
                "ignored": NSNull(),
            ],
        ])
        try writeFile("pnpm-lock.yaml", contents: "lockfileVersion: '9.0'\n")

        let result = await DevServerCommandDiscovery.scan(workspaceRoot: workspaceURL)

        XCTAssertEqual(result.packageManager, "pnpm")
        XCTAssertEqual(
            result.commands.map(\.name),
            ["start", "dev:web", "build", "lint", "test"]
        )
        XCTAssertEqual(result.suggested?.name, "start")

        let start = try XCTUnwrap(result.commands.first)
        XCTAssertEqual(start.commandLine, "pnpm run start")
        XCTAssertEqual(start.script, "node server.js")
        XCTAssertTrue(start.startsAServer)

        let devWeb = try XCTUnwrap(result.commands.first { $0.name == "dev:web" })
        XCTAssertEqual(devWeb.commandLine, "pnpm run dev:web")
        XCTAssertTrue(devWeb.startsAServer)

        let lint = try XCTUnwrap(result.commands.first { $0.name == "lint" })
        XCTAssertFalse(lint.startsAServer)
    }

    func testYarnUsesItsDirectScriptInvocation() async throws {
        try writeManifest([
            "scripts": ["dev": "vite"],
        ])
        try writeFile("yarn.lock", contents: "# yarn lockfile v1\n")

        let result = await DevServerCommandDiscovery.scan(workspaceRoot: workspaceURL)

        XCTAssertEqual(result.packageManager, "yarn")
        XCTAssertEqual(result.commands.map(\.commandLine), ["yarn dev"])
    }

    func testManifestWithoutScriptsRetainsTheDetectedPackageManager() async throws {
        try writeManifest(["name": "plain-project"])
        try writeFile("package-lock.json", contents: "{}\n")

        let result = await DevServerCommandDiscovery.scan(workspaceRoot: workspaceURL)

        XCTAssertTrue(result.commands.isEmpty)
        XCTAssertEqual(result.packageManager, "npm")
        XCTAssertEqual(result.unavailableReason, "package.json defines no scripts.")
    }

    func testStaticPreviewDiscoveryForRootIndexHTML() async throws {
        try writeFile("index.html", contents: "<html><body>Hello</body></html>")

        let result = await DevServerCommandDiscovery.scan(workspaceRoot: workspaceURL)

        XCTAssertEqual(result.commands.count, 1)
        let cmd = try XCTUnwrap(result.commands.first)
        XCTAssertEqual(cmd.name, "Static Preview")
        XCTAssertEqual(cmd.commandLine, DevServerCommand.staticPreviewCommandLine)
        XCTAssertTrue(cmd.isStaticPreview)
        XCTAssertTrue(cmd.startsAServer)
        XCTAssertNil(result.unavailableReason)
    }

    func testStaticPreviewDiscoveryForPublicIndexHTML() async throws {
        try writeFile("public/index.html", contents: "<html><body>Public</body></html>")

        let result = await DevServerCommandDiscovery.scan(workspaceRoot: workspaceURL)

        XCTAssertEqual(result.commands.count, 1)
        let cmd = try XCTUnwrap(result.commands.first)
        XCTAssertEqual(cmd.name, "Static Preview")
        XCTAssertEqual(cmd.commandLine, DevServerCommand.staticPreviewCommandLine)
        XCTAssertTrue(cmd.isStaticPreview)
        XCTAssertTrue(cmd.startsAServer)
        XCTAssertNil(result.unavailableReason)
    }
}
