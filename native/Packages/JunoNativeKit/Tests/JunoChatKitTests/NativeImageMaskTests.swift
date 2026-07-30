import CoreGraphics
import ImageIO
import XCTest
@testable import JunoChatKit

/// The mask's polarity and its orientation.
///
/// Both are trivially easy to get backwards, and neither fails loudly: an
/// inverted mask edits everything *except* what was selected, and a
/// vertically-flipped one edits the mirror-image region. Both produce a
/// plausible picture, so the only thing that catches them is reading the pixels.
final class NativeImageMaskTests: XCTestCase {

    private func mask(
        _ region: NativeImageRegion,
        _ size: CGSize
    ) throws -> (image: CGImage, url: String) {
        let url = try XCTUnwrap(NativeImageMask.pngDataURL(region: region, pixelSize: size))
        let prefix = "data:image/png;base64,"
        XCTAssertTrue(url.hasPrefix(prefix), "the server only accepts a PNG data URL")
        let data = try XCTUnwrap(Data(base64Encoded: String(url.dropFirst(prefix.count))))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        return (try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil)), url)
    }

    /// Alpha at a point, sampled with the region's own top-left orientation.
    private func alpha(_ image: CGImage, x: Int, y: Int) throws -> UInt8 {
        var pixel: [UInt8] = [0, 0, 0, 0]
        let context = try XCTUnwrap(
            CGContext(
                data: &pixel,
                width: 1,
                height: 1,
                bitsPerComponent: 8,
                bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        )
        // Draw the whole image offset so the wanted pixel lands in the 1×1
        // context, flipping y so the coordinates read top-left like the region's.
        context.draw(
            image,
            in: CGRect(
                x: -CGFloat(x),
                y: -CGFloat(image.height - 1 - y),
                width: CGFloat(image.width),
                height: CGFloat(image.height)
            )
        )
        return pixel[3]
    }

    /// The `images.edit` convention: the TRANSPARENT pixels are the ones the
    /// model may repaint. Inverting this edits everything except the selection.
    func testTheSelectionIsTransparentAndEverythingElseIsOpaqueBlack() throws {
        let size = CGSize(width: 100, height: 100)
        let region = NativeImageRegion(x: 0.25, y: 0.25, width: 0.5, height: 0.5)
        let result = try mask(region, size)

        XCTAssertEqual(result.image.width, 100)
        XCTAssertEqual(result.image.height, 100)
        XCTAssertEqual(try alpha(result.image, x: 50, y: 50), 0, "inside the selection must be clear")
        XCTAssertEqual(try alpha(result.image, x: 5, y: 5), 255, "outside must be opaque")
        XCTAssertEqual(try alpha(result.image, x: 95, y: 95), 255, "outside must be opaque")
    }

    /// CoreGraphics' origin is bottom-left and the region's is top-left. Without
    /// the flip, a selection in the top strip clears the BOTTOM strip — and the
    /// edit lands on the mirror-image half of the picture.
    func testTheRegionIsMeasuredFromTheTopLeft() throws {
        let size = CGSize(width: 80, height: 200)
        // The top fifth.
        let region = NativeImageRegion(x: 0, y: 0, width: 1, height: 0.2)
        let result = try mask(region, size)

        XCTAssertEqual(try alpha(result.image, x: 40, y: 10), 0, "the top strip is the selection")
        XCTAssertEqual(try alpha(result.image, x: 40, y: 190), 255, "the bottom must stay opaque")
    }

    /// The mask is drawn at the image's NATURAL size, not at the size it was
    /// displayed. A mask at view size would be scaled by the provider and the
    /// edited area would drift.
    func testTheMaskIsRenderedAtTheImagesNaturalSize() throws {
        let result = try mask(
            NativeImageRegion(x: 0.1, y: 0.1, width: 0.2, height: 0.2),
            CGSize(width: 1_024, height: 768)
        )
        XCTAssertEqual(result.image.width, 1_024)
        XCTAssertEqual(result.image.height, 768)
    }

    /// A sliver still has to clear at least one pixel; a zero-width rectangle
    /// would produce a fully opaque mask, which says "change nothing" while the
    /// UI shows a selection.
    func testASliverStillClearsAtLeastOnePixel() throws {
        let result = try mask(
            NativeImageRegion(x: 0.5, y: 0.5, width: 0.0001, height: 0.0001),
            CGSize(width: 100, height: 100)
        )
        XCTAssertEqual(try alpha(result.image, x: 50, y: 49), 0)
    }

    func testAZeroSizedImageProducesNoMaskRatherThanAnEmptyOne() {
        XCTAssertNil(
            NativeImageMask.pngDataURL(
                region: NativeImageRegion(x: 0, y: 0, width: 1, height: 1),
                pixelSize: .zero
            )
        )
    }

    /// The wire type clamps and rounds, because the server's schema bounds every
    /// component to 0…1 and a doomed request should not cost a round trip.
    func testTheWireRegionClampsAndRoundsToFourPlaces() {
        let region = NativeMediaGenerationRequest.Region(
            x: -0.5, y: 1.5, width: 0.123456, height: 0.5
        )
        XCTAssertEqual(region.x, 0)
        XCTAssertEqual(region.y, 1)
        XCTAssertEqual(region.width, 0.1235)
        XCTAssertEqual(region.height, 0.5)
    }
}
