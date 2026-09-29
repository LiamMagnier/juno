import XCTest
@testable import JunoDesignSystem

/// Holds the native face to the web's vocabulary and seeding.
///
/// Two failures are guarded here, and both are silent without a test. A word
/// out of order in one of the enums still compiles and still draws a face —
/// just not the one `defaultAgentAvatar` in `src/lib/agents/avatar.ts` picked,
/// so the Mac and the browser would show one agent with two faces. And a raw
/// value spelled differently from the web decodes to the seeded fallback, so a
/// face somebody chose would quietly revert.
///
/// The expected faces were computed by running the TypeScript itself:
/// `npx tsx -e 'import {defaultAgentAvatar} from "./src/lib/agents/avatar"; …'`.
final class JunoAgentFaceTests: XCTestCase {
    func testTheVocabularyIsTheWebsVocabularyInTheWebsOrder() {
        XCTAssertEqual(
            JunoAgentShape.allCases.map(\.rawValue),
            ["orb", "pebble", "capsule", "petal", "bloom", "spark", "tile", "halo", "prism"]
        )
        XCTAssertEqual(
            JunoAgentTone.allCases.map(\.rawValue),
            ["coral", "juniper", "teal", "violet", "amber", "sage"]
        )
        XCTAssertEqual(
            JunoAgentEyes.allCases.map(\.rawValue),
            ["soft", "round", "tall", "wide"]
        )
        XCTAssertEqual(
            JunoAgentMark.allCases.map(\.rawValue),
            ["none", "ring", "spark", "leaf", "antenna", "visor"]
        )
        XCTAssertEqual(
            JunoAgentState.allCases.map(\.rawValue),
            ["idle", "thinking", "working", "waiting", "blocked", "done", "sleeping", "listening"]
        )
    }

    func testEveryWordRoundTripsThroughItsRawValue() {
        for shape in JunoAgentShape.allCases {
            XCTAssertEqual(JunoAgentShape(rawValue: shape.rawValue), shape)
        }
        for tone in JunoAgentTone.allCases {
            XCTAssertEqual(JunoAgentTone(rawValue: tone.rawValue), tone)
        }
        for eyes in JunoAgentEyes.allCases {
            XCTAssertEqual(JunoAgentEyes(rawValue: eyes.rawValue), eyes)
        }
        for mark in JunoAgentMark.allCases {
            XCTAssertEqual(JunoAgentMark(rawValue: mark.rawValue), mark)
        }
        for state in JunoAgentState.allCases {
            XCTAssertEqual(JunoAgentState(rawValue: state.rawValue), state)
        }
        XCTAssertNil(JunoAgentShape(rawValue: "Orb"))
        XCTAssertNil(JunoAgentState(rawValue: "asleep"))
    }

    /// `AGENT_STATE_LABEL`: the word said beside the face.
    func testStateLabelsAreTheWebsWords() {
        XCTAssertEqual(
            JunoAgentState.allCases.map(\.label),
            ["Ready", "Thinking", "Working", "Needs you", "Stopped", "Done", "Paused", "Listening"]
        )
    }

    func testTheSeededDefaultMatchesTheTypeScriptBitForBit() {
        let expected: [(seed: String, avatar: JunoAgentAvatar)] = [
            ("agent_1", JunoAgentAvatar(shape: .bloom, tone: .amber, eyes: .wide)),
            ("cm0xyz", JunoAgentAvatar(shape: .orb, tone: .coral, eyes: .wide)),
            ("seed", JunoAgentAvatar(shape: .capsule, tone: .juniper, eyes: .wide)),
            ("Atlas", JunoAgentAvatar(shape: .capsule, tone: .coral, eyes: .soft)),
            ("cmfz1q2w30000abcd1234efgh", JunoAgentAvatar(shape: .pebble, tone: .juniper, eyes: .wide)),
            // Outside the BMP: JavaScript walks UTF-16 code units, so the emoji
            // is two of them, and so must Swift's walk be.
            ("é漢字🙂", JunoAgentAvatar(shape: .capsule, tone: .violet, eyes: .round)),
        ]
        for (seed, avatar) in expected {
            XCTAssertEqual(JunoAgentAvatar.seeded(seed), avatar, "seed \(seed)")
        }
    }

    func testAnEmptySeedIsTheWordAgent() {
        // `hash(seed || "agent")` in the TypeScript.
        XCTAssertEqual(JunoAgentAvatar.seeded(""), JunoAgentAvatar.seeded("agent"))
        XCTAssertEqual(
            JunoAgentAvatar.seeded(""),
            JunoAgentAvatar(shape: .orb, tone: .juniper, eyes: .round)
        )
    }

    func testTheHashIsThirtyTwoBitFNV1a() {
        XCTAssertEqual(JunoAgentAvatar.seedHash("agent_1"), 4_167_343_102)
        XCTAssertEqual(JunoAgentAvatar.seedHash("cm0xyz"), 123_152_658)
        XCTAssertEqual(JunoAgentAvatar.seedHash("seed"), 1_346_747_564)
    }

    func testTheSeededMarkIsAlwaysNone() {
        for seed in ["a", "b", "agent_1", "cm0xyz", "Juniper", "🙂"] {
            XCTAssertEqual(JunoAgentAvatar.seeded(seed).mark, JunoAgentMark.none)
        }
    }

    /// `normalizeAgentAvatar`: an unknown word loses only its own part.
    func testAnUnknownPartFallsBackAloneToTheSeededDefault() {
        let fallback = JunoAgentAvatar.seeded("agent_1")
        let read = JunoAgentAvatar(
            shape: "hexagon",
            tone: "teal",
            eyes: nil,
            mark: "ring",
            seed: "agent_1"
        )
        XCTAssertEqual(read.shape, fallback.shape)
        XCTAssertEqual(read.tone, .teal)
        XCTAssertEqual(read.eyes, fallback.eyes)
        XCTAssertEqual(read.mark, .ring)
    }
}
