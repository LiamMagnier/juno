import Foundation
import JunoWorkCore
import JunoWorkRuntime
import XCTest

@testable import JunoWorkAutomation

/// Pinned at file scope rather than held on the test case, because the closures
/// it is read from are `@Sendable` and an `XCTestCase` is not.
private let suiteNow = Date(timeIntervalSince1970: 1_700_000_000)

/// What the model is shown, and what it is not.
///
/// The rule this suite exists for: a tool in front of the model that cannot act
/// is worse than no tool. It costs a turn, comes back as a refusal, and a
/// refusal reads to a model as the person's answer — so the run reports being
/// forbidden something nobody forbade. Every case below is a state a Mac is
/// routinely in.
final class AutomationSuiteTests: XCTestCase {
    private func permission(
        browser: Bool = true,
        accessibility: Bool = true,
        visual: Bool = true
    ) -> AutomationPermission {
        AutomationPermission(
            automationEnabled: true,
            allowsBrowserControl: browser,
            allowsAccessibilityControl: accessibility,
            allowsVisualControl: visual,
            allowedApps: ["com.example.notes"],
            allowedDomains: [".example.com"]
        )
    }

    private func tools(
        permission: AutomationPermission,
        screenshots: ScreenshotPolicy = ScreenshotPolicy(capturePermitted: true, retention: 60),
        drivers: AutomationDrivers
    ) async -> [String] {
        await AutomationSuite.readyTools(
            permission: permission,
            stop: EmergencyStop(),
            screenshots: screenshots,
            audit: AutomationAuditLog(),
            drivers: drivers,
            now: { suiteNow }
        ).map(\.name)
    }

    // MARK: - Only what has a driver

    /// A Mac with no drivers at all offers nothing. This was the shipping state
    /// before the system drivers existed: three controls conforming to
    /// ``WorkTool``, none of them reachable from any registry.
    func testAMacWithNoDriversAdvertisesNoControls() async {
        let names = await tools(permission: permission(), drivers: .none)
        XCTAssertEqual(names, [])
    }

    func testOnlyTheTiersWithADriverAreAdvertised() async {
        let names = await tools(
            permission: permission(),
            drivers: AutomationDrivers(accessibility: ScriptedAccessibilityDriver())
        )
        XCTAssertEqual(names, ["app_control"])
    }

    func testEveryTierWithADriverAndAPermissionIsAdvertised() async {
        let names = await tools(
            permission: permission(),
            drivers: AutomationDrivers(
                browser: ScriptedBrowserDriver(),
                accessibility: ScriptedAccessibilityDriver(),
                screen: ScriptedScreenDriver()
            )
        )
        XCTAssertEqual(names, ["app_control", "browser_control", "screen_control"])
    }

    // MARK: - Only what can act right now

    /// No browser running is an ordinary state, not a misconfiguration, and the
    /// answer to it is to stop offering the browser rather than to offer one
    /// that refuses.
    func testAControlWhoseDriverCannotActIsNotAdvertised() async {
        let names = await tools(
            permission: permission(),
            drivers: AutomationDrivers(
                browser: ScriptedBrowserDriver(script: .init(available: false)),
                accessibility: ScriptedAccessibilityDriver()
            )
        )
        XCTAssertEqual(names, ["app_control"])
    }

    func testATierSwitchedOffOnThisMacIsNotAdvertised() async {
        let names = await tools(
            permission: permission(browser: false, visual: false),
            drivers: AutomationDrivers(
                browser: ScriptedBrowserDriver(),
                accessibility: ScriptedAccessibilityDriver(),
                screen: ScriptedScreenDriver()
            )
        )
        XCTAssertEqual(names, ["app_control"])
    }

    func testAMacThatHasNotGrantedAccessibilityIsNotOfferedAppControl() async {
        let names = await tools(
            permission: permission(),
            drivers: AutomationDrivers(
                accessibility: ScriptedAccessibilityDriver(script: .init(trusted: false))
            )
        )
        XCTAssertEqual(names, [])
    }

    /// Screen control without capture is an agent clicking blind, so the tier
    /// goes away rather than guessing where the button was.
    func testScreenControlIsNotAdvertisedWhenItMayNotSeeTheScreen() async {
        let names = await tools(
            permission: permission(),
            screenshots: .refused,
            drivers: AutomationDrivers(screen: ScriptedScreenDriver())
        )
        XCTAssertEqual(names, [])
    }

    /// The master switch beats every driver that happens to be present.
    func testAMacWithAutomationSwitchedOffAdvertisesNothing() async {
        let names = await tools(
            permission: .denied,
            drivers: AutomationDrivers(
                browser: ScriptedBrowserDriver(),
                accessibility: ScriptedAccessibilityDriver(),
                screen: ScriptedScreenDriver()
            )
        )
        XCTAssertEqual(names, [])
    }

    // MARK: - Behind the lattice

    /// The controls are wired to each other, not just built beside each other.
    ///
    /// Screen control declares `activate_control` and so does the browser. With
    /// both healthy the lattice must refuse the coarser one — which it can only
    /// do if the gate the screen control holds can see the browser control, and
    /// that wiring is the thing this suite assembles.
    func testTheCoarserTierIsRefusedWhileAFinerOneCouldServe() async throws {
        let registry = await AutomationSuite.registry(
            permission: permission(),
            stop: EmergencyStop(),
            screenshots: ScreenshotPolicy(capturePermitted: true, retention: 60),
            audit: AutomationAuditLog(),
            drivers: AutomationDrivers(
                browser: ScriptedBrowserDriver(),
                screen: ScriptedScreenDriver()
            ),
            now: { suiteNow }
        )
        let approvals = WorkApprovalCoordinator(policy: .permissive, now: { suiteNow })
        do {
            _ = try await registry.invoke(
                toolName: "screen_control",
                input: .object([
                    "intent": .string("activate_control"),
                    "target": .string("com.example.notes"),
                    "x": .number(10),
                    "y": .number(10),
                ]),
                runID: "run-1",
                toolCallID: "call-1",
                approvals: approvals,
                at: suiteNow
            )
            XCTFail("screen control should be refused while the browser could serve the intent")
        } catch let error as WorkToolError {
            guard case .denied(let reason) = error else {
                return XCTFail("expected a denial, got \(error)")
            }
            XCTAssertTrue(reason.contains("Browser"), reason)
        }
    }

    /// With the browser gone, the same call is no longer refused on the grounds
    /// that a finer tier would have done it. A lattice that refused anyway would
    /// be a refusal with no remedy.
    func testTheCoarserTierIsAllowedOnceNothingFinerCanServe() async throws {
        let screen = ScriptedScreenDriver(script: .init(frontmost: "com.example.notes"))
        let registry = await AutomationSuite.registry(
            permission: permission(),
            stop: EmergencyStop(),
            screenshots: ScreenshotPolicy(capturePermitted: true, retention: 60),
            audit: AutomationAuditLog(),
            drivers: AutomationDrivers(screen: screen),
            // The scripted driver hands back bytes that are not an image, so the
            // real redactor cannot decode them and the capture is thrown away
            // before the click. What is under test here is the lattice, not
            // CoreGraphics.
            redactor: RecordingRedactor(),
            now: { suiteNow }
        )
        let approvals = WorkApprovalCoordinator(policy: .permissive, now: { suiteNow })
        let result = try await registry.invoke(
            toolName: "screen_control",
            input: .object([
                "intent": .string("activate_control"),
                "target": .string("com.example.notes"),
                "x": .number(10),
                "y": .number(10),
            ]),
            runID: "run-1",
            toolCallID: "call-1",
            approvals: approvals,
            at: suiteNow
        )
        XCTAssertTrue(result.content.contains("Clicked"))
        let calls = await screen.recorder.calls
        XCTAssertTrue(calls.contains("click:10,10"), "\(calls)")
    }
}
