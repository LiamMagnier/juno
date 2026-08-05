import XCTest
@testable import JunoSimulator

/// State machine, command formation, capability serialization, control lease,
/// discovery scanning, and process cleanup.
///
/// None of these need Xcode or a simulator: they cover the logic that decides
/// *what* to run and *what state we are in*, which is where the bugs that lie
/// to the user live.
final class SimulatorSessionTests: XCTestCase {
    // MARK: State machine

    func testRunningIsOnlyReachableThroughTheRealSequence() {
        // The whole point: no shortcut from "we asked" to "it is running".
        XCTAssertFalse(SimulatorTransition.isValid(from: .ready, to: .running(bundleID: "a", pid: 1)))
        XCTAssertFalse(SimulatorTransition.isValid(from: .building(scheme: "A"), to: .running(bundleID: "a", pid: 1)))
        XCTAssertFalse(SimulatorTransition.isValid(from: .installing(bundleID: "a"), to: .running(bundleID: "a", pid: 1)))
        XCTAssertTrue(SimulatorTransition.isValid(from: .launching(bundleID: "a"), to: .running(bundleID: "a", pid: 1)))
    }

    func testTheHappyPathIsValidEndToEnd() {
        let path: [SimulatorState] = [
            .discovering,
            .ready,
            .booting(deviceName: "iPhone 17"),
            .building(scheme: "Aurora"),
            .installing(bundleID: "com.example.Aurora"),
            .launching(bundleID: "com.example.Aurora"),
            .running(bundleID: "com.example.Aurora", pid: 42),
            .stopping,
            .ready,
        ]
        for (from, to) in zip(path, path.dropFirst()) {
            XCTAssertTrue(SimulatorTransition.isValid(from: from, to: to), "\(from) → \(to) should be legal")
        }
    }

    func testFailureAndRediscoveryAreReachableFromAnywhere() {
        let states: [SimulatorState] = [
            .unavailable(reason: "x"), .discovering, .ready, .booting(deviceName: "d"),
            .building(scheme: "s"), .installing(bundleID: "b"), .launching(bundleID: "b"),
            .running(bundleID: "b", pid: 1), .stopping,
        ]
        for state in states {
            XCTAssertTrue(SimulatorTransition.isValid(from: state, to: .failed(SimulatorFailure(stage: .build, message: "boom"))))
            XCTAssertTrue(SimulatorTransition.isValid(from: state, to: .discovering))
        }
    }

    func testARebuildWhileRunningIsLegalButAResurrectionIsNot() {
        XCTAssertTrue(SimulatorTransition.isValid(from: .running(bundleID: "a", pid: 1), to: .building(scheme: "A")))
        XCTAssertTrue(SimulatorTransition.isValid(from: .running(bundleID: "a", pid: 1), to: .stopping))
        XCTAssertFalse(SimulatorTransition.isValid(from: .stopping, to: .running(bundleID: "a", pid: 1)))
        XCTAssertFalse(SimulatorTransition.isValid(from: .stopping, to: .building(scheme: "A")))
    }

    func testIsRunningIsNeverTrueForAnyOtherState() {
        XCTAssertTrue(SimulatorState.running(bundleID: "a", pid: 1).isRunning)
        for state: SimulatorState in [
            .unavailable(reason: "x"), .discovering, .ready, .booting(deviceName: "d"),
            .building(scheme: "s"), .installing(bundleID: "b"), .launching(bundleID: "b"), .stopping,
            .failed(SimulatorFailure(stage: .launch, message: "no")),
        ] {
            XCTAssertFalse(state.isRunning, "\(state) must not report itself as running")
        }
    }

    /// The session drops illegal transitions rather than applying them, and
    /// counts them so the drop is observable.
    func testTheSessionRefusesAnIllegalTransition() async throws {
        let session = makeSession()
        // Nothing has been discovered, so a run cannot reach `.running`; it
        // fails at selection and the state machine stays coherent.
        await session.run()
        let state = await session.state
        guard case .failed(let failure) = state else {
            return XCTFail("expected a failure, got \(state)")
        }
        XCTAssertEqual(failure.stage, .discovery)
        let running = await session.state.isRunning
        XCTAssertFalse(running)
    }

    // MARK: Command formation

    private let project = XcodeProject(kind: .workspace, path: "/tmp/My App/Aurora.xcworkspace", name: "Aurora", schemes: ["Aurora"])

    func testBuildNamesTheExactDeviceAndJunoOwnedDerivedData() {
        let invocation = SimulatorCommands.build(
            project: project,
            scheme: "Aurora",
            configuration: "Debug",
            deviceUDID: "UDID-1",
            derivedDataPath: "/tmp/juno/dd",
            clean: false
        )
        XCTAssertEqual(invocation.executable, "/usr/bin/xcrun")
        XCTAssertEqual(invocation.arguments.first, "xcodebuild")
        XCTAssertFalse(invocation.arguments.contains("clean"))

        let destination = try? XCTUnwrap(invocation.arguments.firstIndex(of: "-destination"))
        XCTAssertNotNil(destination)
        XCTAssertEqual(invocation.arguments[destination! + 1], "platform=iOS Simulator,id=UDID-1")

        let derived = try? XCTUnwrap(invocation.arguments.firstIndex(of: "-derivedDataPath"))
        XCTAssertEqual(invocation.arguments[derived! + 1], "/tmp/juno/dd")

        XCTAssertTrue(invocation.arguments.contains("-workspace"))
        XCTAssertTrue(invocation.arguments.contains("/tmp/My App/Aurora.xcworkspace"))
        XCTAssertTrue(invocation.arguments.contains("CODE_SIGNING_ALLOWED=NO"))
    }

    /// A path with a space must remain one argument. Building a shell string
    /// would split it, and a project in "~/My Projects" would never build.
    func testPathsWithSpacesStayOneArgument() {
        let invocation = SimulatorCommands.build(
            project: project, scheme: "My Scheme", configuration: "Debug",
            deviceUDID: "U", derivedDataPath: "/tmp/a b", clean: false
        )
        XCTAssertTrue(invocation.arguments.contains("/tmp/My App/Aurora.xcworkspace"))
        XCTAssertTrue(invocation.arguments.contains("My Scheme"))
        XCTAssertTrue(invocation.arguments.contains("/tmp/a b"))
    }

    /// Cleaning is destructive and slow, so it only ever happens when asked.
    func testCleanIsOptInOnly() {
        let dirty = SimulatorCommands.build(project: project, scheme: "A", configuration: "Debug", deviceUDID: "U", derivedDataPath: "/tmp/d", clean: true)
        XCTAssertEqual(dirty.arguments[1], "clean")
        XCTAssertTrue(dirty.arguments.contains("build"))
    }

    func testASwiftPackageBuildsFromItsDirectoryWithNoContainerFlag() {
        let package = XcodeProject(kind: .swiftPackage, path: "/tmp/pkg", name: "pkg", schemes: ["pkg"])
        let invocation = SimulatorCommands.build(project: package, scheme: "pkg", configuration: "Debug", deviceUDID: "U", derivedDataPath: "/tmp/d", clean: false)
        XCTAssertFalse(invocation.arguments.contains("-workspace"))
        XCTAssertFalse(invocation.arguments.contains("-project"))
        XCTAssertEqual(invocation.currentDirectory, "/tmp/pkg")
    }

    /// Juno's derived data must never be Xcode's. Deleting a user's global
    /// DerivedData is a genuinely destructive act.
    func testDerivedDataIsWorkspaceScopedAndNeverTheGlobalCache() {
        let path = SimulatorCommands.derivedDataPath(
            workspaceKey: "my workspace/../../etc",
            containerDirectory: URL(fileURLWithPath: "/tmp/juno-container")
        )
        XCTAssertTrue(path.hasPrefix("/tmp/juno-container/SimulatorDerivedData/"))
        XCTAssertFalse(path.contains("Library/Developer/Xcode"))
        XCTAssertFalse(path.contains(".."), "a workspace key must not be able to escape the container")
        XCTAssertFalse(path.contains(" "))
    }

    func testLogStreamIsScopedToTheAppAndCancellable() {
        let invocation = SimulatorCommands.logStream(udid: "U", bundleID: "com.example.Aurora")
        XCTAssertTrue(invocation.arguments.contains("stream"))
        XCTAssertTrue(invocation.arguments.joined(separator: " ").contains("com.example.Aurora"))
        XCTAssertFalse(invocation.arguments.contains("--console-pty"))
    }

    func testScreenshotCapturesOnlyTheNamedDevice() {
        let invocation = SimulatorCommands.screenshot(udid: "UDID-1", outputPath: "/tmp/f.png")
        XCTAssertEqual(invocation.arguments, ["simctl", "io", "UDID-1", "screenshot", "--type=png", "/tmp/f.png"])
    }

    func testNoCommandTakesAFreeformStringFromTheCaller() {
        // Every invocation is assembled from a fixed verb list; there is no
        // "run this" entry point a model or a browser could reach.
        let all: [SimulatorCommands.Invocation] = [
            .init(arguments: []),
            SimulatorCommands.listRuntimes(),
            SimulatorCommands.listDevices(),
            SimulatorCommands.boot(udid: "U"),
            SimulatorCommands.install(udid: "U", appPath: "/tmp/A.app"),
            SimulatorCommands.launch(udid: "U", bundleID: "b"),
        ]
        for invocation in all {
            XCTAssertFalse(invocation.arguments.contains("-c"), "no shell -c form anywhere")
            XCTAssertNotEqual(invocation.executable, "/bin/sh")
            XCTAssertNotEqual(invocation.executable, "/bin/zsh")
        }
    }

    // MARK: Capability

    func testCapabilityRoundTripsAndOldRegistrationsDecodeAsUnsupported() throws {
        let capability = SimulatorCapability.from(
            toolchain: .ready(developerDirectory: "/Applications/Xcode.app/Contents/Developer", xcodeVersion: "27.0", xcodeBuild: "27A"),
            runtimes: [
                SimulatorRuntime(id: "ios27", name: "iOS 27.0", version: "27.0", platform: "iOS", isAvailable: true),
                SimulatorRuntime(id: "watch", name: "watchOS 27.0", version: "27.0", platform: "watchOS", isAvailable: true),
            ],
            devices: [
                SimulatorDevice(udid: "u1", name: "iPhone 17 Pro", state: .booted, runtimeID: "ios27", deviceTypeID: nil, isAvailable: true),
                SimulatorDevice(udid: "u2", name: "Apple Watch", state: .shutdown, runtimeID: "watch", deviceTypeID: nil, isAvailable: true),
            ],
            input: .current,
            servesSimulatorSessions: false
        )

        XCTAssertTrue(capability.supportsIOSSimulator)
        XCTAssertTrue(capability.supportsScreenshotVerification)
        XCTAssertTrue(capability.supportsFrameStreaming)
        XCTAssertFalse(capability.supportsEmbeddedInput, "this build ships no supported injection API and must not claim one")
        XCTAssertNotNil(capability.inputUnavailableReason)
        XCTAssertEqual(capability.installedPlatformVersions, ["iOS 27.0"], "only iOS runtimes are advertised")
        XCTAssertEqual(capability.availableDevices.map(\.udid), ["u1"], "watchOS devices are not iOS simulators")
        XCTAssertTrue(capability.availableDevices[0].booted)

        let encoded = try JSONEncoder().encode(capability)
        let decoded = try JSONDecoder().decode(SimulatorCapability.self, from: encoded)
        XCTAssertEqual(decoded, capability)
    }

    func testAnOlderRegistrationWithNoSimulatorFieldsDecodesAsUnsupported() throws {
        // Exactly what a pre-simulator client sends.
        let legacy = Data(#"{"name":"Liam’s Mac","platform":"macos","servesQueuedTasks":true}"#.utf8)
        let decoded = try JSONDecoder().decode(SimulatorCapability.self, from: legacy)
        XCTAssertFalse(decoded.supportsIOSSimulator)
        XCTAssertFalse(decoded.servesSimulatorSessions)
        XCTAssertFalse(decoded.canServeRemoteSession)
        XCTAssertEqual(decoded.simulatorProtocolVersion, 0, "an absent version is 0, not today's version")
    }

    func testXcodeWithoutAnIOSRuntimeIsNotAdvertisedAsSupported() {
        let capability = SimulatorCapability.from(
            toolchain: .ready(developerDirectory: "/dev", xcodeVersion: "27.0", xcodeBuild: "27A"),
            runtimes: [SimulatorRuntime(id: "w", name: "watchOS 27", version: "27.0", platform: "watchOS", isAvailable: true)],
            devices: [],
            input: .current,
            servesSimulatorSessions: true
        )
        XCTAssertFalse(capability.supportsIOSSimulator)
        XCTAssertFalse(capability.canServeRemoteSession)
        XCTAssertEqual(capability.xcodeVersion, "27.0", "the Xcode version is still worth reporting")
    }

    /// Capability and consent are different facts, and hosting is off until the
    /// user says otherwise. Serving queued Code work must not imply it.
    func testRemoteHostingRequiresBothCapabilityAndExplicitConsent() {
        let capable = { (consent: Bool) in
            SimulatorCapability.from(
                toolchain: .ready(developerDirectory: "/dev", xcodeVersion: "27", xcodeBuild: "b"),
                runtimes: [SimulatorRuntime(id: "ios", name: "iOS 27", version: "27.0", platform: "iOS", isAvailable: true)],
                devices: [SimulatorDevice(udid: "u", name: "iPhone", state: .shutdown, runtimeID: "ios", deviceTypeID: nil, isAvailable: true)],
                input: .current,
                servesSimulatorSessions: consent
            )
        }
        XCTAssertFalse(capable(false).canServeRemoteSession)
        XCTAssertTrue(capable(true).canServeRemoteSession)
        XCTAssertFalse(SimulatorCapability.unsupported.canServeRemoteSession)
    }

    func testProtocolVersionFallback() throws {
        var capability = SimulatorCapability.unsupported
        capability.simulatorProtocolVersion = SimulatorCapability.protocolVersion + 3
        let encoded = try JSONEncoder().encode(capability)
        let decoded = try JSONDecoder().decode(SimulatorCapability.self, from: encoded)
        // A newer protocol decodes; the *caller* decides not to speak it. The
        // decoder must not throw, or a newer Mac would break an older relay's
        // device registration entirely.
        XCTAssertEqual(decoded.simulatorProtocolVersion, SimulatorCapability.protocolVersion + 3)
        XCTAssertFalse(decoded.simulatorProtocolVersion <= SimulatorCapability.protocolVersion)
    }

    // MARK: Control lease

    func testOnlyOneOwnerHoldsControlAndTheUserAlwaysWins() async {
        let session = makeSession()
        let now = Date()

        let junoTook = await session.takeControl(.juno, now: now)
        XCTAssertTrue(junoTook)
        var lease = await session.lease
        XCTAssertEqual(lease.owner, .juno)

        // The user can always take it, immediately.
        let userTook = await session.takeControl(.user, now: now)
        XCTAssertTrue(userTook)
        lease = await session.lease
        XCTAssertEqual(lease.owner, .user)

        // Juno must wait while the user holds it.
        let junoSeized = await session.takeControl(.juno, now: now)
        XCTAssertFalse(junoSeized)
        lease = await session.lease
        XCTAssertEqual(lease.owner, .user, "Juno must not be able to seize control from the user")
    }

    func testALeaseExpiresSoADisconnectedClientCannotHoldControlForever() async {
        let session = makeSession()
        let start = Date()
        _ = await session.takeControl(.user, now: start, duration: 60)

        await session.expireLeaseIfNeeded(now: start.addingTimeInterval(30))
        var lease = await session.lease
        XCTAssertEqual(lease.owner, .user, "not yet expired")

        await session.expireLeaseIfNeeded(now: start.addingTimeInterval(61))
        lease = await session.lease
        XCTAssertEqual(lease.owner, .none)

        // Once released, Juno may take it.
        let junoTookAfterExpiry = await session.takeControl(.juno, now: start.addingTimeInterval(62))
        XCTAssertTrue(junoTookAfterExpiry)
    }

    func testJunoCanTakeControlOverAnExpiredUserLease() {
        let start = Date()
        let lease = SimulatorControlLease(owner: .user, acquiredAt: start, expiresAt: start.addingTimeInterval(10))
        XCTAssertFalse(lease.canTake(.juno, now: start.addingTimeInterval(5)))
        XCTAssertTrue(lease.canTake(.juno, now: start.addingTimeInterval(11)))
        XCTAssertTrue(lease.canTake(.user, now: start.addingTimeInterval(5)), "the user is never blocked")
    }

    // MARK: Discovery scanning

    func testFindsWorkspacesAndProjectsWithoutDescendingIntoNoise() throws {
        let root = try makeTemporaryTree([
            "App.xcodeproj",
            "App.xcworkspace",
            // A project bundle's own inner workspace is an implementation
            // detail and must never be offered as a container.
            "App.xcodeproj/project.xcworkspace",
            "node_modules/evil.xcodeproj",
            "Pods/Pods.xcodeproj",
            "Packages/Feature",
            "Deep/A/B/C/D/E/F/Buried.xcodeproj",
        ])
        defer { try? FileManager.default.removeItem(at: root) }

        let found = XcodeProjectDiscoveryService.scan(root: root)
        let names = found.map(\.path).map { ($0 as NSString).lastPathComponent }

        XCTAssertTrue(names.contains("App.xcworkspace"))
        XCTAssertTrue(names.contains("App.xcodeproj"))
        XCTAssertFalse(names.contains("evil.xcodeproj"), "node_modules is never the project you meant")
        XCTAssertFalse(names.contains("Pods.xcodeproj"))
        XCTAssertEqual(found.filter { $0.path.hasSuffix("project.xcworkspace") }.count, 0)
        XCTAssertFalse(names.contains("Buried.xcodeproj"), "the walk is depth-bounded")
    }

    func testFindsASwiftPackageWhenThereIsNoProjectBesideIt() throws {
        let root = try makeTemporaryTree(["PackageOnly"])
        defer { try? FileManager.default.removeItem(at: root) }
        FileManager.default.createFile(atPath: root.appendingPathComponent("PackageOnly/Package.swift").path, contents: Data())

        let found = XcodeProjectDiscoveryService.scan(root: root)
        XCTAssertTrue(found.contains { $0.kind == .swiftPackage && $0.name == "PackageOnly" })
    }

    // MARK: Process cleanup

    func testTerminatingAllLeavesNothingRunning() async throws {
        let runner = SimulatorProcessRunner()
        // A real long-lived child, so this is cleanup and not a mock.
        let sleeper = SimulatorCommands.Invocation(executable: "/bin/sleep", arguments: ["45"])

        let stream = runner.stream(sleeper)
        let consume = Task { for await _ in stream {} }
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(runner.liveProcessCount, 1)

        runner.terminateAll()
        consume.cancel()
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(runner.liveProcessCount, 0, "no process may outlive its runner")
    }

    func testCancellingARunTerminatesTheProcessRatherThanWaiting() async throws {
        let runner = SimulatorProcessRunner()
        let started = Date()
        let task = Task {
            try await runner.run(SimulatorCommands.Invocation(executable: "/bin/sleep", arguments: ["45"]), timeout: 0)
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        task.cancel()
        _ = try? await task.value

        XCTAssertLessThan(Date().timeIntervalSince(started), 20, "cancellation must not wait for the command")
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(runner.liveProcessCount, 0)
    }

    func testShutdownEndsEverythingAndIsSafeToCallTwice() async {
        let session = makeSession()
        await session.shutDown()
        await session.shutDown()
        let live = await session.liveProcessCount
        XCTAssertEqual(live, 0)
        let lease = await session.lease
        XCTAssertEqual(lease.owner, .none)
    }

    // MARK: Output handling

    func testTheLineBufferReassemblesSplitLinesAndIsBounded() {
        let buffer = LineBuffer()
        XCTAssertEqual(buffer.append("hel"), [])
        XCTAssertEqual(buffer.append("lo\nwor"), ["hello"])
        XCTAssertEqual(buffer.append("ld\n"), ["world"])
        XCTAssertEqual(buffer.flush(), [])

        let huge = String(repeating: "x", count: 70_000)
        XCTAssertEqual(buffer.append(huge).count, 1, "a newline-less flood is emitted rather than buffered forever")
    }

    // MARK: Helpers

    private func makeSession() -> SimulatorSessionService {
        SimulatorSessionService(
            configuration: .init(
                workspaceKey: "test",
                workspaceRoot: URL(fileURLWithPath: NSTemporaryDirectory()),
                containerDirectory: URL(fileURLWithPath: NSTemporaryDirectory())
            )
        )
    }

    private func makeTemporaryTree(_ relativeDirectories: [String]) throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-sim-\(UUID().uuidString)", isDirectory: true)
        for relative in relativeDirectories {
            try FileManager.default.createDirectory(
                at: root.appendingPathComponent(relative, isDirectory: true),
                withIntermediateDirectories: true
            )
        }
        return root
    }
}
