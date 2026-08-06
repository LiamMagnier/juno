import Foundation
import JunoWorkCore
import JunoWorkRuntime

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

    public init(
        browser: (any BrowserDriving)? = nil,
        accessibility: (any AccessibilityDriving)? = nil,
        screen: (any VisualScreenDriving)? = nil
    ) {
        self.browser = browser
        self.accessibility = accessibility
        self.screen = screen
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
            screen: SystemScreenDriver()
        )
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
            controls.append(AccessibilityControl(driver: accessibility, gate: gate))
        }
        if let screen = drivers.screen {
            controls.append(VisualControl(driver: screen, gate: gate, redactor: redactor))
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
        now: @escaping @Sendable () -> Date = { Date() }
    ) async -> [any WorkTool] {
        await registry(
            permission: permission,
            stop: stop,
            screenshots: screenshots,
            audit: audit,
            drivers: drivers,
            redactor: redactor,
            now: now
        ).allTools
    }
}
