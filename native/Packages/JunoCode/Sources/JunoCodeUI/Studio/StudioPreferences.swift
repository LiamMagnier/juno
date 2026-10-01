import Foundation
import Observation
import JunoCodeCore

/// How much of the agent's work the thread shows by default.
public enum StudioThreadDensity: String, CaseIterable, Identifiable, Sendable {
    /// Summaries only; every step folded, reasoning hidden.
    case compact
    /// Summaries, with the step in flight shown live.
    case balanced
    /// Every step open, reasoning shown.
    case detailed

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .compact: "Compact"
        case .balanced: "Balanced"
        case .detailed: "Detailed"
        }
    }

    public var detail: String {
        switch self {
        case .compact: "One line per stretch of work."
        case .balanced: "One line per stretch, with the current step live."
        case .detailed: "Every step, command and reasoning summary."
        }
    }
}

/// What Enter does while the agent is working.
public enum StudioFollowUpBehavior: String, CaseIterable, Identifiable, Sendable {
    /// Reaches the agent at its next safe point, mid-run.
    case steer
    /// Waits until the current run finishes.
    case queue

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .steer: "Steer the current run"
        case .queue: "Queue for after it finishes"
        }
    }

    var instructionKind: UserInstructionKind {
        switch self {
        case .steer: .steer
        case .queue: .queue
        }
    }
}

public enum StudioDiffLayout: String, CaseIterable, Identifiable, Sendable {
    case unified
    case split

    public var id: String { rawValue }
    public var label: String { self == .unified ? "Unified" : "Side by side" }
}

/// Presentation preferences for Juno Code: how the thread reads, how the
/// composer sends, when to notify.
///
/// These are about this Mac's window, not about what the agent may do, so
/// they live in `UserDefaults` rather than in the settings files — a team has
/// no business checking in someone's density preference.
@MainActor
@Observable
public final class StudioPreferences {
    public static let shared = StudioPreferences()

    private enum Key {
        static let density = "juno.code.studio.density"
        static let showReasoning = "juno.code.studio.show-reasoning"
        static let diffLayout = "juno.code.studio.diff-layout"
        static let wrapLines = "juno.code.studio.wrap-lines"
        static let followUp = "juno.code.studio.follow-up"
        static let commandReturnSends = "juno.code.studio.command-return-sends"
        static let notifyDone = "juno.code.studio.notify-done"
        static let notifyNeedsYou = "juno.code.studio.notify-needs-you"
        static let notifyOnlyInBackground = "juno.code.studio.notify-background-only"
        static let notificationSound = "juno.code.studio.notification-sound"
        static let keepAwake = "juno.code.studio.keep-awake"
        static let showContextMeter = "juno.code.studio.context-meter"
        static let resumeInterruptedOnLaunch = "juno.code.studio.resume-interrupted-on-launch"
    }

    private let store: UserDefaults

    public init(store: UserDefaults = .standard) {
        self.store = store
        density = store.string(forKey: Key.density).flatMap(StudioThreadDensity.init(rawValue:)) ?? .balanced
        showReasoning = store.object(forKey: Key.showReasoning) as? Bool ?? false
        diffLayout = store.string(forKey: Key.diffLayout).flatMap(StudioDiffLayout.init(rawValue:)) ?? .unified
        wrapLines = store.object(forKey: Key.wrapLines) as? Bool ?? false
        followUp = store.string(forKey: Key.followUp).flatMap(StudioFollowUpBehavior.init(rawValue:)) ?? .steer
        commandReturnSends = store.object(forKey: Key.commandReturnSends) as? Bool ?? false
        notifyWhenDone = store.object(forKey: Key.notifyDone) as? Bool ?? true
        notifyWhenNeedsYou = store.object(forKey: Key.notifyNeedsYou) as? Bool ?? true
        notifyOnlyInBackground = store.object(forKey: Key.notifyOnlyInBackground) as? Bool ?? true
        notificationSound = store.object(forKey: Key.notificationSound) as? Bool ?? true
        keepAwakeWhileRunning = store.object(forKey: Key.keepAwake) as? Bool ?? true
        showContextMeter = store.object(forKey: Key.showContextMeter) as? Bool ?? true
        resumeInterruptedOnLaunch = store.object(forKey: Key.resumeInterruptedOnLaunch) as? Bool ?? false
    }

    public var density: StudioThreadDensity {
        didSet { store.set(density.rawValue, forKey: Key.density) }
    }

    /// Whether the model's reasoning summaries appear in the thread.
    public var showReasoning: Bool {
        didSet { store.set(showReasoning, forKey: Key.showReasoning) }
    }

    public var diffLayout: StudioDiffLayout {
        didSet { store.set(diffLayout.rawValue, forKey: Key.diffLayout) }
    }

    /// Whether long lines wrap in diffs and code blocks.
    public var wrapLines: Bool {
        didSet { store.set(wrapLines, forKey: Key.wrapLines) }
    }

    public var followUp: StudioFollowUpBehavior {
        didSet { store.set(followUp.rawValue, forKey: Key.followUp) }
    }

    /// ⌘↩ sends and ↩ inserts a new line, instead of the other way round.
    public var commandReturnSends: Bool {
        didSet { store.set(commandReturnSends, forKey: Key.commandReturnSends) }
    }

    public var notifyWhenDone: Bool {
        didSet { store.set(notifyWhenDone, forKey: Key.notifyDone) }
    }

    public var notifyWhenNeedsYou: Bool {
        didSet { store.set(notifyWhenNeedsYou, forKey: Key.notifyNeedsYou) }
    }

    /// Stay quiet while Juno is the frontmost app.
    public var notifyOnlyInBackground: Bool {
        didSet { store.set(notifyOnlyInBackground, forKey: Key.notifyOnlyInBackground) }
    }

    public var notificationSound: Bool {
        didSet { store.set(notificationSound, forKey: Key.notificationSound) }
    }

    /// Keep the Mac from sleeping while a run is working.
    public var keepAwakeWhileRunning: Bool {
        didSet { store.set(keepAwakeWhileRunning, forKey: Key.keepAwake) }
    }

    /// The small ring beside the model that fills as the context does.
    public var showContextMeter: Bool {
        didSet { store.set(showContextMeter, forKey: Key.showContextMeter) }
    }

    /// Carry on runs Juno quit in the middle of as soon as it opens again,
    /// rather than waiting for Resume. Off by default (D-025).
    public var resumeInterruptedOnLaunch: Bool {
        didSet { store.set(resumeInterruptedOnLaunch, forKey: Key.resumeInterruptedOnLaunch) }
    }

    public func resetToDefaults() {
        density = .balanced
        showReasoning = false
        diffLayout = .unified
        wrapLines = false
        followUp = .steer
        commandReturnSends = false
        notifyWhenDone = true
        notifyWhenNeedsYou = true
        notifyOnlyInBackground = true
        notificationSound = true
        keepAwakeWhileRunning = true
        showContextMeter = true
        resumeInterruptedOnLaunch = false
    }
}
