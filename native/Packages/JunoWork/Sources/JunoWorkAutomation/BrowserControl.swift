import Foundation
import JunoWorkCore
import JunoWorkRuntime

// MARK: - What a page looks like from here

/// A page as automation sees it: roles, labels and identities.
///
/// Not the page's text. An outline is what a model needs to decide which control
/// to press, and handing it the prose as well is how a run ends up with an
/// article's worth of somebody's private correspondence in its context window
/// for the sake of finding a Send button.
public struct BrowserPageOutline: Hashable, Sendable {
    public let host: String
    public let title: String
    public let fields: [AccessibilityFieldDescriptor]

    public init(host: String, title: String, fields: [AccessibilityFieldDescriptor]) {
        self.host = host
        self.title = title
        self.fields = fields
    }
}

// MARK: - The seam

public protocol BrowserDriving: Sendable {
    /// Whether a driveable browser is actually there. Asked rather than assumed:
    /// a browser that is not running is a reason to fall through to a coarser
    /// tier, not a reason to fail the task.
    func isAvailable() async -> Bool
    /// The host of the page currently in front. Used to prove the page did not
    /// change between the permission check and the action.
    func currentHost() async throws -> String
    func outline() async throws -> BrowserPageOutline
    func navigate(toHost host: String, path: String) async throws
    func activate(elementID: String) async throws
    func enterText(_ text: String, intoElementID elementID: String) async throws
}

/// A browser driver that drives nothing, for tests and previews.
///
/// It is named for what it is. A double that pretended to reach Safari would be
/// worse than no driver at all: the containment tests would pass against a
/// fiction, and the first real page would meet code nobody had exercised.
public struct ScriptedBrowserDriver: BrowserDriving {
    public struct Script: Sendable {
        public var available: Bool
        public var host: String
        public var outline: BrowserPageOutline
        /// Raised when the driver is asked to act, so a test can exercise the
        /// path where the platform fails partway through.
        public var failure: AutomationRefusal?

        public init(
            available: Bool = true,
            host: String = "example.com",
            outline: BrowserPageOutline = BrowserPageOutline(
                host: "example.com",
                title: "Example",
                fields: []
            ),
            failure: AutomationRefusal? = nil
        ) {
            self.available = available
            self.host = host
            self.outline = outline
            self.failure = failure
        }
    }

    /// Everything the driver was asked to do, in order, for a test to assert on.
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

    public func currentHost() async throws -> String {
        if let failure = script.failure { throw failure }
        return script.host
    }

    public func outline() async throws -> BrowserPageOutline {
        await recorder.record("outline")
        if let failure = script.failure { throw failure }
        return script.outline
    }

    public func navigate(toHost host: String, path: String) async throws {
        await recorder.record("navigate:\(host)\(path)")
        if let failure = script.failure { throw failure }
    }

    public func activate(elementID: String) async throws {
        await recorder.record("activate:\(elementID)")
        if let failure = script.failure { throw failure }
    }

    /// Records the length, never the text — the same rule the audit keeps, for
    /// the same reason: a test fixture that logs typed strings is a test fixture
    /// somebody eventually points at production.
    public func enterText(_ text: String, intoElementID elementID: String) async throws {
        await recorder.record("enterText:\(elementID):\(text.count)")
        if let failure = script.failure { throw failure }
    }
}

// MARK: - The control

/// Tier 3: drive a page through the browser's own object model.
///
/// The first tier this module implements and the one to prefer, because it is
/// the only one of the three that can name what it is acting on. A click here is
/// "press the element whose accessible name is Send"; the same click one tier
/// down is "press the element at index 7"; two tiers down it is "click at
/// (412, 883)", which is the same instruction whether or not the window moved.
///
/// ### What a real driver needs at runtime
///
/// There is no platform call in this file to put behind an availability check,
/// because driving a browser is not an OS API — it is a protocol conversation
/// with a browser process. A real ``BrowserDriving`` is one of two things: a
/// Chrome DevTools Protocol client speaking WebSocket to a Chromium launched
/// with `--remote-debugging-port` bound to `127.0.0.1`, using the person's own
/// profile so their sessions are the ones being driven; or `safaridriver`, which
/// requires "Allow Remote Automation" in Safari's Develop menu and shows a
/// persistent banner while it is connected. Neither exists yet. Everything in
/// this file above the seam is real and does not change when one arrives.
public struct BrowserControl: AutomationControl, WorkTool {
    public let tier: AutomationTier = .browserDOM
    public let declaredIntents: Set<AutomationIntent> = [
        .inspect, .navigate, .enterText, .activateControl,
        .sendMessage, .publish, .purchase, .deleteItem, .changeAccountSetting,
    ]

    private let driver: any BrowserDriving
    private let gate: AutomationGate

    public init(driver: any BrowserDriving, gate: AutomationGate) {
        self.driver = driver
        self.gate = gate
    }

    public func health() async -> AutomationControlHealth {
        guard gate.permission.permits(tier: .browserDOM).isAllowed else {
            return .unavailable(reason: "Browser control is switched off on this Mac.")
        }
        guard await driver.isAvailable() else {
            return .unavailable(reason: "No browser Juno can drive is running.")
        }
        return .healthy
    }

    // MARK: WorkTool

    public var name: String { "browser_control" }

    public var description: String {
        """
        Look at and act on a page in the signed-in browser on this Mac. Preferred \
        over app or screen control: it can name what it is acting on. Only sites \
        the person allowed can be reached.
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
            return "Do something in the browser."
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
        // Re-checked here rather than trusted from the registry, exactly as
        // `WorkTool` asks: calling `executeAuthorized` directly must not be a
        // way past the question.
        if let refusal = try await approvalRefusal(request: request, context: context) {
            throw await gate.refuse(refusal, holding: token)
        }

        do {
            let result = try await perform(request, token: token)
            await gate.finish(
                token,
                characterCount: request.intent == .enterText ? request.text?.count : nil
            )
            return result
        } catch let refusal as AutomationRefusal {
            throw await gate.refuse(refusal, holding: token)
        } catch {
            throw await gate.refuse(
                AutomationRefusal(.driverUnavailable, "The browser did not do what Juno asked."),
                holding: token
            )
        }
    }

    private func perform(
        _ request: AutomationRequest,
        token: AutomationRunToken
    ) async throws -> WorkToolResult {
        // The page in front is compared against the one the permission check was
        // made about. A tab that changed between the two — a redirect, a popup,
        // a person clicking a link — would otherwise mean the action lands on a
        // site nobody allowed while the audit records the one that was checked.
        let liveHost = try await driver.currentHost()
        try await gate.checkpoint(token)
        guard AutomationPermission.normalizeHost(liveHost)
            == AutomationPermission.normalizeHost(request.target)
        else {
            throw AutomationRefusal(
                .focusMoved,
                "The page changed to a different site before Juno could act, so it stopped."
            )
        }

        switch request.intent {
        case .inspect:
            let outline = try await driver.outline()
            try await gate.checkpoint(token)
            let sensitive = SensitiveSurfaceDetector.classify(fields: outline.fields)
            return WorkToolResult(
                content: "\(outline.title) — \(outline.fields.count) controls.",
                detail: [
                    "controls": .number(Double(outline.fields.count)),
                    "sensitive_fields": .number(Double(sensitive.count)),
                ]
            )
        case .navigate:
            try await driver.navigate(toHost: request.target, path: request.element ?? "/")
            try await gate.checkpoint(token)
            return WorkToolResult(content: "Opened a page on \(request.target).")
        case .enterText:
            guard let elementID = request.element, let text = request.text else {
                throw AutomationRefusal(
                    .intentNotServed,
                    "Juno needed a field and some text and did not have both."
                )
            }
            try await refuseIfSensitive(elementID: elementID, token: token)
            try await driver.enterText(text, intoElementID: elementID)
            try await gate.checkpoint(token)
            return WorkToolResult(content: "Typed \(text.count) characters.")
        case .activateControl, .sendMessage, .publish, .purchase, .deleteItem,
             .changeAccountSetting:
            guard let elementID = request.element else {
                throw AutomationRefusal(
                    .intentNotServed,
                    "Juno needed to know which control to press."
                )
            }
            try await driver.activate(elementID: elementID)
            try await gate.checkpoint(token)
            return WorkToolResult(content: "Pressed a control on \(request.target).")
        case .captureScreen, .changeSecuritySetting:
            throw AutomationRefusal(
                .intentNotServed,
                "The browser cannot do that, and Juno will not fall back to something coarser for it."
            )
        }
    }

    /// Refuses to type into a field the page itself says is secure.
    ///
    /// A signal, not the boundary — see ``SensitiveSurfaceDetector``. What makes
    /// this worth doing anyway is that it is free and it catches the honest
    /// case: a model that decided the password box was the search box.
    private func refuseIfSensitive(elementID: String, token: AutomationRunToken) async throws {
        let outline = try await driver.outline()
        try await gate.checkpoint(token)
        guard let field = outline.fields.first(where: { $0.elementID == elementID }) else {
            return
        }
        if let surface = SensitiveSurfaceDetector.classify(field) {
            throw AutomationRefusal(
                .sensitiveSurface,
                "That field is for \(surface.kind.phrase), and Juno does not fill those in."
            )
        }
    }

    /// The receipt this call needs, or nil when it needs none.
    private func approvalRefusal(
        request: AutomationRequest,
        context: WorkToolContext
    ) async throws -> AutomationRefusal? {
        guard request.intent.requiresApprovalReceipt(inTier: tier) else { return nil }
        return AutomationApproval.refusal(
            for: context.authorization,
            digest: AutomationApproval.digest(tool: name, request: request),
            at: gate.now()
        )
    }
}

// MARK: - Binding an approval to an automated action

/// How an automated action is bound to the approval a person gave for it.
///
/// There is no second approval path here. The receipt comes from
/// ``WorkApprovalCoordinator`` by way of ``WorkToolRegistry``, and this type only
/// recomputes the digest and re-checks it at the moment of execution — which is
/// the check that matters, because an approval granted while the arguments were
/// one thing must not survive them becoming another.
public enum AutomationApproval {
    /// Namespaced and versioned so an automation digest can never be mistaken
    /// for a file batch digest, and so a change to the canonical form
    /// invalidates stored approvals loudly instead of colliding with them.
    public static let digestDomain = "juno.work.automation.v1"

    public static func digest(tool: String, request: AutomationRequest) -> String {
        WorkDigests.sha256Hex(
            WorkDigests.canonicalRecord([
                digestDomain,
                tool,
                request.intent.rawValue,
                request.target,
                request.element ?? "",
                // The text is bound by its digest rather than by its contents,
                // so an approval still cannot be reused for different text and
                // the canonical record still contains no secret.
                request.text.map { WorkDigests.sha256Hex($0) } ?? "",
                request.x.map(String.init) ?? "",
                request.y.map(String.init) ?? "",
            ])
        )
    }

    /// Why this authority does not cover the action, or nil.
    public static func refusal(
        for authorization: WorkAuthorization,
        digest: String,
        at date: Date
    ) -> AutomationRefusal? {
        switch authorization {
        case .approved(let receipt):
            guard receipt.authorizes(digest: digest, at: date) else {
                return AutomationRefusal(
                    .approvalStale,
                    "What Juno was about to do no longer matches what you approved, so it stopped."
                )
            }
            return nil
        case .allowedByPolicy, .deferredToTheTool:
            // A policy cannot cover this. Sending, publishing, buying, deleting
            // and changing a setting always ask, under every policy — the same
            // rule `WorkRisk.ruling` puts above the policy ladder. Reaching here
            // means the gate was bypassed, so the answer is no rather than a
            // second attempt to ask.
            return AutomationRefusal(
                .approvalMissing,
                "Juno will not do that without asking you first."
            )
        }
    }
}
