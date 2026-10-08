import SwiftUI
import XCTest

@testable import JunoDesignSystem

#if canImport(AppKit)
import AppKit
#endif

/// The brand motifs (Brand/): the dot matrix, the product orbit, the empty
/// mark, Deep Field's dots and the dot grid.
///
/// The parity numbers are the web's own: `scripts/parity.ts` in the
/// brand-ascii verification ran `src/components/home/dot-scenes.ts` into its
/// `Raster` at the same sizes and printed lit cells, presence cells and the
/// summed brightness. A change on either side that moves a dot fails here.
///
/// Snapshots go to `JUNO_SNAPSHOT_DIR/brand-motifs` when that is set, and are
/// always asserted to render with ink in them.
@MainActor
final class JunoBrandMotifsTests: XCTestCase {
    // MARK: - Web parity

    private struct Counts: Equatable, CustomStringConvertible {
        var lit: Int
        var blue: Int
        var lum: Double
        var description: String { "lit \(lit), blue \(blue), lum \(lum)" }
    }

    private func frame(_ w: Double, _ h: Double, pitch: Double, t: Double = 1e4, still: Bool = true, style: JunoDotStyle = .light) -> JunoDotFrame {
        JunoDotFrame(t: t, w: w, h: h, ox: w / 2, oy: h / 2, u: w / 1500, pitch: pitch, still: still, style: style)
    }

    private func counts(_ raster: JunoDotRaster) -> Counts {
        Counts(lit: raster.litCount, blue: raster.blueCount, lum: raster.litLuminance)
    }

    private func assertWeb(_ c: Counts, lit: Int, blue: Int, lum: Double, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(c.lit, lit, "lit cells (\(c))", file: file, line: line)
        XCTAssertEqual(c.blue, blue, "presence cells (\(c))", file: file, line: line)
        XCTAssertEqual(c.lum, lum, accuracy: 0.05, "summed brightness (\(c))", file: file, line: line)
    }

    private func rings(_ rings: [JunoDotRing], lines: [JunoDotLine] = [], arcs: [JunoDotArc] = [], animate: Bool,
                       stagger: Double = 0.09, draw: Double = 1.8, delay: Double = 0.12, start: Double = 180) -> JunoRingsScene {
        JunoRingsScene(rings: rings, lines: lines, arcs: arcs, animate: animate, stagger: stagger, draw: draw, delay: delay, start: start)
    }

    func testTheProductOrbitAtRestIsTheWebsDots() {
        var r = JunoDotRaster(width: 84, height: 48, pitch: 2.4)
        _ = rings(JunoProductOrbitGeometry.ring, arcs: JunoProductOrbitGeometry.restChat, animate: false)
            .plot(frame(84, 48, pitch: 2.4), raster: &r)
        assertWeb(counts(r), lit: 54, blue: 10, lum: 21.353)
    }

    func testTheTrailToCodeHalfwayIsTheWebsDots() {
        var r = JunoDotRaster(width: 84, height: 48, pitch: 2.4)
        let scene = rings(JunoProductOrbitGeometry.ring, arcs: JunoProductOrbitGeometry.trailToCode, animate: true,
                          stagger: 0, draw: JunoProductOrbitGeometry.draw, delay: 0)
        let out = scene.plot(frame(84, 48, pitch: 2.4, t: 0.31, still: false), raster: &r)
        assertWeb(counts(r), lit: 54, blue: 21, lum: 22.024)
        XCTAssertTrue(out.busy, "still travelling at 0.31s of 0.62s")
        XCTAssertEqual(out.heads.count, 1)
    }

    func testTheEmptyMarkIsTheWebsDots() {
        var r = JunoDotRaster(width: 208, height: 76, pitch: 2.7)
        var style = JunoDotStyle.light
        style.floor = 0.5
        _ = rings(JunoEmptyMark.rings, lines: JunoEmptyMark.lines, arcs: JunoEmptyMark.arcs, animate: true,
                  stagger: 0.1, draw: 1.2, delay: 0.1, start: 180)
            .plot(frame(208, 76, pitch: 2.7, style: style), raster: &r)
        assertWeb(counts(r), lit: 427, blue: 30, lum: 117.004)
    }

    func testDeepFieldsDotsAreTheWebsDots() {
        var r = JunoDotRaster(width: 400, height: 275, pitch: 3.6)
        let targets = [JunoDeepFieldDots.Target(x: 0.7, y: 0.35), .init(x: 0.28, y: 0.62, current: true)]
        _ = rings(JunoDeepFieldDots.rings, lines: JunoDeepFieldDots.lines(for: targets), animate: false)
            .plot(frame(400, 275, pitch: 3.6), raster: &r)
        assertWeb(counts(r), lit: 708, blue: 32, lum: 212.198)
    }

    func testTheConstructionIsTheWebsDots() {
        var r = JunoDotRaster(width: 600, height: 400, pitch: 3.9)
        _ = JunoConstructionScene(ticks: false, trajectory: true, axis: true, animate: false)
            .plot(frame(600, 400, pitch: 3.9), raster: &r)
        assertWeb(counts(r), lit: 1385, blue: 44, lum: 518.396)
    }

    func testTheConstructionMidArrivalIsTheWebsDots() {
        var r = JunoDotRaster(width: 600, height: 400, pitch: 3.9)
        let out = JunoConstructionScene(ticks: false, trajectory: true, axis: true, animate: true)
            .plot(frame(600, 400, pitch: 3.9, t: 1.2, still: false), raster: &r)
        assertWeb(counts(r), lit: 1391, blue: 12, lum: 516.864)
        XCTAssertTrue(out.busy)
    }

    // MARK: - Geometry and behaviour

    func testTheSwitchPicksTheRestingArcThenTheTrail() {
        let G = JunoProductOrbitGeometry.self
        XCTAssertEqual(G.arcs(for: .chat, turn: 0), G.restChat)
        XCTAssertEqual(G.arcs(for: .code, turn: 0), G.restCode)
        XCTAssertEqual(G.arcs(for: .code, turn: 1), G.trailToCode)
        XCTAssertEqual(G.arcs(for: .chat, turn: 2), G.trailToChat)
        // Every trail ends on the side of its product: Chat on the left (180°), Code on the right (0°).
        XCTAssertEqual(abs(G.trailToChat[0].to.truncatingRemainder(dividingBy: 360)), 180)
        XCTAssertEqual(G.trailToCode[0].to, 0)
    }

    func testASettledDrawingAsksForNoMoreFrames() {
        var r = JunoDotRaster(width: 208, height: 76, pitch: 2.7)
        let scene = rings(JunoEmptyMark.rings, arcs: JunoEmptyMark.arcs, animate: true, stagger: 0.1, draw: 1.2, delay: 0.1)
        XCTAssertTrue(scene.plot(frame(208, 76, pitch: 2.7, t: 0.5, still: false), raster: &r).busy)
        var settled = JunoDotRaster(width: 208, height: 76, pitch: 2.7)
        XCTAssertFalse(scene.plot(frame(208, 76, pitch: 2.7, t: 5, still: false), raster: &settled).busy)
    }

    func testAZeroSizedBoxDrawsNothingAndDoesNotTrap() {
        var r = JunoDotRaster(width: 0, height: 0, pitch: 3.9)
        _ = rings(JunoDeepFieldDots.rings, animate: false).plot(frame(0, 0, pitch: 3.9), raster: &r)
        XCTAssertEqual(r.gw, 1)
        // Every ring collapses onto the origin: at most the one corner cell.
        XCTAssertLessThanOrEqual(r.litCount, 1)
    }

    func testTheDotGridIsTheWebsGrid() {
        let points = JunoDotGrid.points(in: CGSize(width: 100, height: 50), spacing: 24)
        // x: 12, 36, 60, 84; y: 12, 36.
        XCTAssertEqual(points.count, 8)
        XCTAssertEqual(points.first, CGPoint(x: 12, y: 12))
        XCTAssertEqual(points.last, CGPoint(x: 84, y: 36))
        XCTAssertTrue(JunoDotGrid.points(in: .zero, spacing: 24).isEmpty)
    }

    func testTheEaseIsTheHomepagesExpo() {
        XCTAssertEqual(JunoDotEase.ease(0), 0)
        XCTAssertEqual(JunoDotEase.ease(1), 1)
        XCTAssertEqual(JunoDotEase.inverse(JunoDotEase.ease(0.3)), 0.3, accuracy: 1e-3)
        XCTAssertGreaterThan(JunoDotEase.ease(0.2), 0.6, "expo-out is mostly there by a fifth")
    }

    // MARK: - Snapshots

    #if canImport(AppKit)
    private static let frames: [(String, Double)] = [("t030", 0.3), ("t090", 0.9), ("settled", .infinity)]

    func testEveryMotifRendersInBothAppearancesAcrossItsArrival() throws {
        for scheme in [ColorScheme.light, .dark] {
            let tone = scheme == .dark ? "dark" : "light"
            for (label, t) in Self.frames {
                try snapshot(JunoProductOrbit(active: .chat) { _ in }, scheme: scheme, t: t, name: "product-orbit-chat-\(tone)-\(label)")
                try snapshot(JunoProductOrbit(active: .code, locked: []) { _ in }, scheme: scheme, t: t, name: "product-orbit-code-\(tone)-\(label)")
                try snapshot(JunoEmptyMark(), scheme: scheme, t: t, name: "empty-mark-\(tone)-\(label)")
                try snapshot(JunoEmptyMark(size: .panel), scheme: scheme, t: t, name: "empty-mark-panel-\(tone)-\(label)")
                try snapshot(
                    JunoDotConstruction(ticks: true).frame(width: 520, height: 340),
                    scheme: scheme, t: t, name: "construction-\(tone)-\(label)"
                )
                try snapshot(
                    JunoDeepFieldDots(targets: [.init(x: 0.7, y: 0.35), .init(x: 0.28, y: 0.62, current: true)])
                        .frame(width: 400, height: 275),
                    scheme: scheme, t: t, name: "deep-field-\(tone)-\(label)"
                )
            }
            try snapshot(JunoDotGrid(spacing: 24).frame(width: 360, height: 200), scheme: scheme, t: .infinity,
                         name: "dot-grid-\(tone)", minimumInk: 0)
            try snapshot(trailToCode(), scheme: scheme, t: 0.31, name: "product-orbit-trail-to-code-\(tone)-t031")
        }
    }

    /// The trail layer on its own, mid-flight (what a switch to Code draws).
    private func trailToCode() -> some View {
        JunoDotRings(
            rings: JunoProductOrbitGeometry.ring, arcs: JunoProductOrbitGeometry.trailToCode,
            stagger: 0, draw: JunoProductOrbitGeometry.draw, delay: 0, pitch: JunoProductOrbitGeometry.pitch
        )
        .frame(width: 84, height: 48)
    }

    private func snapshot<V: View>(_ view: V, scheme: ColorScheme, t: Double, name: String, minimumInk: Double? = nil) throws {
        // 0.3s in, the rings are only starting to arrive: a few dots, not none.
        let minimumInk = minimumInk ?? (t < 0.5 ? 0.0001 : 0.002)
        let content = view
            .padding(16)
            .background(scheme == .dark ? Color(white: 0.11) : Color(white: 0.98))
            .environment(\.colorScheme, scheme)
            .environment(\.junoDotsTime, t)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 3
        let image = try XCTUnwrap(renderer.cgImage, "\(name) did not render")
        if let dir = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] {
            let directory = URL(fileURLWithPath: dir).appendingPathComponent("brand-motifs")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let rep = NSBitmapImageRep(cgImage: image)
            let data = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            try data.write(to: directory.appendingPathComponent("\(name).png"))
        }
        if minimumInk > 0 {
            XCTAssertGreaterThan(Self.inkCoverage(image, scheme: scheme), minimumInk, "\(name) drew no dots")
        }
    }

    private static func inkCoverage(_ image: CGImage, scheme: ColorScheme) -> Double {
        let width = image.width, height = image.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(
            data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
        context?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let ground: Int = scheme == .dark ? 28 : 250
        var inked = 0
        for i in stride(from: 0, to: data.count, by: 4) where abs(Int(data[i]) - ground) > 30 {
            inked += 1
        }
        return Double(inked) / Double(width * height)
    }
    #endif
}
