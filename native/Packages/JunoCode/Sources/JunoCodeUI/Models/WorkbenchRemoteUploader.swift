import Foundation
import JunoCodeKit

/// One uploader's lifetime against one workbench: the store observation it
/// owns, attached before it starts and removed when it ends.
///
/// The host switches uploads on and off with the Remote switch, and a quick
/// off-and-on used to leave the new uploader deaf. The old one's shutdown
/// awaited its retraction — a network request — before removing "the"
/// observer, which by then was the one the new uploader had just attached;
/// the new one had found an observer already in place and attached none. It
/// then heard about changes only from its minute-long reconcile. Here each
/// run holds the observation it was given and ends only that, and a run
/// starts only after the previous one has finished ending, so an old
/// retraction cannot land after the new list either.
@MainActor
public final class WorkbenchRemoteUploader {
    public let sync: CodeRemoteSessionSync
    private let bridge: WorkbenchRemoteBridge
    /// Resolves to this run's observation once it is attached, or nil when
    /// the run was ended before it began.
    private var starting: Task<WorkbenchRemoteBridge.RelayObservation?, Never>?
    private var ending: Task<Void, Never>?

    /// - Parameter previous: the previous run's `end(retracting:)`, which this
    ///   one waits out before attaching or sending anything.
    public init(
        sync: CodeRemoteSessionSync,
        bridge: WorkbenchRemoteBridge,
        after previous: Task<Void, Never>? = nil
    ) {
        self.sync = sync
        self.bridge = bridge
        starting = Task { [weak self] in
            await previous?.value
            guard let self, !self.isEnding else { return nil }
            let observation = await bridge.startRelayObservation { await sync.noteChange() }
            // Ended while the observer was being attached. `end` is waiting on
            // this task and removes the observation it returns.
            guard !self.isEnding else { return observation }
            await sync.start()
            return observation
        }
    }

    public var isEnding: Bool { ending != nil }

    /// Stops the uploader and removes its observation — this run's, never
    /// another's. Retracting also takes the sessions it listed off the phone.
    ///
    /// Returns the work in progress, for the next run to wait on. Calling it
    /// again returns the same task.
    @discardableResult
    public func end(retracting: Bool) -> Task<Void, Never> {
        if let ending { return ending }
        let starting = starting
        let bridge = bridge
        let sync = sync
        let task = Task {
            if let observation = await starting?.value {
                await bridge.stopRelayObservation(observation)
            }
            if retracting {
                await sync.retract()
            } else {
                await sync.stop()
            }
        }
        ending = task
        return task
    }
}
