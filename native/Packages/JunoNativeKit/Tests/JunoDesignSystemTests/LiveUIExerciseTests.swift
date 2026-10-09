import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// The exercise card and Run (owner, 2026-10-09: "On IOS & MacOS add the new
/// exercices tool and the ability to run code like we did on the website").
final class LiveUIExerciseTests: XCTestCase {
    func testAnExerciseParsesAndNeverCarriesASolution() throws {
        let source = #"{"ui":[{"type":"exercise","title":"Exercice 1","tag":"SQL","prompt":"Affiche **les employés**.","language":"SQL","hints":["a","b","c","d","e","f"],"solution":"SELECT 1"}]}"#
        let spec = try XCTUnwrap(LiveSpecParser.parse(source).spec)
        guard case .exercise(let exercise) = spec.ui.first else { return XCTFail("not an exercise") }
        XCTAssertEqual(exercise.language, "sql")
        XCTAssertEqual(exercise.hints.count, LiveSpecLimits.hints)
        XCTAssertEqual(exercise.tag, "SQL")
        XCTAssertEqual(exercise.id, "exercise_0")
    }

    func testSendPostsTheWebsMessage() {
        XCTAssertEqual(
            LiveExerciseView.message(title: "Exercice 1", language: "sql", answer: "  SELECT *\nFROM employees;\n\n"),
            "**Exercice 1**\n\n```sql\nSELECT *\nFROM employees;\n```"
        )
        XCTAssertEqual(LiveExerciseView.message(title: "Alias", language: nil, answer: "A second name.\n"), "**Alias**\n\nA second name.")
    }

    func testTheStatementReadsBoldAndCode() {
        let statement = LiveExerciseView.statement("Affiche **les employés** du département `60`, et 2 * 3.")
        XCTAssertEqual(String(statement.characters), "Affiche les employés du département 60, et 2 * 3.")
        let bold = statement.runs.first { $0.inlinePresentationIntent == .stronglyEmphasized }
        XCTAssertEqual(bold.map { String(statement[$0.range].characters) }, "les employés")
        XCTAssertEqual(String(LiveExerciseView.statement("an **unclosed bold").characters), "an **unclosed bold")
    }

    func testRunTargetsAreTheWebsBrowserLanguages() {
        XCTAssertEqual(JunoCodeRunTarget.target(for: "PLSQL")?.language, "sql")
        XCTAssertEqual(JunoCodeRunTarget.target(for: "py")?.label, "Python")
        XCTAssertEqual(JunoCodeRunTarget.target(for: "ts")?.language, "typescript")
        XCTAssertEqual(JunoCodeRunTarget.target(for: "sql")?.outputTitle, "Output · SQLite, HR sample")
        XCTAssertNil(JunoCodeRunTarget.target(for: "c"), "the hosted sandbox's languages have no Run here")
        XCTAssertNil(JunoCodeRunTarget.target(for: nil))
    }
}
