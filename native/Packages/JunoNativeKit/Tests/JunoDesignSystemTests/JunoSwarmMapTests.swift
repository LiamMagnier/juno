import XCTest
@testable import JunoDesignSystem

/// Holds the native swarm map to the web's layout (`stageLayout` in
/// `src/components/code/v2/agents-tree.tsx`): the same run must put the same
/// faces in the same places on the Mac, the iPhone and the web.
/// tests/code-v2-agents-tree.test.ts pins the same coordinates.
final class JunoSwarmMapTests: XCTestCase {
    private func member(_ id: String, parent: String? = nil) -> JunoSwarmMember {
        JunoSwarmMember(id: id, name: id, avatar: .seeded(id), state: .working, link: .working, parentID: parent)
    }

    func testAgentsSitOnTheOrbitAndAHelperBesideItsParent() {
        let (spots, more) = JunoSwarmLayout.spots([member("a"), member("c", parent: "a"), member("b"), member("d"), member("e")])
        XCTAssertEqual(more, 0)
        let at = Dictionary(uniqueKeysWithValues: spots.map { ($0.id, $0) })
        // Four agents on the ring, turned half a step: top right, bottom right, bottom left, top left.
        XCTAssertEqual(at["a"]!.point.x, 306.07, accuracy: 0.01)
        XCTAssertEqual(at["a"]!.point.y, 48.50, accuracy: 0.01)
        XCTAssertEqual(at["b"]!.point.x, 306.07, accuracy: 0.01)
        XCTAssertEqual(at["b"]!.point.y, 147.50, accuracy: 0.01)
        XCTAssertEqual(at["d"]!.point.x, 93.93, accuracy: 0.01)
        XCTAssertEqual(at["e"]!.point.y, 48.50, accuracy: 0.01)
        XCTAssertEqual(at["a"]!.parent, CGPoint(x: 200, y: 98), "an agent the lead started hangs from the lead")
        // The helper "a" started sits just outside it, joined to it.
        XCTAssertTrue(at["c"]!.nested)
        XCTAssertEqual(at["c"]!.point.x, 342.31, accuracy: 0.01)
        XCTAssertEqual(at["c"]!.point.y, 38.35, accuracy: 0.01)
        XCTAssertEqual(at["c"]!.parent.x, at["a"]!.point.x, accuracy: 0.001)
    }

    func testAMissingOrSelfParentHangsFromTheLead() {
        let (spots, _) = JunoSwarmLayout.spots([member("x", parent: "gone"), member("y", parent: "y")])
        XCTAssertEqual(spots.map(\.nested), [false, false])
        // Two on the ring, turned half a step: right and left of the lead.
        XCTAssertEqual(spots.first?.point.x ?? 0, 350, accuracy: 0.01)
        XCTAssertEqual(spots.first?.point.y ?? 0, 98, accuracy: 0.01)
        // One alone sits at the top.
        let one = JunoSwarmLayout.spots([member("solo")]).spots
        XCTAssertEqual(one.first?.point.x ?? 0, 200, accuracy: 0.01)
        XCTAssertEqual(one.first?.point.y ?? 0, 28, accuracy: 0.01)
    }

    func testMoreThanTenAreCountedNotDrawn() {
        let (spots, more) = JunoSwarmLayout.spots((0..<13).map { member("m\($0)") })
        XCTAssertEqual(spots.count, JunoSwarmLayout.maxShown)
        XCTAssertEqual(more, 3)
    }
}
