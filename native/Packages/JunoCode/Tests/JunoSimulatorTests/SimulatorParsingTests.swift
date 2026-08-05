import XCTest
@testable import JunoSimulator

/// Parser tests run against fixtures captured from the real tools on a machine
/// with Xcode 27 and an iOS 27 runtime, plus hand-written fixtures for the
/// shapes that are hard to produce on demand (an older Xcode's runtime list, a
/// project with no shared scheme, a macOS-only target, a failing build).
///
/// These need no Xcode, no simulator and no network, so they run everywhere —
/// which is the point: the parsing is the part most likely to break on an Xcode
/// update, and it must be covered even where an integration test cannot run.
final class SimulatorParsingTests: XCTestCase {
    private func fixture(_ name: String, _ ext: String = "json") throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: ext),
            "missing fixture \(name).\(ext)"
        )
        return try Data(contentsOf: url)
    }

    private func fixtureText(_ name: String, _ ext: String) throws -> String {
        String(decoding: try fixture(name, ext), as: UTF8.self)
    }

    // MARK: Schemes

    func testParsesWorkspaceSchemes() throws {
        let list = try SimulatorParsing.parseSchemeList(fixture("xcodebuild-list-workspace"))
        XCTAssertEqual(list.name, "Aurora")
        XCTAssertEqual(list.schemes, ["Aurora", "AuroraTests", "AuroraKit"])
    }

    func testParsesProjectSchemesAndConfigurations() throws {
        let list = try SimulatorParsing.parseSchemeList(fixture("xcodebuild-list-project"))
        XCTAssertEqual(list.schemes, ["Aurora"])
        XCTAssertEqual(list.configurations, ["Debug", "Release"])
        XCTAssertEqual(list.targets, ["Aurora", "AuroraTests"])
    }

    /// A project whose schemes are not shared lists none. That is a real state
    /// with a real fix, so it must parse cleanly and report emptiness rather
    /// than throw.
    func testAProjectWithNoSharedSchemesParsesAsEmpty() throws {
        let list = try SimulatorParsing.parseSchemeList(fixture("xcodebuild-list-no-shared-schemes"))
        XCTAssertTrue(list.schemes.isEmpty)
        XCTAssertEqual(list.targets, ["Aurora"])
    }

    func testRejectsUnparseableSchemeOutput() {
        XCTAssertThrowsError(try SimulatorParsing.parseSchemeList(Data("not json".utf8))) {
            XCTAssertEqual($0 as? SimulatorParsing.ParseError, .notJSON)
        }
        XCTAssertThrowsError(try SimulatorParsing.parseSchemeList(Data("{}".utf8))) {
            XCTAssertEqual($0 as? SimulatorParsing.ParseError, .missing("workspace/project"))
        }
    }

    // MARK: Build settings and app discovery

    func testFindsTheApplicationTargetAndItsBuiltProduct() throws {
        let settings = try SimulatorParsing.parseBuildSettings(fixture("xcodebuild-settings-app"))
        XCTAssertEqual(settings.bundleIdentifier, "com.example.Aurora")
        XCTAssertEqual(settings.productName, "Aurora.app")
        XCTAssertEqual(settings.appPath, "/tmp/juno-derived/Build/Products/Debug-iphonesimulator/Aurora.app")
        XCTAssertEqual(settings.deploymentTarget, "17.0")
        XCTAssertTrue(settings.targetsIOSSimulator)
    }

    /// The scheme also builds a framework; picking the first entry would install
    /// a `.framework` and fail with a confusing message.
    func testIgnoresNonApplicationTargetsInTheSameScheme() throws {
        let settings = try SimulatorParsing.parseBuildSettings(fixture("xcodebuild-settings-app"))
        XCTAssertFalse(settings.productName.hasSuffix(".framework"))
    }

    func testDetectsAMacOnlyTarget() throws {
        let settings = try SimulatorParsing.parseBuildSettings(fixture("xcodebuild-settings-macos-only"))
        XCTAssertFalse(settings.targetsIOSSimulator, "a macOS-only scheme must not be offered to the simulator")
    }

    func testRejectsSettingsWithNoApplication() {
        let json = Data(#"[{"buildSettings":{"PRODUCT_TYPE":"com.apple.product-type.library.static","FULL_PRODUCT_NAME":"libx.a"}}]"#.utf8)
        XCTAssertThrowsError(try SimulatorParsing.parseBuildSettings(json)) {
            XCTAssertEqual($0 as? SimulatorParsing.ParseError, .noApplicationScheme)
        }
    }

    func testRejectsSettingsMissingTheBundleIdentifier() {
        let json = Data(#"[{"buildSettings":{"PRODUCT_TYPE":"com.apple.product-type.application","FULL_PRODUCT_NAME":"A.app","TARGET_BUILD_DIR":"/tmp"}}]"#.utf8)
        XCTAssertThrowsError(try SimulatorParsing.parseBuildSettings(json)) {
            XCTAssertEqual($0 as? SimulatorParsing.ParseError, .missing("PRODUCT_BUNDLE_IDENTIFIER"))
        }
    }

    // MARK: Runtimes

    func testParsesRealRuntimeOutput() throws {
        let runtimes = try SimulatorParsing.parseRuntimes(fixture("simctl-runtimes"))
        XCTAssertFalse(runtimes.isEmpty)
        let ios = try XCTUnwrap(runtimes.first { $0.isIOS })
        XCTAssertTrue(ios.isAvailable)
        XCTAssertTrue(ios.name.hasPrefix("iOS"))
        XCTAssertTrue(runtimes.contains { $0.platform.lowercased() == "watchos" })
    }

    /// Older Xcodes omit `platform` and report availability as a string. Both
    /// must still yield usable runtimes rather than an empty list that reads as
    /// "no iOS runtime installed".
    func testParsesLegacyRuntimeOutput() throws {
        let runtimes = try SimulatorParsing.parseRuntimes(fixture("simctl-runtimes-legacy"))
        XCTAssertEqual(runtimes.count, 3)
        let ios = runtimes.filter(\.isIOS)
        XCTAssertEqual(ios.count, 2)
        XCTAssertTrue(ios.allSatisfy(\.isAvailable))
        XCTAssertEqual(runtimes.first { $0.version == "9.4" }?.platform, "watchOS")
    }

    /// String comparison puts "9.3" above "16.4", which would silently default
    /// every project to a decade-old runtime.
    func testPrefersTheNewestIOSRuntimeNumerically() throws {
        let runtimes = try SimulatorParsing.parseRuntimes(fixture("simctl-runtimes-legacy"))
        let preferred = try SimulatorParsing.preferredRuntime(in: runtimes)
        XCTAssertEqual(preferred.version, "16.4")

        XCTAssertEqual(SimulatorParsing.compareVersions("9.3", "16.4"), .orderedAscending)
        XCTAssertEqual(SimulatorParsing.compareVersions("27.0", "27"), .orderedSame)
        XCTAssertEqual(SimulatorParsing.compareVersions("27.1", "27.0.9"), .orderedDescending)
    }

    func testReportsWhenNoIOSRuntimeIsInstalled() {
        let watchOnly = [SimulatorRuntime(id: "w", name: "watchOS 11", version: "11.0", platform: "watchOS", isAvailable: true)]
        XCTAssertThrowsError(try SimulatorParsing.preferredRuntime(in: watchOnly)) {
            XCTAssertEqual($0 as? SimulatorParsing.ParseError, .noIOSRuntime)
        }
    }

    // MARK: Devices

    func testParsesRealDeviceOutputWithStableOrder() throws {
        let devices = try SimulatorParsing.parseDevices(fixture("simctl-devices"))
        XCTAssertFalse(devices.isEmpty)
        XCTAssertTrue(devices.contains { $0.name.hasPrefix("iPhone") })

        // Dictionary iteration is unordered; the parser must not be.
        let again = try SimulatorParsing.parseDevices(fixture("simctl-devices"))
        XCTAssertEqual(devices.map(\.udid), again.map(\.udid))
    }

    func testPrefersABootedDeviceThenTheNewestIPhone() throws {
        let devices = try SimulatorParsing.parseDevices(fixture("simctl-devices"))
        let iosRuntime = try XCTUnwrap(devices.first { $0.runtimeID.contains("iOS") }).runtimeID

        let preferred = try XCTUnwrap(SimulatorParsing.preferredDevice(in: devices, runtimeID: iosRuntime))
        XCTAssertEqual(preferred.state, .booted, "a booted device is the one the user is already looking at")

        // With nothing booted, an iPhone wins over other device families.
        let shutdown = devices.map {
            SimulatorDevice(
                udid: $0.udid, name: $0.name, state: .shutdown,
                runtimeID: $0.runtimeID, deviceTypeID: $0.deviceTypeID, isAvailable: $0.isAvailable
            )
        }
        let fallback = try XCTUnwrap(SimulatorParsing.preferredDevice(in: shutdown, runtimeID: iosRuntime))
        XCTAssertTrue(fallback.name.hasPrefix("iPhone"))
    }

    func testSkipsUnavailableDevices() {
        let devices = [
            SimulatorDevice(udid: "a", name: "iPhone 17", state: .shutdown, runtimeID: "r", deviceTypeID: nil, isAvailable: false),
            SimulatorDevice(udid: "b", name: "iPad", state: .shutdown, runtimeID: "r", deviceTypeID: nil, isAvailable: true),
        ]
        XCTAssertEqual(SimulatorParsing.preferredDevice(in: devices, runtimeID: "r")?.udid, "b")
    }

    func testUnknownDeviceStatesDecodeAsUnknownRatherThanFailing() {
        XCTAssertEqual(SimulatorDeviceState(wire: "Booted"), .booted)
        XCTAssertEqual(SimulatorDeviceState(wire: "Reticulating"), .unknown)
    }

    // MARK: Diagnostics

    func testExtractsReadableDiagnosticsFromABuildFailure() throws {
        let diagnostics = SimulatorParsing.parseDiagnostics(try fixtureText("xcodebuild-failure", "log"))

        let first = try XCTUnwrap(diagnostics.first)
        XCTAssertEqual(first.severity, .error)
        XCTAssertEqual(first.file, "/Users/dev/Aurora/Sources/ContentView.swift")
        XCTAssertEqual(first.line, 42)
        XCTAssertEqual(first.column, 9)
        XCTAssertEqual(first.message, "cannot find 'titel' in scope")

        XCTAssertTrue(diagnostics.contains { $0.severity == .warning && $0.line == 51 })
        // A file:line with no column still parses.
        XCTAssertTrue(diagnostics.contains { $0.line == 8 && $0.message.contains("unterminated string") })
        // xcodebuild's own bare "error:" lines are diagnostics too.
        XCTAssertTrue(diagnostics.contains { $0.file == nil && $0.message.contains("development team") })
        XCTAssertTrue(diagnostics.contains { $0.severity == .note })
    }

    func testDiagnosticsAreDeduplicated() {
        let repeated = Array(repeating: "/a/B.swift:1:1: error: boom", count: 5).joined(separator: "\n")
        XCTAssertEqual(SimulatorParsing.parseDiagnostics(repeated).count, 1)
    }

    func testASuccessfulBuildHasNoErrorDiagnostics() {
        let output = "** BUILD SUCCEEDED **\nCompileSwift normal arm64\n"
        XCTAssertTrue(SimulatorParsing.parseDiagnostics(output).allSatisfy { $0.severity != .error })
    }

    // MARK: Launch and version

    func testReadsTheLaunchProcessID() {
        XCTAssertEqual(SimulatorParsing.parseLaunchPID("com.example.Aurora: 54321"), 54_321)
        XCTAssertEqual(SimulatorParsing.parseLaunchPID("com.example.Aurora: 54321\n"), 54_321)
        XCTAssertNil(SimulatorParsing.parseLaunchPID("com.example.Aurora: launched"))
        XCTAssertNil(SimulatorParsing.parseLaunchPID(""))
        XCTAssertNil(SimulatorParsing.parseLaunchPID("com.example.Aurora: 0"), "pid 0 is not evidence of a running app")
    }

    func testParsesTheXcodeVersion() throws {
        let parsed = try XCTUnwrap(SimulatorParsing.parseXcodeVersion(try fixtureText("xcodebuild-version", "txt")))
        XCTAssertFalse(parsed.version.isEmpty)
        XCTAssertFalse(parsed.build.isEmpty)
        XCTAssertNil(SimulatorParsing.parseXcodeVersion("command not found"))
    }
}
