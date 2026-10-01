#if os(macOS)
import AppKit
import XCTest
@testable import JunoScreenControl

/// The offscreen calibration test (CODE_AGENT_SPEC §3.5 item 7).
///
/// A grid window is drawn into a bitmap at backing scale 2 — `cacheDisplay`,
/// no screen capture, the window never ordered front — at three common
/// sizes. Targets are found in the scaled frame the way a model finds them,
/// by looking: the centre of each red marker. Each found point goes through
/// the whole pipeline — frame → global point → input driver → event sink —
/// and the posted click must land within 2 pt of the marker's true centre.
/// A Retina halving bug, a flipped axis, a lost origin or a wrong scale all
/// land tens of points away.
@MainActor
final class CalibrationTests: XCTestCase {
    /// Window sizes in points: 14-inch, 16-inch and XDR at default scaling.
    let sizes: [(Double, Double)] = [(1512, 982), (1728, 1117), (3008, 1692)]
    /// Where the window sits in global space: a secondary display at a
    /// negative origin, so the origin must survive the round trip.
    let origin = ScreenPoint(x: -1728, y: -240)

    func testEveryTargetLandsWithinTwoPointsAtEverySizeAndBudget() async throws {
        for (width, height) in sizes {
            for budget in [ImageBudget.anthropicStandard, .anthropicHighResolution, .openAIHighDetail] {
                try await calibrate(width: width, height: height, budget: budget)
            }
        }
    }

    private func targets(width: Double, height: Double) -> [ScreenPoint] {
        // A 5×4 grid of markers inset from the edges, in window points.
        var points: [ScreenPoint] = []
        for row in 0..<4 {
            for column in 0..<5 {
                points.append(ScreenPoint(
                    x: (width - 120) * Double(column) / 4 + 60,
                    y: (height - 120) * Double(row) / 3 + 60
                ))
            }
        }
        return points
    }

    private func calibrate(width: Double, height: Double, budget: ImageBudget) async throws {
        let markers = targets(width: width, height: height)
        let view = GridView(frame: NSRect(x: 0, y: 0, width: width, height: height), markers: markers)
        let window = NSWindow(
            contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: height),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = view
        defer { window.contentView = nil }

        // Backing scale 2, whatever display this machine has.
        let rep = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(width * 2),
            pixelsHigh: Int(height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ))
        rep.size = NSSize(width: width, height: height)
        view.cacheDisplay(in: view.bounds, to: rep)
        let capture = try XCTUnwrap(rep.cgImage)
        XCTAssertEqual(capture.width, Int(width * 2))

        // The pipeline: scale to the budget, describe the frame.
        let framed = try XCTUnwrap(CaptureScaler.frame(of: capture, budget: budget))
        XCTAssertTrue(CaptureScaler.fits(PixelSize(width: framed.image.width, height: framed.image.height), budget))
        let geometry = FrameGeometry(
            origin: origin,
            pointWidth: width,
            pointHeight: height,
            backingScale: Double(capture.width) / width,
            scale: framed.scale,
            frameSize: PixelSize(width: framed.image.width, height: framed.image.height)
        )

        // "The model": find each marker's centre in the frame it was sent.
        let found = try findMarkers(in: framed.image)
        XCTAssertEqual(found.count, markers.count, "\(Int(width))×\(Int(height)) at \(budget.maxLongEdge): markers found")

        let sink = RecordingEventSink()
        let driver = InputDriver(layout: .usANSI, sink: sink, pause: { _ in })
        for marker in markers {
            let truth = ScreenPoint(x: origin.x + marker.x, y: origin.y + marker.y)
            // The marker nearest to where it should be, as integers the way
            // a model writes coordinates.
            let expected = geometry.framePoint(global: truth)
            let nearest = try XCTUnwrap(found.min { hypot($0.x - expected.x, $0.y - expected.y) < hypot($1.x - expected.x, $1.y - expected.y) })
            let modelX = nearest.x.rounded()
            let modelY = nearest.y.rounded()
            await sink.reset()
            try await driver.click(at: geometry.globalPoint(frameX: modelX, frameY: modelY), target: .global)
            let posted = await sink.events
            let landed = try XCTUnwrap(posted.compactMap(\.point).last)
            XCTAssertLessThanOrEqual(
                landed.distance(to: truth), 2,
                "\(Int(width))×\(Int(height)) budget \(budget.maxLongEdge): \(truth) landed at \(landed)"
            )
        }
    }

    /// Centroids of red blobs, by flood fill over the frame's pixels.
    private func findMarkers(in image: CGImage) throws -> [(x: Double, y: Double)] {
        let pixels = try XCTUnwrap(RGBAPixels(image))
        var visited = [Bool](repeating: false, count: pixels.width * pixels.height)
        func isRed(_ x: Int, _ y: Int) -> Bool {
            let (r, g, b) = pixels.rgb(x, y)
            return r > 170 && g < 110 && b < 110
        }
        var centroids: [(x: Double, y: Double)] = []
        for y in 0..<pixels.height {
            for x in 0..<pixels.width where !visited[y * pixels.width + x] && isRed(x, y) {
                var stack = [(x, y)]
                visited[y * pixels.width + x] = true
                var sumX = 0.0, sumY = 0.0, count = 0.0
                while let (cx, cy) = stack.popLast() {
                    sumX += Double(cx) + 0.5
                    sumY += Double(cy) + 0.5
                    count += 1
                    for (nx, ny) in [(cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)]
                    where nx >= 0 && ny >= 0 && nx < pixels.width && ny < pixels.height
                        && !visited[ny * pixels.width + nx] && isRed(nx, ny)
                    {
                        visited[ny * pixels.width + nx] = true
                        stack.append((nx, ny))
                    }
                }
                if count >= 4 { centroids.append((sumX / count, sumY / count)) }
            }
        }
        return centroids
    }
}

/// A grid with red square markers, drawn top-left origin like the screen.
private final class GridView: NSView {
    let markers: [ScreenPoint]

    init(frame: NSRect, markers: [ScreenPoint]) {
        self.markers = markers
        super.init(frame: frame)
    }

    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        NSColor(white: 0.85, alpha: 1).setFill()
        var x = 0.0
        while x < bounds.width {
            NSRect(x: x, y: 0, width: 1, height: bounds.height).fill()
            x += 40
        }
        var y = 0.0
        while y < bounds.height {
            NSRect(x: 0, y: y, width: bounds.width, height: 1).fill()
            y += 40
        }
        NSColor(srgbRed: 0.9, green: 0.1, blue: 0.1, alpha: 1).setFill()
        for marker in markers {
            NSRect(x: marker.x - 7, y: marker.y - 7, width: 14, height: 14).fill()
        }
    }
}
#endif
