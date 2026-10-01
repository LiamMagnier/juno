import Darwin
import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// `.juno/launch.json`, the `.claude/launch.json` import, discovery, URL
/// ownership and ports (CODE_AGENT_SPEC §4.2, §6.4).
final class LaunchConfigurationTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-launch-\(UUID().uuidString)", isDirectory: true)
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

    // MARK: - Files

    func testJunoLaunchFileParsesEveryField() throws {
        try write("apps/web/package.json", "{}")
        try write(".juno/launch.json", """
        {
          "version": "0.0.1",
          "autoVerify": false,
          "configurations": [
            { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev", "--", "--port", "${port}"],
              "cwd": "${workspaceFolder}/apps/web", "port": 3000, "autoPort": true,
              "env": { "NEXT_TELEMETRY_DISABLED": "1" }, "network": "internet",
              "ready": { "path": "health", "timeoutSeconds": 30 },
              "allowedExternalOrigins": ["https://accounts.example.com"] },
            { "name": "api", "program": "server.py", "runtimeExecutable": "python3", "args": ["--debug"], "port": 8000, "autoPort": false },
            { "name": "proxy", "url": "http://127.0.0.1:4000" },
            { "name": "site", "runtimeExecutable": "juno:static", "cwd": "public" }
          ]
        }
        """)
        let catalog = LaunchConfigurationStore.load(workspaceRoot: root)

        XCTAssertEqual(catalog.issues, [])
        XCTAssertFalse(catalog.autoVerify)
        XCTAssertTrue(catalog.hasJunoFile)
        XCTAssertEqual(catalog.configurations.map(\.name), ["web", "api", "proxy", "site"])

        let web = try XCTUnwrap(catalog.configuration(named: "web"))
        XCTAssertEqual(web.source, .juno)
        XCTAssertEqual(web.kind, .command(argv: ["npm", "run", "dev", "--", "--port", "${port}"]))
        XCTAssertEqual(web.workingDirectoryDisplay, "apps/web")
        XCTAssertEqual(web.commandLine(port: 3104), "npm run dev -- --port 3104")
        XCTAssertEqual(web.environmentKeys, ["NEXT_TELEMETRY_DISABLED"])
        XCTAssertEqual(web.network, .internet)
        XCTAssertEqual(web.readyPath, "/health")
        XCTAssertEqual(web.readyTimeoutSeconds, 30)
        XCTAssertEqual(web.autoPort, true)
        XCTAssertEqual(web.allowedExternalOrigins.map(\.host), ["accounts.example.com"])

        let api = try XCTUnwrap(catalog.configuration(named: "api"))
        XCTAssertEqual(api.kind, .command(argv: ["python3", "server.py", "--debug"]))
        XCTAssertEqual(api.network, .loopback)
        XCTAssertEqual(api.readyPath, "/")

        XCTAssertEqual(catalog.configuration(named: "proxy")?.kind, .attach(url: URL(string: "http://127.0.0.1:4000/")!))
        guard case let .staticSite(siteRoot)? = catalog.configuration(named: "site")?.kind else {
            return XCTFail("site is a static configuration")
        }
        XCTAssertEqual(siteRoot.path, root.appendingPathComponent("public").path)
        XCTAssertEqual(catalog.defaultConfiguration?.name, "web")
    }

    /// The approval covers the bytes: any change to a configuration changes
    /// its hash, and nothing else does.
    func testContentHashFollowsTheConfigurationBytes() {
        let base = PreviewLaunchConfiguration(name: "web", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 3000)
        var changedArgs = base
        changedArgs.runtimeArgs = ["run", "dev:evil"]
        var changedEnv = base
        changedEnv.env = ["NODE_OPTIONS": "--require ./x.js"]
        var changedNetwork = base
        changedNetwork.network = .internet

        let hash = LaunchConfigurationStore.contentHash(base, source: .juno)
        XCTAssertEqual(hash, LaunchConfigurationStore.contentHash(base, source: .juno))
        XCTAssertNotEqual(hash, LaunchConfigurationStore.contentHash(changedArgs, source: .juno))
        XCTAssertNotEqual(hash, LaunchConfigurationStore.contentHash(changedEnv, source: .juno))
        XCTAssertNotEqual(hash, LaunchConfigurationStore.contentHash(changedNetwork, source: .juno))
        XCTAssertNotEqual(hash, LaunchConfigurationStore.contentHash(base, source: .claude))
    }

    func testInvalidConfigurationsAreIssuesInWords() throws {
        try write(".juno/launch.json", """
        { "configurations": [
          { "name": "escape", "runtimeExecutable": "npm", "cwd": "../elsewhere" },
          { "name": "remote", "url": "https://example.com:443" },
          { "name": "pathy", "url": "http://localhost:3000/app" },
          { "name": "mismatch", "url": "http://localhost:3000", "port": 3001 },
          { "name": "empty" },
          { "name": "dup", "runtimeExecutable": "npm" },
          { "name": "dup", "runtimeExecutable": "pnpm" },
          { "name": "secret", "runtimeExecutable": "npm", "env": { "API_TOKEN": "x" } }
        ] }
        """)
        let catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        let messages = catalog.issues.map(\.message)

        XCTAssertTrue(messages.contains { $0.contains("outside the workspace") }, "\(messages)")
        XCTAssertTrue(messages.contains { $0.contains("not on this Mac") })
        XCTAssertTrue(messages.contains { $0.contains("origin only") })
        XCTAssertTrue(messages.contains { $0.contains("does not match port 3001") })
        XCTAssertTrue(messages.contains { $0.contains("has no runtimeExecutable, program or url") })
        XCTAssertTrue(messages.contains { $0.contains("defined twice") })
        XCTAssertEqual(catalog.configurations.map(\.name), ["dup", "secret"])
        XCTAssertEqual(catalog.configuration(named: "dup")?.kind, .command(argv: ["npm"]))
        XCTAssertEqual(catalog.configuration(named: "secret")?.warnings.count, 1)
    }

    func testBrokenJSONIsAnIssueNotACrash() throws {
        try write(".juno/launch.json", "{ not json")
        let catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertEqual(catalog.configurations, [])
        XCTAssertEqual(catalog.issues.first?.source, .juno)
        XCTAssertTrue(catalog.issues.first?.message.contains("not valid JSON") == true)
    }

    /// `.claude/launch.json` is imported read-only for names the Juno file
    /// does not define; the Juno file wins on the same name.
    func testClaudeLaunchFileIsImportedReadOnly() throws {
        try write(".claude/launch.json", """
        { "version": "0.0.1", "configurations": [
          { "name": "juno-dev", "runtimeExecutable": "bash", "runtimeArgs": ["-c", "npx next dev -p 3100"], "port": 3100 },
          { "name": "web", "runtimeExecutable": "yarn", "runtimeArgs": ["dev"] }
        ] }
        """)
        var catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertTrue(catalog.hasClaudeFile)
        XCTAssertEqual(catalog.configurations.map(\.name), ["juno-dev", "web"])
        XCTAssertEqual(catalog.configurations.map(\.source), [.claude, .claude])
        XCTAssertEqual(catalog.configuration(named: "juno-dev")?.commandLine(), "bash -c 'npx next dev -p 3100'")

        try write(".juno/launch.json", """
        { "configurations": [ { "name": "web", "runtimeExecutable": "pnpm", "runtimeArgs": ["dev"] } ] }
        """)
        catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertEqual(catalog.configurations.map(\.name), ["web", "juno-dev"])
        XCTAssertEqual(catalog.configuration(named: "web")?.source, .juno)
        XCTAssertEqual(catalog.configuration(named: "web")?.kind, .command(argv: ["pnpm", "dev"]))
    }

    // MARK: - Discovery

    func testDiscoveryFindsNodeScriptsWithTheRootPackageManager() throws {
        try write("package.json", #"{"scripts":{"lint":"eslint .","dev":"turbo dev"}}"#)
        try write("pnpm-lock.yaml", "")
        try write("apps/web/package.json", #"{"scripts":{"dev":"next dev","build":"next build"}}"#)
        try write("apps/web/node_modules/x/package.json", #"{"scripts":{"dev":"vite"}}"#)

        let file = LaunchConfigurationDiscovery.propose(workspaceRoot: root)
        XCTAssertEqual(file.configurations.map(\.name), ["dev", "apps/web dev"])
        let nested = try XCTUnwrap(file.configurations.last)
        XCTAssertEqual(nested.runtimeExecutable, "pnpm")
        XCTAssertEqual(nested.runtimeArgs, ["run", "dev"])
        XCTAssertEqual(nested.cwd, "apps/web")
        XCTAssertEqual(nested.autoPort, true)

        // With no file, the catalog offers them as discovered.
        let catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        XCTAssertEqual(catalog.configurations.map(\.source), [.discovered, .discovered])
    }

    func testDiscoveryCoversPythonRailsGoPHPHugoAndStatic() throws {
        func propose(_ files: [String: String]) throws -> [PreviewLaunchConfiguration] {
            try FileManager.default.removeItem(at: root)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            for (path, text) in files { try write(path, text) }
            return LaunchConfigurationDiscovery.propose(workspaceRoot: root).configurations
        }

        let django = try propose(["manage.py": "", "requirements.txt": "Django==5.0"])
        XCTAssertEqual(django.map(\.name), ["django"])
        XCTAssertEqual(django.first?.runtimeArgs, ["manage.py", "runserver", "127.0.0.1:${port}"])

        let fastapi = try propose(["main.py": "", "pyproject.toml": "dependencies = [\"fastapi\", \"uvicorn\"]", "uv.lock": ""])
        XCTAssertEqual(fastapi.first?.name, "fastapi")
        XCTAssertEqual(fastapi.first?.runtimeExecutable, "uv")
        XCTAssertEqual(Array(fastapi.first?.runtimeArgs?.prefix(5) ?? []), ["run", "python", "-m", "uvicorn", "main:app"])

        let flask = try propose(["app.py": "", "requirements.txt": "flask\n"])
        XCTAssertEqual(flask.first?.name, "flask")

        let rails = try propose(["Gemfile": "gem 'rails', '~> 7.1'", "bin/rails": ""])
        XCTAssertEqual(rails.first?.runtimeExecutable, "bin/rails")

        let go = try propose(["go.mod": "module x", "main.go": "import \"net/http\"\nhttp.ListenAndServe(\":\"+os.Getenv(\"PORT\"), nil)"])
        XCTAssertEqual(go.first?.runtimeArgs, ["run", "."])

        let php = try propose(["public/index.php": "<?php"])
        XCTAssertEqual(php.first?.runtimeArgs, ["-S", "127.0.0.1:${port}", "-t", "public"])

        let hugo = try propose(["hugo.toml": "baseURL = '/'"])
        XCTAssertEqual(hugo.first?.name, "hugo")

        let rootSite = try propose(["index.html": "<html></html>"])
        XCTAssertEqual(rootSite.first?.runtimeExecutable, "juno:static")
        XCTAssertNil(rootSite.first?.cwd)

        // PV-16: a page in public/ is served from public/, and a
        // tooling-only package.json does not hide it (PV-10).
        let publicSite = try propose(["public/index.html": "<html></html>", "package.json": #"{"scripts":{"lint":"eslint ."}}"#])
        XCTAssertEqual(publicSite.map(\.name), ["static"])
        XCTAssertEqual(publicSite.first?.cwd, "public")
    }

    // MARK: - Sockets and ports

    func testListeningSocketsOfThisProcessGroupIncludeAServerItOpened() throws {
        let server = try StaticPreviewServer(staticRootURL: root)
        defer { server.stop() }
        let sockets = ListeningSocketOwnership.listeningSockets(inProcessGroup: getpgrp())
        let mine = sockets.first { $0.port == Int(server.port) }
        XCTAssertNotNil(mine, "\(sockets)")
        XCTAssertEqual(mine?.address, .loopback)
        XCTAssertTrue(ListeningSocketOwnership.groupListensOnLoopback(port: Int(server.port), processGroup: getpgrp()))
        XCTAssertEqual(ListeningSocketOwnership.owner(ofPort: Int(server.port))?.pid, getpid())
    }

    /// PV-15: a squatter on the preferred port is noticed, named, and stepped
    /// around.
    func testAutoPortStepsAroundASquatter() throws {
        let squatter = try StaticPreviewServer(staticRootURL: root)
        defer { squatter.stop() }
        let taken = Int(squatter.port)

        XCTAssertFalse(PreviewPorts.isFree(taken))
        let chosen = try XCTUnwrap(PreviewPorts.freePort(preferring: taken))
        XCTAssertNotEqual(chosen, taken)
        XCTAssertTrue(PreviewPorts.isFree(chosen))
        XCTAssertEqual(ListeningSocketOwnership.owner(ofPort: taken)?.name.isEmpty, false)
    }

    // MARK: - URL truth (PV-8)

    /// A URL printed by a process outside the server's group — here a server
    /// in this test process — is ignored; the address the server's own group
    /// listens on wins even though it was printed second.
    func testURLOwnershipIgnoresAnAddressTheGroupDoesNotListenOn() async throws {
        let foreign = try StaticPreviewServer(staticRootURL: root)
        defer { foreign.stop() }
        let script = """
        print("Proxy target: http://127.0.0.1:\(foreign.port)/", flush=True)
        import http.server, socketserver, time
        time.sleep(0.5)
        s = socketserver.TCPServer(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
        print("Local: http://127.0.0.1:%d/" % s.server_address[1], flush=True)
        s.serve_forever()
        """
        try write("serve.py", script)
        let service = DevServerService()
        defer { service.stop() }
        let stream = await service.start(DevServerLaunch(commandLine: "python3 -u serve.py", workingDirectory: root))

        var running: URL?
        var lines: [String] = []
        let deadline = Date().addingTimeInterval(20)
        for await event in stream {
            switch event {
            case let .line(line): lines.append(line.text)
            case let .state(.running(url)): running = url
            case .state: break
            }
            if running != nil || Date() > deadline { break }
        }
        let url = try XCTUnwrap(running, "\(lines)")
        XCTAssertNotEqual(url.port, Int(foreign.port))
        XCTAssertEqual(url.host, "127.0.0.1")
        XCTAssertTrue(lines.contains { $0.contains("Juno is not using http://127.0.0.1:\(foreign.port)/") }, "\(lines)")
    }

    /// With a port configured, readiness probes it directly and passes `PORT`.
    func testConfiguredPortIsProbedDirectly() async throws {
        let port = try XCTUnwrap(PreviewPorts.freePort())
        try write("serve.py", """
        import http.server, socketserver, os
        s = socketserver.TCPServer(("127.0.0.1", int(os.environ["PORT"])), http.server.SimpleHTTPRequestHandler)
        print("serving quietly", flush=True)
        s.serve_forever()
        """)
        let service = DevServerService()
        defer { service.stop() }
        let stream = await service.start(DevServerLaunch(
            commandLine: "python3 -u serve.py", workingDirectory: root, port: port
        ))
        var running: URL?
        for await event in stream {
            if case let .state(.running(url)) = event { running = url; break }
            if case .state(.failed) = event { break }
        }
        XCTAssertEqual(running, URL(string: "http://localhost:\(port)/"))
        XCTAssertNotNil(service.processIdentity)
    }

    func testAllPrintedURLsAreCandidates() {
        let urls = DevServerURLDetector.detectAll(in: "API http://127.0.0.1:54321 and Local: http://localhost:3000/")
        XCTAssertEqual(urls.map(\.port), [54_321, 3_000])
    }

    /// The loopback rule is spelled exactly: no name the resolver might send
    /// to DNS, no octet WebKit would read as octal.
    func testLoopbackHostsAreSpelledExactly() {
        XCTAssertTrue(PreviewOrigin.isLoopbackHost("127.0.0.1"))
        XCTAssertTrue(PreviewOrigin.isLoopbackHost("127.1.2.3"))
        XCTAssertTrue(PreviewOrigin.isLoopbackHost("localhost"))
        XCTAssertTrue(PreviewOrigin.isLoopbackHost("[::1]"))
        XCTAssertFalse(PreviewOrigin.isLoopbackHost("0127.0.0.1"), "WebKit reads a leading zero as octal: 87.0.0.1")
        XCTAssertFalse(PreviewOrigin.isLoopbackHost("127.0.0.01"))
        XCTAssertFalse(PreviewOrigin.isLoopbackHost("+127.0.0.1"))
        XCTAssertFalse(PreviewOrigin.isLoopbackHost("app.localhost"), "a name the resolver may send to DNS")
        XCTAssertFalse(PreviewOrigin.isLoopbackHost("127.0.0.1.evil.com"))
        XCTAssertFalse(PreviewOrigin.isLoopback(URL(string: "http://0127.0.0.1:3000/")!))
    }
}

/// The PGID ledger: orphans are reaped only when they are provably Juno's.
final class PreviewServerLedgerTests: XCTestCase {
    private final class FakeControl: PreviewServerLedger.ProcessControl, @unchecked Sendable {
        let lock = NSLock()
        var startTimes: [pid_t: ProcessStartTime] = [:]
        var members: [pid_t: [pid_t]] = [:]
        var directories: [pid_t: String] = [:]
        var signals: [(pid_t, Int32)] = []
        var currentPID: pid_t = 100

        func currentDirectory(of pid: pid_t) -> String? {
            lock.lock(); defer { lock.unlock() }
            return directories[pid]
        }

        func startTime(of pid: pid_t) -> ProcessStartTime? {
            lock.lock(); defer { lock.unlock() }
            return startTimes[pid]
        }

        func groupMembers(_ pgid: pid_t) -> [pid_t] {
            lock.lock(); defer { lock.unlock() }
            return members[pgid] ?? []
        }

        func signalGroup(_ pgid: pid_t, _ signal: Int32) {
            lock.lock(); defer { lock.unlock() }
            signals.append((pgid, signal))
        }

        var recordedSignals: [(pid_t, Int32)] {
            lock.lock(); defer { lock.unlock() }
            return signals
        }
    }

    private func t(_ seconds: Int64) -> ProcessStartTime { ProcessStartTime(seconds: seconds, microseconds: 0) }

    private func entry(pgid: Int32, started: Int64, owner: Int32, ownerStarted: Int64) -> PreviewServerLedger.Entry {
        PreviewServerLedger.Entry(
            pgid: pgid, pid: pgid, startedAt: t(started), cwd: "/tmp/app", configHash: "h", name: "web",
            ownerPID: owner, ownerStartedAt: t(ownerStarted)
        )
    }

    private func ledger(_ control: FakeControl) -> PreviewServerLedger {
        PreviewServerLedger(
            fileURL: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("ledger-\(UUID().uuidString).json"),
            control: control
        )
    }

    func testAnOrphanWithItsOriginalLeaderIsSignalled() async throws {
        let control = FakeControl()
        control.startTimes = [100: t(5_000), 4_211: t(1_000)]
        let ledger = ledger(control)
        ledger.record(entry(pgid: 4_211, started: 1_000, owner: 77, ownerStarted: 900))

        let report = ledger.reapOrphans(killDelay: 0.05)
        XCTAssertEqual(report.reaped.map(\.pgid), [4_211])
        XCTAssertEqual(ledger.entries(), [])
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(control.recordedSignals.map(\.0), [4_211, 4_211])
        XCTAssertEqual(control.recordedSignals.map(\.1), [SIGTERM, SIGKILL])
    }

    /// A pid the system gave to another process since is never signalled.
    func testAReusedPIDIsDroppedWithoutASignal() async throws {
        let control = FakeControl()
        control.startTimes = [100: t(5_000), 4_211: t(3_000)]
        let ledger = ledger(control)
        ledger.record(entry(pgid: 4_211, started: 1_000, owner: 77, ownerStarted: 900))

        let report = ledger.reapOrphans(killDelay: 0.05)
        XCTAssertEqual(report.dropped.map(\.pgid), [4_211])
        XCTAssertEqual(report.reaped, [])
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertTrue(control.recordedSignals.isEmpty)
        XCTAssertEqual(ledger.entries(), [])
    }

    func testAServerWhoseOwnerStillRunsIsKept() {
        let control = FakeControl()
        control.startTimes = [100: t(5_000), 77: t(900), 4_211: t(1_000)]
        let ledger = ledger(control)
        ledger.record(entry(pgid: 4_211, started: 1_000, owner: 77, ownerStarted: 900))
        ledger.record(entry(pgid: 5_000, started: 5_100, owner: 100, ownerStarted: 5_000))

        let report = ledger.reapOrphans(killDelay: 0.05)
        XCTAssertEqual(Set(report.kept.map(\.pgid)), [4_211, 5_000])
        XCTAssertTrue(control.recordedSignals.isEmpty)
        XCTAssertEqual(ledger.entries().count, 2)
    }

    func testAGroupWhoseLeaderExitedIsReapedThroughItsMembers() {
        let control = FakeControl()
        control.startTimes = [100: t(5_000), 4_300: t(1_002)]
        control.members = [4_211: [4_300]]
        control.directories = [4_300: "/private/tmp/app/web"]
        let ledger = ledger(control)
        ledger.record(entry(pgid: 4_211, started: 1_000, owner: 77, ownerStarted: 900))
        XCTAssertEqual(ledger.reapOrphans(killDelay: 5).reaped.map(\.pgid), [4_211])

        let empty = FakeControl()
        empty.startTimes = [100: t(5_000)]
        let other = self.ledger(empty)
        other.record(entry(pgid: 4_211, started: 1_000, owner: 77, ownerStarted: 900))
        XCTAssertEqual(other.reapOrphans(killDelay: 5).dropped.map(\.pgid), [4_211])
    }

    /// The pid went to an unrelated process that led a new group of the same
    /// number and exited; its members started later too, but they work
    /// elsewhere. They are someone else's and are never signalled.
    func testALaterGroupOfTheSameNumberElsewhereIsNotSignalled() async throws {
        let control = FakeControl()
        control.startTimes = [100: t(5_000), 4_300: t(4_000)]
        control.members = [4_211: [4_300]]
        control.directories = [4_300: "/Users/someone/build"]
        let ledger = ledger(control)
        ledger.record(entry(pgid: 4_211, started: 1_000, owner: 77, ownerStarted: 900))
        let report = ledger.reapOrphans(killDelay: 0.05)
        XCTAssertEqual(report.dropped.map(\.pgid), [4_211])
        XCTAssertEqual(report.reaped, [])
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertTrue(control.recordedSignals.isEmpty)
        XCTAssertEqual(PreviewServerLedger.normalizedPath("/private/tmp/app/"), "/tmp/app")
    }

    func testTheWorkingDirectoryOfThisProcessIsReadable() {
        let directory = ListeningSocketOwnership.currentDirectory(of: getpid())
        XCTAssertEqual(
            directory.map(PreviewServerLedger.normalizedPath),
            PreviewServerLedger.normalizedPath(FileManager.default.currentDirectoryPath)
        )
    }

    func testRemoveForgetsAStoppedServer() {
        let control = FakeControl()
        control.startTimes = [100: t(5_000), 4_211: t(1_000)]
        let ledger = ledger(control)
        ledger.record(pgid: 4_211, pid: 4_211, cwd: "/tmp", configHash: "h", name: "web")
        XCTAssertEqual(ledger.entries().first?.ownerPID, 100)
        ledger.remove(pgid: 4_211)
        XCTAssertEqual(ledger.entries(), [])
    }

}
