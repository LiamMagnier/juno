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

    // MARK: - Geometry is the web's table

    /// `SHAPES` and `EYES` in agent-face.tsx, number for number.
    func testShapeAndEyeGeometryIsTheWebsTable() throws {
        let expected: [JunoAgentShape: (CGPoint, CGPoint, CGFloat)] = [
            .tile: (CGPoint(x: 24, y: 32), CGPoint(x: 40, y: 32), 0.9),
            .halo: (CGPoint(x: 25, y: 33), CGPoint(x: 39, y: 33), 0.85),
            .prism: (CGPoint(x: 25, y: 32), CGPoint(x: 39, y: 32), 0.85),
            .orb: (CGPoint(x: 24, y: 31), CGPoint(x: 40, y: 31), 1),
            .pebble: (CGPoint(x: 24, y: 32), CGPoint(x: 40, y: 32), 1),
            .capsule: (CGPoint(x: 26, y: 29), CGPoint(x: 38, y: 29), 0.9),
            .petal: (CGPoint(x: 26, y: 34), CGPoint(x: 42, y: 34), 1),
            .bloom: (CGPoint(x: 25, y: 32), CGPoint(x: 39, y: 32), 0.95),
            .spark: (CGPoint(x: 27, y: 33), CGPoint(x: 37, y: 33), 0.75),
        ]
        for shape in JunoAgentShape.allCases {
            let spec = shape.spec
            let want = try XCTUnwrap(expected[shape])
            XCTAssertEqual(spec.leftEye, want.0, "\(shape) left eye")
            XCTAssertEqual(spec.rightEye, want.1, "\(shape) right eye")
            XCTAssertEqual(spec.eyeScale, want.2, "\(shape) eye scale")
            // Every body sits inside the 64-unit box it is drawn in.
            XCTAssertTrue(CGRect(x: 0, y: 0, width: 64, height: 64).contains(shape.bodyPath.boundingRect), "\(shape) body")
        }
        let cuts = JunoAgentEyes.allCases.map(\.cut)
        XCTAssertEqual(cuts.map(\.width), [7, 6.5, 5, 10])
        XCTAssertEqual(cuts.map(\.height), [9, 6.5, 11, 5.5])
        XCTAssertEqual(cuts.map(\.radius), [2.5, 3.25, 2.5, 2.75])
    }

    // MARK: - The rig

    /// `GAZE_GAIN`.
    func testGazeGainIsTheWebsTable() {
        let gains = JunoAgentState.allCases.map { JunoAgentFaceRig.gazeGain($0) }
        // idle, thinking, working, waiting, blocked, done, sleeping, listening
        XCTAssertEqual(gains, [1, 0.25, 0.35, 1.15, 0.5, 0.8, 0, 0.9])
    }

    func testGazeLooksAtThePointerAndEasesOffWithDistance() {
        let face = CGRect(x: 100, y: 100, width: 48, height: 48)
        // Right on top of the face: straight at you.
        let onTop = JunoAgentFaceRig.gazeTarget(pointer: CGPoint(x: 124, y: 124), faceFrame: face, state: .idle, idle: .zero)
        XCTAssertEqual(onTop, .zero)
        // To the right and near: the eyes go right, never past the reach.
        let near = JunoAgentFaceRig.gazeTarget(pointer: CGPoint(x: 204, y: 124), faceFrame: face, state: .idle, idle: .zero)
        XCTAssertGreaterThan(near.width, 1.5)
        XCTAssertLessThanOrEqual(near.width, JunoAgentFaceRig.maxGazeX)
        XCTAssertEqual(near.height, 0, accuracy: 0.0001)
        // Further away, less attention.
        let far = JunoAgentFaceRig.gazeTarget(pointer: CGPoint(x: 364, y: 124), faceFrame: face, state: .idle, idle: .zero)
        XCTAssertLessThan(far.width, near.width)
        // Out of reach (280pt for a small face): the idle glance, times the gain.
        let away = JunoAgentFaceRig.gazeTarget(pointer: CGPoint(x: 1_000, y: 124), faceFrame: face, state: .waiting, idle: CGPoint(x: 1, y: -1))
        XCTAssertEqual(away.width, 1.15, accuracy: 0.0001)
        XCTAssertEqual(away.height, -1.15, accuracy: 0.0001)
        // Asleep, it looks nowhere.
        let asleep = JunoAgentFaceRig.gazeTarget(pointer: CGPoint(x: 204, y: 124), faceFrame: face, state: .sleeping, idle: CGPoint(x: 2, y: 1))
        XCTAssertEqual(asleep, .zero)
        // Working, it mostly keeps its eyes on the job.
        let working = JunoAgentFaceRig.gazeTarget(pointer: CGPoint(x: 204, y: 124), faceFrame: face, state: .working, idle: .zero)
        XCTAssertEqual(working.width, near.width * 0.35, accuracy: 0.0001)
    }

    func testBlinksAndGlancesKeepTheWebsTiming() {
        var random = SplitMix64(seed: 7)
        var twice = 0
        for _ in 0..<2_000 {
            let blink = JunoAgentFaceRig.nextBlink(using: &random)
            XCTAssertGreaterThanOrEqual(blink.delay, 2.6)
            XCTAssertLessThanOrEqual(blink.delay, 6.4)
            if blink.twice { twice += 1 }
            let glance = JunoAgentFaceRig.nextGlance(using: &random)
            XCTAssertGreaterThanOrEqual(glance.delay, 1.8)
            XCTAssertLessThanOrEqual(glance.delay, 5.2)
            XCTAssertLessThanOrEqual(abs(glance.target.x), JunoAgentFaceRig.maxGazeX * 0.7 + 0.0001)
        }
        // About one blink in six is a double blink.
        XCTAssertEqual(Double(twice) / 2_000, 0.16, accuracy: 0.04)

        XCTAssertEqual(JunoAgentFaceRig.lid(elapsed: 0), 1, accuracy: 0.0001)
        XCTAssertEqual(JunoAgentFaceRig.lid(elapsed: 0.09), 0.08, accuracy: 0.0001)
        XCTAssertEqual(JunoAgentFaceRig.lid(elapsed: 0.3), 1, accuracy: 0.0001)
        XCTAssertEqual(JunoAgentFaceRig.blinkStarts(twice: true), [0, 0.245])
        // Nothing to blink with the eyes shut or replaced.
        XCTAssertEqual(JunoAgentState.allCases.filter { !$0.blinks }, [.blocked, .done, .sleeping])
    }

    /// The keyframes are the CSS's, at the CSS's stops.
    func testStateLoopsHitTheWebsKeyframes() throws {
        let breathe = try XCTUnwrap(JunoAgentFaceRig.loop(.idle))
        XCTAssertEqual(breathe.duration, 5.6)
        XCTAssertEqual(breathe.sample(0.5).scaleX, 1.014, accuracy: 0.0001)
        XCTAssertEqual(breathe.sample(0.5).scaleY, 1.022, accuracy: 0.0001)

        let call = try XCTUnwrap(JunoAgentFaceRig.loop(.waiting))
        XCTAssertEqual(call.duration, 3.4)
        XCTAssertEqual(call.sample(0.3), .identity)
        XCTAssertEqual(call.sample(0.70).y, -2.6, accuracy: 0.0001)
        XCTAssertEqual(call.sample(0.70).rotation, -5, accuracy: 0.0001)
        XCTAssertEqual(call.sample(0.85).rotation, 3.5, accuracy: 0.0001)

        let bob = try XCTUnwrap(JunoAgentFaceRig.loop(.working))
        XCTAssertEqual(bob.duration, 1.35)
        XCTAssertEqual(bob.sample(0.45).y, -1.6, accuracy: 0.0001)

        let sway = try XCTUnwrap(JunoAgentFaceRig.loop(.thinking))
        XCTAssertEqual(sway.sample(0).rotation, -2.2, accuracy: 0.0001)
        XCTAssertEqual(sway.sample(0.5).rotation, 2.2, accuracy: 0.0001)

        let read = try XCTUnwrap(JunoAgentFaceRig.eyesLoop(.working))
        XCTAssertEqual(read.sample(0.4).x, 2.2, accuracy: 0.0001)
        XCTAssertEqual(read.sample(0.5).y, 0.7, accuracy: 0.0001)

        XCTAssertEqual(JunoAgentFaceRig.hop.duration, 0.76)
        XCTAssertEqual(JunoAgentFaceRig.hop.sample(0.44).y, -5.5, accuracy: 0.0001)
        XCTAssertEqual(JunoAgentFaceRig.react.sample(0).scaleX, 0.94, accuracy: 0.0001)
        XCTAssertNil(JunoAgentFaceRig.loop(.done))
        XCTAssertNil(JunoAgentFaceRig.loop(.listening))
    }

    /// agent-face.css's resting eye per state.
    func testEyeShapesPerStateAreTheWebs() {
        let h: CGFloat = 9
        XCTAssertEqual(JunoAgentFaceRig.eyeRest(.idle, height: h), .identity)
        XCTAssertEqual(JunoAgentFaceRig.eyeRest(.thinking, height: h), JunoFaceTransform(x: 1.6, y: -2.4, scaleX: 1, scaleY: 0.8))
        XCTAssertEqual(JunoAgentFaceRig.eyeRest(.working, height: h), JunoFaceTransform(scaleX: 1.02, scaleY: 0.74))
        XCTAssertEqual(JunoAgentFaceRig.eyeRest(.waiting, height: h), JunoFaceTransform(scale: 1.2))
        XCTAssertEqual(JunoAgentFaceRig.eyeRest(.blocked, height: h).scaleY * h, 2, accuracy: 0.0001)
        XCTAssertEqual(JunoAgentFaceRig.eyeRest(.sleeping, height: h).y, 2)
        XCTAssertEqual(JunoAgentFaceRig.eyeRest(.listening, height: h, level: 1).scaleX, 1.45, accuracy: 0.0001)
    }

    func testReduceMotionHoldsTheStillPose() {
        for state in JunoAgentState.allCases {
            let input = JunoAgentFaceRigInput(
                state: state,
                previousState: .idle,
                stateSince: 100,
                appeared: false,
                eyeHeight: 9,
                hovered: true,
                hoverSince: 100,
                gazeTo: CGSize(width: 3, height: 1),
                gazeSince: 100,
                blinks: [100]
            )
            let pose = JunoAgentFaceRig.pose(input, now: 100.05, reduceMotion: true)
            XCTAssertEqual(pose, JunoAgentFacePose.still(state, eyeHeight: 9), "\(state)")
            XCTAssertEqual(pose.rig, .identity)
            XCTAssertEqual(pose.gaze, .zero)
            XCTAssertEqual(pose.lids, 1)
        }
        let done = JunoAgentFacePose.still(.done, eyeHeight: 9)
        XCTAssertEqual(done.lidsOpacity, 0)
        XCTAssertEqual(done.happy, .identity)
        XCTAssertEqual(JunoAgentFacePose.still(.blocked, eyeHeight: 9).all.rotation, -4)
        XCTAssertEqual(JunoAgentFacePose.still(.sleeping, eyeHeight: 9).glintOpacity, 0)
        XCTAssertEqual(JunoAgentFacePose.still(.working, eyeHeight: 9).bars, [0.55, 0.55, 0.55])
        XCTAssertEqual(JunoAgentFacePose.still(.thinking, eyeHeight: 9).thoughts.map(\.opacity), [0.6, 0.6, 0.6])
    }

    func testDoneHopsOnceAndOtherChangesSettle() {
        var input = JunoAgentFaceRigInput(state: .done, previousState: nil, stateSince: 0, appeared: true, eyeHeight: 9)
        // A face that appears already done still hops, as the web's does on mount.
        XCTAssertEqual(JunoAgentFaceRig.pose(input, now: 0.76 * 0.44, reduceMotion: false).rig.y, -5.5, accuracy: 0.0001)
        XCTAssertEqual(JunoAgentFaceRig.pose(input, now: 2, reduceMotion: false).rig, .identity)

        input = JunoAgentFaceRigInput(state: .working, previousState: .idle, stateSince: 0, appeared: false, eyeHeight: 9)
        XCTAssertEqual(JunoAgentFaceRig.pose(input, now: 0, reduceMotion: false).rig.scaleX, 0.94, accuracy: 0.0001)
        XCTAssertEqual(JunoAgentFaceRig.pose(input, now: 1, reduceMotion: false).rig, .identity)
        // And the eye shape eases from the old state's to the new one's.
        XCTAssertEqual(JunoAgentFaceRig.pose(input, now: 0, reduceMotion: false).eye, .identity)
        XCTAssertEqual(JunoAgentFaceRig.pose(input, now: 1, reduceMotion: false).eye, JunoAgentFaceRig.eyeRest(.working, height: 9))
    }

    func testHoverLiftsAndBlinksClose() {
        let input = JunoAgentFaceRigInput(
            state: .idle, previousState: nil, stateSince: -100, appeared: true, eyeHeight: 9,
            hovered: true, hoverSince: 0, blinks: [0]
        )
        XCTAssertEqual(JunoAgentFaceRig.pose(input, now: 1, reduceMotion: false).rig.y, -1.8, accuracy: 0.0001)
        XCTAssertEqual(JunoAgentFaceRig.pose(input, now: 0.09, reduceMotion: false).lids, 0.08, accuracy: 0.0001)
        // Asleep, nothing lifts and nothing blinks.
        var asleep = input
        asleep.state = .sleeping
        XCTAssertEqual(JunoAgentFaceRig.pose(asleep, now: 1, reduceMotion: false).rig.y, 0, accuracy: 0.0001)
        XCTAssertEqual(JunoAgentFaceRig.pose(asleep, now: 0.09, reduceMotion: false).lids, 1)
    }

    func testTheHaloCarriesTheState() {
        XCTAssertEqual(JunoAgentState.allCases.map { JunoAgentHalo.opacity($0) }, [0.55, 0.8, 1, 1, 0.55, 0.55, 0.25, 0.55])
        XCTAssertEqual(JunoAgentState.allCases.filter { JunoAgentHalo.turns($0) }, [.thinking])
        XCTAssertEqual(JunoAgentState.allCases.filter { JunoAgentStatusLine.isLive($0) }, [.thinking, .working])
    }
}

/// A seeded generator, so the random timing can be held to its ranges.
private struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
