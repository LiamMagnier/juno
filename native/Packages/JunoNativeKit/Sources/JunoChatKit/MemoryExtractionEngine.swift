import Foundation
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import Observation

// MARK: - What already exists, and what this adds
//
// ``NativeMemorySettingsStore`` already owns memory end to end *as data*: the
// encrypted local records, the pending-mutation overlay, create/update/delete
// through the outbox, the server's rolling summary, erase-all, and conflict
// resolution. ``NativeMemorySettingsModel`` already exposes all of it to a UI.
// None of that is reimplemented here.
//
// What was missing is the two ends: **where memories come from**, and **where
// they go**. A memory could only be typed in by hand, and nothing in this client
// ever put one in front of a model. This file is those two ends, and nothing
// else:
//
// - ``MemoryExtractionEngine`` reads finalized conversation turns and proposes
//   candidates, under a policy that says out loud what it will and will not keep.
// - ``MemoryInjection`` turns stored memories into the block a turn carries.
//
// Both are pure. The engine proposes; it never writes. Writing stays where it
// already is — `NativeMemorySettingsModel.createMemory` — so there is exactly one
// path a memory can enter this account by, and it is the one that already
// enqueues, drains, reconciles and is already tested.

// MARK: - Candidates

/// Something worth remembering, proposed but not yet stored.
public struct MemoryCandidate: Equatable, Sendable, Identifiable {
    /// The sentence that would be stored, already normalized to third person.
    public let content: String
    public let kind: NativeMemoryKind
    /// Why the extractor thought so. Carried so the settings surface can explain
    /// a memory the reader did not expect — "Juno remembered this because you
    /// said 'I always…'" is answerable; "Juno decided" is not.
    public let rationale: MemoryExtractionRationale
    /// The conversation this came from, stored as
    /// ``NativeMemoryEntry/sourceReference`` so a memory can always be traced
    /// back to the turn that produced it.
    public let conversationID: String

    public var id: String { "\(conversationID)#\(content)" }

    public init(
        content: String,
        kind: NativeMemoryKind,
        rationale: MemoryExtractionRationale,
        conversationID: String
    ) {
        self.content = content
        self.kind = kind
        self.rationale = rationale
        self.conversationID = conversationID
    }
}

/// The reason a candidate exists, as a closed vocabulary rather than free text.
///
/// Closed because it is shown to the reader and because it is asserted about in
/// tests. A free-form string would let the extractor claim anything, including
/// things it did not actually detect.
public enum MemoryExtractionRationale: String, Codable, CaseIterable, Sendable {
    /// "I prefer…", "I like…", "I'd rather…"
    case statedPreference
    /// "I always…", "I usually…", "every morning I…"
    case statedHabit
    /// "My name is…", "I work at…", "I use…"
    case statedFact
    /// "Don't…", "stop…", "never…" — stored as a
    /// ``NativeMemoryKind/suppression`` so it can *remove* behaviour rather than
    /// add a claim.
    case statedProhibition
    /// "Remember that…" — the reader asked directly.
    case explicitRequest

    public var explanation: String {
        switch self {
        case .statedPreference: "You said you prefer this."
        case .statedHabit: "You described this as something you usually do."
        case .statedFact: "You stated this about yourself."
        case .statedProhibition: "You asked Juno not to do this."
        case .explicitRequest: "You asked Juno to remember this."
        }
    }
}

// MARK: - Policy

/// What may be remembered, stated in one place so it can be read by a person and
/// asserted on by a test.
///
/// **This is the privacy contract, not a tuning knob.** Every rule here exists
/// because the alternative is a memory the reader would be alarmed to find in a
/// settings screen — and a memory store nobody trusts is one they turn off,
/// which costs the feature entirely.
public struct MemoryExtractionPolicy: Equatable, Sendable {
    /// Shorter than this is not a fact, it is a fragment.
    public var minimumCharacters: Int
    /// Longer than this is a paragraph someone wrote, not a durable preference.
    /// Storing it verbatim would put arbitrary conversation text in a place the
    /// reader thinks holds short facts.
    public var maximumCharacters: Int
    /// How many candidates one pass may propose. A conversation that trips the
    /// patterns forty times is a conversation *about* preferences, and filing all
    /// of it produces a memory list nobody will ever prune.
    public var maximumCandidatesPerPass: Int
    /// Substrings that veto a candidate outright, matched case-insensitively.
    ///
    /// Deliberately blunt. A sentence containing any of these is dropped whole
    /// rather than redacted, because redaction implies the remainder was
    /// understood — and a partially understood sentence about a password is
    /// exactly the thing not to persist.
    public var forbiddenSubstrings: [String]

    public static let `default` = MemoryExtractionPolicy(
        minimumCharacters: 8,
        maximumCharacters: 240,
        maximumCandidatesPerPass: 5,
        forbiddenSubstrings: Self.sensitiveVocabulary
    )

    public init(
        minimumCharacters: Int,
        maximumCharacters: Int,
        maximumCandidatesPerPass: Int,
        forbiddenSubstrings: [String]
    ) {
        self.minimumCharacters = max(1, minimumCharacters)
        self.maximumCharacters = max(self.minimumCharacters, maximumCharacters)
        self.maximumCandidatesPerPass = max(0, maximumCandidatesPerPass)
        self.forbiddenSubstrings = forbiddenSubstrings.map { $0.lowercased() }
    }

    /// Categories that are never worth the risk of getting wrong.
    ///
    /// Credentials and payment details are obvious. Health, immigration status
    /// and the rest are here for a different reason: they are things people
    /// mention once, in passing, to get help with — and having them recited back
    /// months later, unprompted, in an unrelated conversation, is a betrayal of
    /// the moment they were shared in, whether or not the inference was correct.
    static let sensitiveVocabulary: [String] = [
        "password", "passcode", "passphrase", "api key", "api-key", "secret key",
        "access token", "bearer ", "private key", "seed phrase", "recovery phrase",
        "credit card", "debit card", "card number", "cvv", "iban", "sort code",
        "routing number", "account number", "social security", "ssn", "passport number",
        "driver's licence", "driver's license", "national insurance",
        "diagnosis", "diagnosed", "prescription", "prescribed", "medication",
        "therapy", "therapist", "psychiatr", "hiv", "pregnan", "abortion",
        "immigration status", "visa status", "asylum", "criminal record",
        "sexual orientation", "my religion", "i am gay", "i'm gay",
    ]

    /// ``sensitiveVocabulary`` in plain language, for the settings screen.
    ///
    /// Kept here rather than in the view so the promise and the enforcement live
    /// in one file. A disclosure list that drifted from the vocabulary it
    /// describes is worse than no disclosure at all — it is a written assurance
    /// the code has stopped keeping.
    public static let neverStoredSummary = [
        "Passwords, keys, tokens and recovery phrases",
        "Card, bank and government identification numbers",
        "Health, diagnoses, medication and therapy",
        "Immigration or legal status",
        "Sexual orientation and religion",
        "Anything in an incognito conversation",
        "Anything Juno itself said — only your own words are read",
    ]

    /// True when this text may not be stored under any circumstances.
    public func forbids(_ text: String) -> Bool {
        let lowered = text.lowercased()
        return forbiddenSubstrings.contains { lowered.contains($0) }
    }

    public func admitsLength(_ text: String) -> Bool {
        text.count >= minimumCharacters && text.count <= maximumCharacters
    }
}

// MARK: - Extractor

/// One finalized turn, as the extractor sees it.
public struct MemoryExtractionTurn: Equatable, Sendable {
    public enum Role: String, Equatable, Sendable {
        case user
        case assistant
    }

    public let role: Role
    public let text: String

    public init(role: Role, text: String) {
        self.role = role
        self.text = text
    }
}

/// Proposes memories from a conversation.
///
/// A protocol because the heuristic below is the *floor*, not the ceiling: a
/// server-side or on-device model extractor drops in here without any of the
/// dedupe, gating or write machinery around it changing. It is deliberately
/// pure — an extractor that could write would be a second path memories can
/// enter by, and the whole point of one path is that one screen can show
/// everything.
public protocol MemoryExtracting: Sendable {
    func candidates(
        from turns: [MemoryExtractionTurn],
        conversationID: String,
        policy: MemoryExtractionPolicy
    ) -> [MemoryCandidate]
}

/// Pattern-based extraction over what the reader actually said.
///
/// **Only the reader's own turns are read.** The assistant's turns are excluded
/// on purpose and it is not an optimisation: a model that says "so you prefer
/// dark roast" would otherwise have its own guess promoted into a stored fact,
/// and from then on it would be reciting its own hallucination back as something
/// the reader told it. Memory laundering is the failure mode that makes people
/// distrust the whole feature.
///
/// Heuristics rather than a model, and the trade is stated rather than hidden:
/// this finds less than a model would and invents nothing, which is the correct
/// side to err on for a store the reader is told is theirs.
public struct HeuristicMemoryExtractor: MemoryExtracting {

    public init() {}

    /// The leading phrases that mark a first-person claim, longest first so
    /// "i would rather" wins over "i would".
    private static let preferenceMarkers = [
        "i prefer ", "i'd prefer ", "i would prefer ", "i'd rather ", "i would rather ",
        "i like ", "i love ", "i hate ", "i don't like ", "i do not like ",
    ]
    private static let habitMarkers = [
        "i always ", "i usually ", "i normally ", "i typically ", "i tend to ",
        "i never ", "every morning i ", "every day i ",
    ]
    private static let factMarkers = [
        "my name is ", "call me ", "i work at ", "i work as ", "i work on ",
        "i live in ", "i'm based in ", "i am based in ", "i use ", "i'm learning ",
        "i am learning ", "my team ", "my timezone is ", "my time zone is ",
    ]
    private static let prohibitionMarkers = [
        "don't ", "do not ", "stop ", "never ", "please don't ", "please stop ",
    ]
    private static let explicitMarkers = [
        "remember that ", "remember this: ", "remember, ", "note that i ",
        "keep in mind that ",
    ]

    public func candidates(
        from turns: [MemoryExtractionTurn],
        conversationID: String,
        policy: MemoryExtractionPolicy
    ) -> [MemoryCandidate] {
        guard policy.maximumCandidatesPerPass > 0 else { return [] }
        var results: [MemoryCandidate] = []
        var seen: Set<String> = []

        for turn in turns where turn.role == .user {
            for sentence in Self.sentences(in: turn.text) {
                guard results.count < policy.maximumCandidatesPerPass else {
                    return results
                }
                guard let candidate = Self.candidate(
                    from: sentence, conversationID: conversationID, policy: policy
                ) else { continue }
                let fingerprint = MemoryDeduplication.fingerprint(candidate.content)
                guard seen.insert(fingerprint).inserted else { continue }
                results.append(candidate)
            }
        }
        return results
    }

    /// One sentence → at most one candidate.
    ///
    /// Order matters. An explicit "remember that…" is checked first because it is
    /// the reader asking directly and outranks whatever pattern the rest of the
    /// sentence also happens to match; a prohibition is checked before the
    /// positive markers because "I don't like X" is a preference, while "don't do
    /// X" is an instruction, and the two must not become the same record.
    ///
    /// - Parameter allowExplicit: False on the one recursive call below, which
    ///   re-reads the remainder of a "remember that…" so it is rewritten to the
    ///   third person like everything else. Without the flag a sentence beginning
    ///   "remember that remember that" would recurse on itself.
    static func candidate(
        from sentence: String,
        conversationID: String,
        policy: MemoryExtractionPolicy,
        allowExplicit: Bool = true
    ) -> MemoryCandidate? {
        let trimmed = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !policy.forbids(trimmed) else { return nil }
        let lowered = trimmed.lowercased()

        if allowExplicit,
            let remainder = Self.remainder(of: trimmed, lowered: lowered, after: explicitMarkers)
        {
            // Re-read rather than stored raw. "Remember that I always deploy on
            // Thursdays" would otherwise be filed in the first person — the exact
            // thing every other branch here goes out of its way to avoid — and
            // the reader's most deliberate memories would be the worst-formed
            // ones in the list.
            if let rewritten = Self.candidate(
                from: remainder, conversationID: conversationID,
                policy: policy, allowExplicit: false
            ) {
                return MemoryCandidate(
                    content: rewritten.content,
                    kind: rewritten.kind,
                    // The reader asked, whatever pattern the sentence matched.
                    rationale: .explicitRequest,
                    conversationID: conversationID
                )
            }
            return Self.make(
                statement: remainder, kind: .fact, rationale: .explicitRequest,
                conversationID: conversationID, policy: policy
            )
        }
        // A prohibition is only an instruction when it opens the sentence.
        // "I don't like coriander" is a preference; "don't use coriander" is an
        // instruction, and the difference is entirely where the word sits.
        if let remainder = Self.remainder(
                of: trimmed, lowered: lowered, after: prohibitionMarkers
            ),
            !lowered.hasPrefix("i don't like"), !lowered.hasPrefix("i do not like")
        {
            // Stored without a polarity word. The instruction is carried by
            // ``NativeMemoryKind/suppression``, and ``MemoryInjection`` renders
            // the "Avoid:" — baking one in here would produce "Avoid: don't use
            // em dashes", a double negative the model has to unpick.
            return Self.make(
                statement: remainder, kind: .suppression,
                rationale: .statedProhibition,
                conversationID: conversationID, policy: policy
            )
        }
        if let remainder = Self.remainder(
            of: trimmed, lowered: lowered, after: preferenceMarkers
        ) {
            let verb = Self.verb(for: lowered, among: preferenceMarkers)
            return Self.make(
                statement: "\(verb) \(remainder)", kind: .fact,
                rationale: .statedPreference,
                conversationID: conversationID, policy: policy
            )
        }
        if let remainder = Self.remainder(of: trimmed, lowered: lowered, after: habitMarkers) {
            let verb = Self.verb(for: lowered, among: habitMarkers)
            return Self.make(
                statement: "\(verb) \(remainder)", kind: .fact, rationale: .statedHabit,
                conversationID: conversationID, policy: policy
            )
        }
        if let remainder = Self.remainder(of: trimmed, lowered: lowered, after: factMarkers) {
            let verb = Self.verb(for: lowered, among: factMarkers)
            return Self.make(
                statement: "\(verb) \(remainder)", kind: .fact, rationale: .statedFact,
                conversationID: conversationID, policy: policy
            )
        }
        return nil
    }

    /// The marker that opens this sentence, rewritten to third person.
    ///
    /// Stored memories are read by a model as statements *about* the reader, so
    /// "I prefer" has to become "prefers". Leaving the first person in produces a
    /// memory block in which the model appears to be describing itself, and the
    /// answers that follow are unnervingly confused about who likes what.
    private static func verb(for lowered: String, among markers: [String]) -> String {
        guard let marker = markers
            .sorted(by: { $0.count > $1.count })
            .first(where: { lowered.hasPrefix($0) })
        else { return "" }
        return thirdPerson[marker.trimmingCharacters(in: .whitespaces)] ?? "mentioned"
    }

    private static let thirdPerson: [String: String] = [
        "i prefer": "prefers", "i'd prefer": "prefers", "i would prefer": "prefers",
        "i'd rather": "would rather", "i would rather": "would rather",
        "i like": "likes", "i love": "loves", "i hate": "dislikes",
        "i don't like": "dislikes", "i do not like": "dislikes",
        "i always": "always", "i usually": "usually", "i normally": "normally",
        "i typically": "typically", "i tend to": "tends to", "i never": "never",
        "every morning i": "every morning", "every day i": "every day",
        "my name is": "is called", "call me": "prefers to be called",
        "i work at": "works at", "i work as": "works as", "i work on": "works on",
        "i live in": "lives in", "i'm based in": "is based in",
        "i am based in": "is based in", "i use": "uses",
        "i'm learning": "is learning", "i am learning": "is learning",
        "my team": "their team", "my timezone is": "is in timezone",
        "my time zone is": "is in timezone",
    ]

    /// Matches against the lowered text and slices the **original**.
    ///
    /// Two strings rather than one because a name is a fact worth keeping the
    /// shape of: matching on `lowered` and slicing `lowered` too would file "my
    /// name is Liam" as "is called liam", and a memory store that quietly
    /// lowercases the reader's own name is one they will not trust with anything
    /// else. `dropFirst` is safe across the pair because `lowercased()` is applied
    /// to the whole string and the markers are ASCII — the prefix lengths agree.
    private static func remainder(
        of original: String,
        lowered: String,
        after markers: [String]
    ) -> String? {
        // Longest first: "i would rather" must not be consumed by "i would".
        for marker in markers.sorted(by: { $0.count > $1.count })
        where lowered.hasPrefix(marker) {
            let source = original.count == lowered.count ? original : lowered
            let remainder = String(source.dropFirst(marker.count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return remainder.isEmpty ? nil : remainder
        }
        return nil
    }

    private static func make(
        statement: String,
        kind: NativeMemoryKind,
        rationale: MemoryExtractionRationale,
        conversationID: String,
        policy: MemoryExtractionPolicy
    ) -> MemoryCandidate? {
        let content = statement.trimmingCharacters(
            in: CharacterSet(charactersIn: " .,;:!?")
        )
        // Re-checked after rewriting, not only before: the rewrite can shorten a
        // sentence past the floor, and the forbidden check has to see the text
        // that would actually be stored.
        guard policy.admitsLength(content), !policy.forbids(content) else { return nil }
        return MemoryCandidate(
            content: content,
            kind: kind,
            rationale: rationale,
            conversationID: conversationID
        )
    }

    /// Splits on sentence terminators and newlines.
    ///
    /// Newlines count as terminators because people write lists, and a bulleted
    /// list of five preferences arrives as one "sentence" otherwise — over the
    /// length ceiling, and dropped whole.
    static func sentences(in text: String) -> [String] {
        text.split(whereSeparator: { $0 == "." || $0 == "!" || $0 == "?" || $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}

// MARK: - Deduplication

/// Recognising a memory the account already holds.
///
/// Without this every conversation in which someone mentions their timezone adds
/// another copy, and a memory list is only useful while it is short enough to
/// read.
public enum MemoryDeduplication {
    /// Case-, punctuation- and whitespace-insensitive. Not stemming and not
    /// similarity: a fingerprint that matched *approximately* would silently
    /// discard a genuinely new fact for being adjacent to an old one, and the
    /// cost of a near-duplicate surviving is one row the reader can delete.
    public static func fingerprint(_ content: String) -> String {
        content
            .lowercased()
            .unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) || $0 == " " }
            .map(String.init)
            .joined()
            .split(separator: " ")
            .joined(separator: " ")
    }

    public static func isDuplicate(_ candidate: String, of existing: [String]) -> Bool {
        let target = fingerprint(candidate)
        guard !target.isEmpty else { return true }
        return existing.contains { fingerprint($0) == target }
    }
}

// MARK: - The engine

/// Why a pass stored nothing.
///
/// Named cases rather than a silent empty result, because "memory is off" and
/// "nothing in that conversation was worth keeping" want different UI, and a
/// diagnostics screen that cannot tell them apart cannot answer the only
/// question anyone asks about memory: why did it not remember that.
public enum MemoryExtractionOutcome: Equatable, Sendable {
    case proposed([MemoryCandidate])
    /// The account's `memoryEnabled` is off.
    case disabledByAccount
    /// **The settings record has not loaded.** Distinct from `disabledByAccount`
    /// and treated the same way — nothing is stored — because not knowing whether
    /// the reader consented is not consent. The pass is skipped and will run
    /// again once settings arrive.
    case consentUnknown
    /// This conversation is incognito, or the caller marked it not-for-memory.
    case excludedConversation
    /// Read too recently. Distinct from ``nothingWorthKeeping`` because it is not
    /// a statement about the conversation at all — the same turns may well
    /// produce memories a minute from now, and a diagnostics screen that showed
    /// "nothing worth keeping" here would be describing the throttle as a
    /// judgement.
    case throttled
    case nothingWorthKeeping
}

/// Runs extraction passes over finished conversations.
///
/// An actor because it holds the per-conversation throttle, which two screens can
/// both trigger — the conversation view when a turn finalizes, and a background
/// sweep — and a throttle that can be read and written concurrently is a throttle
/// that does not throttle.
///
/// It **proposes only**. ``MemoryExtractionOutcome/proposed(_:)`` is handed back
/// to the caller, which writes through `NativeMemorySettingsModel.createMemory`
/// like any hand-typed memory: one write path, one audit trail, one place the
/// reader can delete from.
public actor MemoryExtractionEngine {
    private let extractor: any MemoryExtracting
    private let policy: MemoryExtractionPolicy
    /// The shortest gap between two passes over the same conversation. A long
    /// chat finalizes a turn every few seconds, and re-reading the whole thing
    /// each time is work that grows with the square of the conversation.
    private let minimumInterval: TimeInterval
    private var lastPass: [String: Date] = [:]

    public init(
        extractor: any MemoryExtracting = HeuristicMemoryExtractor(),
        policy: MemoryExtractionPolicy = .default,
        minimumInterval: TimeInterval = 60
    ) {
        self.extractor = extractor
        self.policy = policy
        self.minimumInterval = max(0, minimumInterval)
    }

    /// - Parameters:
    ///   - memoryEnabled: The account's setting. **Optional, and nil is not
    ///     false.** Nil means the settings record has not loaded; see
    ///     ``MemoryExtractionOutcome/consentUnknown``.
    ///   - existingMemories: What the account already holds, so a pass proposes
    ///     only what is new.
    ///   - isExcluded: Incognito conversations, and anything else the caller
    ///     knows must not be learned from.
    public func pass(
        turns: [MemoryExtractionTurn],
        conversationID: String,
        memoryEnabled: Bool?,
        existingMemories: [String],
        isExcluded: Bool = false,
        now: Date = Date()
    ) -> MemoryExtractionOutcome {
        guard let memoryEnabled else { return .consentUnknown }
        guard memoryEnabled else { return .disabledByAccount }
        guard !isExcluded, !conversationID.isEmpty else { return .excludedConversation }

        if let previous = lastPass[conversationID],
            now.timeIntervalSince(previous) < minimumInterval
        { return .throttled }
        lastPass[conversationID] = now

        let candidates = extractor.candidates(
            from: turns, conversationID: conversationID, policy: policy
        )
        let fresh = candidates.filter {
            !MemoryDeduplication.isDuplicate($0.content, of: existingMemories)
        }
        return fresh.isEmpty ? .nothingWorthKeeping : .proposed(fresh)
    }

    /// Lets a conversation be re-read immediately — after the reader deletes a
    /// memory, for instance, when the next pass should be allowed to find it
    /// again rather than being told it is too soon.
    public func forgetThrottle(conversationID: String) {
        lastPass[conversationID] = nil
    }

    public func reset() {
        lastPass = [:]
    }
}

// MARK: - Injection

/// Turns stored memories into the text a turn actually carries.
///
/// Pure and deterministic, which is the point: what a model is told about the
/// reader has to be reproducible from what is on the settings screen, or the
/// screen is not an honest account of what Juno knows.
public enum MemoryInjection {
    /// The header the block opens with. Fixed, so a model can be instructed about
    /// it once and so a reader who exports a conversation can find it.
    public static let header = "What Juno remembers about the person you're talking to:"
    /// A budget, not a limit on the store. Memories are short; a hundred of them
    /// are still only a few thousand characters, and a block that grows without
    /// bound eventually crowds out the conversation it was meant to inform.
    public static let maximumCharacters = 4_000

    /// Builds the block, or nil when there is nothing honest to say.
    ///
    /// Nil rather than an empty string, and it matters: an empty header is a
    /// claim that Juno remembers nothing, and it would be sent for an account
    /// whose memories simply have not loaded yet.
    ///
    /// - Parameters:
    ///   - memories: Everything stored, in any order.
    ///   - allowed: False when the active assistant's whitelist excludes
    ///     ``ProjectWorkspaceTool/memoryRecall``. A persona built for work does
    ///     not get told what somebody eats.
    public static func block(
        from memories: [NativeMemoryEntry],
        allowed: Bool = true
    ) -> String? {
        guard allowed else { return nil }
        let facts = memories.filter { $0.kind == .fact }
        let suppressions = memories.filter { $0.kind == .suppression }
        guard !facts.isEmpty || !suppressions.isEmpty else { return nil }

        var lines: [String] = []
        // The budget covers the *rendered* block, header and separators included,
        // rather than only the memory text. Counting content alone made the
        // ceiling a number the finished string routinely exceeded, which is the
        // kind of budget that is discovered by a provider rejecting a request.
        var budget = maximumCharacters - header.count

        // Suppressions first, and this is deliberate rather than aesthetic. They
        // are instructions *not* to do something, and a model that runs out of
        // context reads the front of a block more reliably than the back — a
        // dropped preference is a worse answer, a dropped prohibition is the
        // thing the reader explicitly asked Juno never to do.
        for entry in ordered(suppressions) {
            guard let line = take(entry.content, prefix: "- Avoid: ", from: &budget) else {
                break
            }
            lines.append(line)
        }
        for entry in ordered(facts) {
            guard let line = take(entry.content, prefix: "- ", from: &budget) else { break }
            lines.append(line)
        }
        guard !lines.isEmpty else { return nil }
        return ([header] + lines).joined(separator: "\n")
    }

    /// Newest first, ties broken by id so the block is byte-stable between two
    /// builds of the same store — an unstable prompt defeats prompt caching and
    /// makes two identical questions cost twice.
    ///
    /// Blank entries are dropped **here**, before the budget loop, and that
    /// placement is the whole point: a blank memory reaching ``take(_:prefix:from:)``
    /// would come back nil, the loop would read that as "the budget is spent",
    /// and one empty row in the store would truncate everything after it out of
    /// the prompt.
    private static func ordered(_ entries: [NativeMemoryEntry]) -> [NativeMemoryEntry] {
        entries
            .filter { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted {
                $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt
            }
    }

    /// Nil means one thing only: **the budget is spent.** Every other reason a
    /// line might not be usable is handled before this is called.
    private static func take(
        _ content: String,
        prefix: String,
        from budget: inout Int
    ) -> String? {
        let line = prefix + content.trimmingCharacters(in: .whitespacesAndNewlines)
        // +1 for the newline this line will be joined with.
        let cost = line.count + 1
        guard cost <= budget else { return nil }
        budget -= cost
        return line
    }
}

// MARK: - Running the engine against a live account

/// The pass, the proposals it produced, and the single write path that can turn
/// one into a memory.
///
/// ``MemoryExtractionEngine`` is pure and ``NativeMemorySettingsModel`` already
/// owns every write; what did not exist was anything that *ran* the engine. This
/// is that missing piece and nothing else — it holds no memories of its own, it
/// reads consent from the settings model rather than caching a copy, and the only
/// way a candidate becomes durable is ``accept(_:)``, which calls
/// `NativeMemorySettingsModel.createMemory`. One write path, one audit trail, one
/// place the reader can delete from.
///
/// **Consent is re-read on every pass, and unknown is not consent.** The engine's
/// `memoryEnabled` parameter is `Bool?` precisely so that "the settings record has
/// not loaded" is distinguishable from "the reader switched it off", and this
/// forwards `settings.settings?.memoryEnabled` untouched rather than defaulting it.
/// A `?? false` here would silently stop learning for an account whose settings
/// are merely in flight; a `?? true` would learn from someone who had said no. The
/// optional is the whole point and it is passed through, not collapsed.
@MainActor
@Observable
public final class MemoryLearningModel<Repository: AccountScopedRepository> {
    /// Candidates waiting for the reader's decision, newest pass last.
    ///
    /// Not persisted. A proposal is a question, not a record, and a question that
    /// survived a relaunch would be Juno holding on to something it was told not
    /// to store yet. Anything still here when the app quits is simply asked again
    /// the next time the conversation is read.
    public private(set) var proposals: [MemoryCandidate] = []

    /// Why the last pass ended as it did.
    ///
    /// Kept so a diagnostics surface can answer the only question anyone ever asks
    /// about memory — *why did it not remember that* — with "memory is off" or
    /// "read too recently" rather than with silence.
    public private(set) var lastOutcome: MemoryExtractionOutcome?

    /// Set while ``accept(_:)`` is writing, so a double-click cannot enqueue the
    /// same memory twice.
    public private(set) var isAccepting = false

    /// Past this the review list stops being reviewable. Older proposals are
    /// dropped rather than newer ones rejected: what the reader said most recently
    /// is what they are most likely to recognise.
    public static var maximumPendingProposals: Int { 12 }

    private let settings: NativeMemorySettingsModel<Repository>
    private let engine: MemoryExtractionEngine

    /// Content the reader has explicitly discarded this session.
    ///
    /// Fed back into the pass as though it were already stored, which is what
    /// stops "no, don't remember that" from being asked again sixty seconds later.
    /// Session-scoped on purpose: this is a list of things the reader declined, and
    /// persisting it would build a second, invisible corpus of exactly the
    /// sentences they asked Juno not to keep.
    private var declined: [String] = []

    public init(
        settings: NativeMemorySettingsModel<Repository>,
        engine: MemoryExtractionEngine = MemoryExtractionEngine()
    ) {
        self.settings = settings
        self.engine = engine
    }

    /// Runs one pass over a conversation whose turn has just finalized.
    ///
    /// - Parameters:
    ///   - conversationID: Carried into every candidate as its source reference.
    ///   - turns: **The reader's own turns only.** Callers must not pass the
    ///     model's. ``HeuristicMemoryExtractor`` filters them out as well, but the
    ///     protocol allows a future extractor that would not — and a model's guess
    ///     promoted into a stored fact is the failure that makes people distrust
    ///     the whole feature. Filtering at both ends costs nothing.
    ///   - isExcluded: Incognito, or a project whose whitelist withholds
    ///     ``ProjectWorkspaceTool/memoryRecall``.
    public func observe(
        conversationID: String,
        turns: [MemoryExtractionTurn],
        isExcluded: Bool = false
    ) async {
        let outcome = await engine.pass(
            turns: turns.filter { $0.role == .user },
            conversationID: conversationID,
            // Straight through. See the note on this type about why it is optional.
            memoryEnabled: settings.settings?.memoryEnabled,
            existingMemories: settings.memories.map(\.content)
                + proposals.map(\.content)
                + declined,
            isExcluded: isExcluded
        )
        lastOutcome = outcome
        guard case .proposed(let candidates) = outcome else { return }
        proposals.append(contentsOf: candidates)
        if proposals.count > Self.maximumPendingProposals {
            proposals.removeFirst(proposals.count - Self.maximumPendingProposals)
        }
    }

    /// Stores a proposal, by exactly the route a hand-typed memory takes.
    public func accept(_ candidate: MemoryCandidate) async {
        guard !isAccepting else { return }
        isAccepting = true
        defer { isAccepting = false }
        // Dropped from the list first. `createMemory` awaits a drain, and a
        // proposal still on screen during it is a Keep button the reader can press
        // again.
        remove(candidate)
        await settings.createMemory(content: Self.storableContent(of: candidate))
    }

    /// Drops a proposal and remembers that it was dropped, for this session.
    public func decline(_ candidate: MemoryCandidate) {
        remove(candidate)
        declined.append(candidate.content)
    }

    /// Lets a conversation be re-read before the throttle would allow it —
    /// after the reader deletes a memory, when the next pass should be free to
    /// find it again rather than being told it is too soon.
    public func forgetThrottle(conversationID: String) async {
        await engine.forgetThrottle(conversationID: conversationID)
    }

    /// Sign-out, and account switches. Everything here is about one account and
    /// none of it is durable, so all of it goes.
    public func stop() async {
        proposals = []
        declined = []
        lastOutcome = nil
        await engine.reset()
    }

    private func remove(_ candidate: MemoryCandidate) {
        proposals.removeAll { $0.id == candidate.id }
    }

    /// The text a candidate is stored as.
    ///
    /// A ``NativeMemoryKind/suppression`` is deliberately stored *without* its
    /// polarity word so ``MemoryInjection`` can render "Avoid: …" without a double
    /// negative — but `createMemory` files everything as a
    /// ``NativeMemoryKind/fact``, because `/api/v1`'s `memory.create` has no kind
    /// field. Storing the bare remainder would therefore invert the instruction:
    /// "don't use em dashes" would come back as the fact "use em dashes", which is
    /// the reader's prohibition turned into its own opposite. The polarity is put
    /// back into the text, which is the only place this route can carry it.
    /// `nonisolated` because it is a pure rewrite of one string and nothing about
    /// it belongs to the main actor. Isolating it would make the rule assertable
    /// only from an async main-actor context, which is a needless obstacle in
    /// front of the one place this behaviour is pinned down.
    nonisolated static func storableContent(of candidate: MemoryCandidate) -> String {
        switch candidate.kind {
        case .suppression: "Never: \(candidate.content)"
        case .fact: candidate.content
        }
    }
}

// MARK: - Composing a persona's system prompt

/// Everything the model is told before the conversation starts, assembled once.
///
/// Kept apart from both stores because it is the only place that knows all three
/// halves — the assistant's instructions, its knowledge files, and what the
/// account remembers — and because the *order* of those three is a decision
/// worth being able to point at.
public enum ProjectWorkspacePrompt {

    /// - Parameters:
    ///   - workspace: Nil is plain Juno, which is a real state and not a missing
    ///     one: no persona, no whitelist, memory allowed.
    ///   - project: The synced project behind the workspace, when loaded.
    ///   - knowledgeFileNames: The names of the attachments the assistant treats
    ///     as reference material, in the reader's order. Names only — the files
    ///     themselves are uploaded and referenced by the server, and restating
    ///     their contents here would send the same bytes twice.
    ///   - memories: The account's stored memories.
    public static func systemPrompt(
        workspace: ProjectWorkspaceConfiguration?,
        project: NativeProject?,
        knowledgeFileNames: [String],
        memories: [NativeMemoryEntry]
    ) -> String {
        var sections: [String] = []

        // The assistant's own instructions come first: they are the strongest
        // statement of what this persona is for, and everything after them is
        // context it should read in that light.
        let instructions = workspace?.resolvedInstructions(project: project)
            ?? project?.instructions
            ?? ""
        let trimmedInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedInstructions.isEmpty { sections.append(trimmedInstructions) }

        if !knowledgeFileNames.isEmpty {
            let listed = knowledgeFileNames.prefix(
                ProjectWorkspaceConfiguration.maximumKnowledgeFiles
            )
            sections.append(
                (["Reference material attached to this assistant:"]
                    + listed.map { "- \($0)" }).joined(separator: "\n")
            )
        }

        // Memory last, and gated on the whitelist. A workspace with no opinion
        // allows it; one that restricted its tools without including memory has
        // said no.
        let allowed = workspace?.toolAccess.allows(.memoryRecall) ?? true
        if let block = MemoryInjection.block(from: memories, allowed: allowed) {
            sections.append(block)
        }

        return sections.joined(separator: "\n\n")
    }
}
