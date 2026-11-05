import Foundation
import XCTest
@testable import JunoDesignSystem

/// The Swift half of the stream pacer contract: `JunoStreamPacer` replayed over
/// the recorded arrival traces in `contracts/chat/stream-pacer.v1.json`, which
/// the web pacer generated (scripts/generate-stream-pacer-fixture.ts) and
/// `tests/stream-pacer-contract.test.ts` holds the web to. Read by path, so
/// there is one file and no copy to drift.
final class JunoStreamPacerContractTests: XCTestCase {
    private static let repository = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // …/JunoDesignSystemTests
        .deletingLastPathComponent()  // …/Tests
        .deletingLastPathComponent()  // …/JunoNativeKit
        .deletingLastPathComponent()  // …/Packages
        .deletingLastPathComponent()  // …/native
        .deletingLastPathComponent()  // the repository

    private struct Contract: Decodable {
        struct Pacer: Decodable, Equatable {
            let initialRate, minRate, maxRate, bufferSeconds, drainSeconds, rateTau, jumpAbove, jumpKeep: Double
            let wordSnap: Int
        }
        struct Ink: Decodable {
            let bands: Int
            let bandMs: Double
            let opacity: [Double]
        }
        struct Expected: Decodable {
            let shown: [Int]
            let cut: [Int]
        }
        struct Trace: Decodable {
            let name: String
            let text: String
            let arrivals: [[Int]]
            let until: Int
            let expected: Expected
        }
        let tickMs: Int
        let pacer: Pacer
        let ink: Ink
        let traces: [Trace]
    }

    private func contract() throws -> Contract {
        let url = Self.repository.appendingPathComponent("contracts/chat/stream-pacer.v1.json")
        return try JSONDecoder().decode(Contract.self, from: Data(contentsOf: url))
    }

    func testTheConstantsAreTheContracts() throws {
        let pacer = try contract().pacer
        typealias C = JunoStreamPacer.Constants
        XCTAssertEqual(
            pacer,
            Contract.Pacer(
                initialRate: C.initialRate, minRate: C.minRate, maxRate: C.maxRate,
                bufferSeconds: C.bufferSeconds, drainSeconds: C.drainSeconds, rateTau: C.rateTau,
                jumpAbove: C.jumpAbove, jumpKeep: C.jumpKeep, wordSnap: C.wordSnap
            )
        )
    }

    func testTheInkBandsAreTheContracts() throws {
        let ink = try contract().ink
        XCTAssertEqual(JunoStreamInk.bands, ink.bands)
        XCTAssertEqual(JunoStreamInk.opacity, ink.opacity)
        XCTAssertEqual(JunoStreamInk.bandDuration * 1000, ink.bandMs, accuracy: 1e-9)
        // The band life is the generated `--stream-band` token, not a literal.
        XCTAssertEqual(JunoStreamInk.bandDuration * Double(ink.bands), JunoGeneratedTiming.streamBand, accuracy: 1e-9)
    }

    /// REA chat UX T4: for every recorded arrival trace, the shown length
    /// matches the web within one character at every 16ms tick.
    func testEveryTraceShowsWhatTheWebShows() throws {
        let contract = try contract()
        XCTAssertGreaterThanOrEqual(contract.traces.count, 5)
        for trace in contract.traces {
            var pacer = JunoStreamPacer()
            var length = 0
            var next = 0
            var tick = 0
            var cutMismatches = 0
            var t = 0
            while t <= trace.until {
                while next < trace.arrivals.count, trace.arrivals[next][0] <= t {
                    length = trace.arrivals[next][1]
                    next += 1
                }
                pacer.arrive(length: length, now: Double(t))
                pacer.step(length: length, dtMs: Double(contract.tickMs))
                let shown = Int(pacer.shown.rounded(.down))
                let expected = trace.expected.shown[tick]
                XCTAssertLessThanOrEqual(abs(shown - expected), 1, "\(trace.name) at \(t)ms: \(shown) vs \(expected)")
                let received = JunoLineScanner.substring(of: trace.text, fromUTF16: 0, toUTF16: length)
                let cut = JunoStreamPacer.revealCut(in: received, shown: pacer.shown)
                if shown == expected {
                    XCTAssertEqual(cut, trace.expected.cut[tick], "\(trace.name) cut at \(t)ms")
                } else if cut != trace.expected.cut[tick] {
                    cutMismatches += 1
                }
                tick += 1
                t += contract.tickMs
            }
            XCTAssertEqual(tick, trace.expected.shown.count, trace.name)
            XCTAssertLessThanOrEqual(cutMismatches, 2, "\(trace.name): floating-point edge ticks only")
        }
    }

    func testRevealCutMatchesTheWebExamples() {
        let text = "The quick brown fox jumps"
        XCTAssertEqual(JunoStreamPacer.revealCut(in: text, shown: 6), 9)
        XCTAssertEqual(JunoStreamPacer.revealCut(in: text, shown: 23), 20)
        XCTAssertEqual(JunoStreamPacer.revealCut(in: text, shown: 10), 10)
        XCTAssertEqual(JunoStreamPacer.revealCut(in: text, shown: 999), (text as NSString).length)
        XCTAssertNotEqual(JunoStreamPacer.revealCut(in: "ab \u{1F600}", shown: 4), 4)
        // A non-breaking space is a space, as `\s` says on the web.
        XCTAssertEqual(JunoStreamPacer.revealCut(in: "one\u{00A0}two three", shown: 5), 7)
    }

    // MARK: - Ink clock

    func testInkBandsAgeOutOverTheStreamBand() {
        var clock = JunoStreamInkClock()
        clock.record(length: 100, now: 0)  // baseline: already there, solid
        XCTAssertEqual(clock.bands(now: 0), [])
        clock.record(length: 130, now: 1)
        XCTAssertEqual(clock.bands(now: 1), [30, 30, 30, 30, 30])
        clock.record(length: 150, now: 1.06)
        // 20 newest in band 0, the 30 before them a band older.
        XCTAssertEqual(clock.bands(now: 1.06), [20, 50, 50, 50, 50])
        XCTAssertEqual(clock.bands(now: 1.06 + JunoGeneratedTiming.streamBand + 0.01), [])
        // Replaced text is a new baseline.
        clock.record(length: 10, now: 2)
        XCTAssertEqual(clock.bands(now: 2), [])
    }

    func testRevealInkFollowsTheBands() {
        let reveal = JunoStreamReveal(bands: [2, 4, 4, 6, 8])
        XCTAssertEqual(reveal.ink(fromEnd: 1), 0.35)
        XCTAssertEqual(reveal.ink(fromEnd: 3), 0.52)
        XCTAssertEqual(reveal.ink(fromEnd: 5), 0.82)
        XCTAssertEqual(reveal.ink(fromEnd: 8), 0.92)
        XCTAssertEqual(reveal.ink(fromEnd: 9), 1)
        XCTAssertEqual(JunoStreamReveal(span: 50).span, 50)
        XCTAssertFalse(JunoStreamReveal.settled.isLive)
    }

    // MARK: - Settled prefix

    func testSafeCutsAreParagraphStartsOutsideEveryConstruct() {
        let text = "One para.\n\nTwo para.\n\n- a\n\n- b\n\n```\ncode\n\nmore\n```\n\nThree.\n\n<juno:artifact id=\"x\">\nbody\n\nstill\n</juno:artifact>\n\n## Four\n\n    indented\n\nFive"
        let cuts = JunoStreamSettle.boundaries(in: text, from: 0, to: (text as NSString).length)
        let starts = cuts.map { String((text as NSString).substring(from: $0).prefix(6)) }
        XCTAssertEqual(starts, ["Two pa", "Three.", "## Fou", "Five"])
        // Scanning from a cut finds only the cuts after it.
        let later = JunoStreamSettle.boundaries(in: text, from: cuts[1], to: (text as NSString).length)
        XCTAssertEqual(later, Array(cuts[2...]))
    }

    func testOpenLearningBlocksAndMathAreNotCut() {
        let text = ":::quiz\nq: 1\n\nexplain\n:::\n\nAfter.\n\n$$\nx\n\ny\n$$\n\nEnd"
        let cuts = JunoStreamSettle.boundaries(in: text, from: 0, to: (text as NSString).length)
        let starts = cuts.map { String((text as NSString).substring(from: $0).prefix(3)) }
        XCTAssertEqual(starts, ["Aft", "End"])
    }

    // MARK: - The engine

    /// A long answer streamed through the engine at 60fps with bursty arrival.
    private struct Run {
        var frames: [JunoPacedStreamEngine.Frame] = []
        var seconds: [Double] = []
    }

    @MainActor
    private func stream(
        _ text: String,
        reduceMotion: Bool = false,
        flushAt: Int? = nil,
        parse: Bool = false
    ) -> Run {
        let engine = JunoPacedStreamEngine()
        let total = (text as NSString).length
        var run = Run()
        var received = 0
        var parser = JunoIncrementalMarkdown()
        let start: TimeInterval = 1_000
        // ~680 chars/s in 40-120 character bursts; live for half a second
        // after the last one, then half a second of settling.
        var end: Int?
        var frame = 0
        var source = ""
        while true {
            if received < total, frame % 7 == 0 {
                received = min(total, received + 40 + (frame * 37) % 80)
                // A native string per arrival, as the conversation store hands
                // the view one per chunk.
                source = JunoPacedStreamEngine.slice(text, from: 0, to: received)
            }
            if received >= total, end == nil { end = frame + 30 }
            if let end, frame >= end + 30 { break }
            let clock = Date()
            let output = engine.frame(
                source: source,
                live: end.map { frame < $0 } ?? true,
                now: start + Double(frame) / 60,
                drain: false,
                flush: flushAt.map { frame >= $0 ? 1 : 0 } ?? 0,
                reduceMotion: reduceMotion
            )
            if parse { parser.update(output.tail) }
            run.seconds.append(Date().timeIntervalSince(clock))
            run.frames.append(output)
            frame += 1
        }
        return run
    }

    private static func answer(paragraphs: Int) -> String {
        (0..<paragraphs).map { index in
            let body = String(repeating: "The pacer releases words at a steady cadence while the network bursts. ", count: 4)
            switch index % 6 {
            case 2: return "## Section \(index)\n\n\(body)"
            case 4: return "- first point \(index)\n- second point\n\n\(body)"
            case 5: return "```swift\nlet value = \(index)\n\nprint(value)\n```\n\n\(body)"
            default: return body
            }
        }.joined(separator: "\n\n")
    }

    @MainActor
    func testTheEngineSettlesFinishedParagraphsAndKeepsTheTailSmall() {
        let text = Self.answer(paragraphs: 60)
        let run = stream(text)
        let live = run.frames.filter(\.paced)
        XCTAssertFalse(live.isEmpty)
        // The prefix only ever grows while live, and is the text's own start.
        var previous = ""
        for frame in live {
            XCTAssertTrue(frame.prefix.hasPrefix(previous))
            XCTAssertTrue(text.hasPrefix(frame.prefix))
            previous = frame.prefix
        }
        XCTAssertGreaterThan(previous.count, text.count / 2, "most of the answer settled")
        // The tail stays a few paragraphs long, however long the answer is.
        XCTAssertLessThan(live.map { $0.tail.count }.max() ?? 0, 1_600)
        // Shown text never runs ahead of what arrived, and grows.
        XCTAssertEqual(run.frames.last?.tail, text, "settles into the whole answer")
        XCTAssertEqual(run.frames.last?.prefix, "")
        XCTAssertEqual(run.frames.last?.paced, false)
    }

    @MainActor
    func testNewTextInksInAndReduceMotionDoesNot() {
        let text = Self.answer(paragraphs: 6)
        let faded = stream(text).frames.filter(\.paced)
        XCTAssertTrue(faded.contains { ($0.reveal?.span ?? 0) > 0 }, "fresh words fade in")
        XCTAssertTrue(faded.allSatisfy { $0.reveal?.isLive == true })

        let reduced = stream(text, reduceMotion: true).frames
        XCTAssertTrue(reduced.allSatisfy { $0.reveal == nil }, "no ink bands under Reduce Motion (T5)")
        // Pacing still runs under Reduce Motion, frame for frame the same.
        let normalLengths = faded.map { ($0.prefix + $0.tail).count }
        let reducedLengths = reduced.filter(\.paced).map { ($0.prefix + $0.tail).count }
        XCTAssertEqual(normalLengths, reducedLengths)
    }

    @MainActor
    func testAFlushShowsEverythingReceived() {
        let engine = JunoPacedStreamEngine()
        _ = engine.frame(source: "", live: true, now: 10, drain: false, flush: 0, reduceMotion: false)
        let burst = String(repeating: "word ", count: 120)
        let paced = engine.frame(source: burst, live: true, now: 10.016, drain: false, flush: 0, reduceMotion: false)
        XCTAssertLessThan(paced.tail.count, burst.count, "a burst is paced")
        let flushed = engine.frame(source: burst, live: true, now: 10.032, drain: false, flush: 1, reduceMotion: false)
        XCTAssertEqual(flushed.prefix + flushed.tail, burst, "the reader scrolled: everything shows")

        let more = burst + String(repeating: "more ", count: 120)
        let drained = engine.frame(source: more, live: true, now: 10.048, drain: true, flush: 1, reduceMotion: false)
        XCTAssertEqual(drained.prefix + drained.tail, more, "the app is not active: everything shows")
    }

    @MainActor
    func testAReplyThatWasNeverLiveIsDrawnAsIs() {
        let engine = JunoPacedStreamEngine()
        let frame = engine.frame(source: "Hello **there**", live: false, now: 1, drain: false, flush: 0, reduceMotion: false)
        XCTAssertEqual(frame, .init(prefix: "", tail: "Hello **there**", reveal: nil, paced: false))
    }

    /// Performance: a long streamed answer (~38k characters) costs per frame
    /// what a short one does, because only the tail is touched. Measured
    /// against re-parsing the whole shown text every frame, which is what a
    /// paced reply without a settled prefix does.
    @MainActor
    func testALongStreamedAnswerStaysWellInsideTheFrameBudget() {
        let text = Self.answer(paragraphs: 120)
        XCTAssertGreaterThan(text.count, 30_000)
        let run = stream(text, parse: true)
        let sorted = run.seconds.sorted()
        let p95 = sorted[Int(Double(sorted.count) * 0.95)]

        // The same late frames (the longest shown text), drawn the naive way:
        // the whole shown text re-parsed every release.
        let late = run.frames.indices.filter { run.frames[$0].paced }.suffix(200)
        let mean = late.map { run.seconds[$0] }.reduce(0, +) / Double(max(1, late.count))
        var naive: [Double] = []
        for index in late {
            let frame = run.frames[index]
            let clock = Date()
            var whole = JunoIncrementalMarkdown()
            whole.update(frame.prefix + frame.tail)
            naive.append(Date().timeIntervalSince(clock))
        }
        let naiveMean = naive.reduce(0, +) / Double(max(1, naive.count))
        print("stream pacer perf: \(run.seconds.count) frames, mean \(mean * 1000)ms, p95 \(p95 * 1000)ms; whole-text parse mean \(naiveMean * 1000)ms")
        // Generous for shared CI runners; locally this is ~0.1ms.
        XCTAssertLessThan(p95, 0.004, "engine + tail parse p95 under 4ms of a 16ms frame")
        XCTAssertLessThan(mean, naiveMean, "cheaper than re-parsing the whole answer each frame")
    }

    // MARK: - Incremental Markdown under tidy churn

    func testTidyClosingABoldSpanDoesNotReparseFinishedBlocks() {
        let finished = String(repeating: "A finished paragraph that will not change again. ", count: 40) + "\n\n"
        var parser = JunoIncrementalMarkdown()
        parser.update(finished + "Now this is **bol**")
        parser.update(finished + "Now this is **bold**")
        XCTAssertLessThan(parser.lastParsedCharacters, 40, "only the paragraph being written is parsed")
        XCTAssertEqual(parser.blocks, JunoMarkdown.blocks(from: finished + "Now this is **bold**"))
    }
}
