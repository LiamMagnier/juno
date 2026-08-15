import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest
@testable import JunoChatKit

/// What Juno is allowed to learn, and what it is then allowed to say about it.
///
/// These are privacy assertions before they are behaviour assertions. Every
/// expectation here corresponds to a memory a reader would be alarmed to find in
/// their settings screen.
final class HeuristicMemoryExtractorTests: XCTestCase {

    private let extractor = HeuristicMemoryExtractor()

    private func candidates(
        _ text: String,
        role: MemoryExtractionTurn.Role = .user,
        policy: MemoryExtractionPolicy = .default
    ) -> [MemoryCandidate] {
        extractor.candidates(
            from: [MemoryExtractionTurn(role: role, text: text)],
            conversationID: "conversation-a",
            policy: policy
        )
    }

    // MARK: What is read

    /// **Only the reader's own words.** A model that says "so you prefer dark
    /// roast" would otherwise have its own guess promoted into a stored fact, and
    /// from then on it recites its own hallucination back as something it was
    /// told.
    func testTheAssistantsOwnWordsAreNeverRead() {
        XCTAssertTrue(candidates("I prefer dark roast coffee", role: .assistant).isEmpty)
        XCTAssertFalse(candidates("I prefer dark roast coffee", role: .user).isEmpty)
    }

    func testAStatedPreferenceIsRewrittenToTheThirdPerson() throws {
        let candidate = try XCTUnwrap(candidates("I prefer dark roast coffee.").first)

        XCTAssertEqual(candidate.content, "prefers dark roast coffee")
        XCTAssertEqual(candidate.kind, .fact)
        XCTAssertEqual(candidate.rationale, .statedPreference)
        XCTAssertEqual(candidate.conversationID, "conversation-a")
    }

    /// First person left in produces a memory block in which the model appears to
    /// be describing itself, and the answers that follow are confused about who
    /// likes what.
    func testNoCandidateKeepsTheFirstPerson() {
        for sentence in [
            "I always run the tests before pushing",
            "I work at a small hardware company",
            "I use Swift every day",
            "I'd rather see a diff than a summary",
        ] {
            let content = candidates(sentence).first?.content ?? ""
            XCTAssertFalse(content.hasPrefix("i "), "\(sentence) → \(content)")
            XCTAssertFalse(content.contains(" i "), "\(sentence) → \(content)")
        }
    }

    func testAHabitIsRecognisedAsSuch() throws {
        let candidate = try XCTUnwrap(candidates("I always run the tests before pushing").first)

        XCTAssertEqual(candidate.content, "always run the tests before pushing")
        XCTAssertEqual(candidate.rationale, .statedHabit)
    }

    /// "I don't like coriander" is a preference. "Don't use coriander" is an
    /// instruction. Filing them as the same record would turn a taste into a rule
    /// or a rule into a taste, and only one of the two can be ignored safely.
    func testAProhibitionAndADislikeAreDifferentRecords() throws {
        let dislike = try XCTUnwrap(candidates("I don't like em dashes").first)
        XCTAssertEqual(dislike.kind, .fact)
        XCTAssertEqual(dislike.rationale, .statedPreference)
        XCTAssertEqual(dislike.content, "dislikes em dashes")

        let prohibition = try XCTUnwrap(candidates("Don't use em dashes").first)
        XCTAssertEqual(prohibition.kind, .suppression)
        XCTAssertEqual(prohibition.rationale, .statedProhibition)
        XCTAssertEqual(
            prohibition.content,
            "use em dashes",
            "the polarity is carried by the kind, not baked into the text"
        )
    }

    /// Asking outright outranks whatever else the sentence happens to match.
    func testAnExplicitRequestWins() throws {
        let candidate = try XCTUnwrap(
            candidates("Remember that I always deploy on Thursdays").first
        )

        XCTAssertEqual(candidate.rationale, .explicitRequest)
        XCTAssertEqual(
            candidate.content,
            "always deploy on Thursdays",
            "an explicit request is rewritten like everything else"
        )
    }

    /// A memory store that quietly lowercases the reader's own name is one they
    /// will not trust with anything else.
    func testAStatedNameKeepsItsCapitalisation() throws {
        let candidate = try XCTUnwrap(candidates("My name is Liam").first)

        XCTAssertEqual(candidate.content, "is called Liam")
        XCTAssertEqual(candidate.rationale, .statedFact)
    }

    func testOrdinaryConversationProducesNothing() {
        XCTAssertTrue(candidates("What time is the meeting?").isEmpty)
        XCTAssertTrue(candidates("Can you fix this stack trace").isEmpty)
        XCTAssertTrue(candidates("Thanks, that worked").isEmpty)
    }

    // MARK: What is refused

    /// The privacy contract. A sentence in any of these categories is dropped
    /// whole rather than redacted, because redaction implies the rest was
    /// understood.
    func testSensitiveSentencesAreNeverStored() {
        for sentence in [
            "I always use the password hunter2 for staging",
            "I prefer to keep my api key in the environment",
            "I use the card number ending 4242 for this",
            "Remember that I was diagnosed with something last year",
            "I always take my medication at eight",
            "I prefer my therapist's appointments in the morning",
            "Don't ask about my immigration status",
        ] {
            XCTAssertTrue(
                candidates(sentence).isEmpty,
                "a sensitive sentence was proposed: \(sentence)"
            )
        }
    }

    /// The length check runs again *after* the rewrite, because the rewrite can
    /// shorten a sentence past the floor and because the forbidden check has to
    /// see the text that would actually be stored.
    func testFragmentsAndParagraphsAreBothRefused() {
        XCTAssertTrue(candidates("I use it").isEmpty, "too short to be a fact")
        let paragraph = "I prefer " + String(repeating: "detail ", count: 60)
        XCTAssertTrue(candidates(paragraph).isEmpty, "too long to be a durable preference")
    }

    /// A conversation *about* preferences must not fill the memory list; a
    /// hundred rows nobody will prune is the same as no memory list.
    func testOnePassIsBounded() {
        let text = (1...20).map { "I prefer option number \($0) of the set" }
            .joined(separator: ". ")

        XCTAssertEqual(
            candidates(text).count,
            MemoryExtractionPolicy.default.maximumCandidatesPerPass
        )
    }

    /// People write lists. A newline has to end a sentence, or five preferences
    /// arrive as one over-long line and are dropped whole.
    func testNewlinesSeparateSentences() {
        let text = """
        I prefer dark roast coffee
        I always review before merging
        """

        XCTAssertEqual(candidates(text).count, 2)
    }

    func testTheSameStatementTwiceInOnePassIsProposedOnce() {
        let text = "I prefer dark roast coffee. I prefer dark roast coffee!"

        XCTAssertEqual(candidates(text).count, 1)
    }
}

// MARK: - The engine

final class MemoryExtractionEngineTests: XCTestCase {

    private func turns(_ text: String) -> [MemoryExtractionTurn] {
        [MemoryExtractionTurn(role: .user, text: text)]
    }

    /// **Not knowing whether the reader consented is not consent.** A settings
    /// record that has not loaded must skip the pass, and must be distinguishable
    /// from a reader who switched memory off.
    func testUnknownConsentIsNotTreatedAsPermission() async {
        let engine = MemoryExtractionEngine()

        let outcome = await engine.pass(
            turns: turns("I prefer dark roast coffee"),
            conversationID: "conversation-a",
            memoryEnabled: nil,
            existingMemories: []
        )

        XCTAssertEqual(outcome, .consentUnknown)
    }

    func testMemoryOffStoresNothingAndSaysWhy() async {
        let engine = MemoryExtractionEngine()

        let outcome = await engine.pass(
            turns: turns("I prefer dark roast coffee"),
            conversationID: "conversation-a",
            memoryEnabled: false,
            existingMemories: []
        )

        XCTAssertEqual(outcome, .disabledByAccount)
    }

    func testAnExcludedConversationIsNeverRead() async {
        let engine = MemoryExtractionEngine()

        let outcome = await engine.pass(
            turns: turns("I prefer dark roast coffee"),
            conversationID: "conversation-a",
            memoryEnabled: true,
            existingMemories: [],
            isExcluded: true
        )

        XCTAssertEqual(outcome, .excludedConversation)
    }

    func testAPassProposesOnlyWhatTheAccountDoesNotAlreadyKnow() async throws {
        let engine = MemoryExtractionEngine()

        let outcome = await engine.pass(
            turns: turns("I prefer dark roast coffee. I always review before merging."),
            conversationID: "conversation-a",
            memoryEnabled: true,
            // Same fact, different punctuation and case — still the same fact.
            existingMemories: ["Prefers dark roast coffee!"]
        )

        guard case .proposed(let candidates) = outcome else {
            return XCTFail("expected proposals, got \(outcome)")
        }
        XCTAssertEqual(candidates.map(\.content), ["always review before merging"])
    }

    /// A long chat finalizes a turn every few seconds, and re-reading the whole
    /// thing each time is work that grows with the square of the conversation.
    func testASecondPassTooSoonIsSkipped() async {
        let engine = MemoryExtractionEngine(minimumInterval: 60)
        let start = Date(timeIntervalSince1970: 1_770_000_000)

        let first = await engine.pass(
            turns: turns("I prefer dark roast coffee"),
            conversationID: "conversation-a",
            memoryEnabled: true,
            existingMemories: [],
            now: start
        )
        let second = await engine.pass(
            turns: turns("I always review before merging"),
            conversationID: "conversation-a",
            memoryEnabled: true,
            existingMemories: [],
            now: start.addingTimeInterval(5)
        )
        let later = await engine.pass(
            turns: turns("I always review before merging"),
            conversationID: "conversation-a",
            memoryEnabled: true,
            existingMemories: [],
            now: start.addingTimeInterval(120)
        )

        guard case .proposed = first else { return XCTFail("the first pass must run") }
        XCTAssertEqual(second, .throttled)
        guard case .proposed = later else { return XCTFail("the throttle must expire") }
    }

    /// The throttle is per conversation: two chats open at once must not starve
    /// each other.
    func testTheThrottleIsPerConversation() async {
        let engine = MemoryExtractionEngine(minimumInterval: 60)
        let start = Date(timeIntervalSince1970: 1_770_000_000)

        _ = await engine.pass(
            turns: turns("I prefer dark roast coffee"),
            conversationID: "conversation-a",
            memoryEnabled: true, existingMemories: [], now: start
        )
        let other = await engine.pass(
            turns: turns("I prefer dark roast coffee"),
            conversationID: "conversation-b",
            memoryEnabled: true, existingMemories: [], now: start
        )

        guard case .proposed = other else {
            return XCTFail("a different conversation must not be throttled")
        }
    }

    /// After a deletion the reader may want the same thing found again, so the
    /// throttle has to be releasable.
    func testForgettingTheThrottleAllowsAnImmediateRepass() async {
        let engine = MemoryExtractionEngine(minimumInterval: 60)
        let start = Date(timeIntervalSince1970: 1_770_000_000)
        _ = await engine.pass(
            turns: turns("I prefer dark roast coffee"),
            conversationID: "conversation-a",
            memoryEnabled: true, existingMemories: [], now: start
        )

        await engine.forgetThrottle(conversationID: "conversation-a")
        let again = await engine.pass(
            turns: turns("I prefer dark roast coffee"),
            conversationID: "conversation-a",
            memoryEnabled: true, existingMemories: [], now: start.addingTimeInterval(1)
        )

        guard case .proposed = again else { return XCTFail("the throttle was not released") }
    }

    /// The engine proposes; it never writes. Nothing here touches a store.
    func testAPassWithNothingWorthKeepingSaysSoRatherThanProposingEmpty() async {
        let engine = MemoryExtractionEngine()

        let outcome = await engine.pass(
            turns: turns("What time is the meeting?"),
            conversationID: "conversation-a",
            memoryEnabled: true,
            existingMemories: []
        )

        XCTAssertEqual(outcome, .nothingWorthKeeping)
    }
}

// MARK: - Injection

final class MemoryInjectionTests: XCTestCase {

    private func memory(
        id: String,
        content: String,
        kind: NativeMemoryKind = .fact,
        updatedAt: TimeInterval = 1_760_000_000
    ) -> NativeMemoryEntry {
        NativeMemoryEntry(
            id: id,
            content: content,
            source: .automatic,
            kind: kind,
            sourceReference: nil,
            createdAt: Date(timeIntervalSince1970: updatedAt),
            updatedAt: Date(timeIntervalSince1970: updatedAt),
            revision: 1
        )
    }

    /// Nil rather than an empty string: an empty header is a *claim* that Juno
    /// remembers nothing, and it would be sent for an account whose memories have
    /// simply not loaded yet.
    func testNoMemoriesProducesNoBlockAtAll() {
        XCTAssertNil(MemoryInjection.block(from: []))
    }

    func testTheBlockCarriesEveryMemoryUnderTheFixedHeader() throws {
        let block = try XCTUnwrap(
            MemoryInjection.block(from: [
                memory(id: "a", content: "prefers dark roast coffee"),
                memory(id: "b", content: "works at a hardware company"),
            ])
        )

        XCTAssertTrue(block.hasPrefix(MemoryInjection.header))
        XCTAssertTrue(block.contains("- prefers dark roast coffee"))
        XCTAssertTrue(block.contains("- works at a hardware company"))
    }

    /// A dropped preference is a worse answer; a dropped prohibition is the thing
    /// the reader explicitly asked Juno never to do. Prohibitions go first, where
    /// a model that runs out of context still reads them.
    func testProhibitionsComeBeforeFacts() throws {
        let block = try XCTUnwrap(
            MemoryInjection.block(from: [
                memory(id: "a", content: "prefers dark roast coffee"),
                memory(id: "b", content: "em dashes", kind: .suppression),
            ])
        )

        let suppression = try XCTUnwrap(block.range(of: "Avoid: em dashes"))
        let fact = try XCTUnwrap(block.range(of: "prefers dark roast coffee"))
        XCTAssertLessThan(suppression.lowerBound, fact.lowerBound)
    }

    /// An unstable prompt defeats prompt caching and makes two identical
    /// questions cost twice.
    func testTheBlockIsByteStableAcrossBuilds() {
        let entries = [
            memory(id: "b", content: "second", updatedAt: 1_760_000_000),
            memory(id: "a", content: "first", updatedAt: 1_760_000_000),
            memory(id: "c", content: "newest", updatedAt: 1_770_000_000),
        ]

        let first = MemoryInjection.block(from: entries)
        let shuffled = MemoryInjection.block(from: entries.reversed())

        XCTAssertEqual(first, shuffled)
        // Newest first, ties broken by id.
        XCTAssertEqual(
            first,
            [
                MemoryInjection.header,
                "- newest",
                "- first",
                "- second",
            ].joined(separator: "\n")
        )
    }

    /// The budget bounds the block, not the store: memories past it are still
    /// stored, still visible and still deletable, they are simply not sent.
    func testTheBlockStaysInsideItsBudget() throws {
        let entries = (0..<400).map {
            memory(
                id: String(format: "%04d", $0),
                content: String(repeating: "x", count: 40),
                updatedAt: 1_760_000_000
            )
        }

        let block = try XCTUnwrap(MemoryInjection.block(from: entries))

        XCTAssertLessThanOrEqual(
            block.count,
            MemoryInjection.maximumCharacters,
            "the budget covers the rendered block, header and newlines included"
        )
        XCTAssertTrue(block.contains("xxxx"))
    }

    func testADisallowedBlockIsAbsentRatherThanEmpty() {
        XCTAssertNil(
            MemoryInjection.block(
                from: [memory(id: "a", content: "prefers dark roast coffee")],
                allowed: false
            )
        )
    }

    func testBlankMemoriesAreSkippedWithoutEndingTheBlock() throws {
        let block = try XCTUnwrap(
            MemoryInjection.block(from: [
                memory(id: "a", content: "   ", updatedAt: 1_770_000_000),
                memory(id: "b", content: "prefers dark roast coffee"),
            ])
        )

        XCTAssertTrue(block.contains("- prefers dark roast coffee"))
        XCTAssertFalse(block.contains("- \n"))
    }
}
