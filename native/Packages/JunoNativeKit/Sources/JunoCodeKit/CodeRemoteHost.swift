import Foundation
import JunoAuth
import JunoCore

/// What a claimed command is handed to.
///
/// The host loop deliberately does not execute anything itself. It claims,
/// hands over, and acknowledges — execution belongs to the existing JunoCode
/// runtime, with its own tool permissions and approval flow. Keeping that
/// boundary means remote commands cannot acquire capabilities that a local
/// prompt does not already have, which is the whole security story of Remote.
/// The two relay operations the host loop needs.
///
/// A seam, not an abstraction for its own sake: `CodeRemoteHost` used to name
/// `NativeCodeRemoteClient` directly, which meant the loop — claim, execute,
/// acknowledge, back off, stop on revocation — could only be exercised against
/// a live server. Everything that actually goes wrong in Remote lives in that
/// loop's seams: a claim landing after sign-out, a revocation mid-poll, a
/// duplicate delivery, a failure that must still be acknowledged.
public protocol CodeRemoteRelaying: Sendable {
    /// Long-polls for work. Returning nil is the normal idle outcome.
    func claimNextCommand(
        deviceID: String, for accountID: AccountID
    ) async throws -> CodeRemoteCommand?

    func acknowledgeCommand(
        deviceID: String,
        commandID: String,
        status: String,
        result: [String: JunoJSONValue]?,
        error: String?,
        for accountID: AccountID
    ) async throws
}

extension NativeCodeRemoteClient: CodeRemoteRelaying {}

public protocol CodeRemoteCommandExecuting: Sendable {
    /// Returns a result payload on success. Throwing marks the command failed
    /// and reports the message back to the relay.
    func execute(_ command: CodeRemoteCommand) async throws -> [String: JunoJSONValue]
}

/// What a host remembers about the commands it has already run.
///
/// The relay hands a claimed command out again when its acknowledgement does
/// not arrive within the lease — a dropped connection, a sleeping Mac, a crash.
/// That redelivery is what stops a command being stuck forever, and this is
/// what stops it being run twice: a second "send this prompt" or a second
/// commit is worse than a clear failure. A redelivered command is answered from
/// here with the outcome it already had.
///
/// At most once, deliberately. A command recorded as started but never
/// finished — the Mac stopped mid-run — is reported failed rather than
/// retried, because whether it took effect is exactly what cannot be known.
public actor CodeRemoteCommandLedger {
    public enum Outcome: Codable, Equatable, Sendable {
        case started
        case completed([String: JunoJSONValue])
        case failed(String)
    }

    private struct Entry: Codable {
        let id: String
        var outcome: Outcome
    }

    /// Enough to cover every command a lease could hand back, and small
    /// enough to persist on every change.
    public static let defaultCapacity = 200

    private let capacity: Int
    private let write: @Sendable (Data) -> Void
    private var entries: [Entry]

    public init(
        capacity: Int = CodeRemoteCommandLedger.defaultCapacity,
        read: @Sendable () -> Data? = { nil },
        write: @escaping @Sendable (Data) -> Void = { _ in }
    ) {
        self.capacity = capacity
        self.write = write
        entries = read().flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
    }

    public func outcome(for commandID: String) -> Outcome? {
        entries.last { $0.id == commandID }?.outcome
    }

    public func record(_ outcome: Outcome, for commandID: String) {
        if let index = entries.lastIndex(where: { $0.id == commandID }) {
            entries[index].outcome = outcome
        } else {
            entries.append(Entry(id: commandID, outcome: outcome))
            if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
        }
        if let data = try? JSONEncoder().encode(entries) { write(data) }
    }
}

/// Drives one Mac's participation in Remote: heartbeat, claim, execute,
/// acknowledge.
///
/// Explicitly activated. Nothing here starts on its own, because a Mac that
/// silently began accepting remote commands the moment someone signed in would
/// be a genuinely dangerous default.
public actor CodeRemoteHost {
    public enum State: Equatable, Sendable {
        case inactive
        case connecting
        case listening
        /// Reachable again after backing off; `attempt` drives the delay.
        case reconnecting(attempt: Int)
        /// Stopped and will not retry — the device was revoked, or the account
        /// signed out. Distinguished from `reconnecting` because retrying a
        /// revocation forever is how a decommissioned Mac keeps polling.
        case stopped(reason: String)
    }

    public private(set) var state: State = .inactive
    public private(set) var lastError: String?
    public private(set) var executedCommandCount = 0

    private let deviceID: String
    private let accountID: AccountID
    private let relay: any CodeRemoteRelaying
    private let executor: any CodeRemoteCommandExecuting
    private let ledger: CodeRemoteCommandLedger
    private let sleep: @Sendable (Duration) async throws -> Void
    private let jitter: @Sendable () -> Double
    private var loop: Task<Void, Never>?

    /// Attempts at delivering one acknowledgement before leaving it to the
    /// relay's lease. Past this the relay hands the command back and the
    /// ledger answers it then, so giving up here loses nothing.
    static let acknowledgementAttempts = 3

    /// Base delay between reconnect attempts, doubled per attempt and capped.
    /// Every host that lost the relay at the same moment would otherwise return
    /// at the same moment; the jitter is what stops a fleet of Macs
    /// synchronising into a thundering herd against a service that has just
    /// come back up.
    static let baseBackoff = Duration.seconds(2)
    static let maximumBackoff = Duration.seconds(60)

    public init(
        deviceID: String,
        accountID: AccountID,
        relay: any CodeRemoteRelaying,
        executor: any CodeRemoteCommandExecuting,
        ledger: CodeRemoteCommandLedger = CodeRemoteCommandLedger(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
        },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0.5...1.5) }
    ) {
        self.deviceID = deviceID
        self.accountID = accountID
        self.relay = relay
        self.executor = executor
        self.ledger = ledger
        self.sleep = sleep
        self.jitter = jitter
    }

    public func activate() {
        guard loop == nil else { return }
        state = .connecting
        lastError = nil
        loop = Task { await run() }
    }

    /// Stops accepting work. Called on sign-out and on explicit deactivation;
    /// an in-flight command is cancelled rather than left to acknowledge
    /// against an account that is no longer signed in.
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
                state = .listening
                lastError = nil
                attempt = 0

                // A nil command is the normal idle outcome of the relay's long
                // poll, not a failure — looping straight back is correct.
                let claimed = try await relay.claimNextCommand(
                    deviceID: deviceID, for: accountID
                )

                // Re-check after the await. A long poll parks here for ~25
                // seconds, so deactivation almost always lands *during* it —
                // and a command claimed after sign-out must not be executed
                // against an account that is no longer signed in. The relay
                // will hand it back out once this host's claim lapses.
                if Task.isCancelled { return }
                guard let command = claimed else { continue }

                await handle(command)
            } catch is CancellationError {
                return
            } catch let error as CodeRemoteError {
                // A refusal will keep refusing. Retrying a revoked device
                // forever is how a decommissioned Mac keeps polling a relay
                // that has already told it to stop.
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

    private func handle(_ command: CodeRemoteCommand) async {
        // A command handed out again is one whose acknowledgement never
        // landed. Answer it with what already happened; never run it twice.
        if let prior = await ledger.outcome(for: command.id) {
            switch prior {
            case .completed(let result):
                await acknowledge(command, status: "completed", result: result, error: nil)
            case .failed(let message):
                await acknowledge(command, status: "failed", result: nil, error: message)
            case .started:
                await acknowledge(
                    command, status: "failed", result: nil,
                    error: "This Mac stopped while running this command, so it was not run again. "
                        + "Check the session before sending it once more."
                )
            }
            return
        }

        await ledger.record(.started, for: command.id)
        do {
            let result = try await executor.execute(command)
            executedCommandCount += 1
            await ledger.record(.completed(result), for: command.id)
            await acknowledge(command, status: "completed", result: result, error: nil)
        } catch is CancellationError {
            return
        } catch {
            // A failed command still has to be acknowledged. Leaving it claimed
            // would strand it until its lease ran out, and the phone would show
            // a command that neither completed nor failed.
            let message = error.localizedDescription
            await ledger.record(.failed(message), for: command.id)
            lastError = message
            await acknowledge(command, status: "failed", result: nil, error: message)
        }
    }

    /// Delivers one acknowledgement, retrying a transient failure briefly.
    ///
    /// A refusal is final: the relay answers 409 when the command was already
    /// settled — its lease ran out and it was failed, or a redelivery was
    /// answered first — and repeating the same answer cannot change that.
    private func acknowledge(
        _ command: CodeRemoteCommand,
        status: String,
        result: [String: JunoJSONValue]?,
        error: String?
    ) async {
        for attempt in 1...Self.acknowledgementAttempts {
            do {
                try await relay.acknowledgeCommand(
                    deviceID: deviceID, commandID: command.id,
                    status: status, result: result, error: error, for: accountID
                )
                return
            } catch is CancellationError {
                return
            } catch let failure as CodeRemoteError where !failure.isRetryable {
                lastError = failure.localizedDescription
                return
            } catch let failure {
                lastError = failure.localizedDescription
                guard attempt < Self.acknowledgementAttempts else { return }
                do {
                    try await sleep(backoffDelay(attempt: attempt))
                } catch {
                    return
                }
            }
        }
    }
}

extension Duration {
    /// Duration has no `*` by a Double, and the jitter is fractional.
    func scaled(by factor: Double) -> Duration {
        let attoseconds = Double(components.seconds) * 1e18
            + Double(components.attoseconds)
        let scaled = attoseconds * factor
        return .nanoseconds(Int64(scaled / 1e9))
    }
}
