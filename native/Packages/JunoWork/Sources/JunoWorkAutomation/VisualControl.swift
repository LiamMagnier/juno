import Foundation
import JunoWorkCore
import JunoWorkRuntime

#if os(macOS)
import ApplicationServices
import CoreGraphics
#endif

// MARK: - The seam

/// The low-level screen driver: capture and input injection.
///
/// Deliberately small. Everything that makes screen control safe — the
/// permission gate, the stop, the screenshot policy, the approval receipt, the
/// bounds check, the pacing — is in ``VisualControl``, so a driver cannot be
/// swapped in that skips any of it.
public protocol VisualScreenDriving: Sendable {
    func isAvailable() async -> Bool
    /// The area actions may address, in screen points.
    func displayBounds() async throws -> AutomationRect
    /// The app that will receive input. Screen control cannot name what it is
    /// clicking, so this is the only handle the permission gate has.
    func frontmostBundleIdentifier() async throws -> String?
    /// What is on screen, as far as the driver can tell, so a redaction plan can
    /// be built before anything is stored.
    func sensitiveSurfaces() async throws -> [SensitiveSurface]
    /// Encoded image bytes. Raw and unredacted: they must go through
    /// ``ScreenshotPolicy/capture(raw:surfaces:baseSensitivity:redactor:at:)``
    /// before anything else sees them.
    func capture() async throws -> Data
    func click(at point: AutomationPoint) async throws
    func type(_ text: String) async throws
}

/// A screen driver that drives nothing, for tests and previews.
public struct ScriptedScreenDriver: VisualScreenDriving {
    public struct Script: Sendable {
        public var available: Bool
        public var bounds: AutomationRect
        public var frontmost: String?
        public var surfaces: [SensitiveSurface]
        public var imageBytes: Data
        public var failure: AutomationRefusal?

        public init(
            available: Bool = true,
            bounds: AutomationRect = AutomationRect(x: 0, y: 0, width: 1440, height: 900),
            frontmost: String? = "com.example.notes",
            surfaces: [SensitiveSurface] = [],
            imageBytes: Data = Data("raw-capture".utf8),
            failure: AutomationRefusal? = nil
        ) {
            self.available = available
            self.bounds = bounds
            self.frontmost = frontmost
            self.surfaces = surfaces
            self.imageBytes = imageBytes
            self.failure = failure
        }
    }

    public actor Recorder {
        public private(set) var calls: [String] = []
        public init() {}
        public func record(_ call: String) { calls.append(call) }
    }

    public let script: Script
    public let recorder: Recorder

    public init(script: Script = Script(), recorder: Recorder = Recorder()) {
        self.script = script
        self.recorder = recorder
    }

    public func isAvailable() async -> Bool { script.available }

    public func displayBounds() async throws -> AutomationRect { script.bounds }

    public func frontmostBundleIdentifier() async throws -> String? {
        if let failure = script.failure { throw failure }
        return script.frontmost
    }

    public func sensitiveSurfaces() async throws -> [SensitiveSurface] { script.surfaces }

    public func capture() async throws -> Data {
        await recorder.record("capture")
        if let failure = script.failure { throw failure }
        return script.imageBytes
    }

    public func click(at point: AutomationPoint) async throws {
        await recorder.record("click:\(Int(point.x)),\(Int(point.y))")
        if let failure = script.failure { throw failure }
    }

    public func type(_ text: String) async throws {
        await recorder.record("type:\(text.count)")
        if let failure = script.failure { throw failure }
    }
}

#if os(macOS)
/// The system facts screen control needs before it does anything.
///
/// ### What this needs at runtime
///
/// `CGPreflightScreenCaptureAccess()` reports the Screen Recording permission
/// and `AXIsProcessTrusted()` the Accessibility permission; screen control needs
/// both, because one of them can see the screen and the other can touch it and
/// half of that is a task this Mac would win and then fail. Neither is
/// *requested* here — prompting belongs to an explicit gesture, as it does in
/// `ComputerUseCoordinator`.
///
/// `CGDisplayBounds(CGMainDisplayID())` is the logical-point coordinate space
/// `CGEvent` uses. Sizing anything from a display's physical pixel dimensions
/// instead lands every click at half its intended position on a Retina Mac.
public enum SystemScreenPreflight {
    public static func screenRecordingAuthorized() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    public static func accessibilityAuthorized() -> Bool {
        AXIsProcessTrusted()
    }

    public static func mainDisplayBounds() -> AutomationRect {
        let bounds = CGDisplayBounds(CGMainDisplayID())
        return AutomationRect(
            x: bounds.origin.x,
            y: bounds.origin.y,
            width: bounds.size.width,
            height: bounds.size.height
        )
    }
}
#endif

// MARK: - Pacing

/// The minimum gap between screen actions.
///
/// Screen control is the one tier with no idea what it is acting on, so a run
/// that has gone wrong here goes wrong at whatever rate the loop can manage.
/// Pacing turns "four hundred clicks before anybody noticed" into "eight clicks
/// and somebody hit stop", which is the difference the indicator and the kill
/// switch are there to exploit.
public actor VisualPacer {
    public static let minimumInterval: TimeInterval = 0.5

    private var lastActionAt: Date?
    private let interval: TimeInterval

    public init(interval: TimeInterval = VisualPacer.minimumInterval) {
        self.interval = interval
    }

    public func admit(at date: Date) throws {
        if let lastActionAt, date.timeIntervalSince(lastActionAt) < interval {
            throw AutomationRefusal(
                .tooFast,
                "Juno is being asked to click faster than it is allowed to."
            )
        }
        lastActionAt = date
    }
}

// MARK: - The control

/// Tier 5: click and type at coordinates, using a picture of the screen.
///
/// **The last resort, and the most constrained thing in this module.** It cannot
/// name what it is acting on: "press Send" and "press Delete Account" are the
/// same instruction to a driver that only knows a point. So it does not ship as
/// a capability with controls added around it — it ships as a capability that
/// cannot start without them, and every one of them is checked here:
///
/// 1. ``AutomationPermission`` allows the visual tier *and* the app that is
///    actually in front, checked against the driver rather than against what the
///    model claimed.
/// 2. ``EmergencyStop`` is not stopped, re-checked after every await, so a stop
///    that lands mid-capture is not followed by the click.
/// 3. ``ScreenshotPolicy`` permits the capture, and the redaction runs before
///    anything is stored or relayed.
/// 4. ``AutomationTierLattice`` has no finer tier that could serve the same
///    intent and is healthy.
/// 5. A ``WorkApprovalReceipt`` exists, bound to this exact action, for anything
///    that sends, publishes, buys, deletes or changes a setting.
/// 6. Coordinates are inside the display, and actions are paced.
/// 7. The consequential-action floor Code uses (``WorkScreenFloor``) reads the
///    hit-tested target: a click that lands on "Send", "Delete" or "Pay", or
///    text whose Return sends in a messaging app, asks in every policy, Full
///    access included. Finance apps are refused outright.
///
/// Every click and every typed run draws on the app-wide action overlay
/// (``WorkActionOverlay``): the ring and label a Code session's actions get.
public struct VisualControl: AutomationControl, WorkTool {
    public let tier: AutomationTier = .visual
    public let declaredIntents: Set<AutomationIntent> = [
        .inspect, .captureScreen, .enterText, .activateControl,
        .sendMessage, .publish, .purchase, .deleteItem, .changeAccountSetting,
    ]

    private let driver: any VisualScreenDriving
    private let gate: AutomationGate
    private let redactor: any ScreenRedacting
    private let pacer: VisualPacer
    private let targets: (any WorkScreenTargeting)?
    private let overlay: WorkActionOverlay

    public init(
        driver: any VisualScreenDriving,
        gate: AutomationGate,
        redactor: any ScreenRedacting = CoreGraphicsScreenRedactor(),
        pacer: VisualPacer = VisualPacer(),
        targets: (any WorkScreenTargeting)? = nil,
        overlay: WorkActionOverlay = .none
    ) {
        self.driver = driver
        self.gate = gate
        self.redactor = redactor
        self.pacer = pacer
        self.targets = targets
        self.overlay = overlay
    }

    public func health() async -> AutomationControlHealth {
        guard gate.permission.permits(tier: .visual).isAllowed else {
            return .unavailable(reason: "Screen control is switched off on this Mac.")
        }
        guard gate.screenshots.capturePermitted else {
            // Screen control without capture is an agent clicking blind. Better
            // to declare the tier unhealthy and let the lattice route elsewhere
            // than to let it guess where the button was.
            return .unavailable(reason: "Juno is not allowed to see this Mac's screen.")
        }
        guard await driver.isAvailable() else {
            return .unavailable(reason: "Juno cannot reach this Mac's screen right now.")
        }
        return .healthy
    }

    // MARK: WorkTool

    public var name: String { "screen_control" }

    public var description: String {
        """
        Look at this Mac's screen and click or type on it. The last resort, used \
        only when no connector, browser or app-accessibility route can do the \
        job. Every action is watched, paced, and stoppable.
        """
    }

    public var schema: WorkToolSchema { AutomationRequest.schema }

    public func assessRisk(input: WorkToolValue) -> WorkRiskLevel {
        guard case .success(let request) = AutomationRequest.parse(input) else { return .safe }
        return request.intent.risk(inTier: tier)
    }

    public func irreversibleAction(input: WorkToolValue) -> WorkIrreversibleAction? {
        guard case .success(let request) = AutomationRequest.parse(input) else { return nil }
        return request.intent.irreversibleAction(inTier: tier)
    }

    public func summary(input: WorkToolValue) -> String {
        guard case .success(let request) = AutomationRequest.parse(input) else {
            return "Do something on this Mac's screen."
        }
        return request.summary(tier: tier)
    }

    public func precheck(input: WorkToolValue) -> WorkToolError? {
        AutomationRequest.precheck(input, tier: tier, declaredIntents: declaredIntents)
    }

    public func execute(
        input: WorkToolValue,
        context: WorkToolContext
    ) async throws -> WorkToolResult {
        let request: AutomationRequest
        switch AutomationRequest.parse(input) {
        case .failure(let error): throw error
        case .success(let parsed): request = parsed
        }

        let token = try await gate.admit(
            runID: context.runID,
            tier: tier,
            intent: request.intent,
            subject: request.subject(for: tier),
            declaredIntents: declaredIntents
        )

        // The receipt is demanded here as well as at the registry, and the
        // digest is recomputed from the arguments about to be executed rather
        // than reused from the request. On this tier that is not belt and
        // braces: the arguments include a coordinate, and a coordinate that
        // changed between the question and the answer is a different button.
        if request.intent.requiresApprovalReceipt(inTier: tier),
            let refusal = AutomationApproval.refusal(
                for: context.authorization,
                digest: AutomationApproval.digest(tool: name, request: request),
                at: gate.now()
            )
        {
            throw await gate.refuse(refusal, holding: token)
        }

        do {
            let result = try await perform(request, input: input, context: context, token: token)
            await gate.finish(
                token,
                characterCount: request.intent == .enterText ? request.text?.count : nil
            )
            return result
        } catch let refusal as AutomationRefusal {
            throw await gate.refuse(refusal, holding: token)
        } catch {
            throw await gate.refuse(
                AutomationRefusal(.driverUnavailable, "This Mac's screen did not respond."),
                holding: token
            )
        }
    }

    private func perform(
        _ request: AutomationRequest,
        input: WorkToolValue,
        context: WorkToolContext,
        token: AutomationRunToken
    ) async throws -> WorkToolResult {
        try await pacer.admit(at: gate.now())
        try await gate.checkpoint(token)

        // The app in front is the app that receives everything, and it is asked
        // of the driver rather than taken from the arguments. A model that
        // believed it was driving a text editor while a banking window came
        // forward would otherwise have its click delivered to the bank, with the
        // audit recording the editor.
        let frontmost = try await driver.frontmostBundleIdentifier()
        try await gate.checkpoint(token)
        guard let frontmost else {
            throw AutomationRefusal(
                .notConsidered,
                "Juno could not tell which app was in front, so it did nothing."
            )
        }
        guard AutomationPermission.normalizeIdentifier(frontmost)
            == AutomationPermission.normalizeIdentifier(request.target)
        else {
            throw AutomationRefusal(
                .focusMoved,
                "A different app came to the front, so Juno stopped rather than act on the wrong one."
            )
        }
        if let refusal = gate.permission.permits(app: frontmost).refusal { throw refusal }

        let screenshot = try await capture(token: token)

        switch request.intent {
        case .inspect, .captureScreen:
            return WorkToolResult(
                content: "Looked at the screen.",
                detail: [
                    "redacted_regions": .number(Double(screenshot.redactedRegionCount)),
                    "sensitivity": .string(screenshot.sensitivity.rawValue),
                    "may_leave_this_mac": .bool(
                        gate.screenshots.relayRuling(for: screenshot, at: gate.now()).isAllowed
                    ),
                ]
            )
        case .enterText:
            guard let text = request.text else {
                throw AutomationRefusal(.intentNotServed, "Juno had nothing to type.")
            }
            // Keys reach the focused control of the app in front, and Return
            // presses the window's default button: the floor reads both.
            let focus = await targets?.focusedTarget(bundleIdentifier: frontmost)
            try await gate.checkpoint(token)
            if let surface = focus?.sensitiveSurface {
                // An extra deny, never a reason to ask: no approval makes
                // typing a password or a card number something to delegate.
                throw AutomationRefusal(
                    .sensitiveSurface,
                    "That field is for \(surface.kind.phrase), so nothing was typed. Ask the person to enter it."
                )
            }
            let appName = focus?.appName ?? frontmost
            let label = "Type \(text.count) characters in \(appName)"
            try await applyFloor(
                .type(text),
                bundleIdentifier: frontmost,
                target: focus,
                label: label,
                request: request,
                input: input,
                context: context,
                token: token
            )
            try await overlay.around(
                runID: token.runID,
                label: label,
                point: focus?.center,
                appName: appName,
                input: { try await driver.type(text) },
                checkpoint: { try await gate.checkpoint(token) }
            )
            return WorkToolResult(content: "Typed \(text.count) characters.")
        case .activateControl, .sendMessage, .publish, .purchase, .deleteItem,
             .changeAccountSetting:
            guard let x = request.x, let y = request.y else {
                throw AutomationRefusal(
                    .intentNotServed,
                    "Juno needed a position on screen and did not have one."
                )
            }
            let point = AutomationPoint(x: Double(x), y: Double(y))
            let bounds = try await driver.displayBounds()
            try await gate.checkpoint(token)
            guard bounds.contains(point) else {
                throw AutomationRefusal(
                    .outOfBounds,
                    "That position is not on this Mac's screen."
                )
            }
            // What a click here would actually press, hit-tested system-wide:
            // the floor reads the target, never the model's word for it.
            let hit = await targets?.target(at: point)
            try await gate.checkpoint(token)
            if let hit, !hit.bundleIdentifier.isEmpty,
               AutomationPermission.normalizeIdentifier(hit.bundleIdentifier)
                != AutomationPermission.normalizeIdentifier(frontmost)
            {
                // Another app's window is over that point: the click would go
                // to an app nobody checked.
                throw AutomationRefusal(
                    .focusMoved,
                    "Another app's window is over that position, so nothing was clicked."
                )
            }
            let appName = hit?.appName ?? frontmost
            let label = hit?.spokenName.map { "Click the \($0) in \(appName)" } ?? "Click in \(appName)"
            try await applyFloor(
                .press,
                bundleIdentifier: frontmost,
                target: hit,
                label: label,
                request: request,
                input: input,
                context: context,
                token: token
            )
            try await overlay.around(
                runID: token.runID,
                label: label,
                point: point,
                appName: appName,
                input: { try await driver.click(at: point) },
                checkpoint: { try await gate.checkpoint(token) }
            )
            return WorkToolResult(content: "Clicked once on this Mac's screen.")
        case .navigate, .changeSecuritySetting:
            throw AutomationRefusal(
                .intentNotServed,
                "Screen control will not do that on this Mac."
            )
        }
    }

    /// The floor, against the hit-tested target: refuses, asks (suspending
    /// until the person answers), or lets the input through. Re-checks the
    /// stop afterwards, because an answer can take minutes.
    private func applyFloor(
        _ gesture: WorkScreenFloor.Gesture,
        bundleIdentifier: String,
        target: WorkScreenTarget?,
        label: String,
        request: AutomationRequest,
        input: WorkToolValue,
        context: WorkToolContext,
        token: AutomationRunToken
    ) async throws {
        switch WorkScreenFloor.ruling(
            gesture,
            bundleIdentifier: bundleIdentifier,
            appStoreCategory: target?.appStoreCategory,
            texts: target?.texts ?? []
        ) {
        case .clear:
            return
        case .deny(let refusal):
            throw refusal
        case .ask(let reason):
            try await WorkScreenFloor.confirm(
                tool: name,
                request: request,
                input: input,
                actionDigest: actionDigest(input: input),
                reason: reason,
                summary: label + ".",
                context: context,
                now: gate.now
            )
            try await gate.checkpoint(token)
            // The answer can take minutes. What was approved is this app and,
            // for a click, this control: if either changed meanwhile, the
            // approval is for something no longer there.
            let front = try await driver.frontmostBundleIdentifier()
            try await gate.checkpoint(token)
            guard front.map(AutomationPermission.normalizeIdentifier)
                == AutomationPermission.normalizeIdentifier(bundleIdentifier)
            else {
                throw AutomationRefusal(
                    .focusMoved,
                    "A different app came to the front while you were being asked, so nothing was done."
                )
            }
            if case .press = gesture, let x = request.x, let y = request.y, let targets {
                let again = await targets.target(at: AutomationPoint(x: Double(x), y: Double(y)))
                try await gate.checkpoint(token)
                guard again?.bundleIdentifier == target?.bundleIdentifier, again?.texts == target?.texts else {
                    throw AutomationRefusal(
                        .focusMoved,
                        "What is at that position changed while you were being asked, so nothing was clicked."
                    )
                }
            }
        }
    }

    /// Captures, redacts and records — in that order, always.
    ///
    /// The raw bytes never leave this function. What comes back is a
    /// ``RedactedScreenshot``, which is the only kind of image the rest of the
    /// system has a type for.
    private func capture(token: AutomationRunToken) async throws -> RedactedScreenshot {
        let surfaces = try await driver.sensitiveSurfaces()
        try await gate.checkpoint(token)
        if let refusal = gate.screenshots.captureRuling(surfaces: surfaces).refusal {
            throw refusal
        }
        let raw = try await driver.capture()
        // The last suspension point before an image exists. A stop that landed
        // during the capture must not be followed by a stored screenshot of
        // whatever was on screen when somebody pressed it.
        try await gate.checkpoint(token)
        let screenshot: RedactedScreenshot
        do {
            screenshot = try gate.screenshots.capture(
                raw: raw,
                surfaces: surfaces,
                redactor: redactor,
                at: gate.now()
            )
        } catch let refusal as AutomationRefusal {
            throw refusal
        } catch {
            // A redaction that failed is a capture that does not exist. Storing
            // the unredacted bytes "so the run can continue" is the one outcome
            // this whole file is arranged to prevent.
            throw AutomationRefusal(
                .sensitiveSurface,
                "Juno could not cover up what was on screen, so it threw the picture away."
            )
        }
        await gate.audit.record(
            AutomationAuditEntry(
                at: gate.now(),
                kind: .screenshotCaptured,
                severity: .info,
                runID: token.runID,
                tier: tier,
                intent: token.activity.intent,
                subject: token.activity.subject,
                verdict: .allowed
            )
        )
        return screenshot
    }
}
