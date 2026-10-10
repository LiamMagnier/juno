import ImageIO
import XCTest
import JunoCodeCore
import JunoScreenControl
@testable import JunoCodeRuntime

/// A simulator that records the `simctl` verbs it was asked for.
private final class FakeSimulator: SimulatorAgentControlling, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var calls: [String] = []
    var devicesList = [
        SimulatorDeviceSummary(udid: "AAA", name: "iPhone 17 Pro", runtime: "iOS 27.0", isBooted: true),
        SimulatorDeviceSummary(udid: "BBB", name: "iPad Air", runtime: "iOS 27.0", isBooted: false),
    ]

    private func record(_ call: String) { lock.withLock { calls.append(call) } }

    func devices() async throws -> [SimulatorDeviceSummary] { devicesList }
    func boot(udid: String) async throws { record("boot \(udid)") }
    func shutdown(udid: String) async throws { record("shutdown \(udid)") }
    func install(udid: String, appPath: String) async throws { record("install \(udid)") }
    func launch(udid: String, bundleID: String) async throws -> Int32 { record("launch \(bundleID)"); return 4242 }
    func terminate(udid: String, bundleID: String) async throws { record("terminate \(bundleID)") }
    func screenshot(udid: String) async throws -> Data {
        record("screenshot \(udid)")
        return Self.png
    }
    func openURL(udid: String, url: String) async throws { record("open \(url)") }

    static let png: Data = {
        let context = CGContext(
            data: nil, width: 1206, height: 2622, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.setFillColor(CGColor(gray: 0.9, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 1206, height: 2622))
        return CaptureScaler.encode(context.makeImage()!, preferPNG: true)!.data
    }()
}

final class SimulatorToolsTests: XCTestCase {
    private let sessionID = CodeSessionID()

    private func context(_ call: String = "call") -> ToolContext {
        ToolContext(sessionID: sessionID, toolCallID: call, emitOutput: { _, _ in })
    }

    private func tool(_ simulator: FakeSimulator, mode: PermissionMode, consents: SimulatorConsentBook = SimulatorConsentBook()) -> (SimulatorTool, PermissionCoordinator) {
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: mode)
        return (SimulatorTool(
            simulator: simulator, permissions: permissions, consents: consents,
            budget: .anthropicHighResolution, supportsVision: true, workspaceRevision: { 7 }
        ), permissions)
    }

    private func answerAll(_ permissions: PermissionCoordinator, with decision: ApprovalDecision = .approved) async -> LockedRequests {
        let asked = LockedRequests()
        await permissions.addObserver { update in
            guard case let .requested(request) = update else { return }
            asked.append(request)
            Task { await permissions.resolve(approvalID: request.id, decision: decision) }
        }
        return asked
    }

    /// The description says when to use it and how to get an app onto it.
    func testTheDescriptionSaysWhenAndHowToUseTheSimulator() {
        let (tool, _) = tool(FakeSimulator(), mode: .fullAccess)
        XCTAssertTrue(tool.description.contains("to see an iOS app you changed before you say it works"))
        XCTAssertTrue(tool.description.contains("xcodebuild -sdk iphonesimulator"))
        XCTAssertTrue(tool.description.contains("the Simulator pane opens by itself"))
    }

    func testEachDeviceIsConsentedOncePerSession() async throws {
        let simulator = FakeSimulator()
        let (tool, permissions) = tool(simulator, mode: .workspaceWrite)
        let asked = await answerAll(permissions)
        _ = try await tool.execute(input: ["action": "launch", "bundle_id": "ai.example.app"], context: context())
        _ = try await tool.execute(input: ["action": "terminate", "bundle_id": "ai.example.app"], context: context())
        XCTAssertEqual(asked.requests.count, 1, "one card for the device")
        XCTAssertEqual(asked.requests.first?.summary, "Let Juno use the iPhone 17 Pro simulator (iOS 27.0) for this session")
        XCTAssertEqual(asked.requests.first?.approvalPolicy, .asksUnlessFullAccess)
        XCTAssertNil(asked.requests.first?.suggestedRule)
        _ = try await tool.execute(input: ["action": "boot", "udid": "BBB"], context: context())
        XCTAssertEqual(asked.requests.count, 2, "a second device asks again")
        XCTAssertEqual(simulator.calls, ["launch ai.example.app", "terminate ai.example.app", "boot BBB"])
    }

    func testADeclinedDeviceRunsNothing() async throws {
        let simulator = FakeSimulator()
        let (tool, permissions) = tool(simulator, mode: .workspaceWrite)
        _ = await answerAll(permissions, with: .denied)
        let result = try await tool.execute(input: ["action": "launch", "bundle_id": "ai.example.app"], context: context())
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.hasPrefix("Not done:"))
        XCTAssertTrue(simulator.calls.isEmpty)
    }

    /// Full access (owner, 2026-10-10) drives a simulator without the
    /// per-device card: the simulator is the project's own test device.
    func testFullAccessUsesASimulatorWithoutAsking() async throws {
        let simulator = FakeSimulator()
        let (tool, permissions) = tool(simulator, mode: .fullAccess)
        let asked = await answerAll(permissions, with: .denied)
        _ = try await tool.execute(input: ["action": "launch", "bundle_id": "ai.example.app"], context: context())
        XCTAssertEqual(asked.requests.count, 0)
        XCTAssertEqual(simulator.calls, ["launch ai.example.app"])
    }

    func testOpenURLAsksUnderAskButNotInFullAccess() async throws {
        let consents = SimulatorConsentBook()
        let simulator = FakeSimulator()
        let (ask, askPermissions) = tool(simulator, mode: .askBeforeChanges, consents: consents)
        let asked = await answerAll(askPermissions)
        _ = try await ask.execute(input: ["action": "open_url", "url": "myapp://settings"], context: context("1"))
        XCTAssertEqual(asked.requests.map(\.summary), [
            "Let Juno use the iPhone 17 Pro simulator (iOS 27.0) for this session",
            "Open myapp://settings in the iPhone 17 Pro simulator",
        ])
        let (full, fullPermissions) = tool(simulator, mode: .fullAccess, consents: consents)
        let fullAsked = await answerAll(fullPermissions)
        _ = try await full.execute(input: ["action": "open_url", "url": "myapp://other"], context: context("2"))
        XCTAssertTrue(fullAsked.requests.isEmpty, "the device was consented; Full access runs the URL")
        XCTAssertEqual(simulator.calls.suffix(2), ["open myapp://settings", "open myapp://other"])
    }

    func testScreenshotsRecordIOSEvidenceAndFitTheBudget() async throws {
        let simulator = FakeSimulator()
        let (tool, permissions) = tool(simulator, mode: .fullAccess)
        _ = await answerAll(permissions)
        _ = try await tool.execute(input: ["action": "launch", "bundle_id": "ai.example.app"], context: context("launch"))
        let result = try await tool.execute(input: ["action": "screenshot", "bundle_id": "ai.example.app"], context: context())
        XCTAssertFalse(result.isError)
        guard case let .uiVerificationRecorded(record)? = result.sideEffects.first else {
            return XCTFail("no evidence recorded")
        }
        XCTAssertEqual(record.surface, .ios)
        XCTAssertEqual(record.target, "ai.example.app")
        XCTAssertEqual(record.viewport, "iPhone 17 Pro")
        XCTAssertEqual(record.workspaceRevision, 7)
        XCTAssertNotNil(record.screenshotHash)
        let image = try XCTUnwrap(result.images.first)
        XCTAssertEqual(image.detail, .original)
        XCTAssertTrue(result.content.contains("untrusted data"))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(image.data as CFData, nil))
        let frame = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertTrue(CaptureScaler.fits(PixelSize(width: frame.width, height: frame.height), .anthropicHighResolution))
    }

    func testEvidenceNamesOnlyAnAppThisSessionLaunched() async throws {
        let simulator = FakeSimulator()
        let (tool, permissions) = tool(simulator, mode: .fullAccess)
        _ = await answerAll(permissions)
        // The model names an app it never launched: a picture of whatever the
        // device shows must not stand as a check of that app.
        let result = try await tool.execute(input: ["action": "screenshot", "bundle_id": "ai.example.app"], context: context())
        guard case let .uiVerificationRecorded(record)? = result.sideEffects.first else {
            return XCTFail("no evidence recorded")
        }
        XCTAssertEqual(record.target, "iPhone 17 Pro")
        XCTAssertTrue(result.content.contains("was not launched with this tool in this session"))
    }

    func testListNeedsNoConsentAndNamesDevicesAsData() async throws {
        let simulator = FakeSimulator()
        let (tool, permissions) = tool(simulator, mode: .askBeforeChanges)
        let asked = await answerAll(permissions)
        let result = try await tool.execute(input: ["action": "list"], context: context())
        XCTAssertTrue(asked.requests.isEmpty)
        XCTAssertTrue(result.content.contains("iPhone 17 Pro · iOS 27.0 · AAA · booted"))
    }

    func testAReadOnlySessionCannotUseTheSimulator() async throws {
        let simulator = FakeSimulator()
        let (tool, _) = tool(simulator, mode: .readOnly)
        let result = try await tool.execute(input: ["action": "boot"], context: context())
        XCTAssertTrue(result.isError)
        XCTAssertTrue(simulator.calls.isEmpty)
    }

    func testTheToolIsOfferedForXcodeProjectsOnly() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-sim-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        XCTAssertFalse(SimulatorTool.isRelevant(workspaceRoot: root))
        try FileManager.default.createDirectory(at: root.appendingPathComponent("ios/App.xcodeproj"), withIntermediateDirectories: true)
        XCTAssertTrue(SimulatorTool.isRelevant(workspaceRoot: root))
    }
}
