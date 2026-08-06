import Foundation
import JunoAuth
import JunoCore
import JunoWorkKit
import Observation

/// The macOS permissions Juno Work's capabilities actually stand on.
///
/// Two booleans rather than one "may automate", because they are granted
/// separately in System Settings and half of them is a real and confusing state:
/// Screen Recording without Accessibility can watch a screen it cannot touch.
/// Naming them apart is what lets the settings card say which one is missing.
struct DesktopWorkSystemPermissions: Equatable, Sendable {
    let accessibility: Bool
    let screenRecording: Bool

    /// What a Mac is assumed to permit when nobody has asked it. Nothing.
    static let none = DesktopWorkSystemPermissions(
        accessibility: false, screenRecording: false
    )
}

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
    /// Narrowed by what macOS will actually permit, not only by what the person
    /// asked for.
    ///
    /// A switch says what somebody wants; only TCC says whether it is possible.
    /// Both rows could be turned on with no permission held at all, and the
    /// manifest built from them told the relay this Mac could drive a screen —
    /// so `selectTarget` sent it a task that failed on its first click, with a
    /// macOS permission dialog appearing behind a window nobody was looking at.
    /// Advertising less than the switches say is the honest direction: the
    /// settings card names the missing permission and offers the way to grant it.
    var policy: WorkHostPolicy {
        let permissions = systemPermissions?() ?? .none
        return WorkHostPolicy(
            enabled: allowWorkOnThisMac,
            // Files need no macOS permission of their own: a grant *is* the
            // permission, issued by the person in a file panel.
            allowsFileWork: allowsFileWork,
            // Driving a browser goes through the same Accessibility permission
            // an app does — there is no separate grant for "the browser".
            allowsBrowser: allowsBrowser && permissions.accessibility,
            // Both, because screen control without Accessibility can see the
            // screen and not touch it, and advertising that wins this Mac a task
            // it can only half do. `WorkCapabilityManifest` makes the same call.
            allowsComputerUse: allowsComputerUse
                && permissions.accessibility
                && permissions.screenRecording,
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
    private var registrar: (any WorkHostRegistering)?
    private var accountID: AccountID?
    private var hostID: String?
    private var relay: (any WorkRelaying)?
    private var beat: Task<Void, Never>?
    /// Supplies the executor once the app has a local Work runtime to run
    /// against. Nil until then, and the loop cannot start without it — which is
    /// deliberate: advertising a Mac as serving while nothing claims is exactly
    /// how a dispatched task sits queued for ever.
    var executorProvider: (@MainActor () -> (any WorkCommandExecuting)?)?

    /// Builds that executor, given the host row id this Mac has just been
    /// granted.
    ///
    /// The factory takes the id because everything downstream of it needs one:
    /// `LocalWorkExecutor` stamps it into a `ping`, the run host addresses the
    /// event outbox with it, and a grant is recorded against it. None of that
    /// can be composed before registration lands, which is why this is a factory
    /// and ``executorProvider`` is assigned from it here rather than at app
    /// composition — where it was simply never assigned at all, so the claim loop
    /// fell through to `phase = .off` on every single launch.
    var executorFactory: (@MainActor (String, AccountID) -> (any WorkCommandExecuting)?)?

    /// Told whenever the standing policy on this Mac changes.
    ///
    /// The local approval gate holds its own copy of the policy and revokes
    /// pending questions when it narrows — an approval is a decision made inside
    /// the envelope that existed when it was asked for. Without this, somebody
    /// tightening a switch in Settings would tighten what this Mac *advertises*
    /// while the run already going kept asking under the old envelope.
    var policyObserver: (@MainActor (WorkHostPolicy) -> Void)?

    /// What macOS will let this Mac do, asked of macOS.
    ///
    /// A closure so the model stays free of AppKit and can be exercised with
    /// either answer; supplied at composition from `SystemScreenPreflight`. Nil
    /// answers "nothing is permitted", which is the safe direction for a model
    /// composed without it.
    var systemPermissions: (@MainActor () -> DesktopWorkSystemPermissions)?

    /// The actions Settings needs on the grant store, without Settings having to
    /// be handed the store.
    ///
    /// The settings card is built by `DesktopSettingsScreen` from the host model
    /// alone, and threading a second dependency through that surface for three
    /// buttons would be a worse trade than naming the three buttons here.
    var grantActions: DesktopWorkGrantActions?

    /// The host row's id, once the relay has issued one.
    ///
    /// Published so the grant store can attribute what it holds to the right Mac
    /// and the settings card can stop saying this Mac has not finished pairing.
    var pairedHostID: String? { hostID }

    private var remoteHost: WorkRemoteHost?

    /// Matches ``DesktopCodeHostModel``'s key, and is read rather than written
    /// here. Work does not mint an identity of its own: the registration route
    /// looks the device up on the account, so reusing Code's row is what makes
    /// pairing an already-solved problem instead of a second protocol.
    nonisolated private static let codeDeviceIDKey = "juno.code.deviceId"

    /// Half the Code host's minute, because a Work host that stops beating stops
    /// being routable much sooner than a Code device does — `hostStateFor` walks
    /// a host from `online` to `idle` to `stale` on the age of `lastSeenAt`, and
    /// `WorkHostSummary.canServeWork` refuses anything past `idle`.
    private static let heartbeatInterval = Duration.seconds(30)

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
        static let hostID = "juno.work.host.id"
    }

    init(
        registrar: (any WorkHostRegistering)? = nil,
        relay: (any WorkRelaying)? = nil,
        defaults: UserDefaults = .standard
    ) {
        self.registrar = registrar
        self.relay = relay
        self.defaults = defaults
    }

    /// Joins the model to its transports and to the local runtime it drives.
    ///
    /// A second step rather than initializer arguments, because the graph is
    /// genuinely circular: the relay client reports this model's run counts on
    /// every advertisement, and this model claims commands through that client.
    /// One of the two has to be handed the other afterwards, and doing it here
    /// keeps the cycle in one readable place instead of behind a mutable box at
    /// the composition root.
    func connect(
        registrar: any WorkHostRegistering,
        relay: any WorkRelaying,
        executorFactory: @escaping @MainActor (String, AccountID) -> (any WorkCommandExecuting)?,
        policyObserver: @escaping @MainActor (WorkHostPolicy) -> Void
    ) {
        self.registrar = registrar
        self.relay = relay
        self.executorFactory = executorFactory
        self.policyObserver = policyObserver
    }

    /// The identity this Mac registers under, or nil while it has none yet.
    ///
    /// Nil is a real and temporary state: on a first launch the Code device row
    /// is created by its own heartbeat, and until that lands there is no id to
    /// register Work against. The next beat picks it up.
    nonisolated static func identity(
        from defaults: UserDefaults = .standard
    ) -> WorkHostIdentity? {
        guard let deviceID = defaults.string(forKey: codeDeviceIDKey), !deviceID.isEmpty else {
            return nil
        }
        return WorkHostIdentity(
            deviceID: deviceID,
            // Read exactly as `JunoDesktopConfiguration` and the Code host read
            // them, so the computer named in the phone's picker is the computer
            // named everywhere else.
            displayName: Host.current().localizedName ?? "Mac",
            appVersion: Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String ?? "0.1.0"
        )
    }

    /// Registers this Mac for Work, then keeps registering it.
    ///
    /// Shaped like ``DesktopCodeHostModel/start(for:)`` and for the same reason:
    /// being listed is a heartbeat, not an event. The registration writes
    /// `lastSeenAt` on every post and the relay ages a host out of `canServeWork`
    /// when that timestamp gets old, so a single registration at launch buys a
    /// couple of minutes of routability and then silently expires.
    ///
    /// It registers even while Juno Work is switched off, and that is the
    /// presence-versus-capability split the Code host learned the hard way:
    /// registering says this Mac exists and reports `enabled: false`, which is
    /// what lets the settings card say "Juno Work is switched off" instead of
    /// "this Mac has not finished pairing" — two sentences with two different
    /// fixes. Nothing is claimed until the switch is on.
    func start(for accountID: AccountID) {
        guard self.accountID != accountID else { return }
        detach(reason: "Switching account")
        self.accountID = accountID
        // Replayed from the last run so a Mac that has registered before keeps
        // its own row rather than being paired again under a second one.
        hostID = defaults.string(forKey: Keys.hostID)
        phase = .announcing
        beat = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.registerNow()
                guard !Task.isCancelled else { return }
                try? await Task.sleep(for: Self.heartbeatInterval)
            }
        }
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
    ///
    /// The persisted host id deliberately survives, exactly as the Code device id
    /// does: signing back in updates this Mac's own row instead of stranding it
    /// as a second host that is listed, never beats again, and can never be
    /// chosen.
    func detach(reason: String = "Signed out") {
        beat?.cancel()
        beat = nil
        accountID = nil
        hostID = nil
        if let host = remoteHost {
            remoteHost = nil
            Task { await host.deactivate(reason: reason) }
        }
        phase = .stopped(reason: reason)
    }

    /// One registration, and everything that becomes possible once it lands.
    private func registerNow() async {
        guard let accountID, let registrar else { return }
        guard let identity = Self.identity(from: defaults) else {
            // Not an error worth colouring red. The Code host's first heartbeat
            // is seconds away and this one retries in thirty.
            phase = .announcing
            return
        }
        do {
            let registration = try await registrar.registerWorkHost(
                identity: identity, policy: policy, for: accountID
            )
            guard self.accountID == accountID else { return }
            defaults.set(registration.hostID, forKey: Keys.hostID)
            lastAdvertisedAt = Date()
            lastError = nil
            adopt(hostID: registration.hostID, for: accountID)
        } catch {
            guard self.accountID == accountID else { return }
            // Left readable and left beating. A refusal now is very often a token
            // about to be refreshed or a network about to come back, and the next
            // beat is thirty seconds away — which is both the retry and the
            // reason no backoff is needed here.
            lastError = error.localizedDescription
            phase = .failed
        }
    }

    /// Takes up the host row id: builds the executor against it and starts (or
    /// leaves stopped) the claim loop.
    private func adopt(hostID: String, for accountID: AccountID) {
        if executorProvider == nil, let executorFactory {
            let executor = executorFactory(hostID, accountID)
            executorProvider = { executor }
            policyObserver?(policy)
        }
        guard let relay else {
            // Presence without a claim loop. Honest rather than silent: the Mac
            // is listed and says what it can do, and `unavailabilityReason` will
            // report that nothing is serving.
            self.hostID = hostID
            phase = .off
            return
        }
        attach(accountID: accountID, hostID: hostID, relay: relay)
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
        policyObserver?(policy)
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
