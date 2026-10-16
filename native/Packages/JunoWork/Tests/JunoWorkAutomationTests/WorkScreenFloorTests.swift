#if canImport(JunoScreenControl)
import Foundation
import JunoScreenControl
import JunoWorkCore
import JunoWorkRuntime
import XCTest

@testable import JunoWorkAutomation

/// Work's screen and app control on the one pipeline Code uses: the same
/// consequential-action floor against the hit-tested target, and the same
/// action overlay feed.
final class WorkScreenFloorTests: XCTestCase {
    private static let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)

    private func permission(apps: Set<String> = ["com.example.notes"]) -> AutomationPermission {
        AutomationPermission(
            automationEnabled: true,
            allowsAccessibilityControl: true,
            allowsVisualControl: true,
            allowedApps: apps
        )
    }

    private func gate(apps: Set<String> = ["com.example.notes"], audit: AutomationAuditLog = AutomationAuditLog()) -> AutomationGate {
        AutomationGate(
            permission: permission(apps: apps),
            stop: EmergencyStop(),
            screenshots: ScreenshotPolicy(capturePermitted: true, retention: 60),
            audit: audit,
            now: { Self.fixedNow }
        )
    }

    private func context(_ approvals: WorkApprovalCoordinator) -> WorkToolContext {
        WorkToolContext(runID: "run-1", toolCallID: "call-1", authorization: .allowedByPolicy, approvals: approvals)
    }

    private func visual(
        _ gate: AutomationGate,
        driver: ScriptedScreenDriver,
        underPoint: WorkScreenTarget? = nil,
        focused: WorkScreenTarget? = nil,
        feed: ComputerActionFeed? = nil
    ) -> VisualControl {
        VisualControl(
            driver: driver,
            gate: gate,
            redactor: RecordingRedactor(),
            pacer: VisualPacer(interval: 0),
            targets: ScriptedScreenTargets(underPoint: underPoint, focused: focused),
            overlay: WorkActionOverlay(feed: feed)
        )
    }

    private func button(_ title: String, app: String = "com.example.notes", name: String = "Notes") -> WorkScreenTarget {
        WorkScreenTarget(
            bundleIdentifier: app,
            appName: name,
            texts: [title, "button"],
            spokenName: "“\(title)” button",
            role: "AXButton",
            frame: AutomationRect(x: 90, y: 190, width: 20, height: 20)
        )
    }

    private func click(_ app: String = "com.example.notes") -> WorkToolValue {
        ["intent": "activate_control", "target": .string(app), "x": 100, "y": 200]
    }

    /// The first question the coordinator is asked, once it is asked.
    private func firstPending(_ approvals: WorkApprovalCoordinator) async throws -> WorkApprovalRequest {
        for _ in 0..<400 {
            if let first = await approvals.pendingApprovals.first { return first }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw NoQuestionAsked()
    }

    private func denial(_ error: any Error) -> String? {
        guard case WorkToolError.denied(let reason)? = error as? WorkToolError else { return nil }
        return reason
    }

    private func cues(_ stream: AsyncStream<ComputerActionCue>, count: Int) async -> [ComputerActionCue] {
        var out: [ComputerActionCue] = []
        for await cue in stream {
            out.append(cue)
            if out.count == count { break }
        }
        return out
    }

    // MARK: - One overlay

    func testAWorkVisualClickPostsActingThenSettledOnTheInjectedFeed() async throws {
        let feed = ComputerActionFeed()
        let stream = feed.cues()
        let driver = ScriptedScreenDriver()
        let control = visual(gate(), driver: driver, underPoint: button("Bold"), feed: feed)

        let result = try await control.execute(input: click(), context: context(WorkApprovalCoordinator(policy: .permissive)))
        XCTAssertTrue(result.content.contains("Clicked"))

        let posted = await cues(stream, count: 2)
        XCTAssertEqual(posted.map(\.phase), [.acting, .settled(succeeded: true)])
        XCTAssertEqual(posted.first?.sessionID, "work:run-1", "the id Work holds the lock under")
        XCTAssertEqual(posted.first?.label, "Click the “Bold” button in Notes")
        XCTAssertEqual(posted.first?.point, ScreenPoint(x: 100, y: 200))
        XCTAssertEqual(posted.first?.appName, "Notes")
        let calls = await driver.recorder.calls
        XCTAssertTrue(calls.contains("click:100,200"))
    }

    func testAWorkAccessibilityPressPostsCuesToo() async throws {
        let feed = ComputerActionFeed()
        let stream = feed.cues()
        let driver = ScriptedAccessibilityDriver(script: .init(outline: AccessibilityWindowOutline(
            bundleIdentifier: "com.example.notes",
            windowTitle: "Notes",
            fields: [AccessibilityFieldDescriptor(elementID: "0/2", role: "AXButton", label: "Bold")]
        )))
        let control = AccessibilityControl(driver: driver, gate: gate(), overlay: WorkActionOverlay(feed: feed))
        _ = try await control.execute(
            input: ["intent": "activate_control", "target": "com.example.notes", "element": "0/2"],
            context: context(WorkApprovalCoordinator(policy: .permissive))
        )
        let posted = await cues(stream, count: 2)
        XCTAssertEqual(posted.map(\.phase), [.acting, .settled(succeeded: true)])
        XCTAssertEqual(posted.first?.label, "Press the “Bold” button in com.example.notes")
    }

    func testAFailedInputSettlesAsFailed() async throws {
        let feed = ComputerActionFeed()
        let stream = feed.cues()
        let driver = FailingClickDriver()
        let control = VisualControl(
            driver: driver, gate: gate(), redactor: RecordingRedactor(), pacer: VisualPacer(interval: 0),
            overlay: WorkActionOverlay(feed: feed)
        )
        do {
            _ = try await control.execute(input: click(), context: context(WorkApprovalCoordinator(policy: .permissive)))
            XCTFail("the click failed")
        } catch {}
        let posted = await cues(stream, count: 2)
        XCTAssertEqual(posted.map(\.phase), [.acting, .settled(succeeded: false)])
    }

    // MARK: - One floor

    /// Full access (permissive) asks about nothing short of irreversible;
    /// a plain `activate_control` click is `command`. The floor still asks
    /// because the hit-tested control says "Send", exactly as it does for Code.
    func testAWorkClickOnSendAsksUnderFullAccessAndClicksOnlyAfterYes() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedScreenDriver()
        let control = visual(gate(), driver: driver, underPoint: button("Send"))
        let (input, ctx) = (click(), context(approvals))
        let run = Task { try await control.execute(input: input, context: ctx) }

        let question = try await firstPending(approvals)
        XCTAssertEqual(question.risk, .irreversible, "never coverable by a policy or an always-allow")
        XCTAssertTrue(question.summary.hasPrefix("Click the “Send” button in Notes."), question.summary)
        XCTAssertTrue(question.summary.contains("This looks like a “send” control, so Alevr always asks, even in Full access."), question.summary)
        var calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains { $0.hasPrefix("click") }, "nothing is clicked while the question is open")

        await approvals.resolve(approvalID: question.id, decision: .approved, actionDigest: question.actionDigest)
        let result = try await run.value
        XCTAssertTrue(result.content.contains("Clicked"))
        calls = await driver.recorder.calls
        XCTAssertTrue(calls.contains("click:100,200"))
    }

    func testAWorkClickOnDeleteThatThePersonRefusesIsNeverSent() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedScreenDriver()
        let control = visual(gate(), driver: driver, underPoint: button("Delete"))
        let (input, ctx) = (click(), context(approvals))
        let run = Task { try await control.execute(input: input, context: ctx) }

        let question = try await firstPending(approvals)
        XCTAssertTrue(question.summary.contains("“delete” control"), question.summary)
        await approvals.resolve(approvalID: question.id, decision: .denied, actionDigest: question.actionDigest)
        do {
            _ = try await run.value
            XCTFail("a refused Delete must not be clicked")
        } catch {
            XCTAssertNotNil(denial(error))
        }
        let calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains { $0.hasPrefix("click") })
    }

    func testAnAccessibilityPressOnAControlTitledSendAsksUnderFullAccess() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedAccessibilityDriver(script: .init(outline: AccessibilityWindowOutline(
            bundleIdentifier: "com.example.notes",
            windowTitle: "Notes",
            fields: [AccessibilityFieldDescriptor(elementID: "0/3", role: "AXButton", label: "Send")]
        )))
        let control = AccessibilityControl(driver: driver, gate: gate())
        let ctx = context(approvals)
        let run = Task {
            try await control.execute(
                input: ["intent": "activate_control", "target": "com.example.notes", "element": "0/3"],
                context: ctx
            )
        }
        let question = try await firstPending(approvals)
        XCTAssertTrue(question.summary.contains("“send” control"), question.summary)
        await approvals.resolve(approvalID: question.id, decision: .denied, actionDigest: question.actionDigest)
        do {
            _ = try await run.value
            XCTFail("a refused Send must not be pressed")
        } catch {}
        let calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains { $0.hasPrefix("press") })
    }

    /// A question can stay open for minutes. If the control under the point
    /// is a different one by the time the person says yes, the yes was for
    /// something no longer there, and nothing is clicked.
    func testAYesForAControlThatChangedMeanwhileClicksNothing() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedScreenDriver()
        let control = VisualControl(
            driver: driver, gate: gate(), redactor: RecordingRedactor(), pacer: VisualPacer(interval: 0),
            targets: ChangingTargets(first: button("Send"), then: button("Delete account"))
        )
        let (input, ctx) = (click(), context(approvals))
        let run = Task { try await control.execute(input: input, context: ctx) }
        let question = try await firstPending(approvals)
        await approvals.resolve(approvalID: question.id, decision: .approved, actionDigest: question.actionDigest)
        do {
            _ = try await run.value
            XCTFail("the approved control is gone")
        } catch {
            XCTAssertTrue(denial(error)?.contains("changed while you were being asked") ?? false, String(describing: error))
        }
        let calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains { $0.hasPrefix("click") })
    }

    /// Typing a line break is pressing Return, and Return in a messaging app
    /// sends: it asks, as Code's floor does, whatever the intent says.
    func testReturnTypedIntoAMessagingAppAsks() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedScreenDriver(script: .init(frontmost: "com.apple.mail"))
        let control = visual(gate(apps: ["com.apple.mail"]), driver: driver)
        let ctx = context(approvals)
        let run = Task {
            try await control.execute(
                input: ["intent": "enter_text", "target": "com.apple.mail", "text": "On my way\n"],
                context: ctx
            )
        }
        let question = try await firstPending(approvals)
        XCTAssertTrue(question.summary.contains("Return here sends what was typed"), question.summary)
        await approvals.resolve(approvalID: question.id, decision: .denied, actionDigest: question.actionDigest)
        _ = try? await run.value
        let calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains { $0.hasPrefix("type") })
    }

    /// The registry already asked about this exact call (a `send_message`
    /// intent): the floor does not ask a second time.
    func testAnActionThePersonAlreadyApprovedIsNotAskedTwice() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedScreenDriver()
        let control = visual(gate(), driver: driver, underPoint: button("Send"))
        let input: WorkToolValue = ["intent": "send_message", "target": "com.example.notes", "x": 100, "y": 200]
        guard case .success(let request) = AutomationRequest.parse(input) else { return XCTFail() }
        let digest = AutomationApproval.digest(tool: control.name, request: request)
        let asking = Task {
            await approvals.authorize(
                action: control.name, runID: "run-1", actionDigest: digest, risk: .irreversible,
                mode: .readWrite, summary: "Send a message in Notes."
            )
        }
        let question = try await firstPending(approvals)
        await approvals.resolve(approvalID: question.id, decision: .approved, actionDigest: digest)
        guard case .approved(let receipt) = await asking.value else { return XCTFail() }

        let result = try await control.execute(
            input: input,
            context: WorkToolContext(runID: "run-1", toolCallID: "c", authorization: .approved(receipt), approvals: approvals)
        )
        XCTAssertTrue(result.content.contains("Clicked"))
        let pending = await approvals.pendingApprovals
        XCTAssertTrue(pending.isEmpty)
    }

    // MARK: - Denials that do not ask

    /// Finance and trading apps are view only for Code; Work's clicks and
    /// typing there are refused outright, even when the person allowed the
    /// app and the policy is Full access, and nobody is asked.
    func testFinanceAppsStayDenied() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let audit = AutomationAuditLog()
        let robinhood = "com.robinhood.desktop"
        let driver = ScriptedScreenDriver(script: .init(frontmost: robinhood))
        let control = visual(gate(apps: [robinhood], audit: audit), driver: driver, underPoint: button("Buy", app: robinhood, name: "Robinhood"))
        do {
            _ = try await control.execute(input: click(robinhood), context: context(approvals))
            XCTFail("a finance app must not be clicked")
        } catch {
            XCTAssertTrue(denial(error)?.contains("view only") ?? false, String(describing: error))
        }
        let refused = await audit.entries(withVerdict: .refused)
        XCTAssertEqual(refused.last?.refusalCode, .restrictedCategory)

        let ax = ScriptedAccessibilityDriver(script: .init(frontmost: robinhood, outline: AccessibilityWindowOutline(
            bundleIdentifier: robinhood, windowTitle: "Robinhood",
            fields: [AccessibilityFieldDescriptor(elementID: "0/1", role: "AXTextField", label: "Shares")]
        )))
        let app = AccessibilityControl(driver: ax, gate: gate(apps: [robinhood]))
        do {
            _ = try await app.execute(
                input: ["intent": "enter_text", "target": .string(robinhood), "element": "0/1", "text": "10"],
                context: context(approvals)
            )
            XCTFail("a finance app must not be typed into")
        } catch {
            XCTAssertTrue(denial(error)?.contains("view only") ?? false)
        }
        let pending = await approvals.pendingApprovals
        XCTAssertTrue(pending.isEmpty, "a denial is not a question")
        let screenCalls = await driver.recorder.calls
        let appCalls = await ax.recorder.calls
        XCTAssertFalse(screenCalls.contains { $0.hasPrefix("click") })
        XCTAssertFalse(appCalls.contains { $0.hasPrefix("setValue") })
    }

    /// SensitiveSurface stays an extra deny: a field labelled for a password
    /// (not even marked secure) is refused, and no approval can open it.
    func testTypingIntoAPasswordLabelledFieldIsRefusedWithoutAsking() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedAccessibilityDriver(script: .init(outline: AccessibilityWindowOutline(
            bundleIdentifier: "com.example.notes", windowTitle: "Notes",
            fields: [AccessibilityFieldDescriptor(elementID: "0/4", role: "AXTextField", label: "Password")]
        )))
        let control = AccessibilityControl(driver: driver, gate: gate())
        do {
            _ = try await control.execute(
                input: ["intent": "enter_text", "target": "com.example.notes", "element": "0/4", "text": "hunter2"],
                context: context(approvals)
            )
            XCTFail("a password field must not be filled")
        } catch {
            XCTAssertTrue(denial(error)?.contains("a password") ?? false)
        }
        let pending = await approvals.pendingApprovals
        XCTAssertTrue(pending.isEmpty)
        let calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains { $0.hasPrefix("setValue") })
    }

    /// A click lands on whatever window is at the point. Another app's
    /// window there means an app nobody checked would get it.
    func testAClickOverAnotherAppsWindowIsRefused() async throws {
        let driver = ScriptedScreenDriver()
        let control = visual(gate(), driver: driver, underPoint: button("OK", app: "com.other.app", name: "Other"))
        do {
            _ = try await control.execute(input: click(), context: context(WorkApprovalCoordinator(policy: .permissive)))
            XCTFail("the point is over another app")
        } catch {
            XCTAssertTrue(denial(error)?.contains("Another app's window") ?? false)
        }
        let calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains { $0.hasPrefix("click") })
    }

    func testTheFloorRulingMatchesCodesFloor() {
        XCTAssertEqual(WorkScreenFloor.ruling(.press, bundleIdentifier: "com.example.notes", texts: ["Bold"]), .clear)
        guard case .ask(let reason) = WorkScreenFloor.ruling(.press, bundleIdentifier: "com.example.notes", texts: ["Pay now"]) else {
            return XCTFail("Pay asks")
        }
        XCTAssertEqual(reason, FloorReason.consequentialControl("pay").explanation)
        guard case .deny = WorkScreenFloor.ruling(.press, bundleIdentifier: "com.coinbase.coinbase", texts: []) else {
            return XCTFail("finance is denied")
        }
        guard case .deny = WorkScreenFloor.ruling(.type("ls"), bundleIdentifier: "com.googlecode.iterm2", texts: []) else {
            return XCTFail("typing into a terminal is denied, as Code caps it at clicks")
        }
        guard case .ask = WorkScreenFloor.ruling(.type("sk-live-abcdefghijklmnop1234"), bundleIdentifier: "com.example.notes", texts: []) else {
            return XCTFail("credential-shaped text asks")
        }
    }
}

private struct NoQuestionAsked: Error {}

/// A hit-test that answers `first`, then `then` from the second call on.
private final class ChangingTargets: WorkScreenTargeting, @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    private let first: WorkScreenTarget
    private let then: WorkScreenTarget

    init(first: WorkScreenTarget, then: WorkScreenTarget) {
        self.first = first
        self.then = then
    }

    func target(at point: AutomationPoint) async -> WorkScreenTarget? {
        _ = point
        let n = lock.withLock { () -> Int in
            calls += 1
            return calls
        }
        return n == 1 ? first : then
    }

    func focusedTarget(bundleIdentifier: String) async -> WorkScreenTarget? {
        _ = bundleIdentifier
        return nil
    }
}

/// A driver whose click fails.
private struct FailingClickDriver: VisualScreenDriving {
    func isAvailable() async -> Bool { true }
    func displayBounds() async throws -> AutomationRect { AutomationRect(x: 0, y: 0, width: 1440, height: 900) }
    func frontmostBundleIdentifier() async throws -> String? { "com.example.notes" }
    func sensitiveSurfaces() async throws -> [SensitiveSurface] { [] }
    func capture() async throws -> Data { Data("raw".utf8) }
    func click(at point: AutomationPoint) async throws {
        _ = point
        throw AutomationRefusal(.driverUnavailable, "no")
    }
    func type(_ text: String) async throws { _ = text }
}
#endif
