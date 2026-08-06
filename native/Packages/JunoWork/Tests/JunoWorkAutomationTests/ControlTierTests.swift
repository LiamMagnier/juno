import Foundation
import JunoWorkCore
import JunoWorkRuntime
import XCTest

@testable import JunoWorkAutomation

// MARK: - Harness
//
// The composition this module is actually used in: a permission value, a stop, a
// screenshot policy, an audit and a set of scripted drivers. Building it here
// once keeps every test below about the rule it is checking rather than about
// wiring.

private let fixedNow = Date(timeIntervalSince1970: 1_700_000_000)

private func permissiveAutomation() -> AutomationPermission {
    AutomationPermission(
        automationEnabled: true,
        allowsBrowserControl: true,
        allowsAccessibilityControl: true,
        allowsVisualControl: true,
        allowedApps: ["com.example.notes"],
        allowedDomains: [".example.com"]
    )
}

private func makeGate(
    permission: AutomationPermission = permissiveAutomation(),
    stop: EmergencyStop = EmergencyStop(),
    screenshots: ScreenshotPolicy = ScreenshotPolicy(capturePermitted: true, retention: 60),
    audit: AutomationAuditLog = AutomationAuditLog(),
    alternatives: @escaping @Sendable (AutomationIntent) async -> [AutomationTier] = { _ in [] }
) -> AutomationGate {
    AutomationGate(
        permission: permission,
        stop: stop,
        screenshots: screenshots,
        audit: audit,
        alternatives: alternatives,
        now: { fixedNow }
    )
}

private func context(
    authorization: WorkAuthorization = .allowedByPolicy,
    approvals: WorkApprovalCoordinator
) -> WorkToolContext {
    WorkToolContext(
        runID: "run-1",
        toolCallID: "call-1",
        authorization: authorization,
        approvals: approvals
    )
}

/// A real receipt, obtained the only way one can be obtained: by asking
/// ``WorkApprovalCoordinator`` and being answered.
///
/// There is deliberately no shortcut. `WorkApprovalReceipt` has a `fileprivate`
/// initializer, so a test that wanted to fabricate one would have to change the
/// production type — which is the whole point of that design and worth
/// demonstrating from the outside.
private func approvedReceipt(
    action: String,
    digest: String,
    approvals: WorkApprovalCoordinator
) async throws -> WorkApprovalReceipt {
    let pending = Task {
        await approvals.authorize(
            action: action,
            runID: "run-1",
            actionDigest: digest,
            risk: .irreversible,
            mode: .readWrite,
            summary: "Do the irreversible thing."
        )
    }
    var requests: [WorkApprovalRequest] = []
    for _ in 0..<200 where requests.isEmpty {
        requests = await approvals.pendingApprovals
        if requests.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
    }
    let request = try XCTUnwrap(requests.first)
    await approvals.resolve(
        approvalID: request.id,
        decision: .approved,
        actionDigest: digest
    )
    guard case .approved(let receipt) = await pending.value else {
        throw AutomationRefusal(.approvalMissing, "The coordinator did not approve.")
    }
    return receipt
}

private func denialReason(_ error: any Error) -> String? {
    guard case WorkToolError.denied(let reason)? = error as? WorkToolError else { return nil }
    return reason
}

final class ControlTierTests: XCTestCase {
    // MARK: - The lattice

    private func offer(
        _ tier: AutomationTier,
        _ intents: Set<AutomationIntent>,
        healthy: Bool = true
    ) -> AutomationTierOffer {
        AutomationTierOffer(tier: tier, intents: intents) {
            healthy ? .healthy : .unavailable(reason: "not running")
        }
    }

    /// The rule is not "prefer" but "refuse". A visual click is denied outright
    /// while the browser can perform the same intent, because the coarser tier
    /// needs far more permission and puts the page on a screenshot.
    func testScreenControlIsRefusedWhileTheBrowserCanServeTheSameIntent() async {
        let lattice = AutomationControlLattice(offers: [
            offer(.browserDOM, [.activateControl]),
            offer(.visual, [.activateControl]),
        ])
        let ruling = await lattice.ruling(choosing: .visual, for: .activateControl)
        XCTAssertEqual(ruling.refusal?.code, .higherTierAvailable)
        let allowed = await lattice.ruling(choosing: .browserDOM, for: .activateControl)
        XCTAssertTrue(allowed.isAllowed)
    }

    /// Health is part of the answer rather than a separate retry. Refusing
    /// screen control because the browser could have done it, when the browser
    /// is not running, is a refusal with no remedy.
    func testScreenControlIsAllowedWhenTheFinerTierCannotActuallyAct() async {
        let lattice = AutomationControlLattice(offers: [
            offer(.browserDOM, [.activateControl], healthy: false),
            offer(.visual, [.activateControl]),
        ])
        let ruling = await lattice.ruling(choosing: .visual, for: .activateControl)
        XCTAssertTrue(ruling.isAllowed)
    }

    func testATierThatNeverDeclaredTheIntentIsNotACandidateForIt() async {
        let lattice = AutomationControlLattice(offers: [offer(.browserDOM, [.inspect])])
        let ruling = await lattice.ruling(choosing: .visual, for: .activateControl)
        XCTAssertEqual(ruling.refusal?.code, .intentNotServed)
        let tiers = await lattice.healthyTiers(serving: .activateControl)
        XCTAssertTrue(tiers.isEmpty)
    }

    func testHealthyTiersComeBackInPreferenceOrder() async {
        let lattice = AutomationControlLattice(offers: [
            offer(.visual, [.inspect]),
            offer(.accessibility, [.inspect]),
            offer(.browserDOM, [.inspect]),
        ])
        let tiers = await lattice.healthyTiers(serving: .inspect)
        XCTAssertEqual(tiers, [.browserDOM, .accessibility, .visual])
    }

    /// Changing a security setting is in the vocabulary so that a request for it
    /// is named and refused, rather than arriving spelled as an ordinary click.
    /// No control declares it, and the lattice therefore has no candidate.
    func testNoControlWillChangeASecuritySetting() async {
        let gate = makeGate()
        let controls: [any AutomationControl] = [
            BrowserControl(driver: ScriptedBrowserDriver(), gate: gate),
            AccessibilityControl(driver: ScriptedAccessibilityDriver(), gate: gate),
            VisualControl(driver: ScriptedScreenDriver(), gate: gate),
        ]
        for control in controls {
            XCTAssertFalse(
                control.declaredIntents.contains(.changeSecuritySetting),
                control.tier.rawValue
            )
        }
    }

    // MARK: - The gate

    func testAnActionAimedAtAWholeScreenIsRefusedBecauseNobodyNamedTheApp() async {
        let audit = AutomationAuditLog()
        let gate = makeGate(audit: audit)
        do {
            _ = try await gate.admit(
                runID: "run-1",
                tier: .visual,
                intent: .captureScreen,
                subject: .screen(displayIndex: 0),
                declaredIntents: [.captureScreen]
            )
            XCTFail("A display is not a party that can be allowed.")
        } catch {
            XCTAssertNotNil(denialReason(error))
        }
        let refused = await audit.entries(withVerdict: .refused)
        XCTAssertEqual(refused.first?.refusalCode, .notConsidered)
    }

    /// An intent nothing declared is refused before the permission gate and
    /// before the approval gate. Being asked to approve something that was
    /// always going to be refused teaches people the sheet does not mean
    /// anything.
    func testAnIntentNoControlDeclaredNeverReachesTheApprovalGate() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let audit = AutomationAuditLog()
        let driver = ScriptedScreenDriver()
        let control = visualControl(gate: makeGate(audit: audit), driver: driver)
        let input: WorkToolValue = [
            "intent": "change_security_setting", "target": "com.example.notes", "x": 1, "y": 1,
        ]
        // The registry consults `precheck` before it authorises anything, so the
        // refusal happens without a question being asked at all.
        XCTAssertNotNil(control.precheck(input: input))
        do {
            _ = try await control.execute(input: input, context: context(approvals: approvals))
            XCTFail("An undeclared intent must not run.")
        } catch {
            XCTAssertNotNil(denialReason(error))
        }
        let pending = await approvals.pendingApprovals
        XCTAssertTrue(pending.isEmpty)
        let refused = await audit.entries(withVerdict: .refused)
        XCTAssertEqual(refused.first?.refusalCode, .intentNotServed)
        let calls = await driver.recorder.calls
        XCTAssertTrue(calls.isEmpty)
    }

    func testTheGateWritesAnAttemptBeforeItWritesAVerdict() async throws {
        let audit = AutomationAuditLog()
        let gate = makeGate(audit: audit)
        let token = try await gate.admit(
            runID: "run-1",
            tier: .browserDOM,
            intent: .inspect,
            subject: .domain(host: "mail.example.com"),
            declaredIntents: [.inspect]
        )
        await gate.finish(token)
        let entries = await audit.entries(forRun: "run-1")
        XCTAssertEqual(entries.map(\.verdict), [.attempted, .allowed])
    }

    // MARK: - Browser control

    private func browserOutline(secure: Bool) -> BrowserPageOutline {
        BrowserPageOutline(
            host: "mail.example.com",
            title: "Inbox",
            fields: [
                AccessibilityFieldDescriptor(
                    elementID: "field-1",
                    role: "AXTextField",
                    label: secure ? "Password" : "Subject",
                    isSecureTextEntry: secure
                )
            ]
        )
    }

    func testTheBrowserCanInspectAnAllowedSite() async throws {
        let approvals = WorkApprovalCoordinator(policy: .balanced)
        let audit = AutomationAuditLog()
        let driver = ScriptedBrowserDriver(
            script: .init(host: "mail.example.com", outline: browserOutline(secure: false))
        )
        let control = BrowserControl(driver: driver, gate: makeGate(audit: audit))
        let result = try await control.execute(
            input: ["intent": "inspect", "target": "mail.example.com"],
            context: context(approvals: approvals)
        )
        XCTAssertTrue(result.content.contains("Inbox"))
        XCTAssertEqual(result.detail["controls"]?.intValue, 1)
    }

    func testASiteNobodyAllowedIsRefusedBeforeTheDriverIsTouched() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedBrowserDriver(script: .init(host: "bank.invalid"))
        let control = BrowserControl(driver: driver, gate: makeGate())
        do {
            _ = try await control.execute(
                input: ["intent": "inspect", "target": "bank.invalid"],
                context: context(approvals: approvals)
            )
            XCTFail("A site nobody allowed must be refused.")
        } catch {
            XCTAssertNotNil(denialReason(error))
        }
        let calls = await driver.recorder.calls
        XCTAssertTrue(calls.isEmpty, "Nothing should have been asked of the browser.")
    }

    /// A tab that changed between the permission check and the action — a
    /// redirect, a popup, somebody clicking a link — would otherwise land the
    /// action on a site nobody allowed while the audit records the one that was
    /// checked.
    func testAPageThatChangedSiteUnderneathTheActionStopsIt() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedBrowserDriver(script: .init(host: "elsewhere.example.com"))
        let control = BrowserControl(driver: driver, gate: makeGate())
        do {
            _ = try await control.execute(
                input: ["intent": "inspect", "target": "mail.example.com"],
                context: context(approvals: approvals)
            )
            XCTFail("The page moved; the action must not proceed.")
        } catch {
            XCTAssertTrue(denialReason(error)?.contains("changed") ?? false)
        }
    }

    func testTheBrowserWillNotTypeIntoAFieldThePageSaysIsSecure() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedBrowserDriver(
            script: .init(host: "mail.example.com", outline: browserOutline(secure: true))
        )
        let control = BrowserControl(driver: driver, gate: makeGate())
        do {
            _ = try await control.execute(
                input: [
                    "intent": "enter_text",
                    "target": "mail.example.com",
                    "element": "field-1",
                    "text": "an ordinary sentence",
                ],
                context: context(approvals: approvals)
            )
            XCTFail("A secure field must not be typed into.")
        } catch {
            XCTAssertTrue(denialReason(error)?.contains("password") ?? false)
        }
        let calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains { $0.hasPrefix("enterText") })
    }

    /// Sending is irreversible under every policy, so a permissive policy is not
    /// a way past it.
    func testSendingWithoutAReceiptIsRefusedEvenUnderAPermissivePolicy() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedBrowserDriver(script: .init(host: "mail.example.com"))
        let control = BrowserControl(driver: driver, gate: makeGate())
        do {
            _ = try await control.execute(
                input: [
                    "intent": "send_message",
                    "target": "mail.example.com",
                    "element": "send-button",
                ],
                context: context(authorization: .allowedByPolicy, approvals: approvals)
            )
            XCTFail("Sending must not happen without a receipt.")
        } catch {
            XCTAssertTrue(denialReason(error)?.contains("asking you first") ?? false)
        }
        let calls = await driver.recorder.calls
        XCTAssertTrue(calls.isEmpty)
    }

    func testTheBrowserSendsOnceAPersonHasApprovedThatExactAction() async throws {
        let approvals = WorkApprovalCoordinator(policy: .conservative)
        let driver = ScriptedBrowserDriver(script: .init(host: "mail.example.com"))
        let control = BrowserControl(driver: driver, gate: makeGate())
        let input: WorkToolValue = [
            "intent": "send_message",
            "target": "mail.example.com",
            "element": "send-button",
        ]
        let request = try request(from: input)
        let receipt = try await approvedReceipt(
            action: control.name,
            digest: AutomationApproval.digest(tool: control.name, request: request),
            approvals: approvals
        )
        let result = try await control.execute(
            input: input,
            context: context(authorization: .approved(receipt), approvals: approvals)
        )
        XCTAssertTrue(result.content.contains("Pressed"))
        let calls = await driver.recorder.calls
        XCTAssertEqual(calls, ["activate:send-button"])
    }

    /// An approval granted while the arguments were one thing must not survive
    /// them becoming another.
    func testAReceiptForOneActionDoesNotAuthoriseADifferentOne() async throws {
        let approvals = WorkApprovalCoordinator(policy: .conservative)
        let driver = ScriptedBrowserDriver(script: .init(host: "mail.example.com"))
        let control = BrowserControl(driver: driver, gate: makeGate())
        let approvedInput: WorkToolValue = [
            "intent": "send_message",
            "target": "mail.example.com",
            "element": "send-button",
        ]
        let receipt = try await approvedReceipt(
            action: control.name,
            digest: AutomationApproval.digest(
                tool: control.name,
                request: try request(from: approvedInput)
            ),
            approvals: approvals
        )
        do {
            _ = try await control.execute(
                input: [
                    "intent": "send_message",
                    "target": "mail.example.com",
                    "element": "delete-account-button",
                ],
                context: context(authorization: .approved(receipt), approvals: approvals)
            )
            XCTFail("A receipt is bound to one action.")
        } catch {
            XCTAssertTrue(denialReason(error)?.contains("no longer matches") ?? false)
        }
    }

    func testTheDigestChangesWithEveryPartOfTheAction() throws {
        let base = try request(
            from: ["intent": "enter_text", "target": "mail.example.com", "element": "a", "text": "x"]
        )
        let other = try request(
            from: ["intent": "enter_text", "target": "mail.example.com", "element": "a", "text": "y"]
        )
        XCTAssertNotEqual(
            AutomationApproval.digest(tool: "browser_control", request: base),
            AutomationApproval.digest(tool: "browser_control", request: other)
        )
        XCTAssertNotEqual(
            AutomationApproval.digest(tool: "browser_control", request: base),
            AutomationApproval.digest(tool: "screen_control", request: base)
        )
    }

    // MARK: - App control

    /// Typing goes to whatever has focus. Without this check an app that came
    /// forward between the permission check and the keystroke receives text that
    /// was approved for a different app.
    func testAppControlWillNotTypeIntoWhicheverAppHappensToBeInFront() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedAccessibilityDriver(
            script: .init(frontmost: "com.other.thing")
        )
        let control = AccessibilityControl(driver: driver, gate: makeGate())
        do {
            _ = try await control.execute(
                input: [
                    "intent": "enter_text",
                    "target": "com.example.notes",
                    "element": "0/1",
                    "text": "a sentence",
                ],
                context: context(approvals: approvals)
            )
            XCTFail("Focus moved; the keystroke must not be sent.")
        } catch {
            XCTAssertTrue(denialReason(error)?.contains("came to the front") ?? false)
        }
        let calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains { $0.hasPrefix("setValue") })
    }

    func testAppControlIsUnhealthyWithoutTheAccessibilityPermission() async {
        let control = AccessibilityControl(
            driver: ScriptedAccessibilityDriver(script: .init(trusted: false)),
            gate: makeGate()
        )
        let health = await control.health()
        XCTAssertFalse(health.isHealthy)
    }

    // MARK: - Screen control, the last resort

    private func visualControl(
        gate: AutomationGate,
        driver: ScriptedScreenDriver = ScriptedScreenDriver(),
        redactor: any ScreenRedacting = RecordingRedactor()
    ) -> VisualControl {
        VisualControl(
            driver: driver,
            gate: gate,
            redactor: redactor,
            pacer: VisualPacer(interval: 0)
        )
    }

    func testScreenControlRefusesWhileTheStopIsPressed() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let stop = EmergencyStop(stopped: true)
        let control = visualControl(gate: makeGate(stop: stop))
        do {
            _ = try await control.execute(
                input: ["intent": "capture_screen", "target": "com.example.notes"],
                context: context(approvals: approvals)
            )
            XCTFail("A stopped switch must refuse screen control.")
        } catch {
            XCTAssertNotNil(denialReason(error))
        }
    }

    func testScreenControlRefusesWhenItIsNotAllowedToSeeTheScreen() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let gate = makeGate(screenshots: .refused)
        let control = visualControl(gate: gate)
        do {
            _ = try await control.execute(
                input: ["intent": "capture_screen", "target": "com.example.notes"],
                context: context(approvals: approvals)
            )
            XCTFail("No capture permission means no screen control.")
        } catch {
            XCTAssertNotNil(denialReason(error))
        }
        let health = await control.health()
        XCTAssertFalse(health.isHealthy)
    }

    /// The app in front is asked of the driver rather than taken from the
    /// arguments. A model that believed it was driving a text editor while a
    /// banking window came forward would otherwise have its click delivered to
    /// the bank, with the audit recording the editor.
    func testScreenControlChecksWhichAppIsActuallyInFront() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedScreenDriver(script: .init(frontmost: "com.someone.bank"))
        let control = visualControl(gate: makeGate(), driver: driver)
        do {
            _ = try await control.execute(
                input: ["intent": "capture_screen", "target": "com.example.notes"],
                context: context(approvals: approvals)
            )
            XCTFail("The frontmost app is not the one that was checked.")
        } catch {
            XCTAssertTrue(denialReason(error)?.contains("came to the front") ?? false)
        }
        let calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains("capture"))
    }

    func testScreenControlWillNotClickOutsideTheDisplay() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedScreenDriver()
        let control = visualControl(gate: makeGate(), driver: driver)
        do {
            _ = try await control.execute(
                input: [
                    "intent": "activate_control",
                    "target": "com.example.notes",
                    "x": 9_000,
                    "y": 12,
                ],
                context: context(approvals: approvals)
            )
            XCTFail("A click outside the display must be refused.")
        } catch {
            XCTAssertTrue(denialReason(error)?.contains("not on this Mac's screen") ?? false)
        }
        let calls = await driver.recorder.calls
        XCTAssertFalse(calls.contains { $0.hasPrefix("click") })
    }

    func testScreenControlCapturesThroughTheRedactionPass() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let region = AutomationRect(x: 10, y: 10, width: 80, height: 20)
        let driver = ScriptedScreenDriver(
            script: .init(
                surfaces: [
                    SensitiveSurface(kind: .password, signal: .secureTextEntry, region: region)
                ]
            )
        )
        let redactor = RecordingRedactor()
        let audit = AutomationAuditLog()
        let control = visualControl(gate: makeGate(audit: audit), driver: driver, redactor: redactor)
        let result = try await control.execute(
            input: ["intent": "capture_screen", "target": "com.example.notes"],
            context: context(approvals: approvals)
        )
        XCTAssertEqual(redactor.regionsSeen, [[region]])
        XCTAssertEqual(result.detail["redacted_regions"]?.intValue, 1)
        // A password was on screen, so the image is restricted and never leaves.
        XCTAssertEqual(result.detail["sensitivity"]?.stringValue, "restricted")
        XCTAssertEqual(result.detail["may_leave_this_mac"]?.boolValue, false)

        let kinds = await audit.entries(forRun: "run-1").map(\.kind)
        XCTAssertTrue(kinds.contains(.screenshotCaptured))
    }

    func testScreenControlIsRefusedWhileTheBrowserCouldDoTheSameThing() async {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let audit = AutomationAuditLog()
        let gate = makeGate(audit: audit, alternatives: { intent in
            intent == .activateControl ? [.browserDOM] : []
        })
        let driver = ScriptedScreenDriver()
        let control = visualControl(gate: gate, driver: driver)
        do {
            _ = try await control.execute(
                input: [
                    "intent": "activate_control",
                    "target": "com.example.notes",
                    "x": 12,
                    "y": 12,
                ],
                context: context(approvals: approvals)
            )
            XCTFail("A finer tier can do this; screen control must be refused.")
        } catch {
            XCTAssertTrue(denialReason(error)?.contains("Browser") ?? false)
        }
        let refused = await audit.entries(withVerdict: .refused)
        XCTAssertEqual(refused.first?.kind, .tierDowngradeRefused)
        XCTAssertEqual(refused.first?.refusalCode, .higherTierAvailable)
        let calls = await driver.recorder.calls
        XCTAssertTrue(calls.isEmpty)
    }

    func testScreenControlSendsOnlyWithAReceiptForThatExactAction() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let driver = ScriptedScreenDriver()
        let control = visualControl(gate: makeGate(), driver: driver)
        let input: WorkToolValue = [
            "intent": "send_message",
            "target": "com.example.notes",
            "x": 100,
            "y": 200,
        ]
        let receipt = try await approvedReceipt(
            action: control.name,
            digest: AutomationApproval.digest(
                tool: control.name,
                request: try request(from: input)
            ),
            approvals: approvals
        )
        let result = try await control.execute(
            input: input,
            context: context(authorization: .approved(receipt), approvals: approvals)
        )
        XCTAssertTrue(result.content.contains("Clicked"))
        let calls = await driver.recorder.calls
        XCTAssertTrue(calls.contains("click:100,200"))
    }

    /// The registry raises the risk of anything irreversible whatever the tool
    /// says, and the tool must agree rather than under-declare itself into a
    /// gentler tier.
    func testScreenControlDeclaresItsIrreversibleActionsToTheRegistry() {
        let control = visualControl(gate: makeGate())
        let input: WorkToolValue = [
            "intent": "purchase", "target": "com.example.notes", "x": 1, "y": 1,
        ]
        XCTAssertEqual(control.irreversibleAction(input: input), .appPurchase)
        XCTAssertEqual(control.assessRisk(input: input), .irreversible)
        XCTAssertTrue(control.summary(input: input).contains("cannot take this back"))
    }

    // MARK: - The audit

    /// The audit records identifiers and verdicts. There is no field for what
    /// was on the page or what was typed, only how much of it there was.
    func testTheAuditRecordsLengthsAndIdentifiersAndNeverContent() async throws {
        let approvals = WorkApprovalCoordinator(policy: .permissive)
        let audit = AutomationAuditLog()
        let driver = ScriptedBrowserDriver(
            script: .init(host: "mail.example.com", outline: browserOutline(secure: false))
        )
        let control = BrowserControl(driver: driver, gate: makeGate(audit: audit))
        let secret = "meet me at the usual place"
        _ = try await control.execute(
            input: [
                "intent": "enter_text",
                "target": "mail.example.com",
                "element": "field-1",
                "text": .string(secret),
            ],
            context: context(approvals: approvals)
        )
        let entries = await audit.entries(forRun: "run-1")
        let allowed = try XCTUnwrap(entries.last)
        XCTAssertEqual(allowed.verdict, .allowed)
        XCTAssertEqual(allowed.characterCount, secret.count)
        XCTAssertEqual(allowed.subject, .domain(host: "mail.example.com"))

        let encoded = try JSONEncoder().encode(entries)
        let text = String(decoding: encoded, as: UTF8.self)
        XCTAssertFalse(text.contains("usual place"), "The audit must not carry typed text.")
        for entry in entries {
            XCTAssertFalse(entry.readableLine.contains("usual place"))
        }
    }

    // MARK: - Helpers

    private func request(from input: WorkToolValue) throws -> AutomationRequest {
        switch AutomationRequest.parse(input) {
        case .success(let request): return request
        case .failure(let error): throw error
        }
    }
}
