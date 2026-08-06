import JunoCore
import XCTest

@testable import JunoWorkKit

/// The vocabulary's one job is that **no wire token reaches a person**.
///
/// These tests assert that property rather than the individual strings, because
/// the strings are copy and will be edited; the property is the contract. The
/// failure they exist to catch is the one this table was written to fix — a
/// tool, reason or kind that nobody wrote a phrase for, rendered raw in the
/// largest line of the window.
final class JunoWorkVocabularyTests: XCTestCase {
    /// Every tool the executors actually register.
    ///
    /// Kept as a literal list rather than read from `JunoWorkRuntime`: this
    /// package cannot import the executor, and a test that derived the list from
    /// the same place the table does would pass no matter what. Adding a tool
    /// means adding it here, which is the point — the failure is a reminder to
    /// write the phrase.
    private let registeredTools = [
        "list_folder", "read_file", "search_files", "file_details",
        "apply_changes", "permanently_delete",
        "browser_control", "app_control", "screen_control",
    ]

    func testEveryRegisteredToolHasAPresentAndPastPhrase() {
        for tool in registeredTools {
            let present = JunoWorkVocabulary.toolPresent(tool)
            let past = JunoWorkVocabulary.toolPast(tool)
            XCTAssertFalse(
                present.contains("_"),
                "\(tool) has no present-tense phrase — it fell through to the raw token"
            )
            XCTAssertFalse(
                past.contains("_"),
                "\(tool) has no past-tense phrase — it fell through to the raw token"
            )
            // The two tenses must differ, or the timeline says "Reading a file"
            // under a call that finished half an hour ago.
            XCTAssertNotEqual(present, past, "\(tool) reads the same in both tenses")
        }
    }

    func testEveryRegisteredToolHasAnApprovalActionName() {
        for tool in registeredTools {
            let action = JunoWorkVocabulary.action(tool)
            XCTAssertFalse(
                action.contains("_"),
                "\(tool) reaches the approval card as a raw token"
            )
        }
    }

    /// The floor: a tool shipped by an executor a release ahead of this build.
    func testAnUnknownTokenIsSentenceCasedRatherThanPrinted() {
        XCTAssertEqual(JunoWorkVocabulary.toolPresent("draft_email"), "Draft email")
        XCTAssertEqual(JunoWorkVocabulary.action("send.invoice"), "Send invoice")
        XCTAssertEqual(JunoWorkVocabulary.toolPast("archive-folder"), "Archive folder")
    }

    func testMissingOrEmptyNamesDegradeToAPhrase() {
        XCTAssertEqual(JunoWorkVocabulary.toolPresent(nil), "Working")
        XCTAssertEqual(JunoWorkVocabulary.toolPresent("   "), "Working")
        XCTAssertEqual(JunoWorkVocabulary.action(nil), "An action")
    }

    /// A clean finish adds nothing to the status, so it says nothing.
    ///
    /// This is what turned "Finished — completed" into "Finished".
    func testACompletedRunHasNoReasonToState() {
        XCTAssertNil(JunoWorkVocabulary.terminalReason("completed"))
    }

    func testEveryTerminalReasonReadsAsASentenceFragment() {
        for reason in JunoWorkTerminalReason.allCases where reason != .completed {
            guard let phrase = JunoWorkVocabulary.terminalReason(reason.rawValue) else {
                XCTFail("\(reason.rawValue) has no phrase")
                continue
            }
            XCTAssertFalse(
                phrase.contains("_"),
                "\(reason.rawValue) reaches the timeline as a raw token"
            )
            // Lower-case because it is interpolated mid-sentence, after
            // "Finished because …".
            XCTAssertEqual(
                phrase.first, phrase.first?.lowercased().first,
                "\(reason.rawValue) is capitalised but is used mid-sentence"
            )
        }
    }

    func testEveryArtifactKindHasANounAndAGlyph() {
        for kind in JunoWorkArtifactKind.allCases {
            XCTAssertFalse(
                JunoWorkVocabulary.artifactKind(kind).isEmpty,
                "\(kind.rawValue) has no noun"
            )
            let symbol = JunoWorkVocabulary.artifactSymbol(kind)
            XCTAssertFalse(symbol.isEmpty, "\(kind.rawValue) has no glyph")
            XCTAssertFalse(
                symbol.contains("_"),
                "\(kind.rawValue)'s glyph looks like a token, not an SF Symbol"
            )
        }
    }

    func testEveryRiskLevelSaysWhatItMeansInTheSecondPerson() {
        for risk in JunoWorkRiskLevel.allCases {
            let phrase = JunoWorkVocabulary.risk(risk.rawValue)
            XCTAssertFalse(phrase.isEmpty, "\(risk.rawValue) has no phrase")
            XCTAssertFalse(phrase.contains("_"), "\(risk.rawValue) is a raw token")
        }
        // An unrecognised level must still ask rather than reassure.
        XCTAssertEqual(JunoWorkVocabulary.risk("something_new"), "Needs your decision")
    }

    /// Where a run happens is named from the *effective* target, and an absent
    /// one says so rather than guessing a Mac.
    func testTargetNamesTheMacOnlyWhenThereIsOne() {
        XCTAssertEqual(
            JunoWorkVocabulary.target("local", hostName: "Liam’s MacBook Pro"),
            "Runs on Liam’s MacBook Pro"
        )
        XCTAssertEqual(
            JunoWorkVocabulary.target("local", hostName: nil),
            "Runs on a Mac of yours"
        )
        XCTAssertEqual(JunoWorkVocabulary.target("cloud", hostName: nil), "Runs in the cloud")
        XCTAssertTrue(
            JunoWorkVocabulary.target(nil, hostName: nil).contains("hasn’t chosen")
        )
    }
}
