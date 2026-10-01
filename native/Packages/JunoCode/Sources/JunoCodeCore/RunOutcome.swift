import Foundation

// The vocabulary of an autonomous run's ending and continuing, shared by the
// loop (Lane A), the recorders (Lanes B, C, D), the runs list and
// notifications (Lane E) and the agent protocol. See
// docs/rework/CODE_AGENT_SPEC.md §1.3–§1.6.

/// Why a run ended. Every run ends with exactly one, and the divider, the
/// notification, the runs list and the protocol all say it the same way.
///
/// The raw values are the protocol's `RunEndReason` values
/// (contracts/agent/juno-agent-protocol-v1.json), character for character.
public enum RunEndReason: String, Codable, CaseIterable, Sendable {
    /// The stop check passed and fresh passing checks cover the change.
    case doneChecked = "done_checked"
    /// The stop check passed, but no check is known or the change needs none.
    case doneUnchecked = "done_unchecked"
    /// The model finished after a `checks_failing` continuation and the check
    /// still fails.
    case checksFailing = "checks_failing"
    /// The model marked the remaining work blocked with a reason, or a goal was
    /// judged impossible.
    case blocked
    /// Waiting for an approval or an answer, parked until the reader decides.
    case needsYou = "needs_you"
    /// The step limit was reached and a wrap-up turn ran.
    case stepLimit = "step_limit"
    /// A run or goal budget was reached and a wrap-up turn ran. Never "done".
    case budget
    /// Two continuation turns in a row made no tool call.
    case stalled
    /// Background shells or sub-agents still run; the run resumes when one
    /// reports.
    case waitingOnBackground = "waiting_on_background"
    /// The reader pressed Stop.
    case stopped
    /// Juno quit or crashed mid-run.
    case interrupted
    /// An error the retry policy could not clear.
    case error

    /// How the reader is told, per the §1.3 table.
    public var notification: RunEndNotification {
        switch self {
        case .doneChecked, .doneUnchecked: .done
        case .checksFailing, .blocked, .needsYou, .stepLimit, .budget, .stalled: .needsYou
        case .error: .failed
        case .waitingOnBackground, .stopped, .interrupted: .none
        }
    }

    /// Whether the reader can pick the run up with Keep going, which grants
    /// another block of steps or budget and resumes without a new message.
    public var offersKeepGoing: Bool {
        switch self {
        case .stepLimit, .budget, .stalled: true
        default: false
        }
    }
}

/// What kind of notification a run's end deserves.
public enum RunEndNotification: String, Codable, Sendable {
    case done
    case needsYou
    case failed
    /// Nothing: the reader did it, or the run is not over.
    case none
}

/// Why the stop check did not let a turn end. The raw values are what the
/// `<juno_runtime reason="…">` fence carries and what the protocol's
/// `run.continued.reason` says.
public enum GateReason: String, Codable, CaseIterable, Sendable {
    case todosOpen = "todos_open"
    case unverified
    case checksFailing = "checks_failing"
    case uiUnchecked = "ui_unchecked"
    case diffUnreviewed = "diff_unreviewed"
    case reviewFindings = "review_findings"
    case goalNotMet = "goal_not_met"
}

/// What started a turn. The raw values are the protocol's `TurnOrigin`.
public enum TurnOrigin: String, Codable, CaseIterable, Sendable {
    /// A message the reader sent, or a reader action such as Resume, Retry or
    /// Keep going.
    case user
    case steer
    case queue
    case hook
    case remote
    case schedule
    /// The stop check sent the agent back before it could finish.
    case gate
    /// The goal runtime continued toward an active goal.
    case goal
    /// Background work reported, or a check-in on it was due.
    case checkin
    /// A pull request's CI finished and the agent follows up.
    case ci
}

/// A message from Juno's runtime to the model: why the loop kept going, or
/// what to pick up after a resume.
///
/// It travels as a user-role message fenced as runtime text, so the model knows
/// who wrote it and compaction and rewind never take it for the reader's words:
///
/// ```
/// <juno_runtime reason="checks_failing" revision="14">
/// Before finishing: `npm test` failed after your last edit…
/// </juno_runtime>
/// ```
public struct RuntimeNote: Hashable, Codable, Sendable {
    /// Why the note was written. A gate reason, or one of the runtime's own.
    public enum Reason: Hashable, Codable, Sendable {
        case gate(GateReason)
        /// The reader asked to try the failed turn again.
        case retry
        /// Juno quit mid-run and the reader pressed Resume.
        case afterQuit
        /// The reader granted another block of steps or budget.
        case keepGoing
        /// The model's output was cut off at its limit.
        case outputLimit
        /// The last turn before a step limit or budget: summarise and stop.
        case wrapUp
        /// Background work reported, or a check-in on it is due.
        case checkIn
        /// A reason from a newer build, kept verbatim.
        case other(String)

        public init(rawValue: String) {
            if let gate = GateReason(rawValue: rawValue) {
                self = .gate(gate)
                return
            }
            switch rawValue {
            case "retry": self = .retry
            case "after_quit": self = .afterQuit
            case "keep_going": self = .keepGoing
            case "output_limit": self = .outputLimit
            case "wrap_up": self = .wrapUp
            case "checkin": self = .checkIn
            default: self = .other(rawValue)
            }
        }

        /// The fence's `reason` attribute and the protocol's
        /// `run.continued.reason`.
        public var rawValue: String {
            switch self {
            case let .gate(reason): reason.rawValue
            case .retry: "retry"
            case .afterQuit: "after_quit"
            case .keepGoing: "keep_going"
            case .outputLimit: "output_limit"
            case .wrapUp: "wrap_up"
            case .checkIn: "checkin"
            case let .other(value): value
            }
        }

        public init(from decoder: Decoder) throws {
            self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public var reason: Reason
    /// The imperative text the model reads: the concrete fact and what to do.
    public var text: String
    /// The workspace revision the note was written at, when it matters.
    public var revision: Int?
    /// Extra fence attributes (`goal="g3"`, `turn="8"`), in order.
    public var attributes: [Attribute]

    public struct Attribute: Hashable, Codable, Sendable {
        public var name: String
        public var value: String

        public init(_ name: String, _ value: String) {
            self.name = name
            self.value = value
        }
    }

    public init(reason: Reason, text: String, revision: Int? = nil, attributes: [Attribute] = []) {
        self.reason = reason
        self.text = text
        self.revision = revision
        self.attributes = attributes
    }

    /// The opening of every runtime note, and how one is recognised.
    public static let openingPrefix = "<juno_runtime"
    public static let closingTag = "</juno_runtime>"

    /// The fenced user-role text the model receives.
    public var rendered: String {
        var opening = "\(Self.openingPrefix) reason=\"\(Self.escapeAttribute(reason.rawValue))\""
        if let revision {
            opening += " revision=\"\(revision)\""
        }
        for attribute in attributes where Self.isAttributeName(attribute.name) {
            opening += " \(attribute.name)=\"\(Self.escapeAttribute(attribute.value))\""
        }
        opening += ">"
        // The body cannot close the fence early: a model that sees the closing
        // tag inside would read what follows as the reader's.
        let body = text.replacingOccurrences(of: Self.closingTag, with: "<\\/juno_runtime>")
        return opening + "\n" + body + "\n" + Self.closingTag
    }

    /// Whether a user-role message is a runtime note, written whole by Juno:
    /// fenced from its first character to its last.
    public static func isRuntimeNote(_ text: String) -> Bool {
        (text.hasPrefix(openingPrefix + " ") || text.hasPrefix(openingPrefix + ">"))
            && text.hasSuffix(closingTag)
    }

    /// The note's body, without the fence, or nil when `text` is not a note.
    public static func body(of text: String) -> String? {
        guard isRuntimeNote(text),
              let open = text.range(of: ">\n"),
              let close = text.range(of: "\n" + closingTag, options: .backwards),
              close.lowerBound >= open.upperBound
        else { return nil }
        return String(text[open.upperBound..<close.lowerBound])
    }

    // MARK: - Notes the runtime writes itself

    /// Retry after a failed turn: no new reader message, no clobbered draft.
    public static let retry = RuntimeNote(
        reason: .retry,
        text: "The last turn failed before it finished. Carry on from where it stopped."
    )

    /// Resume after Juno quit mid-run. `unknownOutcomes` names the calls that
    /// were running, whose results nobody saw.
    public static func afterQuit(unknownOutcomes: [String] = []) -> RuntimeNote {
        var text = "Juno quit while this run was working. Carry on from where it stopped."
        if !unknownOutcomes.isEmpty {
            text += " These calls were running and may or may not have finished: "
                + unknownOutcomes.joined(separator: ", ")
                + ". Check their effects before repeating them."
        }
        return RuntimeNote(reason: .afterQuit, text: text)
    }

    /// Keep going after a step limit, budget or stall.
    public static let keepGoing = RuntimeNote(
        reason: .keepGoing,
        text: "The reader asked you to keep going. Continue the work from where you stopped."
    )

    private static func escapeAttribute(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\n", with: " ")
    }

    private static func isAttributeName(_ name: String) -> Bool {
        !name.isEmpty && name != "reason" && name != "revision"
            && name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
    }
}

/// A ceiling on how much a run or a goal may spend. Nil means unlimited.
public struct Budget: Hashable, Codable, Sendable {
    public var minutes: Int?
    public var turns: Int?
    public var tokens: Int?
    public var costUSD: Double?

    public init(minutes: Int? = nil, turns: Int? = nil, tokens: Int? = nil, costUSD: Double? = nil) {
        self.minutes = minutes
        self.turns = turns
        self.tokens = tokens
        self.costUSD = costUSD
    }

    /// No ceiling at all.
    public var isUnlimited: Bool {
        minutes == nil && turns == nil && tokens == nil && costUSD == nil
    }
}

/// What a run or a goal has spent so far, children included.
public struct BudgetUsage: Hashable, Codable, Sendable {
    public var minutes: Double
    public var turns: Int
    public var tokens: Int?
    public var costUSD: Double?

    public init(minutes: Double = 0, turns: Int = 0, tokens: Int? = nil, costUSD: Double? = nil) {
        self.minutes = minutes
        self.turns = turns
        self.tokens = tokens
        self.costUSD = costUSD
    }

    /// The first ceiling of `budget` this usage has reached, or nil.
    public func reached(_ budget: Budget) -> BudgetLimit? {
        if let limit = budget.minutes, minutes >= Double(limit) { return .minutes }
        if let limit = budget.turns, turns >= limit { return .turns }
        if let limit = budget.tokens, let tokens, tokens >= limit { return .tokens }
        if let limit = budget.costUSD, let costUSD, costUSD >= limit { return .cost }
        return nil
    }
}

/// Which ceiling of a budget was reached.
public enum BudgetLimit: String, Codable, CaseIterable, Sendable {
    case minutes
    case turns
    case tokens
    case cost
}
