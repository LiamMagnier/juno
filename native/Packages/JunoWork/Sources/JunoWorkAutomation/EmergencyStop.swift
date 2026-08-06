import Foundation

// MARK: - What is running

/// What automation is doing right now, in the words the indicator uses.
public struct AutomationActivity: Hashable, Sendable {
    public let tier: AutomationTier
    public let intent: AutomationIntent
    public let subject: AutomationSubject

    public init(tier: AutomationTier, intent: AutomationIntent, subject: AutomationSubject) {
        self.tier = tier
        self.intent = intent
        self.subject = subject
    }
}

/// Proof that automation was running, and that this action is the one it was
/// running for.
///
/// The generation is `fileprivate`, so nothing outside this file can construct a
/// token or age one forward. A control cannot therefore hold onto authority
/// across a stop: the token it has names a generation that no longer exists, and
/// every checkpoint says so.
public struct AutomationRunToken: Hashable, Sendable {
    public let runID: String
    public let activity: AutomationActivity
    fileprivate let generation: UInt64
}

/// The state a UI shows while automation is running.
///
/// This exists because an agent driving somebody's screen with no indicator is
/// indistinguishable from malware — to the person watching, and to anybody they
/// later describe it to. The indicator is not a courtesy; it is the difference
/// between software that can be trusted with this capability and software that
/// cannot.
public struct AutomationActiveUse: Hashable, Sendable {
    public let runID: String
    public let activity: AutomationActivity
    public let startedAt: Date
    /// How many actions this run has performed, so a stuck run and a busy one
    /// look different.
    public let actionCount: Int

    /// The sentence beside the indicator. Identifiers only — the subject is a
    /// bundle identifier or a domain, never anything read off the screen.
    public var phrase: String {
        "Juno is using \(activity.tier.label.lowercased()) on \(activity.subject.auditIdentifier)."
    }
}

// MARK: - The stop

/// The single switch every control checks before every action and again after
/// every await.
///
/// Four properties, and each one exists because the version without it has a
/// name:
///
/// - **Immediate.** No method of this actor awaits anything. The kill switch
///   therefore never queues behind an in-flight driver call: a `stop()` sent
///   while a capture is running is serviced between suspension points rather
///   than after the capture finishes.
/// - **Total.** Stopping bumps a generation. Every outstanding token names the
///   old one, so nothing that was already in flight can complete and nothing
///   queued behind it can start. There is no per-run stop, because a person
///   holding the stop key does not mean "stop the browser one".
/// - **Sticky.** Automation does not resume because the next action asked
///   nicely. ``resume(afterHumanGesture:)`` refuses unless a person did
///   something, exactly as Juno Code's coordinator refuses to activate without
///   consent.
/// - **Visible.** ``activeUse`` is what the indicator renders, and it is set by
///   the same call that authorises the action rather than by the UI remembering
///   to.
public actor EmergencyStop {
    private var stopped: Bool
    private var stopReason: String?
    /// Bumped by every stop and every end. A resumed action compares the
    /// generation in its token against this one, which is what makes a control
    /// that was mid-await when the stop fired unable to complete.
    private var generation: UInt64 = 0
    private var active: AutomationActiveUse?
    private var observers: [UUID: @Sendable (AutomationActiveUse?) -> Void] = [:]
    private let now: @Sendable () -> Date

    public init(stopped: Bool = false, now: @escaping @Sendable () -> Date = { Date() }) {
        self.stopped = stopped
        self.stopReason = stopped ? "Automation has not been started on this Mac." : nil
        self.now = now
    }

    // MARK: Reading

    public var isStopped: Bool { stopped }
    public var reason: String? { stopReason }
    /// What the indicator shows. Nil means nothing is being driven.
    public var activeUse: AutomationActiveUse? { active }

    @discardableResult
    public func addObserver(
        _ observer: @escaping @Sendable (AutomationActiveUse?) -> Void
    ) -> UUID {
        let id = UUID()
        observers[id] = observer
        // Called immediately with the current state, so an indicator that
        // appears mid-run shows the run rather than nothing until the next
        // action happens to change something.
        observer(active)
        return id
    }

    public func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }

    // MARK: Running

    /// Starts one action and lights the indicator.
    ///
    /// Refuses while another action is in flight. Not a queue: a queued action
    /// is an action that runs after a stop, which is the exact thing this type
    /// exists to make impossible.
    public func begin(runID: String, activity: AutomationActivity) throws -> AutomationRunToken {
        guard !stopped else {
            throw AutomationRefusal(
                .emergencyStopped,
                stopReason ?? "Juno's control of this Mac is stopped."
            )
        }
        if let active {
            throw AutomationRefusal(
                .tooFast,
                "Juno is already doing something on this Mac (\(active.activity.tier.label.lowercased()))."
            )
        }
        let use = AutomationActiveUse(
            runID: runID,
            activity: activity,
            startedAt: now(),
            actionCount: 0
        )
        active = use
        notify()
        return AutomationRunToken(runID: runID, activity: activity, generation: generation)
    }

    /// The check that runs before every action and again after every await.
    ///
    /// Both halves matter. Before, because an action that starts after a stop
    /// has no business starting; after, because a control suspended in a driver
    /// call when the stop fired is holding a screenshot and a click that must
    /// not be delivered.
    public func checkpoint(_ token: AutomationRunToken) throws {
        guard !stopped else {
            throw AutomationRefusal(
                .emergencyStopped,
                stopReason ?? "Juno's control of this Mac is stopped."
            )
        }
        guard token.generation == generation, active?.runID == token.runID else {
            throw AutomationRefusal(
                .emergencyStopped,
                "Juno's control of this Mac was interrupted, so it stopped rather than carry on."
            )
        }
    }

    /// Records one completed step, for the indicator's action count.
    public func note(_ token: AutomationRunToken) throws {
        try checkpoint(token)
        guard let use = active else { return }
        active = AutomationActiveUse(
            runID: use.runID,
            activity: use.activity,
            startedAt: use.startedAt,
            actionCount: use.actionCount + 1
        )
        notify()
    }

    /// Ends one action and clears the indicator.
    ///
    /// Bumps the generation, so a token kept by a control that returned still
    /// cannot be used to perform a second action without going through
    /// ``begin(runID:activity:)`` and therefore through the whole gate again.
    public func end(_ token: AutomationRunToken) {
        guard token.generation == generation, active?.runID == token.runID else { return }
        active = nil
        generation &+= 1
        notify()
    }

    // MARK: Stopping

    /// The kill switch: immediate, unconditional, and always available.
    ///
    /// Safe to call when nothing is running and safe to call twice. A stop that
    /// could fail is a stop somebody has to check the result of while their
    /// screen is being typed into.
    public func stop(reason: String = "You stopped Juno.") {
        stopped = true
        stopReason = reason
        active = nil
        generation &+= 1
        notify()
    }

    /// Allows automation again.
    ///
    /// - Parameter afterHumanGesture: must be the result of a person doing
    ///   something in the UI. Passing false is always an error, mirroring
    ///   `ComputerUseCoordinator.activate(sessionID:userConsented:)`. A model
    ///   that can clear its own stop has not been stopped.
    public func resume(afterHumanGesture: Bool) throws {
        guard afterHumanGesture else {
            throw AutomationRefusal(
                .emergencyStopped,
                "Only you can let Juno start controlling this Mac again."
            )
        }
        stopped = false
        stopReason = nil
        generation &+= 1
        notify()
    }

    private func notify() {
        let snapshot = active
        for observer in observers.values { observer(snapshot) }
    }
}
