import Foundation

/// How much Juno may do in one app.
public enum AppTier: String, CaseIterable, Hashable, Codable, Sendable, Comparable {
    /// See it: screenshots, zoom, the accessibility tree.
    case view
    /// See it and click or scroll, with no keys.
    case click
    /// Everything screen control can do.
    case full

    private var rank: Int {
        switch self {
        case .view: 0
        case .click: 1
        case .full: 2
        }
    }

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rank < rhs.rank }

    public func allows(_ actionClass: ScreenActionClass) -> Bool {
        switch (self, actionClass) {
        case (.full, _): true
        case (.click, .view), (.click, .click): true
        case (.view, .view): true
        default: false
        }
    }

    /// "full control", "clicks only", "view only", for the sheet and refusals.
    public var phrase: String {
        switch self {
        case .view: "view only"
        case .click: "clicks only"
        case .full: "full control"
        }
    }
}

/// One app the reader let Juno use.
public struct AppGrant: Hashable, Codable, Sendable, Identifiable {
    public enum Scope: Hashable, Codable, Sendable {
        /// For one session. The only scope this pass grants (D-021).
        case session(String)
        /// From user settings only, never a project file. Not offered in this
        /// pass (D-021); kept so a stored value has somewhere to decode.
        case always
    }

    public var id: String { bundleID }
    public var bundleID: String
    public var displayName: String
    /// min(category cap, what the reader allowed).
    public var tier: AppTier
    public var scope: Scope
    public var clipboardRead: Bool
    public var clipboardWrite: Bool
    public var grantedAt: Date
    public var lastUsedAt: Date

    public init(
        bundleID: String,
        displayName: String,
        tier: AppTier,
        scope: Scope,
        clipboardRead: Bool = false,
        clipboardWrite: Bool = false,
        grantedAt: Date,
        lastUsedAt: Date? = nil
    ) {
        self.bundleID = bundleID
        self.displayName = displayName
        self.tier = tier
        self.scope = scope
        self.clipboardRead = clipboardRead
        self.clipboardWrite = clipboardWrite
        self.grantedAt = grantedAt
        self.lastUsedAt = lastUsedAt ?? grantedAt
    }
}

/// The reader's standing choices in Settings → Screen control → Apps.
///
/// They can only make things narrower: lower an app's tier or deny it.
/// Nobody can raise a category's cap, and nothing here can grant an app —
/// a grant is a per-session answer on the grant sheet (D-021).
public struct ScreenControlPreferences: Hashable, Codable, Sendable {
    /// Bundle id (lowercased) → the lower tier the reader chose.
    public var loweredTiers: [String: AppTier]
    /// Bundle ids (lowercased) the reader denied.
    public var denied: Set<String>
    /// Finance apps the reader let Juno look at. They are denied otherwise.
    public var allowedFinance: Set<String>

    public init(loweredTiers: [String: AppTier] = [:], denied: Set<String> = [], allowedFinance: Set<String> = []) {
        self.loweredTiers = loweredTiers
        self.denied = denied
        self.allowedFinance = allowedFinance
    }

    public static let `default` = ScreenControlPreferences()
}

/// What the grant sheet shows for one requested app.
public struct AppGrantOffer: Hashable, Codable, Sendable, Identifiable {
    public enum Outcome: Hashable, Codable, Sendable {
        /// Offered at this tier.
        case offered(AppTier)
        /// Never: the category refuses it, or the reader denied it.
        case refused(String)
        /// No app by that name or id is installed or running.
        case notFound
    }

    public var id: String { request }
    /// What the model asked for: a bundle id or a name.
    public var request: String
    public var bundleID: String?
    public var displayName: String
    public var category: AppCategory
    public var outcome: Outcome
    /// Warning lines, in words.
    public var warnings: [String]
    /// The reader's choices on the sheet. Off by default.
    public var include: Bool
    public var clipboardRead: Bool
    public var clipboardWrite: Bool

    public init(
        request: String,
        bundleID: String?,
        displayName: String,
        category: AppCategory,
        outcome: Outcome,
        warnings: [String],
        include: Bool = true,
        clipboardRead: Bool = false,
        clipboardWrite: Bool = false
    ) {
        self.request = request
        self.bundleID = bundleID
        self.displayName = displayName
        self.category = category
        self.outcome = outcome
        self.warnings = warnings
        self.include = include
        self.clipboardRead = clipboardRead
        self.clipboardWrite = clipboardWrite
    }

    public var offeredTier: AppTier? {
        if case let .offered(tier) = outcome { return tier }
        return nil
    }

    /// "TextEdit: full control", "Terminal: clicks only — Juno uses its own
    /// shell for commands".
    public var line: String {
        switch outcome {
        case let .offered(tier):
            let warning = warnings.first.map { " — \($0)" } ?? ""
            return "\(displayName): \(tier.phrase)\(warning)"
        case let .refused(reason):
            return "\(displayName): not allowed — \(reason)"
        case .notFound:
            return "\(request): not found on this Mac"
        }
    }
}

/// One grant request, as the sheet shows it and the reader answers it.
public struct GrantProposal: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var sessionID: String
    public var reason: String?
    public var offers: [AppGrantOffer]

    public init(id: String = UUID().uuidString.lowercased(), sessionID: String, reason: String?, offers: [AppGrantOffer]) {
        self.id = id
        self.sessionID = sessionID
        self.reason = reason
        self.offers = offers
    }

    /// Whether there is anything to say yes to.
    public var hasOffer: Bool { offers.contains { $0.offeredTier != nil } }

    /// The approval's one-line summary.
    public var summary: String {
        let offered = offers.filter { $0.offeredTier != nil }
        guard !offered.isEmpty else { return "No app here can be granted." }
        let names = offered.map { "\($0.displayName) (\($0.offeredTier!.phrase))" }
        return "Let Juno use " + ListFormatter.localizedString(byJoining: names) + " for this session"
    }
}

/// The policy: caps, the reader's narrowing, tiers per action.
public enum AppGrantPolicy {
    /// The most `bundleID` may be granted under `preferences`, or why not.
    public static func offer(
        request: String,
        bundleID: String?,
        displayName: String,
        appStoreCategory: String? = nil,
        preferences: ScreenControlPreferences
    ) -> AppGrantOffer {
        guard let bundleID else {
            return AppGrantOffer(
                request: request, bundleID: nil, displayName: displayName,
                category: .other, outcome: .notFound, warnings: [], include: false
            )
        }
        let category = AppCategories.category(bundleID: bundleID, appStoreCategory: appStoreCategory)
        var warnings: [String] = []
        if let reach = AppCategories.reachWarning(bundleID: bundleID) { warnings.append(reach) }
        if let warning = AppCategories.warning(for: category), category != .refused { warnings.append(warning) }
        let key = bundleID.lowercased()
        guard let cap = category.cap else {
            return AppGrantOffer(
                request: request, bundleID: bundleID, displayName: displayName, category: category,
                outcome: .refused(refusalReason(category: category, bundleID: bundleID)),
                warnings: [], include: false
            )
        }
        if preferences.denied.contains(key) {
            return AppGrantOffer(
                request: request, bundleID: bundleID, displayName: displayName, category: category,
                outcome: .refused("you denied it in Settings"), warnings: warnings, include: false
            )
        }
        if category.deniedByDefault, !preferences.allowedFinance.contains(key) {
            return AppGrantOffer(
                request: request, bundleID: bundleID, displayName: displayName, category: category,
                outcome: .refused("finance and trading apps are denied unless you allow them in Settings"),
                warnings: warnings, include: false
            )
        }
        let tier = min(cap, preferences.loweredTiers[key] ?? cap)
        return AppGrantOffer(
            request: request, bundleID: bundleID, displayName: displayName, category: category,
            outcome: .offered(tier), warnings: warnings
        )
    }

    static func refusalReason(category: AppCategory, bundleID: String) -> String {
        let id = bundleID.lowercased()
        if id.hasPrefix(AppCategories.junoBundlePrefix) {
            return "Juno never controls itself, so it can never answer its own approvals"
        }
        switch id {
        case "com.apple.loginwindow", "com.apple.securityagent", "com.apple.coreautha", "com.apple.coreauthd",
             "com.apple.localauthentication.uiagent", "com.apple.usernotificationcenter":
            return "system and permission prompts are yours to answer"
        default:
            return "passwords and keychains are yours to handle"
        }
    }

    /// Whether `grant` covers an action of `actionClass`, with the sentence
    /// the model reads when it does not.
    public static func check(_ actionClass: ScreenActionClass, against grant: AppGrant?, appName: String) -> String? {
        guard let grant else {
            return "\(appName) is not granted for this session. Ask the reader to grant it with computer_apps request."
        }
        guard grant.tier.allows(actionClass) else {
            switch grant.tier {
            case .view:
                return "\(grant.displayName) is granted for viewing only; the action was not sent."
            case .click:
                return "\(grant.displayName) is granted for clicks only; typing, keys, right-click and drags were not sent."
            case .full:
                return nil
            }
        }
        return nil
    }
}

/// One session's grants, and when they end (CODE_AGENT_SPEC §3.3 "Lapse").
///
/// A grant ends at session end, on Stop, on a switch to Plan or Ask, on a
/// model change, and after 30 minutes without a screen action. The owner of
/// the book calls ``revokeAll()`` for the first four; the idle lapse is read
/// against an injected clock on every lookup.
public struct AppGrantBook: Hashable, Sendable {
    public static let idleLapse: TimeInterval = 30 * 60

    public private(set) var grants: [String: AppGrant] = [:]

    public init() {}

    public mutating func add(_ grant: AppGrant) {
        grants[grant.bundleID.lowercased()] = grant
    }

    /// The live grant for `bundleID` at `now`, dropping it when it lapsed.
    public mutating func grant(for bundleID: String, now: Date) -> AppGrant? {
        let key = bundleID.lowercased()
        guard let grant = grants[key] else { return nil }
        if now.timeIntervalSince(grant.lastUsedAt) >= Self.idleLapse {
            grants[key] = nil
            return nil
        }
        return grant
    }

    /// Every grant still live at `now`.
    public mutating func live(now: Date) -> [AppGrant] {
        for key in grants.keys { _ = grant(for: key, now: now) }
        return grants.values.sorted { $0.displayName < $1.displayName }
    }

    /// A screen action happened in `bundleID`: the idle clock restarts for
    /// every grant, since the session is plainly still using screen control.
    public mutating func touch(now: Date) {
        for key in grants.keys { grants[key]?.lastUsedAt = now }
    }

    public mutating func revoke(_ bundleID: String) {
        grants[bundleID.lowercased()] = nil
    }

    public mutating func revokeAll() {
        grants.removeAll()
    }

    public var isEmpty: Bool { grants.isEmpty }
}

/// The rule "Always allow" would save for a screen action, scoped to one
/// app and one action class: `ScreenInput(com.apple.TextEdit:click)`.
///
/// Never offered for a refused app, a secure field or the always-confirm
/// floor (CU-08). In this pass it is not offered at all (D-021: grants are
/// per app and per session); the type exists so the scope is fixed in one
/// place when the owner turns it on.
public struct ScreenInputRule: Hashable, Codable, Sendable, CustomStringConvertible {
    public var bundleID: String
    public var actionClass: ScreenActionClass

    public init(bundleID: String, actionClass: ScreenActionClass) {
        self.bundleID = bundleID
        self.actionClass = actionClass
    }

    public var description: String { "ScreenInput(\(bundleID):\(actionClass.rawValue))" }

    /// Whether persistent screen rules are offered at all. Off (D-021).
    public static let persistentRulesEnabled = false

    /// The rule to offer for an action, or nil where none may be offered.
    public static func suggestion(
        bundleID: String,
        category: AppCategory,
        actionClass: ScreenActionClass,
        floor: FloorReason?,
        targetIsSecure: Bool,
        persistentRulesEnabled: Bool = ScreenInputRule.persistentRulesEnabled
    ) -> ScreenInputRule? {
        guard persistentRulesEnabled,
              floor == nil,
              !targetIsSecure,
              category.cap != nil,
              actionClass != .view
        else { return nil }
        return ScreenInputRule(bundleID: bundleID, actionClass: actionClass)
    }
}
