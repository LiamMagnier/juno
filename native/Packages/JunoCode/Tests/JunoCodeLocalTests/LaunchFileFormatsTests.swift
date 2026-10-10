import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The launch files people actually have: Claude Code's `.claude/launch.json`,
/// VS Code's `launch.json`, Alevr's `.juno/` and `.alevr/` files, all as JSONC,
/// plus the shortcuts a hand- or model-written file takes. Errors are a
/// sentence naming the file, the key path, what was expected and what was
/// found, never `at ""`; and a file that gives nothing to run falls back to
/// what the project looks like it runs.
final class LaunchFileFormatsTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("alevr-launch-formats-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = root.resolvingSymlinksInPath().standardizedFileURL
    }

    override func tearDownWithError() throws {
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    private func write(_ relative: String, _ text: String) throws {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func parse(_ text: String, file: String = ".juno/launch.json") -> LaunchFileParser.Result {
        LaunchFileParser.parse(Data(text.utf8), fileName: file)
    }

    // MARK: - The owner's report

    /// The owner's pane said `.juno/launch.json has the wrong type at ""` and
    /// "There is no configuration to start." That is what Swift's decoder says
    /// when the root is not an object: a bare list of configurations, the
    /// shape a model writes when told to "write .juno/launch.json with a
    /// configuration (name, runtimeExecutable, ...)". It now loads.
    func testABareListAtTheRootLoads() throws {
        try write(".juno/launch.json", """
        [
          { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173 }
        ]
        """)
        let catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertEqual(catalog.issues, [])
        XCTAssertEqual(catalog.configurations.map(\.name), ["web"])
        XCTAssertEqual(catalog.configurations.first?.source, .juno)
        XCTAssertEqual(catalog.configurations.first?.kind, .command(argv: ["npm", "run", "dev"]))
        XCTAssertEqual(catalog.configurations.first?.port, 5173)
    }

    /// Claude Code's own format, with the comments and trailing commas its
    /// files often carry, in `.juno/launch.json` (the owner's other likely
    /// content) and in `.claude/launch.json`.
    func testClaudeCodeFormatWithCommentsAndTrailingCommas() throws {
        let text = """
        // Dev servers for the preview
        {
          "version": "0.0.1",
          "configurations": [
            {
              "name": "next-dev", /* the app */
              "runtimeExecutable": "npm",
              "runtimeArgs": ["run", "dev",],
              "port": 3000,
              "url": "http://localhost:3000", // opens here
              "cwd": "apps/web",
              "env": { "NODE_ENV": "development", "DEBUG": 1, },
            },
          ],
        }
        """
        try FileManager.default.createDirectory(at: root.appendingPathComponent("apps/web"), withIntermediateDirectories: true)
        for file in [".juno/launch.json", ".claude/launch.json"] {
            try? FileManager.default.removeItem(at: root.appendingPathComponent(".juno"))
            try? FileManager.default.removeItem(at: root.appendingPathComponent(".claude"))
            try write(file, text)
            let catalog = LaunchConfigurationStore.load(workspaceRoot: root)
            XCTAssertEqual(catalog.issues, [], file)
            let web = try XCTUnwrap(catalog.configuration(named: "next-dev"), file)
            XCTAssertEqual(web.kind, .command(argv: ["npm", "run", "dev"]))
            XCTAssertEqual(web.port, 3000)
            XCTAssertEqual(web.workingDirectoryDisplay, "apps/web")
            XCTAssertEqual(web.environment, ["NODE_ENV": "development", "DEBUG": "1"])
            XCTAssertEqual(web.source, file.hasPrefix(".juno") ? .juno : .claude)
        }
    }

    func testCommentMarkersInsideStringsAreKept() {
        let result = parse(#"{ "configurations": [ { "name": "a", "url": "http://localhost:3000", "runtimeExecutable": "echo", "runtimeArgs": ["// not a comment", "/* nor this */"] } ] }"#)
        XCTAssertEqual(result.issues, [])
        XCTAssertEqual(result.file?.configurations.first?.runtimeArgs, ["// not a comment", "/* nor this */"])
    }

    // MARK: - VS Code

    func testVSCodeLaunchConfigurations() throws {
        try write(".juno/launch.json", """
        {
          // Use IntelliSense to learn about possible attributes.
          "version": "0.2.0",
          "configurations": [
            { "type": "node", "request": "launch", "name": "Server", "program": "${workspaceFolder}/server.js", "port": 9229, "env": { "PORT": "4000" } },
            { "type": "chrome", "request": "launch", "name": "Chrome", "url": "http://localhost:5173/dashboard", "webRoot": "${workspaceFolder}" },
            { "type": "node", "request": "attach", "name": "Attach", "port": 9229 },
            { "type": "debugpy", "request": "launch", "name": "Flask", "module": "flask", "args": ["run", "--port", "5001"] },
            { "type": "node", "request": "launch", "name": "Dev", "runtimeExecutable": "npm", "runtimeArgs": ["run-script", "dev"] }
          ],
          "compounds": []
        }
        """)
        let catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertEqual(catalog.issues, [])
        XCTAssertEqual(catalog.configurations.map(\.name), ["Server", "Chrome", "Flask", "Dev"])
        let server = try XCTUnwrap(catalog.configuration(named: "Server"))
        XCTAssertEqual(server.kind, .command(argv: ["node", root.path + "/server.js"]))
        // 9229 is the debugger's port, not the server's.
        XCTAssertNil(server.port)
        XCTAssertEqual(catalog.configuration(named: "Chrome")?.kind, .attach(url: URL(string: "http://localhost:5173/")!))
        XCTAssertEqual(catalog.configuration(named: "Flask")?.kind, .command(argv: ["python3", "-m", "flask", "run", "--port", "5001"]))
    }

    func testAFileOfOnlyDebuggerAttachesSaysSo() {
        let result = parse(#"{ "version": "0.2.0", "configurations": [ { "type": "node", "request": "attach", "name": "Attach", "port": 9229 } ] }"#, file: ".claude/launch.json")
        XCTAssertEqual(result.file?.configurations, [])
        XCTAssertEqual(result.issues, [".claude/launch.json only has debugger configurations (1); none of them starts a server the Preview can open."])
    }

    // MARK: - Shortcuts

    func testShortcutsPeopleWrite() {
        // One configuration at the root, a command line, a port as text.
        let single = parse(#"{ "name": "web", "command": "npm run dev", "port": "5173" }"#)
        XCTAssertEqual(single.issues, [])
        XCTAssertEqual(single.file?.configurations.first?.runtimeExecutable, "npm")
        XCTAssertEqual(single.file?.configurations.first?.runtimeArgs, ["run", "dev"])
        XCTAssertEqual(single.file?.configurations.first?.port, 5173)

        // A command a shell must read runs through sh -c, whole.
        let shell = parse(#"{ "configurations": [ { "name": "both", "command": "npm run build && npm start" } ] }"#)
        XCTAssertEqual(shell.file?.configurations.first?.runtimeExecutable, "sh")
        XCTAssertEqual(shell.file?.configurations.first?.runtimeArgs, ["-c", "npm run build && npm start"])

        // Configurations keyed by name; args as one string; autoPort as text.
        let keyed = parse(#"{ "configurations": { "api": { "runtimeExecutable": "go", "runtimeArgs": "run .", "autoPort": "true" } } }"#)
        XCTAssertEqual(keyed.issues, [])
        XCTAssertEqual(keyed.file?.configurations.first?.name, "api")
        XCTAssertEqual(keyed.file?.configurations.first?.runtimeArgs, ["run", "."])
        XCTAssertEqual(keyed.file?.configurations.first?.autoPort, true)

        // A version written as a number is fine.
        let numbered = parse(#"{ "version": 1, "configurations": [ { "name": "x", "runtimeExecutable": "npm" } ] }"#)
        XCTAssertEqual(numbered.issues, [])
        XCTAssertEqual(numbered.file?.version, "1")

        // No name: called by what it runs.
        let unnamed = parse(#"[ { "runtimeExecutable": "pnpm", "runtimeArgs": ["dev"] } ]"#)
        XCTAssertEqual(unnamed.file?.configurations.first?.name, "pnpm dev")
    }

    // MARK: - Errors in words

    func testErrorsNameTheFileThePathAndWhatWasFound() {
        let wrongPort = parse(#"{ "configurations": [ { "name": "web", "runtimeExecutable": "npm", "port": "abc" }, { "name": "ok", "runtimeExecutable": "npm" } ] }"#)
        XCTAssertEqual(wrongPort.issues, [
            ".juno/launch.json: configurations[0].port (\"web\") should be a port number like 3000, but it is the text \"abc\".",
        ])
        // The good configuration beside it still loads.
        XCTAssertEqual(wrongPort.file?.configurations.map(\.name), ["ok"])

        let wrongEnv = parse(#"{ "configurations": [ { "name": "web", "runtimeExecutable": "npm", "env": ["A=1"] } ] }"#)
        XCTAssertEqual(wrongEnv.issues, [
            ".juno/launch.json: configurations[0].env (\"web\") should be an object of variable names to text values, but it is a list.",
        ])

        let wrongList = parse(#"{ "configurations": "npm run dev" }"#)
        XCTAssertEqual(wrongList.issues, [
            ".juno/launch.json: \"configurations\" should be a list of configurations, but it is the text \"npm run dev\".",
        ])

        let text = parse(#""npm run dev""#)
        XCTAssertEqual(text.issues, [
            ".juno/launch.json should be a JSON object with a \"configurations\" list, but the file holds the text \"npm run dev\".",
        ])

        let empty = parse("{}")
        XCTAssertTrue(empty.issues.first?.hasPrefix(".juno/launch.json has no \"configurations\" list. Add one, for example") == true)

        let blank = parse("  \n")
        XCTAssertEqual(blank.issues.first, ".juno/launch.json is empty. Add a \"configurations\" list, or choose a server Alevr found in the project.")

        let broken = parse("{\n  \"configurations\": [\n    { \"name\": \"web\" \"runtimeExecutable\": \"npm\" }\n  ]\n}")
        XCTAssertNil(broken.file)
        XCTAssertTrue(broken.issues.first?.hasPrefix(".juno/launch.json is not valid JSON (around line 3, column") == true, "\(broken.issues)")

        let notAnObject = parse(#"{ "configurations": [ "npm run dev" ] }"#)
        XCTAssertEqual(notAnObject.issues, [
            ".juno/launch.json: configurations[0] should be an object with a name and a command, but it is the text \"npm run dev\".",
        ])

        for result in [wrongPort, wrongEnv, wrongList, text, empty, blank, broken, notAnObject] {
            XCTAssertFalse(result.issues.contains { $0.contains("at \"\"") }, "\(result.issues)")
        }
    }

    // MARK: - Files and precedence

    func testAlevrFileIsReadAndTheJunoFileWins() throws {
        try write(".alevr/launch.json", #"{ "configurations": [ { "name": "web", "runtimeExecutable": "pnpm", "runtimeArgs": ["dev"] }, { "name": "docs", "runtimeExecutable": "npm", "runtimeArgs": ["run", "docs"] } ] }"#)
        try write(".claude/launch.json", #"{ "configurations": [ { "name": "docs", "runtimeExecutable": "yarn" }, { "name": "api", "runtimeExecutable": "go" } ] }"#)
        var catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertEqual(catalog.configurations.map(\.name), ["web", "docs", "api"])
        XCTAssertEqual(catalog.configurations.map(\.source), [.alevr, .alevr, .claude])
        XCTAssertEqual(catalog.editableFileRelativePath, ".alevr/launch.json")

        try write(".juno/launch.json", #"{ "configurations": [ { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"] } ] }"#)
        catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertEqual(catalog.configuration(named: "web")?.source, .juno)
        XCTAssertEqual(catalog.editableFileRelativePath, ".juno/launch.json")
    }

    /// A broken `.juno/launch.json` used to hide everything: no discovery,
    /// "There is no configuration to start." Now the problem is said and the
    /// pane offers what the project runs.
    func testABrokenFileFallsBackToWhatTheProjectRuns() throws {
        try write(".juno/launch.json", "{}")
        try write("package.json", #"{ "scripts": { "dev": "vite", "build": "vite build" } }"#)
        let catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertTrue(catalog.hasJunoFile)
        XCTAssertEqual(catalog.issues.map(\.source), [.juno])
        XCTAssertEqual(catalog.configurations.map(\.name), ["dev"])
        XCTAssertTrue(catalog.isDiscovered)
        XCTAssertEqual(catalog.configurations.first?.port, 5173)

        // With a working Claude file beside it, that file is used instead.
        try write(".claude/launch.json", #"{ "configurations": [ { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"] } ] }"#)
        let withClaude = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertEqual(withClaude.configurations.map(\.name), ["web"])
        XCTAssertFalse(withClaude.isDiscovered)
    }

    func testSavingCreatesAddsAndKeepsABrokenFile() throws {
        let web = PreviewLaunchConfiguration(name: "dev", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], autoPort: true)
        XCTAssertEqual(try LaunchConfigurationStore.save(web, workspaceRoot: root), "Saved dev as .juno/launch.json.")
        XCTAssertEqual(LaunchConfigurationStore.load(workspaceRoot: root).configurations.map(\.name), ["dev"])

        let api = PreviewLaunchConfiguration(name: "api", runtimeExecutable: "go", runtimeArgs: ["run", "."], autoPort: true)
        XCTAssertEqual(try LaunchConfigurationStore.save(api, workspaceRoot: root), "Added api to .juno/launch.json.")
        XCTAssertEqual(try LaunchConfigurationStore.save(api, workspaceRoot: root), ".juno/launch.json already has a configuration named api.")
        XCTAssertEqual(LaunchConfigurationStore.load(workspaceRoot: root).configurations.map(\.name), ["dev", "api"])

        try write(".juno/launch.json", "{ broken")
        XCTAssertEqual(
            try LaunchConfigurationStore.save(web, workspaceRoot: root),
            "Saved dev as .juno/launch.json. The file that did not read is kept as launch.json.bak."
        )
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent(".juno/launch.json.bak"), encoding: .utf8), "{ broken")
        XCTAssertEqual(LaunchConfigurationStore.load(workspaceRoot: root).issues, [])
    }

    // MARK: - Starting

    /// The owner's bug end to end: the file the pane refused, started through
    /// the registry with the real (contained) launcher. The server picks its
    /// own port and prints it; Alevr finds it in the output, checks that the
    /// server's own process listens there, and the preview is ready on it.
    func testTheOwnersFileNowStartsAndItsPortIsFoundInTheOutput() async throws {
        try write("serve.py", """
        import http.server, socketserver
        s = socketserver.TCPServer(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
        print("  Local:   http://localhost:%d/" % s.server_address[1], flush=True)
        s.serve_forever()
        """)
        try write("index.html", "<h1>hello</h1>")
        try write(".juno/launch.json", #"[ { "name": "site", "runtimeExecutable": "python3", "runtimeArgs": ["-u", "serve.py"] } ]"#)
        let catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertEqual(catalog.issues, [])
        let site = try XCTUnwrap(catalog.configuration(named: "site"))

        let settings = PreviewLocalSettings(fileURL: root.deletingLastPathComponent().appendingPathComponent("settings-\(UUID().uuidString).json"))
        let registry = PreviewRegistry(settings: settings)
        let key = PreviewKey(checkoutRoot: root, name: "site")
        let outcome = await registry.start(site, checkoutRoot: root, session: CodeSessionID(value: "owner-repro"))
        defer { Task { await registry.remove(key) } }
        guard case let .ready(url, _) = outcome.result else {
            return XCTFail("did not start: \(outcome.result) \(outcome.recentLog)")
        }
        XCTAssertEqual(url.host, "localhost")
        XCTAssertNotNil(url.port)
        let (data, _) = try await URLSession.shared.data(from: url)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "<h1>hello</h1>")
        let log = await registry.logs(key, limit: 50)
        XCTAssertTrue(log?.entries.contains { $0.text.contains("Local:   http://localhost:\(url.port!)/") } == true)
        await registry.stop(key)
    }
}
