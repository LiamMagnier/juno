import Foundation

/// One answer being written, as its frames build it — the stream reducer for
/// `/api/chat`, in **both** grammars (Tool calls & research SPEC §2).
///
/// **Profile 1** (today's production, and any server that does not know
/// `clientFeatures`): every `delta` is answer text, in order; the server puts a
/// `"\n\n"` delta between rounds itself; the activity rows are the legacy ones.
///
/// **Timeline** (a server that honours `clientFeatures: ["timeline", …]`):
/// `delta` and `reasoning` carry the model step (`round`) and, when the
/// provider declares one, the delta's `phase`; activity events carry `seq`,
/// typed tool records re-sent in place, reasoning `segment`s, `commentary`,
/// `fact`s and `notice`s. Commentary — text a round wrote before it called a
/// tool — never stays in the answer:
///
/// - a `phase: "commentary"` delta goes straight to the commentary;
/// - a `phase: "answer"` delta is answer text at once;
/// - an undeclared phase, in a turn that offered tools (`fact:tools`), is
///   **held** (SPEC §7.3, provisional text) until a tool call for its round
///   arrives (it was commentary), or 600ms pass, 280 characters or a paragraph
///   break arrive, or the stream ends (it was the answer);
/// - a round the server later marks as commentary (the `commentary` activity
///   event) leaves the answer, whatever the hold decided.
///
/// The grammar is detected from the frames, never from the request: a server
/// that stripped `clientFeatures` simply never sends a `round`.
///
/// Pure and deterministic — the store feeds it frames and a clock, and the
/// tests feed it recorded bytes of both grammars.
public struct NativeTurnStream: Equatable, Sendable {
    public static let textHold: TimeInterval = 0.6
    public static let textHoldCharacters = 280

    public enum Grammar: Equatable, Sendable {
        case profile1, timeline
    }

    /// What a frame did to the stream.
    public enum Outcome: Equatable, Sendable {
        case continuing
        case completed(NativeCompletedChatMessage)
        case failed(message: String, finishReason: NativeChatFinishReason)
        case handoff(NativeResearchHandoff)
    }

    struct Segment: Equatable, Sendable {
        enum Resolution: Equatable, Sendable { case held, answer, commentary }

        let round: Int
        let phase: NativeDeltaPhase?
        var text: String
        let firstAt: Date
        var resolution: Resolution
    }

    public private(set) var grammar: Grammar = .profile1
    public private(set) var reasoning = ""
    /// The provider's declared reasoning parts, when it declares them.
    public private(set) var reasoningParts: [String] = []
    public private(set) var activity: [NativeChatActivity] = []
    public private(set) var sources: [NativeChatSource] = []
    /// When the first answer text reached the answer area.
    public private(set) var answerStartedAt: Date?
    /// When the last frame other than `ping` arrived: what "stalled" is
    /// measured from (SPEC §7.3).
    public private(set) var lastEventAt: Date?

    private var profileOneText = ""
    private var segments: [Segment] = []
    private var lastReasoningPart: Int?
    private var lastReasoningRound: Int?
    private var commentaryRounds = Set<Int>()
    private var holdsProvisionalText = true

    /// - Parameter holdsProvisionalText: whether undeclared text in a turn
    ///   that offered tools is held back. A surface with no timer to release
    ///   it (a private chat, Compare) shows it at once and lets the
    ///   `commentary` event move it out afterwards.
    public init(holdsProvisionalText: Bool = true) {
        self.holdsProvisionalText = holdsProvisionalText
    }

    // MARK: Reading

    /// The answer as it stands: what the answer area shows.
    public var answer: String {
        switch grammar {
        case .profile1: profileOneText
        case .timeline: Self.joinedAnswer(segments.filter { $0.resolution == .answer })
        }
    }

    /// Text already known to be commentary whose `commentary` activity event
    /// has not arrived yet — shown where that event will put it, so it never
    /// jumps (SPEC §7.5).
    public var liveCommentary: [NativeRunCommentary] {
        var byRound: [Int: (text: String, inline: Bool)] = [:]
        var order: [Int] = []
        for segment in segments where segment.resolution == .commentary && !commentaryRounds.contains(segment.round) {
            if byRound[segment.round] == nil { order.append(segment.round) }
            let inline = segment.phase != .commentary
            byRound[segment.round, default: ("", inline)].text += segment.text
        }
        return order.compactMap { round in
            guard let entry = byRound[round] else { return nil }
            let text = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : NativeRunCommentary(round: round, text: text, inline: entry.inline)
        }
    }

    /// When held text must be released as answer text if nothing decides it
    /// first. Nil when nothing is held.
    public var holdDeadline: Date? {
        segments.filter { $0.resolution == .held }.map { $0.firstAt.addingTimeInterval(Self.textHold) }.min()
    }

    /// Whether any text is being held back.
    public var isHolding: Bool { segments.contains { $0.resolution == .held } }

    /// The turn offered tools (`fact:tools.offered` non-empty): undeclared
    /// text is held.
    public var offersTools: Bool {
        activity.contains { event in
            if case .tools(let offered, _, _) = event.fact { return !offered.isEmpty }
            return false
        }
    }

    // MARK: Applying

    @discardableResult
    public mutating func apply(_ event: NativeChatServerEvent, now: Date = Date()) -> Outcome {
        switch event {
        case .ping, .sequence:
            return .continuing
        default:
            lastEventAt = now
        }
        switch event {
        case .textDelta(let text, let round, let phase):
            appendText(text, round: round, phase: phase, now: now)
        case .reasoningDelta(let text, let part, let round):
            appendReasoning(text, part: part, round: round)
        case .activity(let event):
            record(event, now: now)
        case .sources(let list):
            sources = list
        case .completed(let message):
            finish(now: now)
            return .completed(message)
        case .failed(let message, let reason, _, _):
            finish(now: now)
            return .failed(message: message, finishReason: reason)
        case .handoff(let handoff):
            return .handoff(handoff)
        case .metadata, .title, .approval, .mediaProgress, .resume, .work, .sequence, .ping:
            break
        }
        return .continuing
    }

    /// Releases held text whose 600ms have passed, as answer text.
    public mutating func releaseHeldText(now: Date) {
        for index in segments.indices where segments[index].resolution == .held {
            if now.timeIntervalSince(segments[index].firstAt) >= Self.textHold {
                resolve(index, as: .answer, now: now)
            }
        }
    }

    /// The stream ended however it ended: whatever is still held was answer.
    public mutating func finish(now: Date = Date()) {
        for index in segments.indices where segments[index].resolution == .held {
            resolve(index, as: .answer, now: now)
        }
    }

    // MARK: Text

    private mutating func appendText(_ text: String, round: Int?, phase: NativeDeltaPhase?, now: Date) {
        guard let round else {
            // Profile 1, or a timeline server's frame without a round (the
            // SPEC never sends one; kept as answer text if it does).
            if grammar == .timeline {
                appendSegment(text, round: segments.last?.round ?? 0, phase: .answer, now: now)
            } else {
                profileOneText += text
                if answerStartedAt == nil, !text.isEmpty { answerStartedAt = now }
            }
            return
        }
        if grammar == .profile1 {
            grammar = .timeline
            // Anything that arrived before the grammar was known was answer.
            if !profileOneText.isEmpty {
                segments.append(Segment(round: 0, phase: .answer, text: profileOneText, firstAt: now, resolution: .answer))
                profileOneText = ""
            }
        }
        appendSegment(text, round: round, phase: phase, now: now)
    }

    private mutating func appendSegment(_ text: String, round: Int, phase: NativeDeltaPhase?, now: Date) {
        guard !text.isEmpty else { return }
        if let last = segments.indices.last, segments[last].round == round, segments[last].phase == phase {
            segments[last].text += text
            if segments[last].resolution == .held { checkHeld(last, now: now) }
            if segments[last].resolution == .answer, answerStartedAt == nil { answerStartedAt = now }
            return
        }
        let resolution: Segment.Resolution
        if commentaryRounds.contains(round), phase != .answer {
            resolution = .commentary
        } else {
            switch phase {
            case .commentary: resolution = .commentary
            case .answer: resolution = .answer
            case nil: resolution = holdsProvisionalText && offersTools ? .held : .answer
            }
        }
        segments.append(Segment(round: round, phase: phase, text: text, firstAt: now, resolution: resolution))
        let index = segments.count - 1
        if resolution == .held { checkHeld(index, now: now) }
        if segments[index].resolution == .answer, answerStartedAt == nil { answerStartedAt = now }
    }

    /// A held round is answer text once it passes 280 characters or holds a
    /// paragraph break.
    private mutating func checkHeld(_ index: Int, now: Date) {
        let text = segments[index].text
        if text.count >= Self.textHoldCharacters || text.contains("\n\n") {
            resolve(index, as: .answer, now: now)
        }
    }

    private mutating func resolve(_ index: Int, as resolution: Segment.Resolution, now: Date) {
        segments[index].resolution = resolution
        if resolution == .answer, answerStartedAt == nil { answerStartedAt = now }
    }

    /// Segments of different rounds joined with a blank line, trimmed only
    /// at the joins — the server's `answer` rule (SPEC §2.8 rule 3), so the
    /// live answer reads as the persisted one will.
    static func joinedAnswer(_ segments: [Segment]) -> String {
        var result = ""
        var lastRound: Int?
        for segment in segments {
            if let lastRound, lastRound != segment.round, !result.isEmpty {
                while result.last?.isWhitespace == true { result.removeLast() }
                let next = segment.text.drop { $0.isWhitespace }
                if !next.isEmpty {
                    result += "\n\n" + next
                }
            } else {
                result += segment.text
            }
            lastRound = segment.round
        }
        return result
    }

    // MARK: Reasoning

    /// The web's `appendReasoningDelta`: a blank line at a declared part
    /// boundary or a new round, never inferred from the text — so a
    /// segment's offset indexes this string exactly as the server's.
    private mutating func appendReasoning(_ text: String, part: Int?, round: Int?) {
        if round != nil { grammar = .timeline }
        var separator = ""
        if !reasoning.isEmpty {
            if let part, part != lastReasoningPart { separator = "\n\n" }
            if let round, let lastRound = lastReasoningRound, round != lastRound { separator = "\n\n" }
        }
        reasoning += separator + text
        if let part {
            while reasoningParts.count <= part { reasoningParts.append("") }
            reasoningParts[part] += text
            lastReasoningPart = part
        }
        if let round { lastReasoningRound = round }
    }

    // MARK: Activity

    /// Records a step. The server re-sends an event when it gains a detail —
    /// a call's result, a final status — under the same id (and a call under
    /// the same `callId`), so it is replaced in place.
    private mutating func record(_ event: NativeChatActivity, now: Date) {
        if event.seq != nil { grammar = .timeline }
        if let index = activity.firstIndex(where: { $0.id == event.id }) {
            activity[index] = event
        } else if let callID = event.call?.callID,
            let index = activity.firstIndex(where: { $0.call?.callID == callID })
        {
            activity[index] = event
        } else {
            activity.append(event)
        }
        if let commentary = event.commentary {
            // The server's word: that round was commentary, wherever the hold
            // put its text.
            commentaryRounds.insert(commentary.round)
            for index in segments.indices where segments[index].round == commentary.round && segments[index].phase != .answer {
                segments[index].resolution = .commentary
            }
        }
        if let call = event.call {
            // A tool call for a held round: the held text was the model
            // talking before it acted.
            for index in segments.indices where segments[index].round == call.round && segments[index].resolution == .held {
                segments[index].resolution = .commentary
            }
        }
    }
}
