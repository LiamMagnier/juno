import Foundation
import JunoWorkCore
import JunoWorkRuntime

#if canImport(JunoScreenControl)
import JunoScreenControl
#endif
#if os(macOS)
import AppKit
#endif

// MARK: - One floor and one overlay with Code

/// What a Work screen action lands on, as the app hit-tested it: never what
/// the model said it was clicking.
///
/// The consequential-action floor reads these words, exactly as it does for a
/// Code session (CODE_AGENT_SPEC §3.3, §3.8 rule 3), and the action overlay
/// names the control in its label.
public struct WorkScreenTarget: Hashable, Sendable {
    public var bundleIdentifier: String
    public var appName: String
    /// For a press: the element's title, description and role description,
    /// plus what pressing it reaches (a button whose words live in a child
    /// label). For typing: the focused control's words and the window's
    /// default button, which Return presses.
    public var texts: [String]
    /// "“Send” button", for the overlay's label.
    public var spokenName: String?
    /// `AXTextField`, `AXButton`: the accessibility role, when known.
    public var role: String?
    /// The platform marked the element as secure entry.
    public var isSecure: Bool
    /// Global CoreGraphics points (top-left origin), when known.
    public var frame: AutomationRect?
    /// The app's `LSApplicationCategoryType`, when it declares one.
    public var appStoreCategory: String?

    public init(
        bundleIdentifier: String,
        appName: String,
        texts: [String] = [],
        spokenName: String? = nil,
        role: String? = nil,
        isSecure: Bool = false,
        frame: AutomationRect? = nil,
        appStoreCategory: String? = nil
    ) {
        self.bundleIdentifier = bundleIdentifier
        self.appName = appName
        self.texts = texts
        self.spokenName = spokenName
        self.role = role
        self.isSecure = isSecure
        self.frame = frame
        self.appStoreCategory = appStoreCategory
    }

    /// The middle of the element, for the overlay's ring.
    var center: AutomationPoint? {
        frame.map { AutomationPoint(x: $0.x + $0.width / 2, y: $0.y + $0.height / 2) }
    }

    /// What typing here would put text into, if it is a secret: an extra deny
    /// on top of the floor (``SensitiveSurfaceDetector``), never a reason to
    /// ask, because no approval makes a password something to delegate.
    var sensitiveSurface: SensitiveSurface? {
        SensitiveSurfaceDetector.classify(
            AccessibilityFieldDescriptor(
                elementID: "target",
                role: role ?? "",
                label: texts.first,
                isSecureTextEntry: isSecure
            )
        )
    }
}

/// Hit-tests for the floor: what a click at a point would press, and what
/// typing in an app would reach.
///
/// A seam of its own rather than a driver method, so the floor reads the same
/// system-wide accessibility hit-test Code uses (``SystemWorkScreenTargets``)
/// whatever driver sends the input.
public protocol WorkScreenTargeting: Sendable {
    func target(at point: AutomationPoint) async -> WorkScreenTarget?
    func focusedTarget(bundleIdentifier: String) async -> WorkScreenTarget?
}

/// Scripted hit-tests, for tests and previews.
public struct ScriptedScreenTargets: WorkScreenTargeting {
    public var underPoint: WorkScreenTarget?
    public var focused: WorkScreenTarget?

    public init(underPoint: WorkScreenTarget? = nil, focused: WorkScreenTarget? = nil) {
        self.underPoint = underPoint
        self.focused = focused
    }

    public func target(at point: AutomationPoint) async -> WorkScreenTarget? {
        _ = point
        return underPoint
    }

    public func focusedTarget(bundleIdentifier: String) async -> WorkScreenTarget? {
        _ = bundleIdentifier
        return focused
    }
}

#if os(macOS) && canImport(JunoScreenControl)
/// The real hit-tests: JunoScreenControl's accessibility reader, the one Code's
/// service hit-tests with, so a Work click and a Code click on the same
/// "Send" button read the same words to the floor.
public struct SystemWorkScreenTargets: WorkScreenTargeting {
    private let accessibility: SystemAccessibility

    public init() {
        self.accessibility = SystemAccessibility()
    }

    public func target(at point: AutomationPoint) async -> WorkScreenTarget? {
        // System-wide: what a real click at this point would hit, whichever
        // app owns the window there.
        guard let hit = await accessibility.target(at: ScreenPoint(x: point.x, y: point.y), within: nil) else {
            return nil
        }
        return Self.workTarget(hit, texts: hit.pressTexts)
    }

    public func focusedTarget(bundleIdentifier: String) async -> WorkScreenTarget? {
        let wanted = AutomationPermission.normalizeIdentifier(bundleIdentifier)
        let pid = await MainActor.run {
            NSWorkspace.shared.runningApplications.first {
                $0.bundleIdentifier.map(AutomationPermission.normalizeIdentifier) == wanted
            }?.processIdentifier
        }
        guard let pid, let focus = await accessibility.focusedTarget(pid: pid) else { return nil }
        return Self.workTarget(focus, texts: focus.floorTexts)
    }

    static func workTarget(_ target: ScreenTarget, texts: [String]) -> WorkScreenTarget {
        WorkScreenTarget(
            bundleIdentifier: target.bundleID,
            appName: target.appName,
            texts: texts,
            spokenName: target.element?.spokenName,
            role: target.element?.role,
            isSecure: target.element?.isSecure ?? false,
            frame: target.element.map {
                AutomationRect(x: $0.frame.x, y: $0.frame.y, width: $0.frame.width, height: $0.frame.height)
            },
            appStoreCategory: target.appStoreCategory
        )
    }
}
#endif

/// The always-confirm floor for Work's screen and app control: the one Code
/// sessions and connected agents use (``ConsequentialActionFloor``), read
/// against the hit-tested target, plus Code's category caps.
///
/// What it adds to Work's own gate is the case that gate cannot see: a plain
/// `activate_control` click that lands on "Send", "Delete" or "Pay", or typed
/// text whose Return sends in a messaging app. Those ask under every policy,
/// Full access included, and can never be covered by an always-allow.
public enum WorkScreenFloor {
    public enum Gesture: Hashable, Sendable {
        /// A click, or an accessibility press.
        case press
        /// Typed or set text.
        case type(String)
    }

    public enum Ruling: Hashable, Sendable {
        case clear
        /// Ask the person first; the sentence is the floor's reason.
        case ask(String)
        case deny(AutomationRefusal)
    }

    public static func ruling(
        _ gesture: Gesture,
        bundleIdentifier: String,
        appStoreCategory: String? = nil,
        texts: [String]
    ) -> Ruling {
        #if canImport(JunoScreenControl)
        let category = AppCategories.category(bundleID: bundleIdentifier, appStoreCategory: appStoreCategory)
        switch category {
        case .refused:
            return .deny(AutomationRefusal(.restrictedCategory, AppCategories.warning(for: .refused) ?? "This app is never controlled."))
        case .finance:
            // Code caps finance and trading apps at looking; Work's press and
            // type are never looking, whatever the allowlist says.
            return .deny(AutomationRefusal(
                .restrictedCategory,
                "Finance and trading apps are view only, so this was not done.",
                category: .investment
            ))
        case .terminal, .ide:
            if case .type = gesture {
                return .deny(AutomationRefusal(
                    .restrictedCategory,
                    "Typing into a terminal or an editor would get past your command rules, so this was not done."
                ))
            }
        default:
            break
        }
        let action: ScreenAction
        switch gesture {
        case .press: action = ScreenAction(kind: .leftClick)
        case .type(let text): action = ScreenAction(kind: .type, text: text)
        }
        guard let reason = ConsequentialActionFloor.evaluate(
            action: action,
            category: category,
            targetTexts: texts,
            typedSinceLastCommit: false,
            bundleID: bundleIdentifier
        ) else { return .clear }
        return .ask(reason.explanation)
        #else
        // No screen-control package means no screen to drive (the phone only
        // watches). Should a driver ever exist here, it asks.
        _ = (gesture, bundleIdentifier, appStoreCategory, texts)
        return .ask("This always asks first.")
        #endif
    }

    /// Namespaced so a floor approval can never be mistaken for the
    /// registry's or the receipt check's.
    static let digestDomain = "juno.work.floor.v1"

    /// Asks the person about this exact action, with the floor's reason, and
    /// suspends while the question is open.
    ///
    /// Always asks, even when the registry already approved the call. The
    /// registry asks before anything is hit-tested, so its question names a
    /// position or an intent, never the control the floor read ("Send",
    /// "Delete"), and the screen can change while it waits. Code works the
    /// same way: an approval whose card carried no floor reason never covers
    /// a control the floor asks about.
    static func confirm(
        tool: String,
        request: AutomationRequest,
        reason: String,
        summary: String,
        context: WorkToolContext,
        now: @Sendable () -> Date
    ) async throws {
        let digest = WorkDigests.sha256Hex(
            WorkDigests.canonicalRecord([
                digestDomain, tool, AutomationApproval.digest(tool: tool, request: request), reason,
            ])
        )
        let outcome = await context.approvals.authorize(
            action: tool,
            runID: context.runID,
            actionDigest: digest,
            // Irreversible always asks, under every policy and allowance.
            risk: .irreversible,
            mode: .readWrite,
            summary: "\(summary) \(reason)"
        )
        switch outcome {
        case .approved(let receipt):
            guard receipt.authorizes(digest: digest, at: now()) else {
                throw AutomationRefusal(.approvalStale, "That approval expired before it could be used, so nothing was done.")
            }
        case .denied(let why):
            throw AutomationRefusal(.approvalMissing, why)
        case .allowed:
            // An irreversible risk never resolves to "allowed"; if a policy
            // ever claims it did, the answer is still no.
            throw AutomationRefusal(.approvalMissing, "This always asks first, and nobody was asked, so nothing was done.")
        }
    }
}

/// Where Work's screen actions are drawn: the app-wide action overlay, the
/// same ring and label a Code session's actions get (Code v2 SPEC §3.12).
///
/// On the Mac it wraps the app's ``ComputerActionFeed`` (the shared
/// `ScreenControlService`'s). Elsewhere, and in tests that do not inject one,
/// it draws nothing.
public struct WorkActionOverlay: Sendable {
    public enum Phase: Hashable, Sendable {
        case acting
        case settled(succeeded: Bool)
        case cleared
    }

    #if canImport(JunoScreenControl)
    let feed: ComputerActionFeed?

    public init(feed: ComputerActionFeed?) {
        self.feed = feed
    }

    #if os(macOS)
    /// The app's feed, shared with Code.
    public static var app: WorkActionOverlay {
        WorkActionOverlay(feed: ScreenControlService.shared.feed)
    }
    #endif
    #endif

    /// Draws nothing.
    public static var none: WorkActionOverlay {
        #if canImport(JunoScreenControl)
        WorkActionOverlay(feed: nil)
        #else
        WorkActionOverlay()
        #endif
    }

    /// The overlay's session id for a run: the id it holds the lock under.
    static func sessionID(runID: String) -> String { "work:\(runID)" }

    func post(runID: String, label: String, point: AutomationPoint?, appName: String?, phase: Phase) {
        #if canImport(JunoScreenControl)
        guard let feed else { return }
        let cuePhase: ComputerActionCue.Phase
        switch phase {
        case .acting: cuePhase = .acting
        case .settled(let succeeded): cuePhase = .settled(succeeded: succeeded)
        case .cleared: cuePhase = .cleared
        }
        feed.post(ComputerActionCue(
            sessionID: Self.sessionID(runID: runID),
            label: label,
            point: point.map { ScreenPoint(x: $0.x, y: $0.y) },
            appName: appName,
            phase: cuePhase
        ))
        #else
        _ = (runID, label, point, appName, phase)
        #endif
    }

    /// Posts `acting`, runs `input`, then `settled`; a stop that lands after
    /// the input clears the overlay instead.
    func around<T>(
        runID: String,
        label: String,
        point: AutomationPoint?,
        appName: String?,
        input: () async throws -> T,
        checkpoint: () async throws -> Void
    ) async throws -> T {
        post(runID: runID, label: label, point: point, appName: appName, phase: .acting)
        let value: T
        do {
            value = try await input()
        } catch {
            post(runID: runID, label: label, point: point, appName: appName, phase: .settled(succeeded: false))
            throw error
        }
        do {
            try await checkpoint()
        } catch {
            post(runID: runID, label: label, point: point, appName: appName, phase: .cleared)
            throw error
        }
        post(runID: runID, label: label, point: point, appName: appName, phase: .settled(succeeded: true))
        return value
    }
}

// MARK: - The drivers a Mac has

/// The three drivers the three tiers sit on, any of which may be absent.
///
/// Absent is a first-class answer rather than a degraded one. A Mac with no
/// browser open has no browser driver for the duration; a build for a platform
/// with no `CGEvent` has no screen driver at all. Both are ordinary, and the
/// suite's job is to make sure neither turns into a tool the model can call.
public struct AutomationDrivers: Sendable {
    public var browser: (any BrowserDriving)?
    public var accessibility: (any AccessibilityDriving)?
    public var screen: (any VisualScreenDriving)?
    /// The floor's hit-tests for screen control. Nil reads no element words,
    /// so only the floor's app rules apply (as for a Code click whose
    /// hit-test came back empty).
    public var screenTargets: (any WorkScreenTargeting)?

    public init(
        browser: (any BrowserDriving)? = nil,
        accessibility: (any AccessibilityDriving)? = nil,
        screen: (any VisualScreenDriving)? = nil,
        screenTargets: (any WorkScreenTargeting)? = nil
    ) {
        self.browser = browser
        self.accessibility = accessibility
        self.screen = screen
        self.screenTargets = screenTargets
    }

    /// Nothing at all. What a platform without these APIs has, and what a test
    /// starts from.
    public static let none = AutomationDrivers()
}

#if os(macOS)
extension AutomationDrivers {
    /// The real ones.
    ///
    /// All three are constructed whatever the switches say, because deciding
    /// which tiers are live is ``AutomationControl/health()``'s job and it does
    /// it against ``AutomationPermission`` and the machine together. Omitting a
    /// driver here as well would be a second place the same decision is made,
    /// and the two would eventually disagree about which one a person had
    /// actually turned off.
    ///
    /// The permission reaches the browser driver because it is the driver, not
    /// the control, that picks *which* browser to send events to — so it is the
    /// driver that has to consult `allowedApps` and `blockedApps`.
    public static func system(permission: AutomationPermission) -> AutomationDrivers {
        AutomationDrivers(
            browser: SystemBrowserDriver(permission: permission),
            accessibility: SystemAccessibilityDriver(),
            screen: SystemScreenDriver(),
            screenTargets: systemScreenTargets
        )
    }

    private static var systemScreenTargets: (any WorkScreenTargeting)? {
        #if canImport(JunoScreenControl)
        SystemWorkScreenTargets()
        #else
        nil
        #endif
    }
}
#endif

// MARK: - The lattice, once the controls exist

/// Holds the controls the lattice is built from, filled after they are built.
///
/// A control holds an ``AutomationGate``; the gate holds the closure that
/// answers "what else could serve this intent"; that answer comes from the
/// controls. Building it in one expression is therefore impossible, and the
/// note on ``AutomationTierOffer`` says so. This is how the knot is untied
/// without restating any control's health in a second place: the closure the
/// gate is given reads *this*, and this is filled in the line after the controls
/// are constructed. Nothing asks it until a run calls a tool, by which time it
/// is populated.
private actor AutomationControlRegistrar {
    private var lattice = AutomationControlLattice(offers: [])

    func adopt(_ controls: [any AutomationControl]) {
        lattice = AutomationControlLattice(
            offers: controls.map { control in
                AutomationTierOffer(
                    tier: control.tier,
                    intents: control.declaredIntents,
                    health: { await control.health() }
                )
            }
        )
    }

    func tiers(serving intent: AutomationIntent) async -> [AutomationTier] {
        await lattice.healthyTiers(serving: intent)
    }
}

// MARK: - The suite

/// Assembles the three controls over whatever drivers this Mac has, and hands
/// back only the ones that could act right now.
///
/// This is the composition root for automation and the only place the three
/// controls are constructed. Before it existed, ``BrowserControl`` and
/// ``VisualControl`` conformed to ``WorkTool``, passed their own tests, and were
/// reachable from no registry at all — the tier lattice had three tiers and two
/// of them could not act on anything, because the only drivers in the module
/// were the scripted doubles.
///
/// Two rules, both enforced here rather than left to callers:
///
/// * **A control with no driver is not built.** Not built unhealthy, not built
///   returning a refusal — not built. There is nothing for a registry to
///   advertise.
/// * **A control whose driver cannot act right now is not registered.** Asked
///   through ``AutomationControl/health()``, which is the same answer the tier
///   lattice routes on, so the set of tools the model is shown and the set of
///   tiers the lattice will allow cannot drift apart.
public enum AutomationSuite {
    /// Every control this Mac could offer, paired with the question that decides
    /// whether it may be advertised.
    public static func offers(
        permission: AutomationPermission,
        stop: EmergencyStop,
        screenshots: ScreenshotPolicy,
        audit: any AutomationAuditing,
        drivers: AutomationDrivers,
        redactor: any ScreenRedacting = CoreGraphicsScreenRedactor(),
        overlay: WorkActionOverlay = .none,
        now: @escaping @Sendable () -> Date = { Date() }
    ) async -> [WorkToolOffer] {
        let registrar = AutomationControlRegistrar()
        let gate = AutomationGate(
            permission: permission,
            stop: stop,
            screenshots: screenshots,
            audit: audit,
            alternatives: { intent in await registrar.tiers(serving: intent) },
            now: now
        )

        var controls: [any AutomationControl & WorkTool] = []
        if let browser = drivers.browser {
            controls.append(BrowserControl(driver: browser, gate: gate))
        }
        if let accessibility = drivers.accessibility {
            controls.append(AccessibilityControl(driver: accessibility, gate: gate, overlay: overlay))
        }
        if let screen = drivers.screen {
            controls.append(VisualControl(
                driver: screen,
                gate: gate,
                redactor: redactor,
                targets: drivers.screenTargets,
                overlay: overlay
            ))
        }
        await registrar.adopt(controls)

        return controls.map { control in
            WorkToolOffer(tool: control, isReady: { await control.health().isHealthy })
        }
    }

    /// The registry a run's automation tools come from.
    ///
    /// Built per run, because both halves of the answer move: the switches are
    /// the person's to change at any moment, and a macOS permission can be
    /// revoked in System Settings between two runs without Juno being told.
    public static func registry(
        permission: AutomationPermission,
        stop: EmergencyStop,
        screenshots: ScreenshotPolicy,
        audit: any AutomationAuditing,
        drivers: AutomationDrivers,
        redactor: any ScreenRedacting = CoreGraphicsScreenRedactor(),
        overlay: WorkActionOverlay = .none,
        now: @escaping @Sendable () -> Date = { Date() }
    ) async -> WorkToolRegistry {
        await WorkToolRegistry.automation(
            offers: await offers(
                permission: permission,
                stop: stop,
                screenshots: screenshots,
                audit: audit,
                drivers: drivers,
                redactor: redactor,
                overlay: overlay,
                now: now
            )
        )
    }

    /// The tools a run may be shown, in name order.
    public static func readyTools(
        permission: AutomationPermission,
        stop: EmergencyStop,
        screenshots: ScreenshotPolicy,
        audit: any AutomationAuditing,
        drivers: AutomationDrivers,
        redactor: any ScreenRedacting = CoreGraphicsScreenRedactor(),
        overlay: WorkActionOverlay = .none,
        now: @escaping @Sendable () -> Date = { Date() }
    ) async -> [any WorkTool] {
        await registry(
            permission: permission,
            stop: stop,
            screenshots: screenshots,
            audit: audit,
            drivers: drivers,
            redactor: redactor,
            overlay: overlay,
            now: now
        ).allTools
    }
}
