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
    /// The element an action is about to reach, for the consequential-action
    /// floor and the overlay: its words, whether it is secure entry, where it
    /// is. Nil when it cannot be read.
    func target(elementID: String, inApp bundleIdentifier: String) async throws -> WorkScreenTarget?
}

extension AccessibilityDriving {
    /// From the outline: the field with this id, by its label and role.
    public func target(elementID: String, inApp bundleIdentifier: String) async throws -> WorkScreenTarget? {
        let outline = try await outline(ofApp: bundleIdentifier)
        guard let field = outline.fields.first(where: { $0.elementID == elementID }) else { return nil }
        return WorkScreenTarget(
            bundleIdentifier: bundleIdentifier,
            appName: bundleIdentifier,
            texts: [field.label].compactMap { $0 }.filter { !$0.isEmpty },
            spokenName: field.label.map { "“\($0)” \(Self.plainRole(field.role))" },
            role: field.role,
            isSecure: field.isSecureTextEntry,
            frame: field.bounds
        )
    }

    /// "AXButton" → "button".
    static func plainRole(_ role: String) -> String {
        let trimmed = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
        var words = ""
        for character in trimmed {
            if character.isUppercase, !words.isEmpty { words.append(" ") }
            words.append(character)
        }
        return words.lowercased()
    }
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

    /// Read straight from the element, at the moment of acting: its title,
    /// description and role description (the words the floor matches, as
    /// Code's hit-test reads them), its text for a button or label whose
    /// words live in its value, the labels drawn inside a control, and
    /// where it is.
    public func target(elementID: String, inApp bundleIdentifier: String) async throws -> WorkScreenTarget? {
        let element = try resolve(elementID, in: bundleIdentifier)
        let role = string(element, kAXRoleAttribute)
        let title = string(element, kAXTitleAttribute)
        let label = string(element, kAXDescriptionAttribute)
        var texts = [title, label, string(element, kAXRoleDescriptionAttribute)].compactMap { $0 }
        if role == "AXButton" || role == "AXStaticText" || role == "AXLink" || role == "AXMenuItem",
           let value = string(element, kAXValueAttribute)
        {
            texts.append(String(value.prefix(200)))
        }
        if !Self.textEntryRoles.contains(role ?? "") {
            // SwiftUI, Catalyst and web views draw a "Send" button as an
            // untitled button around a static text. Code's hit-test lands on
            // that text; pressing the button by path never does, so its
            // labels are read here, or the floor would see no word at all.
            texts += labels(inside: element)
        }
        let name = (title?.isEmpty == false ? title : label) ?? ""
        let kind = Self.plainRole(role ?? "element")
        let application = NSWorkspace.shared.runningApplications.first {
            $0.bundleIdentifier.map(AutomationPermission.normalizeIdentifier)
                == AutomationPermission.normalizeIdentifier(bundleIdentifier)
        }
        return WorkScreenTarget(
            bundleIdentifier: bundleIdentifier,
            appName: application?.localizedName ?? bundleIdentifier,
            texts: texts.filter { !$0.isEmpty },
            spokenName: name.isEmpty ? kind : "“\(name)” \(kind)",
            role: role,
            isSecure: isSecure(element),
            frame: frame(of: element),
            // The category Code reads too, so a finance app known only by
            // its App Store category is refused here as it is on a click.
            appStoreCategory: application?.bundleURL.flatMap {
                Bundle(url: $0)?.infoDictionary?["LSApplicationCategoryType"] as? String
            }
        )
    }

    /// Fields whose children are their content, not their label.
    static let textEntryRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXSearchField", "AXWebArea",
    ]

    /// The words drawn inside a control: titles, descriptions and static
    /// text of its descendants, two levels down, at most eight of them.
    private func labels(inside element: AXUIElement) -> [String] {
        var texts: [String] = []
        var visited = 0
        var queue: [(AXUIElement, Int)] = children(of: element).map { ($0, 1) }
        while !queue.isEmpty, visited < 8 {
            let (child, depth) = queue.removeFirst()
            visited += 1
            let role = string(child, kAXRoleAttribute)
            texts += [string(child, kAXTitleAttribute), string(child, kAXDescriptionAttribute)].compactMap { $0 }
            if role == "AXStaticText", let value = string(child, kAXValueAttribute) {
                texts.append(value)
            }
            if depth < 2, !Self.textEntryRoles.contains(role ?? "") {
                queue += children(of: child).map { ($0, depth + 1) }
            }
        }
        return texts.filter { !$0.isEmpty }.map { String($0.prefix(200)) }
    }

    private func frame(of element: AXUIElement) -> AutomationRect? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
              let positionValue, let sizeValue,
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        // swiftlint:disable:next force_cast
        AXValueGetValue(positionValue as! AXValue, .cgPoint, &point)
        // swiftlint:disable:next force_cast
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        return AutomationRect(x: point.x, y: point.y, width: size.width, height: size.height)
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
///
/// Every press and every text it sets goes through the consequential-action
/// floor Code uses (``WorkScreenFloor``), read against the element itself, and
/// draws on the app-wide action overlay (``WorkActionOverlay``).
public struct AccessibilityControl: AutomationControl, WorkTool {
    public let tier: AutomationTier = .accessibility
    public let declaredIntents: Set<AutomationIntent> = [
        .inspect, .enterText, .activateControl,
        .sendMessage, .publish, .purchase, .deleteItem, .changeAccountSetting,
    ]

    private let driver: any AccessibilityDriving
    private let gate: AutomationGate
    private let overlay: WorkActionOverlay

    public init(driver: any AccessibilityDriving, gate: AutomationGate, overlay: WorkActionOverlay = .none) {
        self.driver = driver
        self.gate = gate
        self.overlay = overlay
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
            let result = try await perform(request, context: context, token: token)
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
        context: WorkToolContext,
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
            let field = try await driver.target(elementID: elementID, inApp: request.target)
            try await gate.checkpoint(token)
            if let surface = field?.sensitiveSurface {
                // An extra deny on top of the floor, never a reason to ask.
                throw AutomationRefusal(
                    .sensitiveSurface,
                    "That field is for \(surface.kind.phrase), so nothing was typed. Ask the person to enter it."
                )
            }
            let appName = field?.appName ?? request.target
            let label = field?.spokenName.map { "Type \(text.count) characters into the \($0) in \(appName)" }
                ?? "Type \(text.count) characters in \(appName)"
            try await applyFloor(
                .type(text), target: field, label: label,
                request: request, context: context, token: token
            )
            try await overlay.around(
                runID: token.runID,
                label: label,
                point: field?.center,
                appName: appName,
                input: { try await driver.setValue(text, elementID: elementID, inApp: request.target) },
                checkpoint: { try await gate.checkpoint(token) }
            )
            return WorkToolResult(content: "Typed \(text.count) characters.")
        case .activateControl, .sendMessage, .publish, .purchase, .deleteItem,
             .changeAccountSetting:
            guard let elementID = request.element else {
                throw AutomationRefusal(
                    .intentNotServed,
                    "Juno needed to know which control to press."
                )
            }
            // The element itself, read now: "Send", "Delete" and "Pay" ask
            // whatever intent the model filed the press under.
            let control = try await driver.target(elementID: elementID, inApp: request.target)
            try await gate.checkpoint(token)
            let appName = control?.appName ?? request.target
            let label = control?.spokenName.map { "Press the \($0) in \(appName)" } ?? "Press a control in \(appName)"
            try await applyFloor(
                .press, target: control, label: label,
                request: request, context: context, token: token
            )
            try await overlay.around(
                runID: token.runID,
                label: label,
                point: control?.center,
                appName: appName,
                input: { try await driver.press(elementID: elementID, inApp: request.target) },
                checkpoint: { try await gate.checkpoint(token) }
            )
            return WorkToolResult(content: "Pressed a control in \(request.target).")
        case .navigate, .captureScreen, .changeSecuritySetting:
            throw AutomationRefusal(
                .intentNotServed,
                "App control cannot do that, and Juno will not fall back to something coarser for it."
            )
        }
    }

    /// The floor, against the element: refuses, asks (suspending until the
    /// person answers), or lets the action through.
    private func applyFloor(
        _ gesture: WorkScreenFloor.Gesture,
        target: WorkScreenTarget?,
        label: String,
        request: AutomationRequest,
        context: WorkToolContext,
        token: AutomationRunToken
    ) async throws {
        switch WorkScreenFloor.ruling(
            gesture,
            bundleIdentifier: request.target,
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
                reason: reason,
                summary: label + ".",
                context: context,
                now: gate.now
            )
            try await gate.checkpoint(token)
            // The answer can take minutes: the element approved must still be
            // the one at that path, and typing still goes to the app checked.
            if case .type = gesture { try await requireFrontmost(request.target, token: token) }
            if let elementID = request.element {
                let again = try await driver.target(elementID: elementID, inApp: request.target)
                try await gate.checkpoint(token)
                guard again?.texts == target?.texts, again?.role == target?.role else {
                    throw AutomationRefusal(
                        .focusMoved,
                        "That control changed while you were being asked, so nothing was done."
                    )
                }
            }
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
