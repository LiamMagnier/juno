import Foundation
import JunoAuth
import JunoCore

/// The two relay operations a Work host loop needs.
///
/// A seam, not an abstraction for its own sake. Everything that actually goes
/// wrong in remote execution lives in this loop: a claim landing after
/// sign-out, a revocation arriving mid-poll, a duplicate delivery, a lease
/// expiring while a command runs, a failure that must still be acknowledged.
/// Naming a concrete client here would mean none of those could be exercised
/// without a live server, which is the same as saying none of them are tested.
public protocol WorkRelaying: Sendable {
    /// Long-polls for the next command. Returning nil is the normal idle
    /// outcome, not a failure.
    func claimNextWorkCommand(
        hostID: String, for accountID: AccountID
    ) async throws -> WorkCommand?

    func acknowledgeWorkCommand(
        hostID: String,
        commandID: String,
        status: String,
        result: [String: JunoJSONValue]?,
        error: String?,
        for accountID: AccountID
    ) async throws

    /// Re-advertises what this Mac can currently do. Sent on every heartbeat
    /// rather than only at registration, because the answer changes when the
    /// user revokes a folder or switches a toggle off, and a relay routing on a
    /// stale manifest dispatches work the host will refuse.
    func advertiseWorkHost(
        hostID: String,
        policy: WorkHostPolicy,
        for accountID: AccountID
    ) async throws
}

/// How a Mac obtains — and keeps — its place on the account's host list.
///
/// A seam for the same reason ``WorkRelaying`` is one: the interesting cases are
/// a registration that lands after sign-out, a Mac whose device row was revoked,
/// and the very first registration of a machine that has no `hostID` yet. None
/// of those can be reached from a live server on demand.
public protocol WorkHostRegistering: Sendable {
    func registerWorkHost(
        identity: WorkHostIdentity,
        policy: WorkHostPolicy,
        for accountID: AccountID
    ) async throws -> WorkHostRegistration
}

/// What a claimed command is handed to.
///
/// The host loop deliberately executes nothing itself. It claims, checks,
/// hands over, and acknowledges. Execution belongs to the local Work runtime
/// with its own grants and approval flow, which is what makes it true that a
/// remote command cannot acquire a capability a local prompt does not already
/// have.
public protocol WorkCommandExecuting: Sendable {
    func execute(_ command: WorkCommand) async throws -> [String: JunoJSONValue]
}

/// Drives one Mac's participation in Juno Work: advertise, claim, check,
/// execute, acknowledge.
///
/// Explicitly activated and off by default. A Mac that silently began
/// accepting remote instructions the moment someone signed in would be a
/// genuinely dangerous default, and it is the one this actor exists to avoid.
public actor WorkRemoteHost {
    public enum State: Equatable, Sendable {
        case inactive
        case connecting
        case listening
        /// Reachable again after backing off; `attempt` drives the delay.
        case reconnecting(attempt: Int)
        /// Stopped and will not retry — the host was revoked, Work was switched
        /// off, or the account signed out. Distinguished from `reconnecting`
        /// because retrying a revocation forever is how a decommissioned Mac
        /// keeps polling a relay that has already told it to stop.
        case stopped(reason: String)
    }

    /// Why a claimed command was not executed.
    ///
    /// Recorded and acknowledged rather than swallowed. A command the host
    /// silently drops is one the relay keeps re-leasing and the user watches
    /// spin; a refusal with a reason is something the phone can render.
    public enum Refusal: String, Sendable {
        case expired
        case workDisabled
        case capabilityNotGranted
        case unsupportedKind
    }

    public private(set) var state: State = .inactive
    public private(set) var lastError: String?
    public private(set) var executedCommandCount = 0
    public private(set) var refusedCommandCount = 0
    /// Command identifiers this host has already acted on.
    ///
    /// The relay is idempotent by `idempotencyKey`, but re-delivery after a
    /// lease expiry is a normal, expected event — the host may have finished
    /// the work and lost the acknowledgement. Executing "move 400 files" twice
    /// because the ack was lost is exactly the failure the relay's idempotency
    /// cannot see, because from its side the second delivery is the first one
    /// it knows about.
    private var completedCommandIDs: Set<String> = []

    private let hostID: String
    private let accountID: AccountID
    private let relay: any WorkRelaying
    private let executor: any WorkCommandExecuting
    private let policyProvider: @Sendable () async -> WorkHostPolicy
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (Duration) async throws -> Void
    private let jitter: @Sendable () -> Double
    private var loop: Task<Void, Never>?

    /// Base delay between reconnect attempts, doubled per attempt and capped.
    /// The jitter is what stops a fleet of Macs that all lost the relay at the
    /// same moment from synchronising into a thundering herd against a service
    /// that has just come back up.
    static let baseBackoff = Duration.seconds(2)
    static let maximumBackoff = Duration.seconds(60)

    /// How many completed identifiers to remember.
    ///
    /// Bounded because this actor can live for weeks. The window only has to
    /// outlast the relay's re-delivery horizon, which is a lease, not a
    /// lifetime.
    static let completedCommandMemory = 512

    public init(
        hostID: String,
        accountID: AccountID,
        relay: any WorkRelaying,
        executor: any WorkCommandExecuting,
        policyProvider: @escaping @Sendable () async -> WorkHostPolicy,
        now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
        },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0.5...1.5) }
    ) {
        self.hostID = hostID
        self.accountID = accountID
        self.relay = relay
        self.executor = executor
        self.policyProvider = policyProvider
        self.now = now
        self.sleep = sleep
        self.jitter = jitter
    }

    /// Starts serving Work. Refuses when the policy says Work is off, rather
    /// than starting a loop that would refuse every command it claimed.
    @discardableResult
    public func activate() async -> Bool {
        guard loop == nil else { return true }
        let policy = await policyProvider()
        guard policy.enabled else {
            state = .stopped(reason: "Juno Work is switched off on this Mac.")
            return false
        }
        state = .connecting
        lastError = nil
        loop = Task { await run() }
        return true
    }

    /// Stops accepting work. Called on sign-out, on revocation, and when the
    /// user switches Work off. An in-flight command is cancelled rather than
    /// left to acknowledge against an account that is no longer signed in.
    public func deactivate(reason: String = "Deactivated") {
        loop?.cancel()
        loop = nil
        state = .stopped(reason: reason)
    }

    public func backoffDelay(attempt: Int) -> Duration {
        let doublings = min(attempt, 5)
        let scaled = Self.baseBackoff * Int(pow(2.0, Double(doublings)))
        let capped = min(scaled, Self.maximumBackoff)
        return capped.scaled(by: jitter())
    }

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                let policy = await policyProvider()

                // Re-read the policy every pass, not once at activation. The
                // user switching Work off in Settings has to take effect
                // against a loop that is already running, and the loop is
                // parked in a long poll for most of its life.
                guard policy.enabled else {
                    state = .stopped(reason: "Juno Work is switched off on this Mac.")
                    return
                }

                try await relay.advertiseWorkHost(
                    hostID: hostID, policy: policy, for: accountID
                )

                state = .listening
                lastError = nil
                attempt = 0

                let claimed = try await relay.claimNextWorkCommand(
                    hostID: hostID, for: accountID
                )

                // Re-check after the await. A long poll parks here for tens of
                // seconds, so deactivation almost always lands *during* it, and
                // a command claimed after sign-out must not run against an
                // account that is no longer signed in. The relay hands it back
                // out once this host's lease lapses.
                if Task.isCancelled { return }
                guard let command = claimed else { continue }

                await handle(command, under: policy)
            } catch is CancellationError {
                return
            } catch let error as WorkRemoteError {
                guard error.isRetryable else {
                    state = .stopped(reason: error.localizedDescription)
                    lastError = error.localizedDescription
                    return
                }
                await backOff(&attempt, error: error)
            } catch {
                await backOff(&attempt, error: error)
            }
        }
    }

    private func backOff(_ attempt: inout Int, error: any Error) async {
        attempt += 1
        lastError = error.localizedDescription
        state = .reconnecting(attempt: attempt)
        try? await sleep(backoffDelay(attempt: attempt))
    }

    private func handle(_ command: WorkCommand, under policy: WorkHostPolicy) async {
        // A re-delivery of something already done is acknowledged, not redone.
        if completedCommandIDs.contains(command.id) {
            try? await relay.acknowledgeWorkCommand(
                hostID: hostID, commandID: command.id, status: "succeeded",
                result: ["duplicate": .bool(true)], error: nil, for: accountID
            )
            return
        }

        if let refusal = refusal(for: command, under: policy) {
            refusedCommandCount += 1
            try? await relay.acknowledgeWorkCommand(
                hostID: hostID, commandID: command.id, status: "failed",
                result: ["refusal": .string(refusal.rawValue)],
                error: message(for: refusal), for: accountID
            )
            return
        }

        do {
            let result = try await executor.execute(command)
            executedCommandCount += 1
            remember(command.id)
            try await relay.acknowledgeWorkCommand(
                hostID: hostID, commandID: command.id, status: "succeeded",
                result: result, error: nil, for: accountID
            )
        } catch is CancellationError {
            return
        } catch {
            // A failed command still has to be acknowledged. Leaving it claimed
            // strands it: no other process can pick it up while the lease
            // holds, so silence here is a command that never completes and
            // never fails, which presents to the user as a task that is
            // starting forever.
            try? await relay.acknowledgeWorkCommand(
                hostID: hostID, commandID: command.id, status: "failed",
                result: nil, error: error.localizedDescription, for: accountID
            )
            lastError = error.localizedDescription
        }
    }

    /// Whether this Mac will act on a command at all.
    ///
    /// This is the escalation boundary. A command arrives naming what it wants
    /// to do; the host decides whether it may, from its own policy, and never
    /// from anything in the command. Nothing a remote sender can put in a
    /// payload widens the answer.
    ///
    /// `nonisolated` because it is a pure decision over its two arguments and
    /// the clock. That is not an optimisation: a security check that can only
    /// be evaluated by entering the actor is one that can only be tested by
    /// driving the whole loop, and the cases worth testing here are the ones a
    /// live loop reaches by accident.
    nonisolated func refusal(for command: WorkCommand, under policy: WorkHostPolicy) -> Refusal? {
        guard command.isStillValid(at: now()) else { return .expired }
        guard policy.enabled else { return .workDisabled }

        switch command.kind {
        case "start", "resume":
            // Starting local work needs at least one local capability; which
            // one is decided by the run's own plan, checked again at tool time.
            guard !policy.advertisedCapabilities.isEmpty else { return .capabilityNotGranted }
            return nil
        case "grant_folder", "revoke_grant":
            // A grant is created by the person at the Mac, in a file dialog.
            // A remote command may ask the host to *offer* the dialog; it can
            // never mint the grant, which is why this needs file work to be on
            // but still cannot bypass the picker.
            guard policy.allowsFileWork else { return .capabilityNotGranted }
            return nil
        case "pause", "stop", "answer", "approve", "deny", "undo",
             "refresh_capabilities", "ping":
            // Control-plane instructions. These only ever reduce what is
            // happening or answer a question the host itself asked, so they
            // need no capability beyond Work being on.
            return nil
        default:
            return .unsupportedKind
        }
    }

    nonisolated private func message(for refusal: Refusal) -> String {
        switch refusal {
        case .expired:
            "That instruction expired before this Mac could act on it."
        case .workDisabled:
            "Juno Work is switched off on this Mac."
        case .capabilityNotGranted:
            "This Mac has not been granted what that instruction needs."
        case .unsupportedKind:
            "This Mac's version of Juno does not understand that instruction."
        }
    }

    private func remember(_ commandID: String) {
        completedCommandIDs.insert(commandID)
        if completedCommandIDs.count > Self.completedCommandMemory {
            // Cheap eviction. Exact LRU is unnecessary: the window only has to
            // outlast the relay's re-delivery horizon, and dropping a random
            // half costs at worst one duplicate execution of something whose
            // lease has long expired.
            completedCommandIDs = Set(completedCommandIDs.dropFirst(Self.completedCommandMemory / 2))
        }
    }
}

extension Duration {
    /// `Duration` has no multiplication by a `Double`, and the backoff jitter is
    /// fractional. Deliberately duplicated from the Juno Code host rather than
    /// shared: making JunoWorkKit depend on JunoCodeKit to borrow six lines
    /// would couple two products so that a change to one rebuilds the other.
    func scaled(by factor: Double) -> Duration {
        let attoseconds = Double(components.seconds) * 1e18
            + Double(components.attoseconds)
        return .nanoseconds(Int64(attoseconds * factor / 1e9))
    }
}
