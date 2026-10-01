import Darwin
import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The session-owned registry (CODE_AGENT_SPEC §4.1, §6.4): leases, sharing,
/// idle stop, ports, attach, logs and the ledger, against fake processes.
final class PreviewRegistryTests: XCTestCase {
    private var root: URL!
    private var otherRoot: URL!

    override func setUpWithError() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-registry-\(UUID().uuidString)")
        root = base.appendingPathComponent("app", isDirectory: true)
        otherRoot = base.appendingPathComponent("app-worktree", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: otherRoot, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let root { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
    }

    // MARK: - Fakes

    final class FakeProcess: PreviewServerProcess, @unchecked Sendable {
        let lock = NSLock()
        var launches: [DevServerLaunch] = []
        var continuation: AsyncStream<DevServerEvent>.Continuation?
        var lines: [String]
        var readyURL: URL?
        var failure: String?
        var stopped = false
        let contained: Bool

        init(lines: [String], readyURL: URL?, failure: String? = nil, contained: Bool = true) {
            self.lines = lines
            self.readyURL = readyURL
            self.failure = failure
            self.contained = contained
        }

        func start(_ launch: DevServerLaunch) async -> AsyncStream<DevServerEvent> {
            lock.withLock { launches.append(launch) }
            let lines = self.lines
            let readyURL = self.readyURL
            let failure = self.failure
            return AsyncStream { continuation in
                self.lock.lock()
                self.continuation = continuation
                self.lock.unlock()
                continuation.yield(.state(.starting))
                for (index, text) in lines.enumerated() {
                    continuation.yield(.line(DevServerLogLine(id: index, channel: text.hasPrefix("ERR ") ? .stderr : .stdout, text: text)))
                }
                Task {
                    try? await Task.sleep(for: .milliseconds(30))
                    if let failure {
                        continuation.yield(.state(.failed(reason: failure)))
                        continuation.finish()
                    } else if let readyURL {
                        continuation.yield(.state(.running(readyURL)))
                    }
                }
            }
        }

        func stopAndWaitAsync() async {
            let continuation = lock.withLock {
                stopped = true
                return self.continuation
            }
            continuation?.yield(.state(.stopped))
            continuation?.finish()
        }

        var processIdentity: (pgid: Int32, pid: Int32)? { (getpid(), getpid()) }
        var isContained: Bool { contained }
        func notifyStaticReload() {}

        var launchCount: Int {
            lock.lock(); defer { lock.unlock() }
            return launches.count
        }

        var wasStopped: Bool {
            lock.lock(); defer { lock.unlock() }
            return stopped
        }
    }

    final class FakeLauncher: PreviewServerLaunching, @unchecked Sendable {
        let lock = NSLock()
        var made: [FakeProcess] = []
        var networks: [PreviewNetworkPolicy] = []
        var lines: [String] = ["ready in 120 ms"]
        var readyURL: URL? = URL(string: "http://localhost:3000/")
        var failure: String?

        func makeProcess(checkoutRoot: URL, network: PreviewNetworkPolicy) -> any PreviewServerProcess {
            lock.lock(); defer { lock.unlock() }
            let process = FakeProcess(lines: lines, readyURL: readyURL, failure: failure)
            made.append(process)
            networks.append(network)
            return process
        }

        var processes: [FakeProcess] {
            lock.lock(); defer { lock.unlock() }
            return made
        }
    }

    struct FakeProbe: PreviewHTTPProbing {
        var answering: Set<String>
        func answers(_ url: URL) async -> Bool { answering.contains(url.absoluteString) }
    }

    final class Clock: @unchecked Sendable {
        let lock = NSLock()
        var now = Date(timeIntervalSince1970: 1_000_000)
        func advance(minutes: Double) {
            lock.lock(); now += minutes * 60; lock.unlock()
        }
        var read: @Sendable () -> Date {
            { [self] in lock.lock(); defer { lock.unlock() }; return now }
        }
    }

    private func configuration(
        _ name: String = "web",
        args: [String] = ["run", "dev"],
        port: Int? = nil,
        autoPort: Bool? = nil,
        in checkout: URL? = nil,
        url: String? = nil
    ) throws -> ResolvedPreviewConfiguration {
        let raw = url.map { PreviewLaunchConfiguration(name: name, url: $0) }
            ?? PreviewLaunchConfiguration(name: name, runtimeExecutable: "npm", runtimeArgs: args, port: port, autoPort: autoPort)
        let resolved = LaunchConfigurationStore.resolve([raw], source: .juno, workspaceRoot: checkout ?? root)
        return try XCTUnwrap(resolved.configurations.first, "\(resolved.issues)")
    }

    private func settings() -> PreviewLocalSettings {
        PreviewLocalSettings(fileURL: root.deletingLastPathComponent().appendingPathComponent("settings-\(UUID().uuidString).json"))
    }

    // MARK: - Leases

    /// PV-1: switching sessions hides the pane, which removes a viewer; the
    /// session's lease keeps the server running.
    func testALeaseSurvivesASessionSwitch() async throws {
        let launcher = FakeLauncher()
        let registry = PreviewRegistry(launcher: launcher, settings: settings())
        let session = CodeSessionID(value: "s1")
        let web = try configuration()

        let outcome = await registry.start(web, checkoutRoot: root, session: session)
        XCTAssertEqual(outcome.result, .ready(URL(string: "http://localhost:3000/")!, alreadyRunning: false))
        let key = PreviewKey(checkoutRoot: root, name: "web")

        await registry.addViewer(key)
        await registry.removeViewer(key) // the reader switched to another session
        let snapshot = await registry.snapshot(key)
        XCTAssertEqual(snapshot?.phase, .running(URL(string: "http://localhost:3000/")!))
        XCTAssertEqual(snapshot?.leaseHolders, [session])
        XCTAssertFalse(launcher.processes[0].wasStopped)
        let leased = await registry.leasedKeys(session: session)
        XCTAssertEqual(leased, [key])
    }

    func testTwoSessionsOnOneCheckoutShareAServerAndWorktreesGetTheirOwn() async throws {
        let launcher = FakeLauncher()
        let registry = PreviewRegistry(launcher: launcher, settings: settings())
        let first = CodeSessionID(value: "s1")
        let second = CodeSessionID(value: "s2")

        _ = await registry.start(try configuration(), checkoutRoot: root, session: first)
        let shared = await registry.start(try configuration(), checkoutRoot: root, session: second)
        XCTAssertEqual(shared.result, .ready(URL(string: "http://localhost:3000/")!, alreadyRunning: true))
        XCTAssertEqual(launcher.processes.count, 1, "one server for one checkout")
        let key = PreviewKey(checkoutRoot: root, name: "web")
        var holders = await registry.snapshot(key)?.leaseHolders
        XCTAssertEqual(holders, [first, second])

        _ = await registry.start(try configuration(in: otherRoot), checkoutRoot: otherRoot, session: second)
        XCTAssertEqual(launcher.processes.count, 2, "a worktree is another checkout")

        await registry.release(key, session: first)
        XCTAssertFalse(launcher.processes[0].wasStopped, "another session still holds it")
        await registry.release(key, session: second)
        XCTAssertTrue(launcher.processes[0].wasStopped, "the last lease ended")
        holders = await registry.snapshot(key)?.leaseHolders
        XCTAssertEqual(holders, [])
        let phase = await registry.snapshot(key)?.phase
        XCTAssertEqual(phase, .stopped)
    }

    func testReleaseAllEndsEverySessionLease() async throws {
        let launcher = FakeLauncher()
        let registry = PreviewRegistry(launcher: launcher, settings: settings())
        let session = CodeSessionID(value: "gone")
        _ = await registry.start(try configuration(), checkoutRoot: root, session: session)
        await registry.releaseAll(session: session)
        XCTAssertTrue(launcher.processes[0].wasStopped)
    }

    /// A server with no lease and no view stops after 30 minutes, measured on
    /// an injected clock; a view keeps it.
    func testIdleStopAfterThirtyMinutes() async throws {
        let launcher = FakeLauncher()
        let clock = Clock()
        let registry = PreviewRegistry(launcher: launcher, settings: settings(), clock: clock.read)
        _ = await registry.start(try configuration(), checkoutRoot: root, session: nil)
        let key = PreviewKey(checkoutRoot: root, name: "web")

        await registry.addViewer(key)
        clock.advance(minutes: 45)
        await registry.sweepIdle()
        XCTAssertFalse(launcher.processes[0].wasStopped, "a view keeps it")

        await registry.removeViewer(key)
        clock.advance(minutes: 29)
        await registry.sweepIdle()
        XCTAssertFalse(launcher.processes[0].wasStopped)

        clock.advance(minutes: 2)
        await registry.sweepIdle()
        XCTAssertTrue(launcher.processes[0].wasStopped)
        let log = await registry.logs(key)
        XCTAssertTrue(log?.entries.last?.text.contains("30 minutes") == true)
    }

    // MARK: - Starting

    func testAChangedConfigurationRestartsTheServer() async throws {
        let launcher = FakeLauncher()
        let registry = PreviewRegistry(launcher: launcher, settings: settings())
        let session = CodeSessionID(value: "s1")
        _ = await registry.start(try configuration(args: ["run", "dev"]), checkoutRoot: root, session: session)
        _ = await registry.start(try configuration(args: ["run", "dev", "--turbo"]), checkoutRoot: root, session: session)
        XCTAssertEqual(launcher.processes.count, 2)
        XCTAssertTrue(launcher.processes[0].wasStopped)
        XCTAssertEqual(launcher.processes[1].launches.first?.commandLine, "npm run dev --turbo")
    }

    func testFailureReturnsTheReasonAndTheLastLogLines() async throws {
        let launcher = FakeLauncher()
        launcher.lines = ["> next dev", "ERR Error: Cannot find module 'next'"]
        launcher.failure = "Exited with code 1 without serving an address."
        let registry = PreviewRegistry(launcher: launcher, settings: settings())
        let outcome = await registry.start(try configuration(), checkoutRoot: root, session: CodeSessionID(value: "s"))
        XCTAssertEqual(outcome.result, .failed("Exited with code 1 without serving an address."))
        XCTAssertTrue(outcome.recentLog.contains("ERR Error: Cannot find module 'next'"))
    }

    /// PV-15: `autoPort: false` refuses a taken port and names its owner;
    /// `true` steps around it and passes `PORT`.
    func testPortsNameTheSquatterOrStepAroundIt() async throws {
        let squatter = try StaticPreviewServer(staticRootURL: root)
        defer { squatter.stop() }
        let taken = Int(squatter.port)
        let launcher = FakeLauncher()
        let registry = PreviewRegistry(launcher: launcher, settings: settings())

        let strict = await registry.start(try configuration(port: taken, autoPort: false), checkoutRoot: root, session: nil)
        guard case let .failed(reason) = strict.result else { return XCTFail("\(strict.result)") }
        XCTAssertTrue(reason.contains("Port \(taken) is already in use by"), reason)
        XCTAssertTrue(reason.contains("pid \(getpid())"), reason)
        XCTAssertTrue(launcher.processes.isEmpty, "nothing launched")

        _ = await registry.start(try configuration("auto", port: taken, autoPort: true), checkoutRoot: root, session: nil)
        let launch = try XCTUnwrap(launcher.processes.last?.launches.first)
        let chosen = try XCTUnwrap(launch.environment["PORT"].flatMap(Int.init))
        XCTAssertNotEqual(chosen, taken)
        XCTAssertEqual(launch.port, chosen, "a configured port is probed directly")
    }

    /// `${port}` in the argv is expanded with the port Juno picked.
    func testPortPlaceholderIsExpanded() async throws {
        let launcher = FakeLauncher()
        let registry = PreviewRegistry(launcher: launcher, settings: settings())
        _ = await registry.start(
            try configuration(args: ["manage.py", "runserver", "127.0.0.1:${port}"], autoPort: true),
            checkoutRoot: root,
            session: nil
        )
        let launch = try XCTUnwrap(launcher.processes.last?.launches.first)
        let port = try XCTUnwrap(launch.environment["PORT"])
        XCTAssertEqual(launch.commandLine, "npm manage.py runserver 127.0.0.1:\(port)")
    }

    /// A `url` configuration attaches to a server Juno did not start, and is
    /// refused when nothing answers.
    func testURLConfigurationAttaches() async throws {
        let launcher = FakeLauncher()
        let registry = PreviewRegistry(
            launcher: launcher, probe: FakeProbe(answering: ["http://127.0.0.1:4000/"]), settings: settings()
        )
        let attached = await registry.start(try configuration("proxy", url: "http://127.0.0.1:4000"), checkoutRoot: root, session: nil)
        XCTAssertEqual(attached.result, .ready(URL(string: "http://127.0.0.1:4000/")!, alreadyRunning: false))
        XCTAssertEqual(attached.snapshot.phase, .attached(URL(string: "http://127.0.0.1:4000/")!))
        XCTAssertTrue(launcher.processes.isEmpty)

        let missing = await registry.start(try configuration("other", url: "http://127.0.0.1:4001"), checkoutRoot: root, session: nil)
        guard case let .failed(reason) = missing.result else { return XCTFail() }
        XCTAssertTrue(reason.contains("Nothing answers"), reason)
    }

    /// A durable shell's server is used only when that shell's group listens
    /// on the port.
    func testShellAttachChecksOwnership() async throws {
        let server = try StaticPreviewServer(staticRootURL: root)
        defer { server.stop() }
        let registry = PreviewRegistry(
            launcher: FakeLauncher(), probe: FakeProbe(answering: [server.url.absoluteString]), settings: settings()
        )
        let owned = await registry.attachShell(
            shellID: "sh1", url: server.url, processGroup: getpgrp(), checkoutRoot: root, session: nil
        )
        XCTAssertEqual(owned.result, .ready(server.url, alreadyRunning: false))
        XCTAssertEqual(owned.snapshot.shellID, "sh1")

        // Another process group, which listens on nothing.
        let sleeper = Process()
        sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep")
        sleeper.arguments = ["5"]
        try sleeper.run()
        defer { sleeper.terminate() }
        let other = await registry.attachShell(
            shellID: "sh2", url: server.url, processGroup: sleeper.processIdentifier, checkoutRoot: root, session: nil
        )
        guard case let .failed(reason) = other.result else { return XCTFail() }
        XCTAssertTrue(reason.contains("No process of that shell listens"), reason)
    }

    // MARK: - Logs, network, ledger

    func testLogsAreReadableBySinceCursorLevelAndSearch() async throws {
        let launcher = FakeLauncher()
        launcher.lines = ["compiling /", "ERR Failed to compile ./src/app/page.tsx", "compiled in 400 ms", "GET / 200"]
        let registry = PreviewRegistry(launcher: launcher, settings: settings())
        _ = await registry.start(try configuration(), checkoutRoot: root, session: nil)
        let key = PreviewKey(checkoutRoot: root, name: "web")

        let allPage = await registry.logs(key)
        let all = try XCTUnwrap(allPage)
        XCTAssertEqual(Array(all.entries.map(\.text).suffix(4)), launcher.lines)
        let errorsPage = await registry.logs(key, level: .error)
        XCTAssertEqual(errorsPage?.entries.map(\.text), ["ERR Failed to compile ./src/app/page.tsx"])
        let searchPage = await registry.logs(key, search: "get /")
        XCTAssertEqual(searchPage?.entries.map(\.text), ["GET / 200"])
        let afterPage = await registry.logs(key, since: all.cursor)
        XCTAssertEqual(afterPage?.entries, [])
        let compile = await registry.compileErrors(key, since: 0)
        XCTAssertEqual(compile.count, 1)
    }

    /// A process whose launch waits on the test, and which (like
    /// `DevServerService`) can only be stopped once it has launched.
    final class SlowLaunchProcess: PreviewServerProcess, @unchecked Sendable {
        let lock = NSLock()
        private var gate: CheckedContinuation<Void, Never>?
        private(set) var entered = false
        private(set) var launched = false
        private(set) var stoppedAfterLaunch = false

        func start(_ launch: DevServerLaunch) async -> AsyncStream<DevServerEvent> {
            await withCheckedContinuation { continuation in
                lock.withLock {
                    gate = continuation
                    entered = true
                }
            }
            lock.withLock { launched = true }
            return AsyncStream { $0.yield(.state(.starting)) }
        }

        func letLaunch() {
            let gate = lock.withLock { () -> CheckedContinuation<Void, Never>? in
                defer { self.gate = nil }
                return self.gate
            }
            gate?.resume()
        }

        func stopAndWaitAsync() async {
            lock.withLock { if launched { stoppedAfterLaunch = true } }
        }

        var hasEntered: Bool { lock.withLock { entered } }
        var wasStoppedAfterLaunch: Bool { lock.withLock { stoppedAfterLaunch } }
        var processIdentity: (pgid: Int32, pid: Int32)? { nil }
        var isContained: Bool { true }
        func notifyStaticReload() {}
    }

    struct SlowLauncher: PreviewServerLaunching {
        let process: SlowLaunchProcess
        func makeProcess(checkoutRoot: URL, network: PreviewNetworkPolicy) -> any PreviewServerProcess { process }
    }

    /// A stop that lands while a start is still launching: the launch that
    /// lost the race is stopped once it exists, never left holding a port
    /// with no entry, no pump and no ledger line to find it by.
    func testAStartThatLostARaceStopsItsProcess() async throws {
        let process = SlowLaunchProcess()
        let registry = PreviewRegistry(launcher: SlowLauncher(process: process), settings: settings())
        let configuration = try configuration()
        let checkout: URL = root
        let key = PreviewKey(checkoutRoot: checkout, name: configuration.name)
        let start = Task {
            await registry.start(configuration, checkoutRoot: checkout, session: CodeSessionID(value: "s1"), waitUntilReady: false)
        }
        for _ in 0..<200 where !process.hasEntered {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(process.hasEntered)
        await registry.stop(key)
        XCTAssertFalse(process.wasStoppedAfterLaunch, "nothing had launched yet")
        process.letLaunch()
        _ = await start.value
        XCTAssertTrue(process.wasStoppedAfterLaunch)
        let phase = await registry.snapshot(key)?.phase
        XCTAssertEqual(phase, .stopped)
    }

    func testLogLinesAreBounded() {
        var buffer = PreviewLogBuffer()
        let entry = buffer.append(channel: .stdout, text: String(repeating: "x", count: 100_000))
        XCTAssertEqual(entry.text.count, PreviewLogBuffer.maximumLineLength + 2)
        XCTAssertTrue(entry.text.hasSuffix(" …"))
    }

    func testRingBufferKeepsTheNewestFiveThousandLines() {
        var buffer = PreviewLogBuffer()
        for index in 0..<5_200 { buffer.append(channel: .stdout, text: "line \(index)") }
        XCTAssertEqual(buffer.entries.count, 5_000)
        XCTAssertEqual(buffer.entries.first?.text, "line 200")
        XCTAssertEqual(buffer.dropped, 200)
        let page = buffer.page(since: 10, limit: 500)
        XCTAssertEqual(page.droppedBefore, 190)
        XCTAssertEqual(page.entries.count, 500)
    }

    func testABlockedOutboundAttemptIsNoticedWhileOffline() async throws {
        let launcher = FakeLauncher()
        launcher.lines = ["ERR getaddrinfo ENOTFOUND fonts.googleapis.com"]
        let registry = PreviewRegistry(launcher: launcher, settings: settings())
        _ = await registry.start(try configuration(), checkoutRoot: root, session: nil)
        let snapshot = await registry.snapshot(PreviewKey(checkoutRoot: root, name: "web"))
        XCTAssertEqual(snapshot?.blockedOutboundHost, "fonts.googleapis.com")
        XCTAssertEqual(snapshot?.statusSentence.hasSuffix("· offline"), true)

        XCTAssertEqual(PreviewNetworkHints.blockedHost(in: "Error: connect EPERM 142.250.74.10:443"), "142.250.74.10")
        XCTAssertEqual(PreviewNetworkHints.blockedHost(in: "Failed to download `Inter` from Google Fonts."), "fonts.googleapis.com")
        XCTAssertNil(PreviewNetworkHints.blockedHost(in: "connect ECONNREFUSED 127.0.0.1:5432"))
    }

    /// The reader's "use the internet" answer, bound to the configuration's
    /// bytes, reaches the launcher.
    func testInternetAnswerIsBoundToTheBytes() async throws {
        let launcher = FakeLauncher()
        let settings = settings()
        let registry = PreviewRegistry(launcher: launcher, settings: settings)
        let web = try configuration()
        XCTAssertTrue(settings.shouldAskAboutInternet(for: web, in: root))
        settings.setInternet(true, for: web, in: root)
        _ = await registry.start(web, checkoutRoot: root, session: nil)
        XCTAssertEqual(launcher.networks.last, .internet)

        let changed = try configuration(args: ["run", "dev", "--other"])
        XCTAssertEqual(settings.effectiveNetwork(for: changed, in: root), .loopback, "changed bytes ask again")
    }

    func testTheLedgerRecordsARunningServerAndForgetsItWhenStopped() async throws {
        let ledgerURL = root.deletingLastPathComponent().appendingPathComponent("ledger.json")
        let ledger = PreviewServerLedger(fileURL: ledgerURL)
        let launcher = FakeLauncher()
        let registry = PreviewRegistry(launcher: launcher, ledger: ledger, settings: settings())
        _ = await registry.start(try configuration(), checkoutRoot: root, session: nil)
        XCTAssertEqual(ledger.entries().map(\.name), ["web"])
        XCTAssertEqual(ledger.entries().first?.pgid, getpid())
        await registry.stop(PreviewKey(checkoutRoot: root, name: "web"))
        XCTAssertEqual(ledger.entries(), [])
    }
}
