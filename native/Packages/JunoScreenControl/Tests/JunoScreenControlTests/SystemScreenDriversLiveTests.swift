#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
import XCTest
@testable import JunoScreenControl

/// Opt-in hardware check. Reads Calculator only; it never posts input or
/// requests macOS permission. Missing grants are a skip, not a false pass.
final class SystemScreenDriversLiveTests: XCTestCase {
    func testUnconfirmedAccessibilityWritesNeverTriggerFallbackInput() throws {
        XCTAssertTrue(try AXWriteResult.accepted(.success))
        XCTAssertFalse(try AXWriteResult.accepted(.actionUnsupported))
        XCTAssertFalse(try AXWriteResult.accepted(.attributeUnsupported))
        for status in [AXError.cannotComplete, .failure, .invalidUIElement, .apiDisabled] {
            XCTAssertThrowsError(try AXWriteResult.accepted(status)) { error in
                XCTAssertTrue(error.localizedDescription.contains("result is unknown"))
                XCTAssertTrue(error.localizedDescription.contains("not repeated"))
            }
        }
    }

    func testRealBackgroundWindowCaptureAndAccessibility() async throws {
        guard ProcessInfo.processInfo.environment["JUNO_LIVE_SCREEN_TESTS"] == "1" else {
            throw XCTSkip("Set JUNO_LIVE_SCREEN_TESTS=1 for the real-Mac observation check.")
        }
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
            throw XCTSkip("This test process does not have Accessibility and Screen Recording grants.")
        }
        let environment = SystemScreenEnvironment()
        let alreadyRunning = await environment.runningApps().contains { $0.bundleID == "com.apple.calculator" }
        let app = try await environment.open(bundleID: "com.apple.calculator")
        do {
            var window: WindowInfo?
            for _ in 0..<30 {
                window = await environment.windows(pid: app.pid).first
                if window != nil { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            let target = try XCTUnwrap(window)
            let capture = SystemScreenCapture()
            let start = ContinuousClock.now
            let first = try await capture.capture(window: target)
            let middle = ContinuousClock.now
            let second = try await capture.capture(window: target)
            let end = ContinuousClock.now
            XCTAssertGreaterThan(first.image.width, 0)
            XCTAssertEqual(first.image.width, second.image.width)
            XCTAssertEqual(second.origin.x, target.frame.x)
            let snapshot = try await SystemAccessibility().snapshot(pid: app.pid, maxDepth: 12)
            XCTAssertEqual(snapshot.bundleID, app.bundleID)
            XCTAssertTrue(snapshot.elements.contains { $0.isInteractive })
            print("[computer-use live] cold capture: \(start.duration(to: middle)); warm capture: \(middle.duration(to: end)); AX nodes: \(snapshot.elements.count)")
            if !alreadyRunning { await MainActor.run { _ = NSRunningApplication(processIdentifier: app.pid)?.terminate() } }
        } catch {
            if !alreadyRunning { await MainActor.run { _ = NSRunningApplication(processIdentifier: app.pid)?.terminate() } }
            throw error
        }
    }
}
#endif
