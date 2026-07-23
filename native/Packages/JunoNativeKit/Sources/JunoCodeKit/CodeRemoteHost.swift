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
public protocol CodeRemoteCommandExecuting: Sendable {
    /// Returns a result payload on success. Throwing marks the command failed
    /// and reports the message back to the relay.
    func execute(_ command: CodeRemoteCommand) async throws -> [String: JunoJSONValue]
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
    private let client: NativeCodeRemoteClient
    private let executor: any CodeRemoteCommandExecuting
    private let sleep: @Sendable (Duration) async throws -> Void
    private let jitter: @Sendable () -> Double
    private var loop: Task<Void, Never>?

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
        client: NativeCodeRemoteClient,
        executor: any CodeRemoteCommandExecuting,
        sleep: @escaping @Sendable (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
        },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0.5...1.5) }
    ) {
        self.deviceID = deviceID
        self.accountID = accountID
        self.client = client
        self.executor = executor
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
                let claimed = try await client.claimNextCommand(
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
        do {
            let result = try await executor.execute(command)
            executedCommandCount += 1
            try await client.acknowledgeCommand(
                deviceID: deviceID, commandID: command.id,
                status: "completed", result: result, error: nil, for: accountID
            )
        } catch is CancellationError {
            return
        } catch {
            // A failed command still has to be acknowledged. Leaving it claimed
            // would strand it: the relay's CAS means no other process can pick
            // it up, so silence here is a command that never completes and
            // never fails.
            try? await client.acknowledgeCommand(
                deviceID: deviceID, commandID: command.id,
                status: "failed", result: nil,
                error: error.localizedDescription, for: accountID
            )
            lastError = error.localizedDescription
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
