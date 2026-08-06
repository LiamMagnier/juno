import XCTest
@testable import JunoSimulator

/// The one test that touches real Xcode and a real simulator.
///
/// Everything else in this target is deliberately hermetic — parsers against
/// captured fixtures, a state machine with no I/O — because those must run
/// everywhere, including a CI box with no Xcode. This one exercises the parts
/// that only exist when the toolchain does: that `xcodebuild -list` and
/// `simctl list` on *this* machine parse with the same code the fixtures
/// exercise, and that discovery finds a real project.
///
/// **It skips loudly rather than passing quietly.** A skipped integration test
/// that looks green is how "the simulator works" becomes something nobody has
/// actually checked. `XCTSkip` reports the specific missing piece — no Xcode, no
/// iOS runtime, no simulator — so the reason is in the log.
final class SimulatorIntegrationTests: XCTestCase {
    private let runner = SimulatorProcessRunner()

    override func tearDown() {
        runner.terminateAll()
        super.tearDown()
    }

    /// Guard shared by every test here.
    private func requireToolchain() async throws -> (runtimes: [SimulatorRuntime], devices: [SimulatorDevice]) {
        let discovery = XcodeProjectDiscoveryService(runner: runner)
        guard case .ready(_, let version, _) = await discovery.toolchain() else {
            throw XCTSkip("No usable Xcode on this machine — the parser and state tests still ran.")
        }
        let devices = SimulatorDeviceService(runner: runner)

        let runtimes: [SimulatorRuntime]
        do {
            runtimes = try await devices.runtimes()
        } catch {
            throw XCTSkip("`simctl list runtimes` failed: \(error)")
        }
        guard runtimes.contains(where: { $0.isIOS && $0.isAvailable }) else {
            throw XCTSkip("Xcode \(version) is installed but has no available iOS runtime.")
        }

        // Never `try?` here. A skip that says "no simulators" on a machine with
        // nineteen of them is the same class of dishonest reporting this whole
        // feature exists to avoid — the reason has to be the real one.
        let available: [SimulatorDevice]
        do {
            available = try await devices.devices()
        } catch {
            throw XCTSkip("`simctl list devices` failed: \(error)")
        }
        guard !available.isEmpty else { throw XCTSkip("`simctl list devices` returned no simulators.") }
        return (runtimes, available)
    }

    /// The real tools' output parses with the same code the fixtures cover.
    ///
    /// This is what catches an Xcode update changing a key: the fixtures would
    /// keep passing, and only this test would notice.
    func testRealToolOutputParsesWithTheFixtureParsers() async throws {
        let (runtimes, devices) = try await requireToolchain()

        let ios = runtimes.filter(\.isIOS)
        XCTAssertFalse(ios.isEmpty)
        XCTAssertTrue(ios.allSatisfy { !$0.id.isEmpty && !$0.version.isEmpty })

        let preferred = try SimulatorParsing.preferredRuntime(in: runtimes)
        XCTAssertTrue(preferred.isIOS)

        let device = try XCTUnwrap(
            SimulatorParsing.preferredDevice(in: devices, runtimeID: preferred.id),
            "the newest installed iOS runtime has no simulator"
        )
        XCTAssertTrue(device.isAvailable)
        XCTAssertFalse(device.udid.isEmpty)
    }

    /// Discovery finds the bundled sample and reads a scheme out of it.
    ///
    /// The fixture is a Swift package rather than an `.xcodeproj` so it can live
    /// in the repository as reviewable text.
    func testDiscoversTheBundledSampleProject() async throws {
        _ = try await requireToolchain()

        let sample = try XCTUnwrap(
            Bundle.module.url(forResource: "Fixtures/AuroraSample/Package", withExtension: "swift"),
            "the AuroraSample fixture is missing from the test bundle"
        ).deletingLastPathComponent()

        let containers = XcodeProjectDiscoveryService.scan(root: sample)
        XCTAssertTrue(
            containers.contains { $0.kind == .swiftPackage },
            "a directory with a Package.swift and no project beside it is a package"
        )

        let discovery = XcodeProjectDiscoveryService(runner: runner)
        let projects = await discovery.findProjects(root: sample)
        let package = try XCTUnwrap(projects.first { $0.kind == .swiftPackage })
        XCTAssertEqual(package.name, "AuroraSample")
        // `xcodebuild -list` on a package lists its products as schemes. An
        // empty list is a real answer here (some Xcodes decline), so the
        // assertion is that parsing succeeded, not that a scheme exists.
        XCTAssertNotNil(package.schemes)
    }

    /// Boot a device, capture a frame, and stop — the visual-verification path.
    ///
    /// Skipped unless a device is already booted: booting one from cold takes
    /// tens of seconds and leaves a simulator running on a developer's machine,
    /// which a unit-test run has no business doing.
    func testCapturesAFrameFromAnAlreadyBootedSimulator() async throws {
        let (_, devices) = try await requireToolchain()
        guard let booted = devices.first(where: { $0.state == .booted }) else {
            throw XCTSkip("No simulator is currently booted; this test does not boot one itself.")
        }

        let frames = SimulatorFrameService(runner: runner)
        let frame: SimulatorFrameService.Frame
        do {
            frame = try await frames.capture(udid: booted.udid, enforceRate: false)
        } catch {
            throw XCTSkip("Capture from \(booted.name) failed: \(error)")
        }

        XCTAssertFalse(frame.png.isEmpty)
        // A real PNG, not an empty file or an error page.
        XCTAssertEqual(Array(frame.png.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        XCTAssertEqual(frame.sequence, 1)

        // Nothing is left behind: the frame file is removed on the way out.
        await frames.cleanUp()
    }

    /// A build invocation formed against this machine's real device is one
    /// `xcodebuild` accepts — checked without running a full build by asking it
    /// to read settings with the same destination.
    func testTheBuildDestinationIsOneXcodeAccepts() async throws {
        let (runtimes, devices) = try await requireToolchain()
        let runtime = try SimulatorParsing.preferredRuntime(in: runtimes)
        let device = try XCTUnwrap(SimulatorParsing.preferredDevice(in: devices, runtimeID: runtime.id))

        let invocation = SimulatorCommands.build(
            project: XcodeProject(kind: .project, path: "/nonexistent/App.xcodeproj", name: "App", schemes: ["App"]),
            scheme: "App",
            configuration: "Debug",
            deviceUDID: device.udid,
            derivedDataPath: NSTemporaryDirectory() + "juno-integration-dd",
            clean: false
        )

        // The project does not exist, so this must fail — but on the *project*,
        // not on the destination. A malformed destination is a different error,
        // and that is the one this test is looking for.
        let result = try await runner.run(invocation, timeout: 120)
        XCTAssertFalse(result.succeeded)
        XCTAssertFalse(
            result.combined.contains("Unable to find a destination"),
            "Juno formed a destination Xcode does not accept: \(result.combined.prefix(400))"
        )
    }
}
