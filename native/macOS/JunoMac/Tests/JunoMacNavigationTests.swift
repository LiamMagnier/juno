import XCTest
@testable import JunoMac

final class JunoMacNavigationTests: XCTestCase {
    /// The exact destination set, not a count.
    ///
    /// This assertion previously checked `identifiers.count == 9` against an
    /// enum with seven cases and had been failing silently. Naming the
    /// destinations makes the test fail with the difference rather than with
    /// two integers, and makes adding a destination a deliberate edit here.
    func testNavigationIdentifiersAreStableAndUnique() {
        XCTAssertEqual(
            JunoMacSection.allCases.map(\.id),
            ["chat", "search", "projects", "library", "artifacts", "code", "settings"]
        )
        XCTAssertEqual(
            Set(JunoMacSection.allCases.map(\.id)).count,
            JunoMacSection.allCases.count
        )
    }

    /// Chat is the product's default destination. `JunoMacApp` seeds its
    /// `@SceneStorage` from this case, so first launch lands on Chat and never
    /// on Juno Code.
    func testChatIsTheFirstDestination() {
        XCTAssertEqual(JunoMacSection.allCases.first, .chat)
    }

    func testEveryDestinationHasASystemImage() {
        XCTAssertTrue(JunoMacSection.allCases.allSatisfy { !$0.systemImage.isEmpty })
    }

    /// Every destination must be reachable from exactly one sidebar group, or
    /// it is either unreachable or duplicated in the source list.
    func testEveryDestinationBelongsToExactlyOneGroup() {
        let grouped = JunoMacSection.Group.allCases.flatMap(\.sections)
        XCTAssertEqual(Set(grouped), Set(JunoMacSection.allCases))
        XCTAssertEqual(grouped.count, JunoMacSection.allCases.count)
    }

    func testKeyboardShortcutsAreUnique() {
        let shortcuts = JunoMacSection.allCases.map(\.keyboardShortcut.character)
        XCTAssertEqual(Set(shortcuts).count, shortcuts.count)
    }
}
