import SwiftUI
import XCTest

@testable import JunoDesignSystem

#if canImport(AppKit)
import AppKit
#endif

/// The galaxy working mark, the paced stream and the Alevr brand mark.
///
/// Snapshots are written to `JUNO_SNAPSHOT_DIR/motion-marks` when that is set
/// and are always asserted to render with ink in them.
final class JunoMotionMarksTests: XCTestCase {
    // MARK: - Galaxy: the shared generator

    func testMulberry32MatchesTheJavaScriptBitForBit() {
        // node: mulberry32(0xA1E7) → 0.45009570731781423, 0.6133725999388844, 0.025462020188570023
        var random = JunoGalaxyField.Mulberry32(seed: 0xA1E7)
        XCTAssertEqual(random.next(), 0.45009570731781423, accuracy: 1e-15)
        XCTAssertEqual(random.next(), 0.6133725999388844, accuracy: 1e-15)
        XCTAssertEqual(random.next(), 0.025462020188570023, accuracy: 1e-15)
    }

    func testTheFieldIsTheSpecsCountsAndIsDeterministic() {
        XCTAssertEqual(JunoGalaxyField.count(forSize: 16), 72)
        XCTAssertEqual(JunoGalaxyField.count(forSize: 18), 120)
        let a = JunoGalaxyField.generate(count: 120)
        let b = JunoGalaxyField.generate(count: 120)
        XCTAssertEqual(a.particles, b.particles)
        XCTAssertEqual(a.particles.count, 120)
        XCTAssertEqual(a.core.count, 6)
        XCTAssertTrue(a.core.allSatisfy { $0.radius < 0.06 })
        let dust = a.particles.filter(\.isDust).count
        XCTAssertGreaterThan(dust, 8, "about 18% dust")
        XCTAssertLessThan(dust, 40)
        XCTAssertTrue(a.particles.filter(\.isAccent).allSatisfy { $0.index % 13 == 0 && !$0.isDust })
        XCTAssertTrue(a.particles.allSatisfy { (0...1).contains($0.alpha) })
    }

    func testInnerStarsTurnFasterAndTheArmsDoNotWindForever() {
        let dt = 0.01
        func speed(_ r: Double, at t: Double) -> Double {
            abs(JunoGalaxyRenderer.angle(0, radius: r, clock: t + dt) - JunoGalaxyRenderer.angle(0, radius: r, clock: t)) / dt
        }
        XCTAssertGreaterThan(speed(0.1, at: 0), speed(0.9, at: 0))
        // Peak inner speed is the spec's ω0 · (0.35 + 0.65 · (1 − r)).
        let omega = 2 * Double.pi / JunoGalaxyRenderer.period
        XCTAssertEqual(speed(0, at: 0), omega, accuracy: 0.01)
        // The core's lead over the rim is bounded: after a minute of turning the
        // arms are as wound as after a second, give or take one oscillation.
        let lead = { (t: Double) in
            JunoGalaxyRenderer.angle(0, radius: 0, clock: t) - JunoGalaxyRenderer.angle(0, radius: 1, clock: t)
        }
        XCTAssertLessThan(abs(lead(60)), 2)
        XCTAssertLessThan(abs(lead(600)), 2)
    }

    // MARK: - Pacer

    func testThePacerSpreadsABurstAcrossTheGapThatFollows() {
        var pacer = JunoStreamPacer()
        // 60 characters land at once; the screen gets them over ~a quarter second,
        // never all on the first frame.
        let first = pacer.step(target: 60, dt: 1.0 / 60)
        XCTAssertLessThan(first, 10)
        var shown = first
        var frames = 1
        while shown < 60, frames < 120 {
            shown = pacer.step(target: 60, dt: 1.0 / 60)
            frames += 1
        }
        XCTAssertEqual(shown, 60)
        XCTAssertGreaterThan(frames, 6, "released over several frames")
        XCTAssertLessThan(frames, 60, "and drained within a second")
    }

    func testThePacerReleasesMonotonicallyAndCatchesUpWhenFarBehind() {
        var pacer = JunoStreamPacer()
        var target = 0
        var last = 0
        for frame in 0..<300 {
            if frame % 6 == 0 { target += 25 }  // bursty arrival, ~250 chars/s
            let shown = pacer.step(target: target, dt: 1.0 / 60)
            XCTAssertGreaterThanOrEqual(shown, last)
            XCTAssertLessThanOrEqual(shown, target)
            last = shown
        }
        XCTAssertGreaterThan(Double(last), Double(target) * 0.85, "keeps pace with a steady stream")

        var behind = JunoStreamPacer()
        let jumped = behind.step(target: 5_000, dt: 1.0 / 60)
        XCTAssertGreaterThanOrEqual(jumped, 5_000 - JunoStreamPacer.maxBacklog)
    }

    func testThePacerFollowsReplacedTextDown() {
        var pacer = JunoStreamPacer(shown: 400)
        XCTAssertEqual(pacer.step(target: 20, dt: 1.0 / 60), 20)
    }

    // MARK: - Tidy tails

    func testHalfWrittenMarkdownIsHeldOrClosed() {
        XCTAssertEqual(JunoStreamTidy.tidy("Intro\n| a | b"), "Intro\n")
        XCTAssertEqual(JunoStreamTidy.tidy("Intro\n```swi"), "Intro\n")
        XCTAssertEqual(JunoStreamTidy.tidy("Intro\n- "), "Intro\n")
        XCTAssertEqual(JunoStreamTidy.tidy("Intro\n12."), "Intro\n")
        XCTAssertEqual(JunoStreamTidy.tidy("This is **bol"), "This is **bol**")
        XCTAssertEqual(JunoStreamTidy.tidy("Run `npm te"), "Run `npm te`")
        XCTAssertEqual(JunoStreamTidy.tidy("See [the docs](https://exa"), "See ")
        XCTAssertEqual(JunoStreamTidy.tidy("Ends with *"), "Ends with ")
        XCTAssertEqual(JunoStreamTidy.tidy("Plain words"), "Plain words")
        // Inside an open fence nothing is touched.
        XCTAssertEqual(JunoStreamTidy.tidy("```js\nconst a = **b"), "```js\nconst a = **b")
    }

    func testTheCutNeverSplitsACharacter() {
        let text = "Hi 👋🏽 there"
        let ns = text as NSString
        for offset in 0...ns.length {
            let cut = JunoStreamTidy.boundary(in: text, at: offset)
            let prefix = ns.substring(to: cut)
            XCTAssertTrue(text.hasPrefix(prefix))
        }
    }

    // MARK: - Snapshots

    @MainActor
    func testTheGalaxyRendersAtEverySizeInBothAppearancesAndMoves() throws {
        #if canImport(AppKit)
        for size in [16.0, 24.0, 64.0] {
            for scheme in [ColorScheme.light, .dark] {
                let image = try render(
                    JunoGalaxyMark(size: size).environment(\.junoGalaxyClock, 1.2),
                    scheme: scheme, padding: 6, name: "galaxy-\(Int(size))-\(name(scheme))"
                )
                XCTAssertGreaterThan(Self.inkCoverage(image, scheme: scheme), 0.01, "galaxy \(size) \(scheme) drew nothing")
            }
        }
        // A frame sequence: the field moves between timestamps.
        var frames: [CGImage] = []
        for (index, time) in [0.0, 0.6, 1.2, 2.4, 3.6, 4.8].enumerated() {
            frames.append(try render(
                JunoGalaxyMark(size: 96).environment(\.junoGalaxyClock, time),
                scheme: .dark, padding: 8, name: "galaxy-sequence-\(index)"
            ))
        }
        for (a, b) in zip(frames, frames.dropFirst()) {
            XCTAssertGreaterThan(Self.difference(a, b), 0.002, "consecutive frames should differ")
        }
        #endif
    }

    @MainActor
    func testAStreamingReplyFadesItsNewestWords() throws {
        #if canImport(AppKit)
        let source = """
        Streaming should feel like ink settling, not like blocks of text being dropped onto the page. \
        The newest words arrive softly while everything before them stays perfectly still and sharp.
        """
        for scheme in [ColorScheme.light, .dark] {
            let live = try render(
                JunoMarkdownText(source)
                    .environment(\.junoProseStyle, .reading)
                    .environment(\.junoStreamReveal, JunoStreamReveal(span: 48))
                    .frame(width: 520, alignment: .leading),
                scheme: scheme, padding: 20, name: "stream-midway-\(name(scheme))"
            )
            let settled = try render(
                JunoMarkdownText(source)
                    .environment(\.junoProseStyle, .reading)
                    .frame(width: 520, alignment: .leading),
                scheme: scheme, padding: 20, name: "stream-settled-\(name(scheme))"
            )
            XCTAssertGreaterThan(Self.difference(live, settled), 0.0005, "the live tail should differ from the settled text")
            XCTAssertLessThan(Self.inkCoverage(live, scheme: scheme), Self.inkCoverage(settled, scheme: scheme))
        }
        #endif
    }

    @MainActor
    func testTheAlevrMarkAndLockupRenderAsVectors() throws {
        #if canImport(AppKit)
        for scheme in [ColorScheme.light, .dark] {
            for size in [16.0, 24.0, 48.0] {
                let image = try render(
                    JunoMark(size: size).foregroundStyle(scheme == .dark ? Color.white : Color.black),
                    scheme: scheme, padding: 4, name: "mark-\(Int(size))-\(name(scheme))"
                )
                XCTAssertGreaterThan(Self.inkCoverage(image, scheme: scheme), 0.05)
            }
            let lockup = try render(
                JunoLogo(height: 32).foregroundStyle(scheme == .dark ? Color.white : Color.black),
                scheme: scheme, padding: 12, name: "lockup-\(name(scheme))"
            )
            XCTAssertGreaterThan(lockup.width, lockup.height * 2, "the word sits beside the mark")
            XCTAssertGreaterThan(Self.inkCoverage(lockup, scheme: scheme), 0.05)
        }
        XCTAssertEqual(JunoContinuumShape.drawing(forDevicePixels: 32), 32)
        XCTAssertEqual(JunoContinuumShape.drawing(forDevicePixels: 16), 16)
        XCTAssertEqual(JunoContinuumShape.drawing(forDevicePixels: 96), 0)
        #endif
    }

    // MARK: - Helpers

    private func name(_ scheme: ColorScheme) -> String { scheme == .dark ? "dark" : "light" }

    #if canImport(AppKit)
    @MainActor
    private func render<V: View>(_ view: V, scheme: ColorScheme, padding: CGFloat, name: String) throws -> CGImage {
        let content = view
            .padding(padding)
            .background(scheme == .dark ? Color(white: 0.11) : Color(white: 0.98))
            .environment(\.colorScheme, scheme)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 3
        let image = try XCTUnwrap(renderer.cgImage, "\(name) did not render")
        if let dir = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] {
            let directory = URL(fileURLWithPath: dir).appendingPathComponent("motion-marks")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let rep = NSBitmapImageRep(cgImage: image)
            let data = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            try data.write(to: directory.appendingPathComponent("\(name).png"))
        }
        return image
    }

    /// RGBA8 pixels of an image.
    private static func pixels(_ image: CGImage) -> [UInt8] {
        let width = image.width, height = image.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(
            data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
        context?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return data
    }

    /// The share of pixels far from the ground: ink drawn.
    private static func inkCoverage(_ image: CGImage, scheme: ColorScheme) -> Double {
        let data = pixels(image)
        let ground: Int = scheme == .dark ? 28 : 250
        var inked = 0
        for i in stride(from: 0, to: data.count, by: 4) where abs(Int(data[i]) - ground) > 40 {
            inked += 1
        }
        return Double(inked) / Double(data.count / 4)
    }

    /// Mean absolute channel difference, 0…1, between two same-sized images.
    private static func difference(_ a: CGImage, _ b: CGImage) -> Double {
        let pa = pixels(a), pb = pixels(b)
        guard pa.count == pb.count, !pa.isEmpty else { return 1 }
        var total = 0
        for i in 0..<pa.count { total += abs(Int(pa[i]) - Int(pb[i])) }
        return Double(total) / Double(pa.count) / 255
    }
    #endif
}
