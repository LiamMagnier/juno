import XCTest
@testable import JunoCodeCore

final class TextPatchTests: XCTestCase {
    func testAppliesUniqueReplacement() throws {
        let patch = TextPatch(target: "let x = 1", replacement: "let x = 2")
        let result = try patch.apply(to: "let x = 1\nlet y = 3\n")
        XCTAssertEqual(result, "let x = 2\nlet y = 3\n")
    }

    func testAmbiguousTargetFails() {
        let patch = TextPatch(target: "x", replacement: "y")
        XCTAssertThrowsError(try patch.apply(to: "x x")) { error in
            XCTAssertEqual(error as? TextPatchError, .ambiguousTarget(occurrences: 2))
        }
    }

    func testReplaceAllReplacesEveryOccurrence() throws {
        let patch = TextPatch(target: "x", replacement: "y", replaceAll: true)
        XCTAssertEqual(try patch.apply(to: "x a x"), "y a y")
    }

    func testMissingTargetFails() {
        let patch = TextPatch(target: "absent", replacement: "y")
        XCTAssertThrowsError(try patch.apply(to: "content")) { error in
            XCTAssertEqual(error as? TextPatchError, .targetNotFound)
        }
    }

    func testDegenerateInputsFail() {
        XCTAssertThrowsError(try TextPatch(target: "", replacement: "y").apply(to: "a")) { error in
            XCTAssertEqual(error as? TextPatchError, .emptyTarget)
        }
        XCTAssertThrowsError(try TextPatch(target: "a", replacement: "a").apply(to: "a")) { error in
            XCTAssertEqual(error as? TextPatchError, .noChange)
        }
    }
}
