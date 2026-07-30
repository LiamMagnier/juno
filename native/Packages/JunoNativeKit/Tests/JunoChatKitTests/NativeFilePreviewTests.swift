import CoreGraphics
import ImageIO
import XCTest
@testable import JunoChatKit

/// What the shared preview loader must never do: fetch the same file twice, and
/// fetch a file it has no business drawing.
///
/// These moved down here with the loader itself, which used to live in the iOS
/// app and could therefore only ever be tested — or used — by the phone. The Mac
/// Library was drawing the word "PNG" for the same reason.
@MainActor
final class NativeFilePreviewTests: XCTestCase {

    private func request(
        _ name: String,
        isImage: Bool = true,
        bytes: Int = 1_024
    ) -> NativeFilePreviewRequest {
        NativeFilePreviewRequest(id: name, fileName: name, isImage: isImage, byteSize: bytes)
    }

    /// A card scrolls away and comes back. Re-downloading on every appearance
    /// costs real money on a metered connection, so a failure is remembered as
    /// firmly as a success.
    func testAFileIsOnlyEverFetchedOnce() async {
        let loader = NativeFilePreviewLoader()
        let file = request("beach.png")
        var fetches = 0

        await loader.load(file) {
            fetches += 1
            return nil
        }
        await loader.load(file) {
            fetches += 1
            return nil
        }

        XCTAssertEqual(fetches, 1, "the library re-downloaded a file it had already failed on")
        XCTAssertEqual(loader.state(for: file.id), .unavailable)
    }

    /// A 60 MB video or archive is not worth pulling down to draw a 300pt square,
    /// so it never leaves the card's fallback state — and never touches the
    /// network to get there.
    func testAnOversizedDocumentIsNeverDownloadedForAThumbnail() async {
        let loader = NativeFilePreviewLoader()
        let huge = request(
            "archive.zip",
            isImage: false,
            bytes: NativeFilePreviewLoader.documentByteLimit + 1
        )
        var fetched = false

        await loader.load(huge) {
            fetched = true
            return nil
        }

        XCTAssertFalse(fetched)
        XCTAssertEqual(loader.state(for: huge.id), .unavailable)
    }

    /// The ceiling is on documents only. An image is worth fetching whatever its
    /// stored size, because ImageIO decodes straight to thumbnail size and never
    /// holds the full bitmap.
    func testALargeImageIsStillWorthFetching() async {
        let loader = NativeFilePreviewLoader()
        let photo = request(
            "huge.heic",
            bytes: NativeFilePreviewLoader.documentByteLimit * 4
        )
        var fetched = false

        await loader.load(photo) {
            fetched = true
            return nil
        }

        XCTAssertTrue(fetched)
    }

    /// Bytes that are not a picture are not a picture. The card falls back rather
    /// than showing an empty frame that looks like a broken image.
    func testUndecodableBytesLeaveTheCardInItsFallback() async {
        let loader = NativeFilePreviewLoader()
        let file = request("not-really.png")

        await loader.load(file) { .downloaded(Data("this is not a PNG".utf8)) }

        XCTAssertEqual(loader.state(for: file.id), .unavailable)
    }

    /// A real image decodes, and decodes *down*: the thumbnail is bounded by
    /// `thumbnailPixelSize` however large the source is.
    func testARealImageDecodesToABoundedThumbnail() async throws {
        let loader = NativeFilePreviewLoader()
        let file = request("wide.png")
        let source = try XCTUnwrap(Self.png(width: 1_600, height: 900))

        await loader.load(file) { .downloaded(source) }

        guard case .ready(let image) = loader.state(for: file.id) else {
            return XCTFail("a valid PNG should have produced a thumbnail")
        }
        XCTAssertLessThanOrEqual(
            max(image.width, image.height),
            NativeFilePreviewLoader.thumbnailPixelSize
        )
        XCTAssertGreaterThan(image.width, image.height, "the aspect ratio must survive")
    }

    /// A library row and a project file describe the same attachment, and both
    /// have to arrive at the same preview request — otherwise the picker and the
    /// Library would key their caches differently for one file.
    func testBothRowTypesProduceTheSameRequest() {
        let fromLibrary = NativeFilePreviewRequest(
            NativeLibraryItem(
                id: "att-1",
                fileName: "beach.png",
                mimeType: "image/png",
                size: 2_048,
                kind: "IMAGE",
                createdAt: Date(timeIntervalSince1970: 0)
            )
        )
        let fromProject = NativeFilePreviewRequest(
            NativeProjectFile(
                id: "att-1",
                projectID: nil,
                conversationID: nil,
                messageID: nil,
                fileName: "beach.png",
                kind: "IMAGE",
                mimeType: "image/png",
                size: 2_048,
                width: nil,
                height: nil,
                createdAt: Date(timeIntervalSince1970: 0),
                revision: 1
            )
        )
        XCTAssertEqual(fromLibrary, fromProject)
        XCTAssertTrue(fromLibrary.isImage)
    }

    private static func png(width: Int, height: Int) -> Data? {
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = context.makeImage() else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, "public.png" as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}
