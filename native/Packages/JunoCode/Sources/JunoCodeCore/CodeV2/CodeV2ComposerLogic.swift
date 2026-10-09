import Foundation

/// The composer's decisions, kept out of the view so they can be tested
/// (DESIGN §5.5–§5.6, §8; INTERACTION I-1, I-13, I-17).
public enum CodeV2ComposerLogic {
    /// The composer's visible state, which drives the glow.
    public enum Tone: Equatable, Sendable {
        case idle
        case working
        case needsYou
        case limited
    }

    public static func tone(state: CodeV2.SessionState, hasPendingRequest: Bool) -> Tone {
        if hasPendingRequest || state == .waiting { return .needsYou }
        switch state {
        case .running: return .working
        case .limited: return .limited
        case .idle, .error, .waiting: return .idle
        }
    }

    /// What the round button at the end of the footer does now.
    public enum PrimaryButton: Equatable, Sendable {
        case send(enabled: Bool)
        case stop
        /// Running with a draft: Send queues it.
        case queue
    }

    public static func primaryButton(isRunning: Bool, draft: String, hasAttachments: Bool = false, canSend: Bool = true) -> PrimaryButton {
        let empty = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !hasAttachments
        if isRunning { return empty ? .stop : .queue }
        return .send(enabled: !empty && canSend)
    }

    /// What a key press in the field means.
    public enum Submission: Equatable, Sendable {
        case send
        case queue
        case steer
        case ignore
    }

    /// ↵ sends (queues while running); ⌘↵ steers while running and only if the
    /// runtime can steer; ⇧↵ / ⌥↵ are newlines.
    public static func submission(
        command: Bool, shift: Bool, option: Bool, isRunning: Bool, canSteer: Bool, draftIsEmpty: Bool
    ) -> Submission {
        if shift || option || draftIsEmpty { return .ignore }
        if isRunning {
            if command { return canSteer ? .steer : .queue }
            return .queue
        }
        return .send
    }

    public static func placeholder(isRunning: Bool, hasProvider: Bool = true) -> String {
        guard hasProvider else { return "Connect a subscription or add a key to start" }
        return isRunning ? "Queue a follow-up. ⌘↩ to steer now" : "Ask for a change. @ for files, / for commands"
    }
}

/// Esc pressed twice within the window stops the turn (DESIGN §8, I-17).
/// The first press only arms it and shows "Press Esc again to stop".
public struct CodeV2DoubleEscape: Equatable, Sendable {
    public static let window: TimeInterval = 0.6
    public private(set) var armedAt: Date?

    public init() {}

    public enum Outcome: Equatable, Sendable { case armed, fire }

    public mutating func press(at date: Date = Date()) -> Outcome {
        if let armedAt, date.timeIntervalSince(armedAt) <= Self.window {
            self.armedAt = nil
            return .fire
        }
        armedAt = date
        return .armed
    }

    public func isArmed(at date: Date = Date()) -> Bool {
        guard let armedAt else { return false }
        return date.timeIntervalSince(armedAt) <= Self.window
    }

    public mutating func reset() { armedAt = nil }
}

/// The queue dock's rows (DESIGN §5.5): up to three, then "+n more".
public struct CodeV2QueueDockModel: Equatable, Sendable {
    public static let visibleRows = 3
    public var items: [CodeV2.QueuedInput]

    public init(items: [CodeV2.QueuedInput]) { self.items = items }

    public var visible: [CodeV2.QueuedInput] { Array(items.prefix(Self.visibleRows)) }
    public var overflowLabel: String? {
        items.count > Self.visibleRows ? "+\(items.count - Self.visibleRows) more" : nil
    }

    /// ⌥↑ edits the newest queued item.
    public var lastEditable: CodeV2.QueuedInput? { items.last }

    /// Moves an item within the queue (drag to reorder).
    public static func moving(_ items: [CodeV2.QueuedInput], from source: Int, to destination: Int) -> [CodeV2.QueuedInput] {
        guard items.indices.contains(source) else { return items }
        var copy = items
        let item = copy.remove(at: source)
        copy.insert(item, at: min(max(0, destination), copy.count))
        return copy
    }
}

/// The runtime modes as the composer's Mode menu names them (SPEC §3.7).
public extension CodeV2.RuntimeMode {
    var title: String {
        switch self {
        case .readOnly: "Read-only"
        case .ask: "Ask"
        case .autoEdit: "Auto-edit"
        case .auto: "Auto"
        case .full: "Full access"
        }
    }

    var summary: String {
        switch self {
        case .readOnly: "Reads and searches. Asks before any change."
        case .ask: "Asks before every edit and command."
        case .autoEdit: "Edits files in the workspace; asks before commands."
        case .auto: "A reviewer model approves routine actions; asks for the rest."
        case .full: "Runs anything without asking. Use in a throwaway worktree."
        }
    }
}

public extension CodeV2.EffortLevel {
    var title: String {
        switch self {
        case .none: "Off"
        case .minimal: "Minimal"
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .xhigh: "Extra high"
        case .max: "Max"
        }
    }

    /// ⌘⇧E cycles through the model's own levels.
    static func cycled(from current: CodeV2.EffortLevel?, in levels: [CodeV2.EffortLevel]) -> CodeV2.EffortLevel? {
        guard !levels.isEmpty else { return current }
        guard let current, let index = levels.firstIndex(of: current) else { return levels.first }
        return levels[(index + 1) % levels.count]
    }
}

/// The traits control's label: "High · 1M", "High · 1M · Fast".
public enum CodeV2Traits {
    public static func label(effort: CodeV2.EffortLevel?, contextTokens: Int?, fast: Bool, lean: Bool = false) -> String {
        var parts: [String] = []
        if let effort, effort != .none { parts.append(effort.title) }
        if lean {
            parts.append(CodeV2ContextMath.label(tokens: CodeV2ContextMath.leanWindow))
        } else if let contextTokens {
            parts.append(CodeV2ContextMath.label(tokens: contextTokens))
        }
        if fast { parts.append("Fast") }
        return parts.isEmpty ? "Default" : parts.joined(separator: " · ")
    }
}
