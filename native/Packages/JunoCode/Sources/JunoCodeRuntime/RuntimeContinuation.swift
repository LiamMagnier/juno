import Foundation
import JunoCodeCore

/// The runtime notes that send the agent back to work (CODE_AGENT_SPEC §1.5).
///
/// One template per ``GateReason``. Each is imperative, names the concrete
/// fact the stop check found, and stays under ``maximumCharacters``. They
/// travel fenced as `<juno_runtime>` so the model knows Juno wrote them and
/// compaction never quotes them as the reader's words.
public enum RuntimeContinuation {
    /// The longest a continuation's text may be.
    public static let maximumCharacters = 600

    /// The note for a stop-check continuation.
    public static func note(
        for reason: GateReason,
        detail: String,
        revision: Int,
        attributes: [RuntimeNote.Attribute] = []
    ) -> RuntimeNote {
        RuntimeNote(
            reason: .gate(reason),
            text: bounded(text(for: reason, detail: detail)),
            revision: revision,
            attributes: attributes
        )
    }

    static func text(for reason: GateReason, detail: String) -> String {
        let fact = sentence(detail)
        switch reason {
        case .todosOpen:
            return "Before finishing: \(fact) Finish them, or mark each one you cannot do as blocked with todo_write and say why."
        case .unverified:
            return "Before finishing: \(fact) Run it (run_checks when you have it, otherwise run_tests or run_command), fix what fails, then finish."
        case .checksFailing:
            return "Before finishing: \(fact) Fix it and run it again, or stop and say exactly why it cannot pass."
        case .uiUnchecked:
            return "Before finishing: \(fact) Look at the running result for the routes or screens your change affects, at desktop and phone widths when layout changed, and fix what is wrong."
        case .diffUnreviewed:
            return "Before finishing: \(fact) Read it with git_diff as a reviewer would — correctness, the request's requirements, leftovers such as debug output or commented-out code — and fix what you would flag."
        case .reviewFindings:
            return "Before finishing: \(fact) Fix each one, or say why it is not a problem."
        case .goalNotMet:
            return "The goal is not met yet: \(fact) Do the work for each criterion without evidence, then finish again."
        }
    }

    /// The note after the judge says the goal is not met (§2.5).
    public static func goalContinuation(goal: GoalRun, reason: String, turn: Int, revision: Int) -> RuntimeNote {
        let text = """
            The goal is not met yet: \(sentence(reason, limit: 220))
            Before you finish again, audit the goal: restate each criterion, point to the evidence that satisfies it \
            (a check Juno recorded, a Preview or Simulator check, a file:line), and do the work for any criterion \
            without evidence. Effort, intent and a plausible summary are not evidence.
            If a criterion cannot be met, mark the goal blocked with update_goal and say why.
            """
        return RuntimeNote(
            reason: .gate(.goalNotMet),
            text: bounded(text),
            revision: revision,
            attributes: [RuntimeNote.Attribute("goal", goal.id), RuntimeNote.Attribute("turn", String(turn))]
        )
    }

    /// The last turn before a step limit or budget ends the run: tools are
    /// off for it.
    public static func wrapUp(_ ending: RunEndReason, limitWords: String) -> RuntimeNote {
        RuntimeNote(
            reason: .wrapUp,
            text: "You have reached \(limitWords), so this is your last turn and your tools are off: do not call any, Juno will not run them. Summarise where you got to, what remains and the next step."
        )
    }

    /// The note after the model's reply was cut off at its output limit.
    public static func outputLimit(droppedToolCall: Bool) -> RuntimeNote {
        RuntimeNote(
            reason: .outputLimit,
            text: droppedToolCall
                ? "Your last reply reached the output limit and your last tool call was cut off. Send it again in smaller pieces."
                : "Your last reply reached the output limit before it finished. Carry on from where it stopped."
        )
    }

    /// A check-in on background work that has kept the run waiting.
    public static func checkIn(running: [String], waitedMinutes: Int) -> RuntimeNote {
        let list = running.prefix(4).map { "`\($0)`" }.joined(separator: ", ")
        return RuntimeNote(
            reason: .checkIn,
            text: bounded("This background work has kept the run waiting for \(waitedMinutes) minutes: \(list). Read its output, keep waiting, or stop anything stuck.")
        )
    }

    /// The reader resumed a paused or waiting goal.
    public static let goalResumed = RuntimeNote(
        reason: .other("goal_resumed"),
        text: "The reader resumed the goal. Continue toward it from where you stopped."
    )

    /// Text that came from a file, a command's output or another model, set
    /// into a note as a quotation: one line, in quotation marks, with angle
    /// brackets and straight quotes neutralised and its length bounded. A
    /// note is Juno's own voice, which the system prompt tells the agent to
    /// act on; what it quotes stays data, and can never open or close a
    /// fence of its own.
    public static func quoted(_ text: String, limit: Int = 160) -> String {
        var line = text
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .replacingOccurrences(of: "<", with: "‹")
            .replacingOccurrences(of: ">", with: "›")
            .replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: "“", with: "'")
            .replacingOccurrences(of: "”", with: "'")
        if line.count > limit { line = String(line.prefix(limit)) + "…" }
        return "“" + line + "”"
    }

    /// `detail` as the middle of a sentence: trimmed, bounded, ending in one
    /// full stop.
    static func sentence(_ detail: String, limit: Int = 320) -> String {
        var text = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.count > limit { text = String(text.prefix(limit)) + "…" }
        guard let last = text.last else { return "" }
        return ".!?…".contains(last) ? text : text + "."
    }

    static func bounded(_ text: String) -> String {
        guard text.count > maximumCharacters else { return text }
        return String(text.prefix(maximumCharacters - 1)) + "…"
    }
}
