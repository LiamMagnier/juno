import Foundation
import JunoAuth
import JunoCore
import JunoWorkKit
import Observation

/// Whether this Mac serves Juno Work, and on exactly what terms.
///
/// Everything here is off until the person sitting at the machine turns it on.
/// That is not caution for its own sake: signing into Juno is not consent to
/// hand a phone the filesystem, and a Mac that began accepting instructions
/// from elsewhere the moment someone signed in would be a default nobody would
/// choose if they were asked. Juno Code learned the same lesson with
/// `servesQueuedTasks`; this is the same shape, for a much larger capability.
///
/// The model owns three things and deliberately not a fourth:
///
///   * the switches, persisted, because they are standing decisions about this
///     machine rather than per-launch ones;
///   * the policy those switches add up to, which is what the relay is told;
///   * the claim loop's lifetime, so there is exactly one place that decides
///     whether this Mac is listening rather than three that can disagree.
///
/// It does not execute anything. Execution belongs to the local Work runtime
/// with its own grants and approval flow, which is what makes it true that a
/// remote instruction cannot acquire a capability a local prompt does not
/// already have.
@MainActor
@Observable
final class DesktopWorkHostModel {
    enum Phase: Equatable, Sendable {
        case off
        /// Switched on; the first advertisement of this sign-in is in flight.
        case announcing
        /// The relay knows this Mac and what it can do.
        case serving
        /// The last advertisement or claim failed. `lastError` says what
        /// happened; the loop keeps retrying with backoff unless it was refused
        /// permanently.
        case failed
        /// Stopped and will not retry — revoked, or signed out.
        case stopped(reason: String)
    }

    private(set) var phase: Phase = .off
    private(set) var lastError: String?
    private(set) var lastAdvertisedAt: Date?
    private(set) var activeRunCount = 0
    private(set) var queuedRunCount = 0
    private(set) var lastActivityAt: Date?

    /// Folders this Mac has been granted, as the user sees them.
    ///
    /// Display names and access modes only. The paths live behind
    /// `GrantAccessing` in JunoWorkLocal and are never held here, so a settings
    /// screen cannot accidentally render one and a screenshot of this window
    /// cannot leak one.
    private(set) var grants: [WorkGrantSummary] = []

    // MARK: - The switches

    /// The master switch. Off means every capability below is off, whatever
    /// they individually say.
    var allowWorkOnThisMac: Bool {
        get { defaults.bool(forKey: Keys.enabled) }
        set { write(Keys.enabled, newValue) }
    }

    var allowsFileWork: Bool {
        get { defaults.bool(forKey: Keys.files) }
        set { write(Keys.files, newValue) }
    }

    var allowsBrowser: Bool {
        get { defaults.bool(forKey: Keys.browser) }
        set { write(Keys.browser, newValue) }
    }

    var allowsComputerUse: Bool {
        get { defaults.bool(forKey: Keys.computerUse) }
        set { write(Keys.computerUse, newValue) }
    }

    /// Off by default and separate from computer use, because a shell is not a
    /// smaller version of clicking around an app — it is a different and much
    /// larger capability that only a developer workflow has any use for.
    var allowsShell: Bool {
        get { defaults.bool(forKey: Keys.shell) }
        set { write(Keys.shell, newValue) }
    }

    /// Whether remote-dispatched runs may execute while nobody is at the Mac.
    ///
    /// Its own switch rather than something implied by the others: "Juno may
    /// organise my folders" and "Juno may organise my folders while I am asleep
    /// and cannot see the approval prompt" are different consents.
    var allowsBackground: Bool {
        get { defaults.bool(forKey: Keys.background) }
        set { write(Keys.background, newValue) }
    }

    /// conservative | balanced | permissive. Never widened by anything else —
    /// a session, schedule or skill can only narrow it.
    var approvalPolicy: WorkHostPolicy.ApprovalPolicy {
        get {
            WorkHostPolicy.ApprovalPolicy(
                rawValue: defaults.string(forKey: Keys.approval) ?? ""
            ) ?? .conservative
        }
        set {
            defaults.set(newValue.rawValue, forKey: Keys.approval)
            onPolicyChanged()
        }
    }

    /// Bundle identifiers the user has allowed for app control, and refused.
    ///
    /// Stored as arrays because `UserDefaults` has no set; converted at the
    /// boundary. A block always beats an allow, so removing something from the
    /// blocklist is a deliberate act rather than a side effect of adding it to
    /// the allowlist.
    var allowedApps: [String] {
        get { defaults.stringArray(forKey: Keys.allowedApps) ?? [] }
        set { write(Keys.allowedApps, newValue) }
    }

    var blockedApps: [String] {
        get { defaults.stringArray(forKey: Keys.blockedApps) ?? [] }
        set { write(Keys.blockedApps, newValue) }
    }

    var allowedDomains: [String] {
        get { defaults.stringArray(forKey: Keys.allowedDomains) ?? [] }
        set { write(Keys.allowedDomains, newValue) }
    }

    // MARK: - Derived truth

    /// What this Mac tells the relay it can do.
    ///
    /// Derived from the switches every time rather than stored alongside them.
    /// A manifest that can be set independently of the toggles is a manifest
    /// that can lie, and the relay routes local work by believing it — so the
    /// lie would present to the user as a task dispatched to a Mac that then
    /// refuses every step of it.
    var policy: WorkHostPolicy {
        WorkHostPolicy(
            enabled: allowWorkOnThisMac,
            allowsFileWork: allowsFileWork,
            allowsBrowser: allowsBrowser,
            allowsComputerUse: allowsComputerUse,
            allowsShell: allowsShell,
            allowsBackground: allowsBackground,
            approvalPolicy: approvalPolicy,
            allowedApps: Set(allowedApps),
            blockedApps: Set(blockedApps),
            allowedDomains: Set(allowedDomains)
        )
    }

    /// Whether a task dispatched here would actually be picked up.
    ///
    /// Read by the settings surface instead of hard-coding a sentence that rots
    /// the moment the wiring changes. Both halves matter: the switch says the
    /// user consented, and a live host says something is actually claiming.
    var willServeDispatchedWork: Bool {
        allowWorkOnThisMac && remoteHost != nil && !policy.advertisedCapabilities.isEmpty
    }

    /// Why this Mac would refuse work right now, for the settings row.
    ///
    /// A sentence rather than a boolean, because "Juno Work is on but this Mac
    /// has been granted nothing, so no task can run here" and "Juno Work is
    /// off" are different problems with different fixes, and a single grey
    /// "unavailable" sends the user looking in the wrong place.
    var unavailabilityReason: String? {
        if !allowWorkOnThisMac { return "Juno Work is switched off on this Mac." }
        if accountID == nil { return "Sign in to let Juno Work use this Mac." }
        if hostID == nil { return "This Mac has not finished pairing with your account yet." }
        if policy.advertisedCapabilities.isEmpty {
            return "Juno Work is on, but nothing has been allowed yet — grant a folder or turn on a capability."
        }
        if remoteHost == nil { return "Juno Work is starting on this Mac." }
        return nil
    }

    // MARK: - Wiring

    private let defaults: UserDefaults
    private var accountID: AccountID?
    private var hostID: String?
    private var relay: (any WorkRelaying)?
    /// Supplies the executor once the app has a local Work runtime to run
    /// against. Nil until then, and the loop cannot start without it — which is
    /// deliberate: advertising a Mac as serving while nothing claims is exactly
    /// how a dispatched task sits queued for ever.
    var executorProvider: (@MainActor () -> (any WorkCommandExecuting)?)?

    private var remoteHost: WorkRemoteHost?

    private enum Keys {
        static let enabled = "juno.work.host.enabled"
        static let files = "juno.work.host.files"
        static let browser = "juno.work.host.browser"
        static let computerUse = "juno.work.host.computerUse"
        static let shell = "juno.work.host.shell"
        static let background = "juno.work.host.background"
        static let approval = "juno.work.host.approvalPolicy"
        static let allowedApps = "juno.work.host.allowedApps"
        static let blockedApps = "juno.work.host.blockedApps"
        static let allowedDomains = "juno.work.host.allowedDomains"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Binds the model to a signed-in account and its paired host row.
    func attach(accountID: AccountID, hostID: String, relay: any WorkRelaying) {
        self.accountID = accountID
        self.hostID = hostID
        self.relay = relay
        syncRemoteHost()
    }

    /// Sign-out. Stops serving immediately rather than at the next heartbeat,
    /// because an in-flight command must not acknowledge against an account
    /// that is no longer signed in.
    func detach(reason: String = "Signed out") {
        accountID = nil
        hostID = nil
        relay = nil
        if let host = remoteHost {
            remoteHost = nil
            Task { await host.deactivate(reason: reason) }
        }
        phase = .stopped(reason: reason)
    }

    /// The immediate kill switch.
    ///
    /// Sets the master switch off and stops the loop in one step, so "off"
    /// means off now. A version that only wrote the preference and waited for
    /// the next advertisement would leave a window in which the relay still
    /// believes this Mac is serving — and that window is precisely when
    /// somebody reaches for a kill switch.
    func stopServingWork() {
        allowWorkOnThisMac = false
    }

    private func write<T>(_ key: String, _ value: T) {
        defaults.set(value, forKey: key)
        onPolicyChanged()
    }

    /// One place decides whether this Mac is listening.
    ///
    /// Called from every switch, from attach and from detach. Three call sites
    /// that each start or stop the loop is how a Mac ends up still serving
    /// after the account it was serving for signed out.
    private func onPolicyChanged() {
        syncRemoteHost()
        // Re-advertise immediately rather than waiting for the next beat: until
        // the relay knows, a phone still shows this Mac as available after it
        // was switched off, which is the wrong direction to be stale in.
        Task { await self.advertiseNow() }
    }

    private func syncRemoteHost() {
        let shouldServe = allowWorkOnThisMac && accountID != nil && hostID != nil
        if shouldServe, remoteHost == nil {
            guard let accountID, let hostID, let relay,
                  let executor = executorProvider?()
            else {
                // Nothing to claim with. Say so rather than advertising a Mac
                // that would accept work and never run it.
                phase = .off
                return
            }
            let policyProvider: @Sendable () async -> WorkHostPolicy = { [weak self] in
                guard let self else { return .denied }
                return await MainActor.run { self.policy }
            }
            let host = WorkRemoteHost(
                hostID: hostID,
                accountID: accountID,
                relay: relay,
                executor: executor,
                policyProvider: policyProvider
            )
            remoteHost = host
            phase = .announcing
            Task { [weak self] in
                let started = await host.activate()
                await MainActor.run {
                    guard let self else { return }
                    self.phase = started ? .serving : .off
                    if started { self.lastAdvertisedAt = Date() }
                }
            }
        } else if !shouldServe, let host = remoteHost {
            remoteHost = nil
            phase = .off
            Task { await host.deactivate(reason: "Juno Work was switched off on this Mac.") }
        }
    }

    private func advertiseNow() async {
        guard let relay, let hostID, let accountID, allowWorkOnThisMac else { return }
        do {
            try await relay.advertiseWorkHost(hostID: hostID, policy: policy, for: accountID)
            lastAdvertisedAt = Date()
            lastError = nil
            if case .failed = phase { phase = .serving }
        } catch {
            lastError = error.localizedDescription
            phase = .failed
        }
    }

    // MARK: - Grants

    /// Replaces the displayed grant list.
    ///
    /// Pushed in by whatever owns the local Work runtime rather than fetched
    /// here, for the same reason the Code host takes its workspaces that way: a
    /// list snapshotted when the loop starts is always empty, and an empty list
    /// is what makes a phone show this Mac with nothing it can work in.
    func setGrants(_ grants: [WorkGrantSummary]) {
        self.grants = grants
    }

    func setActivity(active: Int, queued: Int, at date: Date = Date()) {
        activeRunCount = active
        queuedRunCount = queued
        lastActivityAt = date
    }
}
