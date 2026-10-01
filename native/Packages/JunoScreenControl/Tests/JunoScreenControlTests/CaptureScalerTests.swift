import CoreGraphics
import XCTest
@testable import JunoScreenControl

/// Budgets per tier and the map back (CODE_AGENT_SPEC §3.5).
final class CaptureScalerTests: XCTestCase {
    /// A 16-inch MacBook Pro at default scaling, captured at device pixels.
    let mbp16 = PixelSize(width: 3456, height: 2234)
    /// A Pro Display XDR.
    let xdr = PixelSize(width: 6016, height: 3384)

    private func frame(_ size: PixelSize, _ budget: ImageBudget) -> (PixelSize, Double) {
        let scale = CaptureScaler.scale(pixelWidth: size.width, pixelHeight: size.height, budget: budget)
        return (CaptureScaler.scaledSize(pixelWidth: size.width, pixelHeight: size.height, scale: scale), scale)
    }

    func testOlderClaudeModelsGetAtMost1568PixelsAndAboutOnePointOneFiveMegapixels() {
        for source in [mbp16, xdr, PixelSize(width: 2940, height: 1912), PixelSize(width: 5120, height: 2880)] {
            let (size, _) = frame(source, .anthropicStandard)
            XCTAssertLessThanOrEqual(size.longEdge, 1_568, "\(source)")
            XCTAssertLessThanOrEqual(size.pixelCount, 1_150_000, "\(source)")
            XCTAssertTrue(CaptureScaler.fits(size, .anthropicStandard))
            // Not shrunk further than the binding limit needs.
            XCTAssertGreaterThan(size.pixelCount, 1_100_000, "\(source) → \(size)")
        }
    }

    func testNewerClaudeModelsGetAtMost2576PixelsAnd4784VisualTokens() {
        for source in [mbp16, xdr, PixelSize(width: 3024, height: 1964), PixelSize(width: 2560, height: 1440)] {
            let (size, _) = frame(source, .anthropicHighResolution)
            XCTAssertLessThanOrEqual(size.longEdge, 2_576, "\(source)")
            let tokens = ((size.width + 27) / 28) * ((size.height + 27) / 28)
            XCTAssertLessThanOrEqual(tokens, 4_784, "\(source) → \(size)")
            XCTAssertEqual(tokens, CaptureScaler.visualTokens(size))
            XCTAssertGreaterThan(tokens, 4_500, "\(source) → \(size) should use most of the budget")
        }
    }

    func testASmallWindowIsNeverEnlarged() {
        let (size, scale) = frame(PixelSize(width: 800, height: 600), .anthropicHighResolution)
        XCTAssertEqual(scale, 1)
        XCTAssertEqual(size, PixelSize(width: 800, height: 600))
    }

    func testOpenAIHighDetailFitsTheBoxTheServerWouldResizeTo() {
        let (size, _) = frame(mbp16, .openAIHighDetail)
        XCTAssertLessThanOrEqual(size.longEdge, 2_048)
        XCTAssertLessThanOrEqual(size.shortEdge, 768)
    }

    func testMapBackWithBackingScaleTwo() {
        // A window at (200, 100) points, 800×600 points, Retina.
        let (size, scale) = frame(PixelSize(width: 1600, height: 1200), .anthropicStandard)
        let geometry = FrameGeometry(
            origin: ScreenPoint(x: 200, y: 100), pointWidth: 800, pointHeight: 600,
            backingScale: 2, scale: scale, frameSize: size
        )
        // The frame's centre is the window's centre.
        let center = geometry.globalPoint(frameX: Double(size.width) / 2, frameY: Double(size.height) / 2)
        XCTAssertEqual(center.x, 600, accuracy: 0.5)
        XCTAssertEqual(center.y, 400, accuracy: 0.5)
        // And back.
        let back = geometry.framePoint(global: center)
        XCTAssertEqual(back.x, Double(size.width) / 2, accuracy: 0.5)
    }

    func testASecondaryDisplayAtANegativeOriginMapsInGlobalSpace() {
        // A display to the left of and above the main one.
        let geometry = FrameGeometry(
            origin: ScreenPoint(x: -1920, y: -300), pointWidth: 1920, pointHeight: 1080,
            backingScale: 1, scale: 0.5, frameSize: PixelSize(width: 960, height: 540)
        )
        let point = geometry.globalPoint(frameX: 480, frameY: 270)
        XCTAssertEqual(point.x, -960, accuracy: 0.01)
        XCTAssertEqual(point.y, 240, accuracy: 0.01)
        XCTAssertTrue(geometry.globalBounds.contains(point))
        XCTAssertFalse(geometry.globalBounds.contains(ScreenPoint(x: 10, y: 10)), "the main display is not this frame")
    }

    func testNormalizedCoordinatesMapThroughTheFrame() {
        let geometry = FrameGeometry(
            origin: ScreenPoint(x: 0, y: 0), pointWidth: 1000, pointHeight: 500,
            backingScale: 2, scale: 0.5, frameSize: PixelSize(width: 1000, height: 500),
            coordinates: .normalized1000
        )
        let point = geometry.globalPoint(frameX: 500, frameY: 500)
        XCTAssertEqual(point.x, 500, accuracy: 0.01)
        XCTAssertEqual(point.y, 250, accuracy: 0.01)
    }

    func testZoomCropsAtNativePixelsWithoutChangingTheClickFrame() {
        let geometry = FrameGeometry(
            origin: ScreenPoint(x: 0, y: 0), pointWidth: 1512, pointHeight: 982,
            backingScale: 2, scale: 0.5, frameSize: PixelSize(width: 1512, height: 982)
        )
        let before = geometry
        let rect = geometry.sourcePixelRect(frameRegion: [100, 100, 300, 200])
        XCTAssertEqual(rect?.x, 200)
        XCTAssertEqual(rect?.y, 200)
        XCTAssertEqual(rect?.width, 400)
        XCTAssertEqual(rect?.height, 200)
        XCTAssertEqual(geometry, before, "zoom reads; the click frame is untouched")
        XCTAssertNil(geometry.sourcePixelRect(frameRegion: [5000, 5000, 6000, 6000]))
    }

    func testTheFrameHeaderStatesTheFrame() {
        let geometry = FrameGeometry(
            origin: ScreenPoint(x: 0, y: 0), pointWidth: 1728, pointHeight: 1117,
            backingScale: 2, scale: 0.397, frameSize: PixelSize(width: 1372, height: 887), displayID: 1
        )
        XCTAssertEqual(
            geometry.header(app: "com.apple.TextEdit", window: "Untitled 2"),
            "frame 1372×887 · scale 0.397 · display 1 · app com.apple.TextEdit · window \"Untitled 2\""
        )
    }

    func testResampleAndEncodeProduceTheChosenSize() throws {
        let image = makeImage(width: 3456, height: 2234, rects: [(CGRect(x: 100, y: 100, width: 400, height: 300), (0.9, 0.1, 0.1))])
        let framed = try XCTUnwrap(CaptureScaler.frame(of: image, budget: .anthropicStandard))
        XCTAssertTrue(CaptureScaler.fits(PixelSize(width: framed.image.width, height: framed.image.height), .anthropicStandard))
        let encoded = try XCTUnwrap(CaptureScaler.encode(framed.image))
        XCTAssertEqual(encoded.size.width, framed.image.width)
        XCTAssertFalse(encoded.data.isEmpty)
    }

    func testFlatGreyFramesAreTextHeavyAndPhotosAreNot() {
        let document = makeImage(width: 400, height: 300, rects: [(CGRect(x: 20, y: 20, width: 300, height: 4), (0.2, 0.2, 0.2))])
        XCTAssertTrue(CaptureScaler.isTextHeavy(document))
        var rects: [(CGRect, (Double, Double, Double))] = []
        for index in 0..<48 {
            rects.append((CGRect(x: index * 8, y: 0, width: 8, height: 300), (Double(index % 7) / 7, Double(index % 5) / 5, Double(index % 3) / 3)))
        }
        XCTAssertFalse(CaptureScaler.isTextHeavy(makeImage(width: 400, height: 300, rects: rects)))
    }

    func testFrameComparisonSeesADialogButNotACaret() {
        let size = PixelSize(width: 400, height: 300)
        let base = makeImage(width: 400, height: 300)
        let caret = makeImage(width: 400, height: 300, rects: [(CGRect(x: 200, y: 150, width: 1, height: 12), (0.1, 0.1, 0.1))])
        let dialog = makeImage(width: 400, height: 300, rects: [(CGRect(x: 150, y: 110, width: 120, height: 80), (0.2, 0.3, 0.7))])
        XCTAssertLessThan(FrameComparison.difference(base, caret, around: (200, 150), frameSize: size), FrameComparison.changedThreshold)
        XCTAssertGreaterThan(FrameComparison.difference(base, dialog, around: (200, 150), frameSize: size), FrameComparison.changedThreshold)
    }
}
