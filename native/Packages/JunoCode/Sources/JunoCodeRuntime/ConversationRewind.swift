import Foundation
import JunoCodeCore

/// One of the reader's messages that started a turn: a prompt that began a
/// run, or a steered or queued message a run took in.
public struct ConversationTurn: Identifiable, Hashable, Sendable {
    public enum Kind: String, Sendable {
        case prompt
        case steer
        case queue
    }

    /// The transcript event of the message: the row the reader points at.
    public let id: String
    public let text: String
    public let kind: Kind
    public let sentAt: Date
    /// The event that put the message into the model's context. A prompt's is
    /// its own row; an instruction's is the later moment it was applied.
    let openSequence: Int
    let conversationIndex: Int?
}

public enum ConversationRewindError: Error, Equatable, Sendable {
    case turnNotFound
    /// Sent before rewind points were recorded, in a session whose history can
    /// no longer be matched to its messages by counting.
    case notRecorded
    /// Compaction folded the message into a summary.
    case summarized
    /// The saved conversation does not hold the message where the transcript
    /// says it should, so cutting there could drop the wrong turn.
    case outOfSync
}

/// The session as it will be after rewinding its conversation to a turn.
public struct ConversationRewindPlan: Sendable {
    public let turn: ConversationTurn
    /// The model-facing history, ending just before the turn's message.
    public let messages: [ModelMessage]
    /// The transcript as it will be: a ``TranscriptRewoundEvent`` numbered
    /// past every event the session ever held, then what is kept from before
    /// the turn's prompt, numbered on from it.
    public let events: [SessionEvent]
    public let status: SessionStatus
    /// The goal as it stood before the turn, so a goal the rewound turns
    /// created or advanced does not outlive them.
    public let goal: SessionGoal?
}

/// Cuts a session's two records — the model-facing conversation and the
/// transcript the reader sees — back to just before one of the reader's
/// messages, and keeps them agreeing with each other.
///
/// **Where the conversation is cut.** Each turn records the index its message
/// landed at. Compaction later replaces a run of older messages with a summary
/// in the first message; the transcript records how many it removed, so an
/// index recorded before a compaction is carried forward by exactly that
/// count. A message folded into the summary has no index left to cut at, and
/// its conversation cannot be rewound. A rewind keeps the compaction events
/// the kept history went through, even ones recorded after the cut, so this
/// arithmetic still holds for the next rewind.
///
/// **Why the cut is always valid.** A turn's message is only ever appended
/// once every tool call before it has its result — `ConversationIntegrity`'s
/// invariant — so the history before it is a complete one, and the repair
/// pass run on it is a check rather than a change.
public enum ConversationRewind {
    /// Every rewindable message in the transcript, in the order the model
    /// received them.
    public static func turns(in events: [SessionEvent]) -> [ConversationTurn] {
        var instructions: [String: (event: SessionEvent, instruction: UserInstructionEvent)] = [:]
        var turns: [ConversationTurn] = []
        for event in events {
            switch event.payload {
            case let .userPrompt(prompt):
                turns.append(ConversationTurn(
                    id: event.id,
                    text: prompt.text,
                    kind: .prompt,
                    sentAt: event.timestamp,
                    openSequence: event.sequence,
                    conversationIndex: prompt.conversationIndex
                ))
            case let .userInstruction(instruction):
                instructions[instruction.id] = (event, instruction)
            case let .userInstructionApplied(applied):
                // An instruction that was never applied never reached the
                // model, so there is nothing to rewind to.
                guard let row = instructions[applied.instructionID] else { continue }
                turns.append(ConversationTurn(
                    id: row.event.id,
                    text: row.instruction.text,
                    kind: row.instruction.kind == .steer ? .steer : .queue,
                    sentAt: row.event.timestamp,
                    openSequence: event.sequence,
                    conversationIndex: applied.conversationIndex
                ))
            default:
                break
            }
        }
        return turns
    }

    /// What the session keeps when rewound to just before `turnID`.
    ///
    /// Everything from the turn on leaves the transcript, file-change records
    /// included, even when the rewind leaves the files themselves as they are:
    /// a record of an edit with no turn around it would be drawn as work
    /// happening after the thread ends. The turn store still holds what those
    /// turns wrote, so code can be rewound past them later.
    ///
    /// - Parameter nextSequence: the sequence the store would give its next
    ///   event. The cut transcript is numbered from there, never from zero, so
    ///   no number a reader has already seen is reused; see
    ///   ``TranscriptRewoundEvent``. Nil numbers it past the last of `events`.
    public static func plan(
        rewindingTo turnID: String,
        events: [SessionEvent],
        conversation: [ModelMessage],
        nextSequence: Int? = nil,
        at date: Date = Date()
    ) throws -> ConversationRewindPlan {
        let turns = turns(in: events)
        guard let position = turns.firstIndex(where: { $0.id == turnID }) else {
            throw ConversationRewindError.turnNotFound
        }
        let turn = turns[position]
        let index = try messageIndex(
            of: turn,
            at: position,
            among: turns,
            events: events,
            conversation: conversation
        )
        let cut = cutSequence(for: turn, in: events)

        // An instruction belongs to the turn it was applied in, not the one it
        // was typed during. One applied at or after the cut — or never — goes
        // with the cut turns; left in, a fresh runtime would find it
        // unapplied and deliver it again.
        let appliedBeforeCut = Set(events.lazy.compactMap { event -> String? in
            guard event.sequence < cut,
                  case let .userInstructionApplied(applied) = event.payload
            else { return nil }
            return applied.instructionID
        })
        var kept = events.filter { event in
            guard event.sequence < cut else { return false }
            switch event.payload {
            case let .userInstruction(instruction):
                return appliedBeforeCut.contains(instruction.id)
            case .transcriptRewound:
                // An earlier rewind's restart, which this one supersedes: the
                // cut transcript opens with a restart of its own.
                return false
            default:
                return true
            }
        }

        // A cut inside a run leaves its last status active, and a transcript
        // that ends mid-run reads as a run that is still going. The run is over
        // at the cut: a queued message only ever enters at a natural end, so
        // what came before it completed; a steer interrupted it.
        let lastStatus = kept.lastStatus
        let status: SessionStatus
        if let lastStatus, lastStatus.isActive, let last = kept.last {
            status = turn.kind == .queue ? .completed : .cancelled
            kept.append(SessionEvent(
                sessionID: last.sessionID,
                sequence: 0,
                timestamp: last.timestamp,
                payload: .statusChanged(StatusChangedEvent(status: status))
            ))
        } else {
            status = lastStatus ?? .idle
        }

        // A compaction after the cut still shapes what is kept: the messages
        // kept are the compacted history, cut short. Every turn kept recorded
        // its index before that compaction, and only the compaction event
        // carries the index forward (`messageIndex`), so the events stay —
        // after the kept turns, where they apply to all of them. Dropped with
        // the cut turns, the next rewind to a kept turn would cut the history
        // at an index the compaction had already moved. The quiet row they
        // draw at the end of the thread is true: the model now reads those
        // turns through the summary. A rewind to the very first message keeps
        // no history, and so no compaction.
        if index > 0 {
            kept.append(contentsOf: events.filter { event in
                guard event.sequence >= cut, case .compaction = event.payload else { return false }
                return true
            })
        }

        let goal = kept.lazy.reversed().compactMap { event -> SessionGoal? in
            if case let .goalUpdated(update) = event.payload { return update.goal }
            return nil
        }.first

        // Numbered on from the highest sequence the session ever used, never
        // from zero: a reader polling "after 150" has to receive the restart,
        // and every event after it, rather than skip them as already seen.
        // Ids — which rows, groups and turns are keyed on — are kept.
        let first = max(
            nextSequence ?? 0,
            (events.lazy.map(\.sequence).max() ?? -1) + 1
        )
        // Not empty: the turn was found in it.
        let restart = SessionEvent(
            sessionID: events[0].sessionID,
            sequence: first,
            timestamp: date,
            payload: .transcriptRewound(TranscriptRewoundEvent(turnID: turn.id))
        )
        let renumbered = kept.enumerated().map { offset, event in
            SessionEvent(
                id: event.id,
                sessionID: event.sessionID,
                sequence: first + 1 + offset,
                timestamp: event.timestamp,
                payload: event.payload
            )
        }
        return ConversationRewindPlan(
            turn: turn,
            messages: ConversationIntegrity.repaired(Array(conversation[..<index])),
            events: [restart] + renumbered,
            status: status,
            goal: goal
        )
    }

    // MARK: - Locating the message

    private static func messageIndex(
        of turn: ConversationTurn,
        at position: Int,
        among turns: [ConversationTurn],
        events: [SessionEvent],
        conversation: [ModelMessage]
    ) throws -> Int {
        var index: Int
        if let recorded = turn.conversationIndex {
            index = recorded
            for event in events where event.sequence > turn.openSequence {
                guard case let .compaction(compaction) = event.payload, index > 0 else { continue }
                // Compaction keeps the first message, as the anchor, and a
                // suffix; everything between is the summary.
                let removed = compaction.beforeMessageCount - compaction.afterMessageCount
                guard index > removed else { throw ConversationRewindError.summarized }
                index -= removed
            }
        } else {
            // Recorded before turns carried their index. Without a compaction
            // every turn's message is still in the history, one per turn and
            // in order, so the nth turn is the nth user message — provided the
            // counts agree exactly.
            let userMessages = conversation.indices.filter { conversation[$0].userText != nil }
            let compacted = events.contains {
                if case .compaction = $0.payload { return true }
                return false
            }
            guard !compacted, userMessages.count == turns.count else {
                throw ConversationRewindError.notRecorded
            }
            index = userMessages[position]
        }
        // The model saw what the reader typed, sometimes with file context or
        // an attachment note after it, and a compaction anchor keeps it first.
        guard index < conversation.count,
              let text = conversation[index].userText,
              text.hasPrefix(turn.text)
        else {
            throw ConversationRewindError.outOfSync
        }
        return index
    }

    /// Where the transcript is cut. A prompt's turn opens with the contract
    /// event written just before it, which goes with it.
    private static func cutSequence(for turn: ConversationTurn, in events: [SessionEvent]) -> Int {
        guard turn.kind == .prompt,
              let previous = events.last(where: { $0.sequence < turn.openSequence }),
              case .turnConfiguration = previous.payload
        else { return turn.openSequence }
        return previous.sequence
    }
}

private extension Array where Element == SessionEvent {
    var lastStatus: SessionStatus? {
        lazy.reversed().compactMap { event -> SessionStatus? in
            if case let .statusChanged(change) = event.payload { return change.status }
            return nil
        }.first
    }
}

extension ModelMessage {
    /// The text of a message the reader sent, or nil for anything else —
    /// including a stop hook's reason, which is a user-role turn too but not
    /// one of the reader's, and would throw the count of theirs out.
    var userText: String? {
        switch self {
        case let .user(text), let .userWithImages(text, _):
            AgentHookContext.isHookMessage(text) ? nil : text
        default:
            nil
        }
    }
}
