import XCTest
@testable import JunoVoiceKit

/// The one rule a spoken transcript has to keep: a question is above its answer.
///
/// A realtime relay does not deliver a turn in the order it happened. The model
/// starts answering the moment the reader stops talking, while their own words
/// are still being transcribed — so the frames arrive answer-first, routinely by
/// a second or more. Every case below is a real frame order, replayed.
final class JunoVoiceTranscriptRecordTests: XCTestCase {

    private func transcript(_ record: JunoVoiceTranscriptRecord) -> [String] {
        record.lines.map { "\($0.role.rawValue): \($0.text)" }
    }

    /// The frame order for one turn: the model is already speaking before the
    /// question exists.
    func testALateQuestionIsFiledAboveTheAnswerItPrompted() {
        var record = JunoVoiceTranscriptRecord()
        record.beginAnswer()
        record.upsert(role: .assistant, text: "Paris.", final: true)
        record.upsert(role: .user, text: "What is the capital of France?", final: true)

        XCTAssertEqual(
            transcript(record),
            ["user: What is the capital of France?", "assistant: Paris."]
        )
    }

    /// The regression this file exists for.
    ///
    /// The previous fix walked backwards over the trailing run of assistant lines.
    /// That is right for turn one and wrong from turn two on: nothing separates
    /// the two answers until this very insert, so the walk stepped over both and
    /// produced Q1 Q2 A1 A2 — an ordering that reads fine at the top of the page
    /// and is nonsense by the bottom.
    func testTheSecondQuestionDoesNotJumpAboveTheFirstAnswer() {
        var record = JunoVoiceTranscriptRecord()
        record.beginAnswer()
        record.upsert(role: .assistant, text: "Paris.", final: true)
        record.upsert(role: .user, text: "Capital of France?", final: true)

        record.beginAnswer()
        record.upsert(role: .assistant, text: "Rome.", final: true)
        record.upsert(role: .user, text: "And Italy?", final: true)

        XCTAssertEqual(
            transcript(record),
            [
                "user: Capital of France?",
                "assistant: Paris.",
                "user: And Italy?",
                "assistant: Rome.",
            ]
        )
    }

    func testTenTurnsStayInterleaved() {
        var record = JunoVoiceTranscriptRecord()
        for turn in 1...10 {
            record.beginAnswer()
            record.upsert(role: .assistant, text: "A\(turn)", final: true)
            record.upsert(role: .user, text: "Q\(turn)", final: true)
        }
        XCTAssertEqual(
            record.lines.map(\.role),
            (1...10).flatMap { _ in [JunoVoiceTranscriptRole.user, .assistant] }
        )
        XCTAssertEqual(transcript(record).first, "user: Q1")
        XCTAssertEqual(transcript(record).last, "assistant: A10")
    }

    /// Some relays send no turn frame. The first assistant word then marks where
    /// the answer began, so a late question still lands above it.
    func testAnAnswerWithNoTurnFrameStillMarksItsOwnStart() {
        var record = JunoVoiceTranscriptRecord()
        record.upsert(role: .assistant, text: "Paris.", final: true)
        record.upsert(role: .user, text: "Capital of France?", final: true)
        XCTAssertEqual(transcript(record), ["user: Capital of France?", "assistant: Paris."])
    }

    /// The ordinary case, and it must not be disturbed: when transcription keeps
    /// up, the question is simply already there.
    func testAQuestionThatArrivesFirstSimplyAppends() {
        var record = JunoVoiceTranscriptRecord()
        record.upsert(role: .user, text: "Capital of France?", final: true)
        record.beginAnswer()
        record.upsert(role: .assistant, text: "Paris.", final: true)
        XCTAssertEqual(transcript(record), ["user: Capital of France?", "assistant: Paris."])
    }

    /// A growing utterance rewrites its own row. Appending each frame would print
    /// the same sentence once per word as it is spoken.
    func testPartialsRewriteTheirOwnRowRatherThanStacking() {
        var record = JunoVoiceTranscriptRecord()
        record.beginAnswer()
        record.upsert(role: .assistant, text: "Par", final: false)
        record.upsert(role: .assistant, text: "Paris", final: false)
        record.upsert(role: .assistant, text: "Paris.", final: true)
        XCTAssertEqual(record.lines.count, 1)
        XCTAssertEqual(record.lines[0].text, "Paris.")
        XCTAssertTrue(record.lines[0].final)
    }

    /// A partial question opens the row in the right place, and the final one
    /// updates it there instead of opening a second.
    func testAPartialQuestionKeepsItsPlaceWhenItIsFinalised() {
        var record = JunoVoiceTranscriptRecord()
        record.beginAnswer()
        record.upsert(role: .assistant, text: "Paris.", final: false)
        record.upsert(role: .user, text: "Capital of", final: false)
        record.upsert(role: .user, text: "Capital of France?", final: true)
        record.upsert(role: .assistant, text: "Paris.", final: true)

        XCTAssertEqual(
            transcript(record),
            ["user: Capital of France?", "assistant: Paris."]
        )
    }

    /// Two questions in one turn — the reader carried on talking. The second
    /// belongs after the first, not on top of it.
    func testASecondQuestionInTheSameTurnFollowsTheFirst() {
        var record = JunoVoiceTranscriptRecord()
        record.beginAnswer()
        record.upsert(role: .assistant, text: "Sure.", final: true)
        record.upsert(role: .user, text: "First thought.", final: true)
        record.upsert(role: .user, text: "Second thought.", final: true)

        XCTAssertEqual(
            transcript(record),
            ["user: First thought.", "assistant: Sure.", "user: Second thought."]
        )
    }

    /// The cap trims from the front, which shifts every index — including the
    /// remembered boundary. Left stale it would file the next question into the
    /// middle of an older answer.
    func testTrimmingKeepsTheBoundaryPointingAtTheRightPlace() {
        var record = JunoVoiceTranscriptRecord()
        for turn in 1...JunoVoiceTranscriptRecord.capacity {
            record.beginAnswer()
            record.upsert(role: .assistant, text: "A\(turn)", final: true)
            record.upsert(role: .user, text: "Q\(turn)", final: true)
        }
        XCTAssertEqual(record.lines.count, JunoVoiceTranscriptRecord.capacity)
        // Whatever survived the trim, the pairing must still hold: no answer may
        // sit directly above the question that produced it.
        for (index, line) in record.lines.enumerated() where line.role == .assistant {
            guard index + 1 < record.lines.count else { continue }
            let following = record.lines[index + 1]
            if following.role == .user {
                XCTAssertNotEqual(
                    following.text.dropFirst(),
                    line.text.dropFirst(),
                    "Q\(line.text.dropFirst()) must not follow its own answer"
                )
            }
        }
    }

    // MARK: Shared images

    /// The images arrive once, on the relay's echo of a composed turn, and the
    /// line they land on is what gets posted to `/api/voice/transcript` on
    /// hang-up. A late question still files above its answer, so the pictures
    /// have to travel with it.
    func testALateComposedTurnKeepsItsImagesAboveTheAnswer() {
        var record = JunoVoiceTranscriptRecord()
        record.beginAnswer()
        record.upsert(role: .assistant, text: "That is a receipt.", final: true)
        record.upsert(
            role: .user, text: "Shared an image", final: true, attachmentIDs: ["att_1"]
        )

        XCTAssertEqual(record.lines.map(\.role), [.user, .assistant])
        XCTAssertEqual(record.lines[0].attachmentIDs, ["att_1"])
        XCTAssertTrue(record.lines[1].attachmentIDs.isEmpty)
    }

    /// The regression this parameter's default exists to prevent. Only the echo
    /// carries ids; the partials that keep rewriting the same row carry none, so
    /// assigning unconditionally would wipe the pictures off a line that had
    /// them a moment ago — and the loss would only show up after the call, in
    /// the saved conversation.
    func testLaterFramesForTheSameLineDoNotClearItsImages() {
        var record = JunoVoiceTranscriptRecord()
        record.upsert(role: .user, text: "look at", final: false, attachmentIDs: ["att_1"])
        record.upsert(role: .user, text: "look at this", final: true)

        XCTAssertEqual(record.lines.count, 1)
        XCTAssertEqual(record.lines[0].text, "look at this")
        XCTAssertEqual(record.lines[0].attachmentIDs, ["att_1"])
    }

    /// A spoken line has no images, and must not inherit the previous turn's.
    func testAnOrdinarySpokenLineCarriesNoImages() {
        var record = JunoVoiceTranscriptRecord()
        record.upsert(role: .user, text: "Shared an image", final: true, attachmentIDs: ["att_1"])
        record.beginAnswer()
        record.upsert(role: .assistant, text: "A receipt.", final: true)
        record.upsert(role: .user, text: "And this one?", final: true)

        XCTAssertEqual(record.lines.map(\.attachmentIDs), [["att_1"], [], []])
    }

    func testResetClearsTheBoundaryAsWellAsTheLines() {
        var record = JunoVoiceTranscriptRecord()
        record.beginAnswer()
        record.upsert(role: .assistant, text: "Paris.", final: true)
        record.reset()
        record.upsert(role: .user, text: "New call.", final: true)
        XCTAssertEqual(transcript(record), ["user: New call."])
    }
}
