import Foundation
import JunoCore
import JunoDesignSystem
import XCTest

@testable import JunoWorkKit

/// The Agents home's rules, held to the web's `agents-home.tsx`: the face and
/// name a new agent is given before it exists, the request that starts it,
/// the one sentence about the team, and the order the cards are in.
final class NativeAgentStarterTests: XCTestCase {
    private func agent(
        _ name: String,
        state: JunoAgentState = .idle,
        needsYou: Int = 0,
        sortOrder: Int = 0,
        pinned: Bool = false,
        avatar: JunoAgentAvatar = JunoAgentAvatar(shape: .orb, tone: .coral, eyes: .soft),
        status: NativeAgentStatus = .active
    ) -> NativeAgent {
        let date = Date(timeIntervalSince1970: 1_789_000_000)
        return NativeAgent(
            id: "agent-\(name.lowercased())", name: name, role: "", avatar: avatar, style: .warm,
            instructions: "", model: nil, reasoningEffort: nil, approvalMode: .balanced, connectorIDs: [],
            projectID: nil, conversationID: nil, status: status, proactive: true, template: nil,
            lastReflectedAt: nil, sortOrder: sortOrder, createdAt: date, updatedAt: date, state: state,
            stateSentence: "", task: nil, needsYou: needsYou, nextRoutine: nil, newIdeas: 0,
            pinnedAt: pinned ? date : nil
        )
    }

    func testANewFaceTakesTheQuietestToneAndAShapeNobodyWears() {
        // An empty team: the web's `nextFace([], salt)`.
        XCTAssertEqual(
            NativeAgentStarter.nextFace(team: [], salt: 0),
            JunoAgentAvatar(shape: .orb, tone: .juniper, eyes: .soft)
        )
        XCTAssertEqual(
            NativeAgentStarter.nextFace(team: [], salt: 5),
            JunoAgentAvatar(shape: .prism, tone: .amber, eyes: .round)
        )
        // Coral and juniper are taken, orb is worn: the face avoids all three.
        let team = [
            agent("Mira", avatar: JunoAgentAvatar(shape: .orb, tone: .coral, eyes: .soft)),
            agent("Scout", avatar: JunoAgentAvatar(shape: .pebble, tone: .juniper, eyes: .soft)),
        ]
        for salt in 0..<50 {
            let face = NativeAgentStarter.nextFace(team: team, salt: salt)
            XCTAssertFalse([.coral, .juniper].contains(face.tone), "salt \(salt)")
            XCTAssertFalse([.orb, .pebble].contains(face.shape), "salt \(salt)")
            XCTAssertEqual(face.mark, JunoAgentMark.none)
        }
    }

    func testANewNameIsNobodysYet() {
        XCTAssertEqual(NativeAgentStarter.nextName(team: [], salt: 0), "Nova")
        XCTAssertEqual(NativeAgentStarter.nextName(team: [agent("Nova")], salt: 0), "Pip")
        let everyone = NativeAgentStarter.names.map { agent($0) }
        // Everyone is taken: the list starts again rather than failing.
        XCTAssertEqual(NativeAgentStarter.nextName(team: everyone, salt: 13), "Pip")
    }

    /// `POST /api/agents` with the name, the face, the key and the job.
    func testTheStartingRequestCarriesTheJobAndTheKey() {
        let face = JunoAgentAvatar(shape: .spark, tone: .teal, eyes: .tall)
        let draft = NativeAgentStarter.draft(job: "  Watch flights to Tokyo  ", name: "Kit", avatar: face, creationKey: "key-1")
        XCTAssertEqual(draft.name, "Kit")
        XCTAssertEqual(draft.avatar, face)
        XCTAssertEqual(draft.creationKey, "key-1")
        XCTAssertEqual(draft.starterMessage, "Watch flights to Tokyo")
        XCTAssertEqual(draft.template, "custom")
        XCTAssertEqual(draft.role, "")
        XCTAssertEqual(draft.approvalMode, .balanced)
        XCTAssertTrue(draft.isValid)
    }

    func testTheTeamIsOneSentence() {
        XCTAssertEqual(NativeAgentStarter.teamSentence([agent("Atlas")]), "Everyone is caught up.")
        XCTAssertEqual(
            NativeAgentStarter.teamSentence([agent("Mira", state: .waiting), agent("Scout", state: .working)]),
            "Mira needs you. Scout is working."
        )
        XCTAssertEqual(
            NativeAgentStarter.teamSentence([
                agent("Mira", needsYou: 1), agent("Iris", state: .blocked),
                agent("Scout", state: .working), agent("Quill", state: .thinking), agent("Kit", state: .working),
            ]),
            "Mira and Iris need you. Scout and 2 others are working."
        )
    }

    /// `sortRosterAgents`: waiting first, then busy, done, idle and asleep;
    /// pinned ahead within a state; then the order they were hired in.
    func testCardsAreInTheOrderAPersonScansThem() {
        let sorted = NativeAgentStarter.sorted([
            agent("Iris", state: .sleeping, sortOrder: 0),
            agent("Atlas", state: .idle, sortOrder: 1),
            agent("Kit", state: .idle, sortOrder: 2, pinned: true),
            agent("Quill", state: .working, sortOrder: 3),
            agent("Mira", state: .waiting, sortOrder: 4),
            agent("Rex", state: .blocked, sortOrder: 5),
            agent("Sol", state: .done, sortOrder: 6),
        ])
        XCTAssertEqual(sorted.map(\.name), ["Mira", "Rex", "Quill", "Sol", "Kit", "Atlas", "Iris"])
    }

    func testTheFootnoteSaysWhatTheSentenceDoesNot() {
        XCTAssertNil(NativeAgentStarter.footnote(for: agent("Atlas")))
        XCTAssertEqual(NativeAgentStarter.footnote(for: agent("Iris", status: .paused)), "Resume it from the menu")
    }
}
