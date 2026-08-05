import Foundation
import JunoWorkCore
import JunoWorkRuntime

// MARK: - The tier ladder

/// The order automation must try things in, most precise first.
///
/// Raw values and ordering match `WORK_TOOL_TIERS` in `src/lib/work/domain.ts`.
/// The numbers are not advice. Clicking through a page when a scoped connector
/// can perform the exact operation is slower, less reliable, needs far more
/// permission, and puts somebody's inbox into a screenshot; so the lattice below
/// *refuses* the lower tier rather than merely preferring the higher one.
public enum AutomationTier: String, Codable, CaseIterable, Sendable, Comparable {
    case connector
    case structuredFile = "structured_file"
    case browserDOM = "browser_dom"
    case accessibility
    case visual
    case shell

    /// Lower is more precise and therefore more preferred.
    public var rank: Int {
        switch self {
        case .connector: 1
        case .structuredFile: 2
        case .browserDOM: 3
        case .accessibility: 4
        case .visual: 5
        case .shell: 6
        }
    }

    public static func < (lhs: AutomationTier, rhs: AutomationTier) -> Bool {
        lhs.rank < rhs.rank
    }

    /// The phrase a person is shown. Matches the `label` field in `domain.ts`.
    public var label: String {
        switch self {
        case .connector: "Connected app"
        case .structuredFile: "File or document tool"
        case .browserDOM: "Browser"
        case .accessibility: "App accessibility"
        case .visual: "Screen control"
        case .shell: "Shell"
        }
    }
}

/// Whether a tier may be used given everything else that could serve the same
/// intent.
///
/// Mirrors `permitsTier` in `src/lib/work/domain.ts`, including the detail that
/// makes it a refusal rather than a preference: `candidates` is every tier that
/// *declared* it can perform this intent and is healthy, and a chosen tier
/// coarser than the best candidate is denied outright.
public enum AutomationTierLattice {
    public static func permits(chosen: AutomationTier, candidates: [AutomationTier]) -> Bool {
        guard let best = candidates.map(\.rank).min() else {
            // Nothing declared it, including the chosen tier. A tier that did
            // not declare an intent has not been reviewed for it, and "not
            // considered" reads as no everywhere else in this file too.
            return false
        }
        return chosen.rank <= best
    }
}

// MARK: - What automation is being asked to do

/// One thing automation can be asked to perform, named for the person's request
/// rather than for the gesture that implements it.
///
/// A click is not an intent. "Activate the control the model named" and "buy
/// this" are the same click and are not the same decision, and a vocabulary that
/// only knows about clicks cannot tell the approval gate which one happened.
public enum AutomationIntent: String, Codable, CaseIterable, Sendable {
    case inspect
    case navigate
    case enterText = "enter_text"
    case activateControl = "activate_control"
    case captureScreen = "capture_screen"
    case sendMessage = "send_message"
    case publish
    case purchase
    case deleteItem = "delete_item"
    case changeAccountSetting = "change_account_setting"
    /// Deliberately declared by **no** control in this module.
    ///
    /// It exists so that a request to turn off a firewall, disable a lock or
    /// edit a keychain is named and refused, rather than arriving spelled as
    /// ``activateControl`` and being gated as an ordinary click. The lattice
    /// refuses an intent nothing declares, so this case is a permanent no with a
    /// reason a person can read.
    case changeSecuritySetting = "change_security_setting"

    /// The irreversible action this intent performs on a given tier, if any.
    ///
    /// Named from ``WorkIrreversibleAction`` rather than guessed, for the reason
    /// that type gives: a rule that looks for "delete" in a name decides
    /// `delete_draft` is a permanent delete and `send_to_trash` is a send.
    ///
    /// A purchase made in a browser and a purchase made by driving an app are
    /// different rows in the audit and the same catastrophe, which is why the
    /// tier is a parameter rather than a guess.
    public func irreversibleAction(inTier tier: AutomationTier) -> WorkIrreversibleAction? {
        switch self {
        case .inspect, .navigate, .enterText, .activateControl, .captureScreen:
            return nil
        case .sendMessage:
            return .connectorSendMessage
        case .publish:
            return .connectorPublish
        case .purchase:
            return tier == .browserDOM ? .browserPurchase : .appPurchase
        case .deleteItem:
            return .connectorDelete
        case .changeAccountSetting:
            return .changeAccountSetting
        case .changeSecuritySetting:
            return .changeSecuritySetting
        }
    }

    /// The risk of the intent before the approval gate sees it.
    ///
    /// Anything with an irreversible action is `.irreversible` by construction
    /// rather than by a second table that could disagree with the first.
    public func risk(inTier tier: AutomationTier) -> WorkRiskLevel {
        guard irreversibleAction(inTier: tier) == nil else { return .irreversible }
        switch self {
        case .inspect, .captureScreen:
            return .safe
        case .enterText:
            return .edit
        case .navigate, .activateControl:
            // A navigation and a click both reach a server that may act on them.
            // `command` says "bounded, but it did something", which is the
            // honest description of pressing a button somebody else wrote.
            return .command
        case .sendMessage, .publish, .purchase, .deleteItem,
             .changeAccountSetting, .changeSecuritySetting:
            return .irreversible
        }
    }

    /// Whether performing this intent requires a receipt from
    /// ``WorkApprovalCoordinator``, not merely a policy that happens to allow it.
    public func requiresApprovalReceipt(inTier tier: AutomationTier) -> Bool {
        irreversibleAction(inTier: tier) != nil
    }
}

// MARK: - Who the action is aimed at

/// The party an automated action is aimed at.
///
/// Identifiers only, and deliberately no free-text field: this value is written
/// to the audit and rendered on a phone, so a case carrying "the text that was
/// on screen" would put page content into both.
public enum AutomationSubject: Hashable, Codable, Sendable {
    case app(bundleIdentifier: String)
    case domain(host: String)
    /// A whole display, used when describing a capture that no single app owns.
    ///
    /// **The gate refuses it.** A display is not a party that can be allowed or
    /// blocked — the apps visible on it are — so an action aimed at "the screen"
    /// is an action whose real target was never named.
    case screen(displayIndex: Int)

    /// The identifier written to the audit row.
    public var auditIdentifier: String {
        switch self {
        case .app(let bundleIdentifier): "app:\(bundleIdentifier)"
        case .domain(let host): "domain:\(host)"
        case .screen(let index): "screen:\(index)"
        }
    }
}

// MARK: - Refusals

/// A category of application or site that is never driven automatically,
/// whatever the allowlist says.
///
/// These are the places where an automated mistake is not recoverable by undo:
/// money, health records, identity documents, and the credential stores that
/// protect everything else. A person can still do any of this themselves; what
/// they cannot do is delegate it to an agent by ticking a box they did not read.
public enum AutomationRestrictedCategory: String, Codable, CaseIterable, Sendable {
    case banking
    case investment
    case healthcare
    case passwordManager = "password_manager"
    case governmentIdentity = "government_identity"
    case securityTool = "security_tool"

    /// The clause that appears in the refusal a person reads.
    public var phrase: String {
        switch self {
        case .banking: "banking"
        case .investment: "investments"
        case .healthcare: "health records"
        case .passwordManager: "saved passwords"
        case .governmentIdentity: "government identity"
        case .securityTool: "security settings"
        }
    }
}

/// Why automation refused, in a form the audit can compare and a person can
/// read.
///
/// The `code` is what is written to the audit and what tests assert on; the
/// `message` is what appears on screen. They are separate fields because a
/// refusal reason that only exists as an English sentence cannot be counted, and
/// a refusal that only exists as a code cannot be explained.
public struct AutomationRefusal: Error, Hashable, Sendable {
    public enum Code: String, Codable, CaseIterable, Sendable {
        case automationDisabled = "automation_disabled"
        case tierDisabled = "tier_disabled"
        case appBlocked = "app_blocked"
        case domainBlocked = "domain_blocked"
        case restrictedCategory = "restricted_category"
        case notConsidered = "not_considered"
        case malformedIdentifier = "malformed_identifier"
        case emergencyStopped = "emergency_stopped"
        case higherTierAvailable = "higher_tier_available"
        case intentNotServed = "intent_not_served"
        case screenshotNotPermitted = "screenshot_not_permitted"
        case screenshotExpired = "screenshot_expired"
        case approvalMissing = "approval_missing"
        case approvalStale = "approval_stale"
        case sensitiveSurface = "sensitive_surface"
        case outOfBounds = "out_of_bounds"
        case tooFast = "too_fast"
        case focusMoved = "focus_moved"
        case driverUnavailable = "driver_unavailable"
    }

    public let code: Code
    /// Written for the person watching, never for a log line, and never
    /// containing anything read from a page or typed into one.
    public let message: String
    public let category: AutomationRestrictedCategory?

    public init(_ code: Code, _ message: String, category: AutomationRestrictedCategory? = nil) {
        self.code = code
        self.message = message
        self.category = category
    }
}

public enum AutomationDecision: Hashable, Sendable {
    case allowed
    case refused(AutomationRefusal)

    public var isAllowed: Bool {
        if case .allowed = self { return true }
        return false
    }

    public var refusal: AutomationRefusal? {
        if case .refused(let refusal) = self { return refusal }
        return nil
    }
}

// MARK: - The gate's policy value

/// What this Mac will let automation drive, and the one direction that answer
/// can move.
///
/// ## These rules are mirrored, on purpose
///
/// `permits(app:)`, `permits(domain:)`, the host normalisation and the
/// restricted categories all exist already, in
/// `JunoNativeKit/Sources/JunoWorkKit/WorkHostPolicy.swift`. They are restated
/// here rather than imported because **JunoWork must not depend on
/// JunoNativeKit**: that package carries a relay client and a UI framework, and
/// an edge from the layer that drives somebody's screen to the layer that talks
/// to the network is exactly the edge the package split exists to forbid. This
/// is the same trade `runner/agent-core/src/work/budget.ts` makes when it
/// mirrors the budget rules from `src/lib/work/domain.ts`.
///
/// The cost of mirroring is drift, so the shape is kept deliberately identical:
/// block first, then the allowlist, then a default of refusal; leading-dot
/// domain rules; the same restricted bundle identifiers. If a rule is added
/// there and not here, this Mac drives something the host policy would have
/// refused — so a change to either file is a change to both.
///
/// One deliberate divergence, called out rather than hidden: identifiers are
/// compared case-folded here. `WorkHostPolicy` compares bundle identifiers
/// literally, which means `COM.APPLE.Terminal` walks past a blocklist entry of
/// `com.apple.Terminal`. macOS treats bundle identifiers case-insensitively, so
/// the literal comparison is the bug and this is the fix.
public struct AutomationPermission: Hashable, Sendable {
    /// The master switch. Off means nothing is driven at all, whatever else is
    /// true.
    public var automationEnabled: Bool
    public var allowsBrowserControl: Bool
    public var allowsAccessibilityControl: Bool
    public var allowsVisualControl: Bool
    /// Bundle identifiers the person allowed. Empty means none — deliberately
    /// not "all", because an empty allowlist read as permissive is how a feature
    /// ships switched on for everybody who never opened settings.
    public var allowedApps: Set<String>
    /// Bundle identifiers refused regardless of the allowlist. A block always
    /// beats an allow, so a later widening of `allowedApps` cannot re-admit
    /// something the person explicitly refused.
    public var blockedApps: Set<String>
    public var allowedDomains: Set<String>
    public var blockedDomains: Set<String>

    public init(
        automationEnabled: Bool = false,
        allowsBrowserControl: Bool = false,
        allowsAccessibilityControl: Bool = false,
        allowsVisualControl: Bool = false,
        allowedApps: Set<String> = [],
        blockedApps: Set<String> = [],
        allowedDomains: Set<String> = [],
        blockedDomains: Set<String> = []
    ) {
        self.automationEnabled = automationEnabled
        self.allowsBrowserControl = allowsBrowserControl
        self.allowsAccessibilityControl = allowsAccessibilityControl
        self.allowsVisualControl = allowsVisualControl
        self.allowedApps = allowedApps
        self.blockedApps = blockedApps
        self.allowedDomains = allowedDomains
        self.blockedDomains = blockedDomains
    }

    /// Everything off. The state a Mac starts from, and the value the meet
    /// collapses to as soon as any layer says no.
    public static let denied = AutomationPermission()

    /// The strictest of two permissions, field by field.
    ///
    /// Note the asymmetry that makes this safe: permissions AND, denials OR.
    /// `blockedApps` and `blockedDomains` union so a block added by any layer
    /// survives; the allowlists intersect so an allow needs every layer's
    /// agreement. A single `union` in the wrong place here would let a skill add
    /// a site the person never approved.
    public func narrowed(by other: AutomationPermission) -> AutomationPermission {
        AutomationPermission(
            automationEnabled: automationEnabled && other.automationEnabled,
            allowsBrowserControl: allowsBrowserControl && other.allowsBrowserControl,
            allowsAccessibilityControl: allowsAccessibilityControl
                && other.allowsAccessibilityControl,
            allowsVisualControl: allowsVisualControl && other.allowsVisualControl,
            allowedApps: allowedApps.intersection(other.allowedApps),
            blockedApps: blockedApps.union(other.blockedApps),
            allowedDomains: allowedDomains.intersection(other.allowedDomains),
            blockedDomains: blockedDomains.union(other.blockedDomains)
        )
    }

    public static func narrowest(_ permissions: [AutomationPermission]) -> AutomationPermission {
        guard var result = permissions.first else { return .denied }
        for permission in permissions.dropFirst() { result = result.narrowed(by: permission) }
        return result
    }

    // MARK: Tiers

    /// Whether a tier may run at all on this Mac.
    ///
    /// The three tiers this module implements have their own switch. The other
    /// three are refused, not because a connector is dangerous but because this
    /// gate does not govern them: a connector call is authorised by its own
    /// scope, and a gate that answered "allowed" for something it cannot see
    /// would be answering a question it was not asked.
    public func permits(tier: AutomationTier) -> AutomationDecision {
        guard automationEnabled else {
            return .refused(
                AutomationRefusal(
                    .automationDisabled,
                    "Juno is not allowed to control anything on this Mac."
                )
            )
        }
        let enabled: Bool
        switch tier {
        case .browserDOM: enabled = allowsBrowserControl
        case .accessibility: enabled = allowsAccessibilityControl
        case .visual: enabled = allowsVisualControl
        case .connector, .structuredFile, .shell: enabled = false
        }
        guard enabled else {
            return .refused(
                AutomationRefusal(
                    .tierDisabled,
                    "\(tier.label) is switched off for Juno on this Mac."
                )
            )
        }
        return .allowed
    }

    // MARK: Apps

    /// Whether an app may be driven.
    ///
    /// Block first, then the restricted categories, then the allowlist, then a
    /// default of refusal. The default matters: a bundle identifier nobody has
    /// considered is one the person has not thought about, and the safe reading
    /// of "not considered" is no.
    public func permits(app bundleIdentifier: String) -> AutomationDecision {
        guard automationEnabled else {
            return .refused(
                AutomationRefusal(
                    .automationDisabled,
                    "Juno is not allowed to control anything on this Mac."
                )
            )
        }
        let target = Self.normalizeIdentifier(bundleIdentifier)
        guard !target.isEmpty else {
            return .refused(
                AutomationRefusal(.malformedIdentifier, "Juno could not tell which app that was.")
            )
        }
        if Self.normalized(blockedApps).contains(target) {
            return .refused(
                AutomationRefusal(.appBlocked, "You told Juno never to control that app.")
            )
        }
        if let category = Self.restrictedCategory(forApp: target) {
            return .refused(
                AutomationRefusal(
                    .restrictedCategory,
                    "Juno never drives anything to do with \(category.phrase), even when it is on the allowed list.",
                    category: category
                )
            )
        }
        guard Self.normalized(allowedApps).contains(target) else {
            return .refused(
                AutomationRefusal(
                    .notConsidered,
                    "You have not allowed Juno to control that app."
                )
            )
        }
        return .allowed
    }

    // MARK: Domains

    /// Whether a domain may be driven in the browser.
    ///
    /// A leading dot means "this domain and anything under it", matching the
    /// runner's egress allowlist. The distinction is load-bearing: a plain
    /// suffix test would match `notexample.com` against `example.com`, which is
    /// a different party entirely, and buying one domain that ends in another is
    /// the cheapest attack there is.
    public func permits(domain host: String) -> AutomationDecision {
        guard automationEnabled else {
            return .refused(
                AutomationRefusal(
                    .automationDisabled,
                    "Juno is not allowed to control anything on this Mac."
                )
            )
        }
        let target = Self.normalizeHost(host)
        guard !target.isEmpty else {
            return .refused(
                AutomationRefusal(.malformedIdentifier, "Juno could not tell which site that was.")
            )
        }
        if Self.matches(host: target, anyOf: blockedDomains) {
            return .refused(
                AutomationRefusal(.domainBlocked, "You told Juno never to use that site.")
            )
        }
        if let category = Self.restrictedCategory(forHost: target) {
            return .refused(
                AutomationRefusal(
                    .restrictedCategory,
                    "Juno never drives anything to do with \(category.phrase), even when it is on the allowed list.",
                    category: category
                )
            )
        }
        guard Self.matches(host: target, anyOf: allowedDomains) else {
            return .refused(
                AutomationRefusal(.notConsidered, "You have not allowed Juno to use that site.")
            )
        }
        return .allowed
    }

    /// Whether one already-normalised host is covered by a rule set.
    static func matches(host target: String, anyOf rules: Set<String>) -> Bool {
        rules.contains { entry in
            let rule = normalizeHost(entry)
            guard !rule.isEmpty else { return false }
            if rule.hasPrefix(".") {
                let base = String(rule.dropFirst())
                guard !base.isEmpty else { return false }
                return target == base || target.hasSuffix("." + base)
            }
            return target == rule
        }
    }

    /// Lowercased, trailing dots removed.
    ///
    /// The trailing dot matters: `evil.com.` and `evil.com` resolve
    /// identically, so a policy comparing them as plain strings admits the first
    /// through a list containing the second. A leading dot is kept, because that
    /// is the rule marker.
    static func normalizeHost(_ host: String) -> String {
        var value = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while value.hasSuffix(".") { value.removeLast() }
        return value
    }

    static func normalizeIdentifier(_ identifier: String) -> String {
        identifier.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func normalized(_ identifiers: Set<String>) -> Set<String> {
        Set(identifiers.map(normalizeIdentifier).filter { !$0.isEmpty })
    }

    // MARK: The refused-anyway lists

    public static func restrictedCategory(forApp bundleIdentifier: String) -> AutomationRestrictedCategory? {
        restrictedApps[normalizeIdentifier(bundleIdentifier)]
    }

    public static func restrictedCategory(forHost host: String) -> AutomationRestrictedCategory? {
        let target = normalizeHost(host)
        guard !target.isEmpty else { return nil }
        for (rule, category) in restrictedDomains where matches(host: target, anyOf: [rule]) {
            return category
        }
        return nil
    }

    /// Applications never driven automatically, whatever the allowlist says.
    ///
    /// Mirrored from `WorkHostPolicy.restrictedCategories`, with each entry now
    /// carrying the category it belongs to so a refusal can say which promise it
    /// is keeping instead of "that app is on a list".
    public static let restrictedApps: [String: AutomationRestrictedCategory] = [
        "com.apple.keychainaccess": .passwordManager,
        "com.apple.passwords": .passwordManager,
        "com.agilebits.onepassword7": .passwordManager,
        "com.agilebits.onepassword8": .passwordManager,
        "com.1password.1password": .passwordManager,
        "com.lastpass.lastpass": .passwordManager,
        "com.bitwarden.desktop": .passwordManager,
        "com.dashlane.dashlane": .passwordManager,
        "com.intuit.quickbooks": .banking,
        "com.apple.home": .securityTool,
        "com.apple.health": .healthcare,
        "com.apple.systempreferences": .securityTool,
        "com.apple.systemprofiler": .securityTool,
        "com.apple.terminal": .securityTool,
        "com.apple.securityagent": .securityTool,
    ]

    /// Sites never driven automatically, whatever the allowlist says.
    ///
    /// **This list is a floor, not a census.** There is no enumeration of the
    /// world's banks, and a design that depended on one would fail the first
    /// time somebody used a credit union. What actually contains this is the
    /// default-deny allowlist above: a site nobody allowed is refused whether or
    /// not it appears here. These entries exist for the case the allowlist
    /// cannot cover — somebody adding `.google.com` and thereby, without meaning
    /// to, adding Google Pay.
    public static let restrictedDomains: [String: AutomationRestrictedCategory] = [
        ".pay.google.com": .banking,
        ".wallet.google.com": .banking,
        ".paypal.com": .banking,
        ".stripe.com": .banking,
        ".wise.com": .banking,
        ".revolut.com": .banking,
        ".coinbase.com": .investment,
        ".robinhood.com": .investment,
        ".fidelity.com": .investment,
        ".schwab.com": .investment,
        ".vanguard.com": .investment,
        ".myhealth.va.gov": .healthcare,
        ".mychart.com": .healthcare,
        ".1password.com": .passwordManager,
        ".lastpass.com": .passwordManager,
        ".bitwarden.com": .passwordManager,
        ".login.gov": .governmentIdentity,
        ".id.me": .governmentIdentity,
        ".gov.uk": .governmentIdentity,
        ".irs.gov": .governmentIdentity,
        ".ssa.gov": .governmentIdentity,
        ".accounts.google.com": .securityTool,
        ".appleid.apple.com": .securityTool,
    ]
}

// MARK: - What a control is

public enum AutomationControlHealth: Hashable, Sendable {
    case healthy
    /// The reason names a subsystem, never a page or a document.
    case unavailable(reason: String)

    public var isHealthy: Bool {
        if case .healthy = self { return true }
        return false
    }
}

/// One way of driving something on this Mac.
///
/// The three conformances are the three tiers, and every one of them passes
/// ``AutomationGate`` before it acts. ``declaredIntents`` is what makes the
/// lattice possible: a control that has not declared an intent is not a
/// candidate for it, so a coarser tier cannot be refused on behalf of a finer
/// one that never claimed it could help.
public protocol AutomationControl: Sendable {
    var tier: AutomationTier { get }
    var declaredIntents: Set<AutomationIntent> { get }
    /// Whether this control could act right now. Asked rather than assumed: a
    /// browser that is not running is not a reason to refuse screen control.
    func health() async -> AutomationControlHealth
}

/// One tier's claim about what it can serve and whether it could serve it now.
///
/// Separate from ``AutomationControl`` so a lattice can be built *before* the
/// controls are. The controls hold an ``AutomationGate``, the gate holds the
/// alternatives closure, and the closure is what the lattice provides — a
/// lattice built out of the controls themselves would be a value that has to
/// exist before it can be constructed.
public struct AutomationTierOffer: Sendable {
    public let tier: AutomationTier
    public let intents: Set<AutomationIntent>
    public let health: @Sendable () async -> AutomationControlHealth

    public init(
        tier: AutomationTier,
        intents: Set<AutomationIntent>,
        health: @escaping @Sendable () async -> AutomationControlHealth
    ) {
        self.tier = tier
        self.intents = intents
        self.health = health
    }
}

/// The tier ordering, applied to a concrete set of offers.
public struct AutomationControlLattice: Sendable {
    private let offers: [AutomationTierOffer]

    public init(offers: [AutomationTierOffer]) {
        self.offers = offers.sorted { $0.tier < $1.tier }
    }

    /// The tiers that both declare the intent and could act right now.
    ///
    /// Health is part of the answer rather than a separate retry, because the
    /// alternative reads badly to whoever is watching: refusing screen control
    /// on the grounds that the browser could have done it, when the browser is
    /// not running, is a refusal with no remedy.
    public func healthyTiers(serving intent: AutomationIntent) async -> [AutomationTier] {
        var tiers: [AutomationTier] = []
        for offer in offers where offer.intents.contains(intent) {
            if await offer.health().isHealthy { tiers.append(offer.tier) }
        }
        return tiers
    }

    public func ruling(
        choosing tier: AutomationTier,
        for intent: AutomationIntent
    ) async -> AutomationDecision {
        let candidates = await healthyTiers(serving: intent)
        guard candidates.contains(tier) else {
            return .refused(
                AutomationRefusal(
                    .intentNotServed,
                    "Juno has no working way to do that on this Mac."
                )
            )
        }
        guard AutomationTierLattice.permits(chosen: tier, candidates: candidates) else {
            let best = candidates.min() ?? tier
            return .refused(
                AutomationRefusal(
                    .higherTierAvailable,
                    "Juno used \(best.label) for that instead of \(tier.label)."
                )
            )
        }
        return .allowed
    }

    /// The closure an ``AutomationGate`` consults before admitting an action.
    public var alternatives: @Sendable (AutomationIntent) async -> [AutomationTier] {
        { intent in await healthyTiers(serving: intent) }
    }
}

// MARK: - The gate

/// The gate every one of the three controls passes, in the same order, before
/// it touches anything.
///
/// Nothing here is advisory. ``admit(runID:tier:intent:subject:)`` either
/// returns a token from ``EmergencyStop`` — proof that automation was running
/// and this action was the one it was running for — or throws, having already
/// written the refusal to the audit. A control that skipped it would have no
/// token, and every checkpoint takes one.
public struct AutomationGate: Sendable {
    public let permission: AutomationPermission
    public let stop: EmergencyStop
    public let screenshots: ScreenshotPolicy
    public let audit: any AutomationAuditing
    /// Tiers that could serve an intent instead. Injected as a closure rather
    /// than a lattice value for the construction-order reason spelled out on
    /// ``AutomationTierOffer``.
    public let alternatives: @Sendable (AutomationIntent) async -> [AutomationTier]
    public let now: @Sendable () -> Date

    public init(
        permission: AutomationPermission,
        stop: EmergencyStop,
        screenshots: ScreenshotPolicy,
        audit: any AutomationAuditing,
        alternatives: @escaping @Sendable (AutomationIntent) async -> [AutomationTier] = { _ in [] },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.permission = permission
        self.stop = stop
        self.screenshots = screenshots
        self.audit = audit
        self.alternatives = alternatives
        self.now = now
    }

    /// Runs the whole gate for one action and starts the visible active-use
    /// state.
    ///
    /// The order is the point. Permission before the lattice, because a refused
    /// app should not produce a message about which tier would have been better;
    /// the lattice before the stop, because arming the active-use indicator for
    /// an action that is about to be refused makes the indicator mean nothing;
    /// the stop last, so the token a control holds is only ever a token for work
    /// that was allowed.
    /// - Parameter declaredIntents: what the calling control said it can serve.
    ///   Checked again here even though ``AutomationRequest/precheck(_:tier:declaredIntents:)``
    ///   already did, because a caller that reached `execute` directly has
    ///   skipped the precheck and must not thereby acquire an intent nobody
    ///   declared.
    public func admit(
        runID: String,
        tier: AutomationTier,
        intent: AutomationIntent,
        subject: AutomationSubject,
        declaredIntents: Set<AutomationIntent>
    ) async throws -> AutomationRunToken {
        await audit.record(
            AutomationAuditEntry(
                at: now(),
                kind: .commandClaimed,
                severity: .info,
                runID: runID,
                tier: tier,
                intent: intent,
                subject: subject,
                verdict: .attempted
            )
        )

        guard declaredIntents.contains(intent) else {
            let refusal = AutomationRefusal(
                .intentNotServed,
                "Juno will not do that with \(tier.label.lowercased()) on this Mac."
            )
            throw await refuse(refusal, runID: runID, tier: tier, intent: intent, subject: subject)
        }
        if let refusal = permission.permits(tier: tier).refusal {
            throw await refuse(refusal, runID: runID, tier: tier, intent: intent, subject: subject)
        }
        if let refusal = subjectRuling(subject).refusal {
            throw await refuse(refusal, runID: runID, tier: tier, intent: intent, subject: subject)
        }

        var candidates = await alternatives(intent)
        if !candidates.contains(tier) { candidates.append(tier) }
        guard AutomationTierLattice.permits(chosen: tier, candidates: candidates) else {
            let best = candidates.min() ?? tier
            let refusal = AutomationRefusal(
                .higherTierAvailable,
                "Juno can do that with \(best.label), which needs far less access than \(tier.label)."
            )
            throw await refuse(
                refusal,
                runID: runID,
                tier: tier,
                intent: intent,
                subject: subject,
                kind: .tierDowngradeRefused
            )
        }

        do {
            return try await stop.begin(
                runID: runID,
                activity: AutomationActivity(tier: tier, intent: intent, subject: subject)
            )
        } catch let error as AutomationRefusal {
            throw await refuse(error, runID: runID, tier: tier, intent: intent, subject: subject)
        }
    }

    /// The stop check that runs before every action and again after every await.
    ///
    /// Throws rather than returning a Bool. A checkpoint whose result can be
    /// ignored is a checkpoint somebody eventually ignores, and the thing being
    /// ignored is a person holding down the key that means stop.
    ///
    /// The token carries the activity, so a control does not restate what it is
    /// doing at every suspension point. A checkpoint that took three arguments
    /// is a checkpoint that gets left out of the awkward branch.
    public func checkpoint(_ token: AutomationRunToken) async throws {
        do {
            try await stop.checkpoint(token)
        } catch let refusal as AutomationRefusal {
            throw await refuse(
                refusal,
                runID: token.runID,
                tier: token.activity.tier,
                intent: token.activity.intent,
                subject: token.activity.subject
            )
        }
    }

    /// Ends the action, clears the active-use indicator, and writes the verdict.
    public func finish(_ token: AutomationRunToken, characterCount: Int? = nil) async {
        await stop.end(token)
        await audit.record(
            AutomationAuditEntry(
                at: now(),
                kind: .commandClaimed,
                severity: .info,
                runID: token.runID,
                tier: token.activity.tier,
                intent: token.activity.intent,
                subject: token.activity.subject,
                verdict: .allowed,
                characterCount: characterCount
            )
        )
    }

    /// Refuses an action that already holds a token, and releases it.
    ///
    /// A control that refuses halfway through must not leave the active-use
    /// indicator lit: to whoever is watching, an indicator that stays on after
    /// automation gave up is indistinguishable from automation still running.
    public func refuse(
        _ refusal: AutomationRefusal,
        holding token: AutomationRunToken,
        kind: AutomationAuditKind = .commandRefused
    ) async -> WorkToolError {
        await stop.end(token)
        return await refuse(
            refusal,
            runID: token.runID,
            tier: token.activity.tier,
            intent: token.activity.intent,
            subject: token.activity.subject,
            kind: kind
        )
    }

    /// Records a refusal and returns the error the tool throws.
    ///
    /// Returns rather than throws so a caller writes `throw await refuse(...)`,
    /// which keeps the refusal and the record inseparable at the call site: it
    /// is not possible to throw the one without writing the other.
    @discardableResult
    public func refuse(
        _ refusal: AutomationRefusal,
        runID: String,
        tier: AutomationTier,
        intent: AutomationIntent,
        subject: AutomationSubject,
        kind: AutomationAuditKind = .commandRefused
    ) async -> WorkToolError {
        await audit.record(
            AutomationAuditEntry(
                at: now(),
                kind: kind,
                severity: .refusal,
                runID: runID,
                tier: tier,
                intent: intent,
                subject: subject,
                verdict: .refused,
                refusalCode: refusal.code,
                restrictedCategory: refusal.category
            )
        )
        return WorkToolError.denied(reason: refusal.message)
    }

    private func subjectRuling(_ subject: AutomationSubject) -> AutomationDecision {
        switch subject {
        case .app(let bundleIdentifier):
            return permission.permits(app: bundleIdentifier)
        case .domain(let host):
            return permission.permits(domain: host)
        case .screen:
            return .refused(
                AutomationRefusal(
                    .notConsidered,
                    "Juno will not act on a whole screen without knowing which app is in front."
                )
            )
        }
    }
}

// MARK: - The arguments the three tools share

/// One parsed automation request.
///
/// The three tools take the same arguments because they answer the same
/// question at different levels of precision, and a model that has to remember
/// three argument shapes gets one of them wrong on the tier with the least
/// containment.
public struct AutomationRequest: Hashable, Sendable {
    public let intent: AutomationIntent
    /// A domain for the browser, a bundle identifier for the other two.
    public let target: String
    /// The control being acted on, in whatever identity scheme the tier uses.
    public let element: String?
    /// Text to enter. Never written to the audit; see ``AutomationAuditEntry``.
    public let text: String?
    public let x: Int?
    public let y: Int?

    public static let schema = WorkToolSchema([
        .init("intent", .string, "What to do, from Juno's automation vocabulary.", required: true),
        .init("target", .string, "The site's domain, or the app's bundle identifier.", required: true),
        .init("element", .string, "The control to act on, as returned by an earlier inspect."),
        .init("text", .string, "Text to enter."),
        .init("x", .integer, "Horizontal position in screen points, for screen control only."),
        .init("y", .integer, "Vertical position in screen points, for screen control only."),
    ])

    /// Parses arguments that have already passed ``schema``.
    ///
    /// The unknown-intent case is a refusal rather than a default, for the same
    /// reason ``WorkToolSchema`` refuses an argument it does not know: quietly
    /// doing the nearest known thing is how somebody ends up approving a summary
    /// of a call that did not happen.
    public static func parse(_ input: WorkToolValue) -> Result<AutomationRequest, WorkToolError> {
        guard let rawIntent = input["intent"]?.stringValue,
            let intent = AutomationIntent(rawValue: rawIntent)
        else {
            let known = AutomationIntent.allCases.map(\.rawValue).sorted().joined(separator: ", ")
            return .failure(
                .invalidInput(message: "Juno does not have that intent. It knows: \(known).")
            )
        }
        guard let target = input["target"]?.stringValue,
            !target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return .failure(.invalidInput(message: "Missing required argument 'target'."))
        }
        return .success(
            AutomationRequest(
                intent: intent,
                target: target,
                element: input["element"]?.stringValue,
                text: input["text"]?.stringValue,
                x: input["x"]?.intValue,
                y: input["y"]?.intValue
            )
        )
    }

    /// The refusal that applies before any authorization, so these arguments
    /// cannot even be offered for approval.
    ///
    /// - Parameter declaredIntents: what this control said it can serve. An
    ///   intent it never declared is refused *here*, ahead of the approval gate,
    ///   and the ordering is the point: an intent nothing will ever perform must
    ///   not produce a sheet a person can tap Allow on. Being asked to approve
    ///   something that was always going to be refused teaches people that the
    ///   sheet does not mean anything.
    public static func precheck(
        _ input: WorkToolValue,
        tier: AutomationTier,
        declaredIntents: Set<AutomationIntent>
    ) -> WorkToolError? {
        let request: AutomationRequest
        switch parse(input) {
        case .failure(let error): return error
        case .success(let parsed): request = parsed
        }
        guard declaredIntents.contains(request.intent) else {
            return .denied(
                reason: "Juno will not do that with \(tier.label.lowercased()) on this Mac."
            )
        }
        if request.intent == .enterText {
            guard let text = request.text, !text.isEmpty else {
                return .invalidInput(message: "Entering text needs a 'text' argument.")
            }
            // A credential-shaped value is refused before anybody is asked about
            // it. The reason is the ordering: an approval sheet quoting the
            // string would put the secret on a phone screen, and approving it
            // would type a card number into a page nobody checked.
            let found = SensitiveSurfaceDetector.scan(text)
            if let first = found.first {
                return .denied(
                    reason: "That looks like \(first.kind.phrase), and Juno does not type those for you."
                )
            }
        }
        if request.intent == .activateControl || request.intent == .enterText,
            tier != .visual, (request.element ?? "").isEmpty
        {
            return .invalidInput(message: "That needs an 'element' from an earlier inspect.")
        }
        if tier == .visual, request.intent == .activateControl,
            request.x == nil || request.y == nil
        {
            return .invalidInput(message: "Screen control needs 'x' and 'y' in screen points.")
        }
        return nil
    }

    /// The subject this request names on a given tier.
    public func subject(for tier: AutomationTier) -> AutomationSubject {
        switch tier {
        case .browserDOM:
            return .domain(host: target)
        case .accessibility, .visual, .connector, .structuredFile, .shell:
            return .app(bundleIdentifier: target)
        }
    }

    /// The sentence stored with the approval and rendered on a phone.
    ///
    /// The text being entered is **not** in it, only its length. The summary is
    /// kept with the approval row and replayed to a lock screen, for the same
    /// reason ``WorkToolResult`` keeps locations out of its detail: a value that
    /// reaches a lock screen is a value anybody standing nearby has read.
    public func summary(tier: AutomationTier) -> String {
        let where_ = subject(for: tier).auditIdentifier
        switch intent {
        case .inspect: return "Look at \(where_) using \(tier.label.lowercased())."
        case .captureScreen: return "Take a picture of \(where_)."
        case .navigate: return "Open a page on \(where_)."
        case .enterText:
            return "Type \(text?.count ?? 0) characters into a field on \(where_)."
        case .activateControl: return "Press a control on \(where_)."
        case .sendMessage: return "Send a message from \(where_). Juno cannot take this back."
        case .publish: return "Publish something on \(where_). Juno cannot take this back."
        case .purchase: return "Buy something on \(where_). Juno cannot take this back."
        case .deleteItem: return "Delete something on \(where_). Juno cannot take this back."
        case .changeAccountSetting:
            return "Change an account setting on \(where_). Juno cannot take this back."
        case .changeSecuritySetting:
            return "Change a security setting on \(where_). Juno cannot take this back."
        }
    }
}
