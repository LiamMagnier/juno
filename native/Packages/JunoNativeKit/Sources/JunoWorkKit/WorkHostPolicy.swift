import Foundation

/// What this Mac will let Juno Work do, and the one direction that answer can move.
///
/// Five things want a say in what a run may do: the host's own switches, the
/// project, the session, the schedule that fired it, and the skill it invoked.
/// Every one of them may only ever *narrow*. Expressed as a lattice with a
/// meet operation rather than as a chain of conditionals, because a chain of
/// conditionals eventually grows a branch that widens — and a widening branch
/// in this particular file is a remote prompt acquiring a capability the owner
/// of the Mac never granted.
public struct WorkHostPolicy: Equatable, Sendable {
    /// Raw values match `src/lib/work/domain.ts`.
    public enum ApprovalPolicy: String, Equatable, Sendable, CaseIterable {
        case conservative
        case balanced
        case permissive

        /// Ordering used by the meet. Lower is stricter.
        var rank: Int {
            switch self {
            case .conservative: 0
            case .balanced: 1
            case .permissive: 2
            }
        }
    }

    public var enabled: Bool
    public var allowsFileWork: Bool
    public var allowsBrowser: Bool
    public var allowsComputerUse: Bool
    public var allowsShell: Bool
    /// Whether remote-dispatched runs may execute while nobody is at the Mac.
    public var allowsBackground: Bool
    public var approvalPolicy: ApprovalPolicy
    /// Bundle identifiers the user allowed for app control. Empty means none —
    /// deliberately not "all", because an empty allowlist read as permissive is
    /// how a feature ships switched on for everybody who never opened settings.
    public var allowedApps: Set<String>
    /// Bundle identifiers refused regardless of the allowlist. A block always
    /// beats an allow, so a later widening of `allowedApps` cannot re-admit
    /// something the user explicitly refused.
    public var blockedApps: Set<String>
    public var allowedDomains: Set<String>

    public init(
        enabled: Bool = false,
        allowsFileWork: Bool = false,
        allowsBrowser: Bool = false,
        allowsComputerUse: Bool = false,
        allowsShell: Bool = false,
        allowsBackground: Bool = false,
        approvalPolicy: ApprovalPolicy = .conservative,
        allowedApps: Set<String> = [],
        blockedApps: Set<String> = [],
        allowedDomains: Set<String> = []
    ) {
        self.enabled = enabled
        self.allowsFileWork = allowsFileWork
        self.allowsBrowser = allowsBrowser
        self.allowsComputerUse = allowsComputerUse
        self.allowsShell = allowsShell
        self.allowsBackground = allowsBackground
        self.approvalPolicy = approvalPolicy
        self.allowedApps = allowedApps
        self.blockedApps = blockedApps
        self.allowedDomains = allowedDomains
    }

    /// Everything off. The default a Mac starts from, and the identity the
    /// meet collapses to as soon as any layer says no.
    public static let denied = WorkHostPolicy()

    /// The strictest of two policies, field by field.
    ///
    /// Note the asymmetry that makes this safe: permissions AND, denials OR.
    /// `blockedApps` unions rather than intersects, so a block added by any
    /// layer survives; `allowedApps` and `allowedDomains` intersect, so an
    /// allow needs every layer's agreement. A single `union` in the wrong place
    /// here would let a skill add a domain the user never approved.
    public func narrowed(by other: WorkHostPolicy) -> WorkHostPolicy {
        WorkHostPolicy(
            enabled: enabled && other.enabled,
            allowsFileWork: allowsFileWork && other.allowsFileWork,
            allowsBrowser: allowsBrowser && other.allowsBrowser,
            allowsComputerUse: allowsComputerUse && other.allowsComputerUse,
            allowsShell: allowsShell && other.allowsShell,
            allowsBackground: allowsBackground && other.allowsBackground,
            approvalPolicy: approvalPolicy.rank <= other.approvalPolicy.rank
                ? approvalPolicy : other.approvalPolicy,
            allowedApps: allowedApps.intersection(other.allowedApps),
            blockedApps: blockedApps.union(other.blockedApps),
            allowedDomains: allowedDomains.intersection(other.allowedDomains)
        )
    }

    public static func narrowest(_ policies: [WorkHostPolicy]) -> WorkHostPolicy {
        guard var result = policies.first else { return .denied }
        for policy in policies.dropFirst() { result = result.narrowed(by: policy) }
        return result
    }

    /// The capability keys this policy actually supports, for the host's
    /// advertisement to the relay.
    ///
    /// Derived from the switches rather than stored alongside them. A manifest
    /// that can be set independently of the toggles is a manifest that can lie,
    /// and the relay routes local work by believing it.
    public var advertisedCapabilities: [String] {
        guard enabled else { return [] }
        var keys: [String] = []
        if allowsFileWork { keys.append("local_files") }
        if allowsComputerUse {
            keys.append("local_computer_use")
            keys.append("local_apps")
        }
        if allowsBrowser { keys.append("local_browser") }
        if allowsShell { keys.append("local_shell") }
        return keys
    }

    /// Whether a named capability may be used at all on this Mac.
    public func permits(capability: String) -> Bool {
        advertisedCapabilities.contains(capability)
    }

    /// Whether an app may be driven.
    ///
    /// Block first, then allowlist, then a default of refusal. The default
    /// matters: a bundle identifier nobody has considered is one the user has
    /// not thought about, and the safe reading of "not considered" is no.
    public func permits(app bundleIdentifier: String) -> Bool {
        guard enabled, allowsComputerUse else { return false }
        if blockedApps.contains(bundleIdentifier) { return false }
        if Self.restrictedCategories.contains(bundleIdentifier) { return false }
        return allowedApps.contains(bundleIdentifier)
    }

    /// Whether a domain may be driven in the browser.
    ///
    /// A leading dot means "this domain and anything under it", matching the
    /// runner's egress allowlist. The distinction is load-bearing: a plain
    /// suffix test would match `notexample.com` against `example.com`, which is
    /// a different party entirely.
    public func permits(domain host: String) -> Bool {
        guard enabled, allowsBrowser else { return false }
        let target = Self.normalizeHost(host)
        guard !target.isEmpty else { return false }
        return allowedDomains.contains { entry in
            let rule = Self.normalizeHost(entry)
            guard !rule.isEmpty else { return false }
            if rule.hasPrefix(".") {
                let base = String(rule.dropFirst())
                return target == base || target.hasSuffix("." + base)
            }
            return target == rule
        }
    }

    /// Lowercased, trailing dots removed.
    ///
    /// The trailing dot matters: `evil.com.` and `evil.com` resolve
    /// identically, so a policy comparing them as plain strings admits the
    /// first through a list containing the second.
    static func normalizeHost(_ host: String) -> String {
        var value = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while value.hasSuffix(".") { value.removeLast() }
        return value
    }

    /// Applications never driven automatically, whatever the allowlist says.
    ///
    /// These are the categories where an automated mistake is not recoverable
    /// by undo: money, health records, identity documents, and the credential
    /// stores that protect everything else. A user can still do any of this
    /// themselves; what they cannot do is delegate it to an agent by ticking a
    /// box they did not read.
    public static let restrictedCategories: Set<String> = [
        "com.apple.keychainaccess",
        "com.agilebits.onepassword7",
        "com.agilebits.onepassword8",
        "com.1password.1password",
        "com.lastpass.LastPass",
        "com.bitwarden.desktop",
        "com.dashlane.Dashlane",
        "com.apple.Passwords",
        "com.intuit.quickbooks",
        "com.apple.Home",
        "com.apple.Health",
        "com.apple.systempreferences",
        "com.apple.SystemProfiler",
        "com.apple.Terminal",
        "com.apple.SecurityAgent",
    ]
}

/// A run's resolved permission, after every layer has had its say.
///
/// Kept as its own type rather than a bare `WorkHostPolicy` so that the digest
/// the approval binds to is over the *resolved* value. An approval granted
/// under one resolution must not execute after the resolution narrowed, and
/// that check is only possible if the resolved value is a thing with an
/// identity.
public struct WorkResolvedPolicy: Equatable, Sendable {
    public let policy: WorkHostPolicy
    /// The layers that contributed, in order, for the "why can't it do X"
    /// explanation. Names only — never their contents.
    public let contributingLayers: [String]

    public init(policy: WorkHostPolicy, contributingLayers: [String]) {
        self.policy = policy
        self.contributingLayers = contributingLayers
    }

    /// Stable, canonical serialisation used as the input to the policy digest.
    ///
    /// Sorted throughout: two structurally equal policies must produce the same
    /// bytes regardless of insertion order, or the digest proves nothing.
    public var canonicalForm: String {
        let flags = [
            "enabled=\(policy.enabled)",
            "files=\(policy.allowsFileWork)",
            "browser=\(policy.allowsBrowser)",
            "computer=\(policy.allowsComputerUse)",
            "shell=\(policy.allowsShell)",
            "background=\(policy.allowsBackground)",
            "approval=\(policy.approvalPolicy.rawValue)",
            "apps=\(policy.allowedApps.sorted().joined(separator: ","))",
            "blocked=\(policy.blockedApps.sorted().joined(separator: ","))",
            "domains=\(policy.allowedDomains.sorted().joined(separator: ","))",
        ]
        return flags.joined(separator: ";")
    }
}
