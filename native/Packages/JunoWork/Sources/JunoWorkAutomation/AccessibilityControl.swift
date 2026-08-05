import Foundation
import JunoWorkCore
import JunoWorkRuntime

#if os(macOS)
import AppKit
import ApplicationServices
#endif

// MARK: - What an app looks like from here

public struct AccessibilityWindowOutline: Hashable, Sendable {
    public let bundleIdentifier: String
    public let windowTitle: String
    public let fields: [AccessibilityFieldDescriptor]

    public init(
        bundleIdentifier: String,
        windowTitle: String,
        fields: [AccessibilityFieldDescriptor]
    ) {
        self.bundleIdentifier = bundleIdentifier
        self.windowTitle = windowTitle
        self.fields = fields
    }
}

// MARK: - The seam

public protocol AccessibilityDriving: Sendable {
    /// Whether macOS has granted this process the Accessibility permission.
    /// Without it every call below fails, and the honest thing to do with an
    /// unhealthy tier is fall through to a coarser one rather than error.
    func isTrusted() async -> Bool
    /// Whether the named app is running and reachable.
    func isRunning(bundleIdentifier: String) async -> Bool
    /// The bundle identifier of the app in front, which is the app that will
    /// receive anything typed.
    func frontmostBundleIdentifier() async throws -> String?
    func outline(ofApp bundleIdentifier: String) async throws -> AccessibilityWindowOutline
    func press(elementID: String, inApp bundleIdentifier: String) async throws
    func setValue(_ text: String, elementID: String, inApp bundleIdentifier: String) async throws
}

/// An accessibility driver that drives nothing, for tests and previews.
public struct ScriptedAccessibilityDriver: AccessibilityDriving {
    public struct Script: Sendable {
        public var trusted: Bool
        public var running: Bool
        public var frontmost: String?
        public var outline: AccessibilityWindowOutline
        public var failure: AutomationRefusal?

        public init(
            trusted: Bool = true,
            running: Bool = true,
            frontmost: String? = "com.example.notes",
            outline: AccessibilityWindowOutline = AccessibilityWindowOutline(
                bundleIdentifier: "com.example.notes",
                windowTitle: "Notes",
                fields: []
            ),
            failure: AutomationRefusal? = nil
        ) {
            self.trusted = trusted
            self.running = running
            self.frontmost = frontmost
            self.outline = outline
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

    public func isTrusted() async -> Bool { script.trusted }

    public func isRunning(bundleIdentifier: String) async -> Bool {
        _ = bundleIdentifier
        return script.running
    }

    public func frontmostBundleIdentifier() async throws -> String? {
        if let failure = script.failure { throw failure }
        return script.frontmost
    }

    public func outline(ofApp bundleIdentifier: String) async throws -> AccessibilityWindowOutline {
        await recorder.record("outline:\(bundleIdentifier)")
        if let failure = script.failure { throw failure }
        return script.outline
    }

    public func press(elementID: String, inApp bundleIdentifier: String) async throws {
        await recorder.record("press:\(bundleIdentifier):\(elementID)")
        if let failure = script.failure { throw failure }
    }

    public func setValue(
        _ text: String,
        elementID: String,
        inApp bundleIdentifier: String
    ) async throws {
        await recorder.record("setValue:\(bundleIdentifier):\(elementID):\(text.count)")
        if let failure = script.failure { throw failure }
    }
}

// MARK: - The real driver

#if os(macOS)
/// Drives an app through its accessibility tree.
///
/// ### What this needs at runtime
///
/// The Accessibility permission (`AXIsProcessTrusted()`), granted by the person
/// in System Settings under Privacy & Security → Accessibility. Without it every
/// `AXUIElement` call returns `kAXErrorAPIDisabled` and ``isTrusted()`` reports
/// the tier unhealthy, which is what makes the lattice fall through rather than
/// fail. The permission is never requested from here: prompting for it belongs
/// to an explicit gesture in the app, for the same reason
/// `ComputerUseCoordinator` only prompts on activation.
///
/// Elements are addressed by their index path from the application element —
/// `"0/3/2"` is the third child of the fourth child of the first child. A path
/// is stable enough for the moments between an inspect and the action that
/// follows it, and it means no `AXUIElement` is ever held across a suspension
/// point, which is what keeps this type genuinely `Sendable` rather than
/// `@unchecked`.
public struct SystemAccessibilityDriver: AccessibilityDriving {
    /// Depth and node ceilings for the tree walk.
    ///
    /// An accessibility tree is not bounded. A document window in a text editor
    /// can expose one element per line, and a walk without a ceiling turns an
    /// inspect into a several-second hang with the whole app blocked behind it.
    public static let maximumDepth = 8
    public static let maximumNodes = 600

    public init() {}

    public func isTrusted() async -> Bool { AXIsProcessTrusted() }

    public func isRunning(bundleIdentifier: String) async -> Bool {
        processIdentifier(for: bundleIdentifier) != nil
    }

    public func frontmostBundleIdentifier() async throws -> String? {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }

    public func outline(ofApp bundleIdentifier: String) async throws -> AccessibilityWindowOutline {
        let element = try applicationElement(bundleIdentifier)
        var fields: [AccessibilityFieldDescriptor] = []
        var visited = 0
        walk(element, path: [], depth: 0, visited: &visited, into: &fields)
        return AccessibilityWindowOutline(
            bundleIdentifier: bundleIdentifier,
            windowTitle: string(element, kAXTitleAttribute) ?? "",
            fields: fields
        )
    }

    public func press(elementID: String, inApp bundleIdentifier: String) async throws {
        let element = try resolve(elementID, in: bundleIdentifier)
        let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard status == .success else {
            throw AutomationRefusal(
                .driverUnavailable,
                "That control did not respond when Juno pressed it."
            )
        }
    }

    public func setValue(
        _ text: String,
        elementID: String,
        inApp bundleIdentifier: String
    ) async throws {
        let element = try resolve(elementID, in: bundleIdentifier)
        // Re-read the role at the moment of writing rather than trusting the
        // outline. Between an inspect and a keystroke a sheet can appear and the
        // element at that path can become a different one; typing into it
        // because the earlier snapshot said it was a search box is how a
        // passphrase ends up in a document.
        if isSecure(element) {
            throw AutomationRefusal(
                .sensitiveSurface,
                "That field is for a password, and Juno does not fill those in."
            )
        }
        let status = AXUIElementSetAttributeValue(
            element,
            kAXValueAttribute as CFString,
            text as CFTypeRef
        )
        guard status == .success else {
            throw AutomationRefusal(
                .driverUnavailable,
                "That field did not accept what Juno typed."
            )
        }
    }

    // MARK: Tree

    private func walk(
        _ element: AXUIElement,
        path: [Int],
        depth: Int,
        visited: inout Int,
        into fields: inout [AccessibilityFieldDescriptor]
    ) {
        guard depth < Self.maximumDepth, visited < Self.maximumNodes else { return }
        visited += 1
        if !path.isEmpty, let role = string(element, kAXRoleAttribute) {
            fields.append(
                AccessibilityFieldDescriptor(
                    elementID: path.map(String.init).joined(separator: "/"),
                    role: role,
                    subrole: string(element, kAXSubroleAttribute),
                    label: string(element, kAXTitleAttribute)
                        ?? string(element, kAXDescriptionAttribute),
                    isSecureTextEntry: isSecure(element),
                    contentHint: nil,
                    // Deliberately nil. Reading a frame means unboxing an
                    // `AXValue`, and the only consumer of a frame is the
                    // redaction plan for a screen capture — which this tier
                    // never takes. A field nobody uses is a field that rots.
                    bounds: nil
                )
            )
        }
        for (index, child) in children(of: element).enumerated() {
            walk(child, path: path + [index], depth: depth + 1, visited: &visited, into: &fields)
        }
    }

    private func children(of element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
            == .success
        else { return [] }
        return (value as? [AXUIElement]) ?? []
    }

    private func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return nil }
        return value as? String
    }

    private func isSecure(_ element: AXUIElement) -> Bool {
        if let subrole = string(element, kAXSubroleAttribute),
            subrole == (kAXSecureTextFieldSubrole as String)
        {
            return true
        }
        return string(element, kAXRoleAttribute) == "AXSecureTextField"
    }

    private func resolve(_ elementID: String, in bundleIdentifier: String) throws -> AXUIElement {
        var element = try applicationElement(bundleIdentifier)
        for component in elementID.split(separator: "/") {
            guard let index = Int(component) else {
                throw AutomationRefusal(
                    .malformedIdentifier,
                    "Juno could not tell which control that was."
                )
            }
            let kids = children(of: element)
            guard index >= 0, index < kids.count else {
                throw AutomationRefusal(
                    .focusMoved,
                    "The window changed before Juno could act, so it stopped."
                )
            }
            element = kids[index]
        }
        return element
    }

    private func applicationElement(_ bundleIdentifier: String) throws -> AXUIElement {
        guard AXIsProcessTrusted() else {
            throw AutomationRefusal(
                .driverUnavailable,
                "Juno does not have permission to control apps on this Mac."
            )
        }
        guard let pid = processIdentifier(for: bundleIdentifier) else {
            throw AutomationRefusal(.driverUnavailable, "That app is not running.")
        }
        return AXUIElementCreateApplication(pid)
    }

    private func processIdentifier(for bundleIdentifier: String) -> pid_t? {
        let target = AutomationPermission.normalizeIdentifier(bundleIdentifier)
        for application in NSWorkspace.shared.runningApplications {
            guard let identifier = application.bundleIdentifier,
                AutomationPermission.normalizeIdentifier(identifier) == target
            else { continue }
            return application.processIdentifier
        }
        return nil
    }
}
#endif

// MARK: - The control

/// Tier 4: drive an app through the accessibility tree macOS already publishes.
///
/// Coarser than the browser, because the identities are index paths rather than
/// names and a sheet appearing changes what a path means. Finer than screen
/// control, because it still addresses *elements*: it can ask whether the thing
/// it is about to type into is a secure field, and screen control cannot.
public struct AccessibilityControl: AutomationControl, WorkTool {
    public let tier: AutomationTier = .accessibility
    public let declaredIntents: Set<AutomationIntent> = [
        .inspect, .enterText, .activateControl,
        .sendMessage, .publish, .purchase, .deleteItem, .changeAccountSetting,
    ]

    private let driver: any AccessibilityDriving
    private let gate: AutomationGate

    public init(driver: any AccessibilityDriving, gate: AutomationGate) {
        self.driver = driver
        self.gate = gate
    }

    public func health() async -> AutomationControlHealth {
        guard gate.permission.permits(tier: .accessibility).isAllowed else {
            return .unavailable(reason: "App control is switched off on this Mac.")
        }
        guard await driver.isTrusted() else {
            return .unavailable(reason: "Juno does not have macOS Accessibility permission.")
        }
        return .healthy
    }

    // MARK: WorkTool

    public var name: String { "app_control" }

    public var description: String {
        """
        Look at and act on an app on this Mac through its accessibility tree. \
        Used when no browser or connector can do the job. Only apps the person \
        allowed can be reached.
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
            return "Do something in an app on this Mac."
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
                AutomationRefusal(.driverUnavailable, "That app did not do what Juno asked."),
                holding: token
            )
        }
    }

    private func perform(
        _ request: AutomationRequest,
        token: AutomationRunToken
    ) async throws -> WorkToolResult {
        switch request.intent {
        case .inspect:
            let outline = try await driver.outline(ofApp: request.target)
            try await gate.checkpoint(token)
            let sensitive = SensitiveSurfaceDetector.classify(fields: outline.fields)
            return WorkToolResult(
                content: "\(outline.windowTitle) — \(outline.fields.count) controls.",
                detail: [
                    "controls": .number(Double(outline.fields.count)),
                    "sensitive_fields": .number(Double(sensitive.count)),
                ]
            )
        case .enterText:
            guard let elementID = request.element, let text = request.text else {
                throw AutomationRefusal(
                    .intentNotServed,
                    "Juno needed a field and some text and did not have both."
                )
            }
            // Typing goes to whatever has focus, so the app in front has to be
            // the app that was checked. Without this, an app that came forward
            // between the check and the keystroke receives text approved for a
            // different app entirely.
            try await requireFrontmost(request.target, token: token)
            try await driver.setValue(text, elementID: elementID, inApp: request.target)
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
            try await driver.press(elementID: elementID, inApp: request.target)
            try await gate.checkpoint(token)
            return WorkToolResult(content: "Pressed a control in \(request.target).")
        case .navigate, .captureScreen, .changeSecuritySetting:
            throw AutomationRefusal(
                .intentNotServed,
                "App control cannot do that, and Juno will not fall back to something coarser for it."
            )
        }
    }

    private func requireFrontmost(_ bundleIdentifier: String, token: AutomationRunToken) async throws {
        let frontmost = try await driver.frontmostBundleIdentifier()
        try await gate.checkpoint(token)
        guard let frontmost else {
            throw AutomationRefusal(
                .notConsidered,
                "Juno could not tell which app was in front, so it did not type anything."
            )
        }
        guard AutomationPermission.normalizeIdentifier(frontmost)
            == AutomationPermission.normalizeIdentifier(bundleIdentifier)
        else {
            throw AutomationRefusal(
                .focusMoved,
                "A different app came to the front before Juno could type, so it stopped."
            )
        }
    }
}
