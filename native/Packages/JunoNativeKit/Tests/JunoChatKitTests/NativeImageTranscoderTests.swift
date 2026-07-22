import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import JunoChatKit

/// The transcoder is what lets the server keep HEIC out of its accepted set.
/// These build real images, push them through, and read the result back —
/// asserting on decoded pixels rather than on the code's intentions.
@Suite struct NativeImageTranscoderTests {
    @Test func heicIsRecognizedAsNeedingTranscoding() {
        #expect(NativeImageTranscoder.needsTranscoding(mimeType: "image/heic"))
        #expect(NativeImageTranscoder.needsTranscoding(mimeType: "image/HEIF"))
    }

    /// A PNG screenshot should not be silently round-tripped through JPEG: the
    /// server accepts it as-is, and recompressing text is exactly where JPEG
    /// looks worst.
    @Test func acceptedTypesArePassedThroughUntouched() throws {
        let png = try makeImageData(type: .png, width: 8, height: 8)
        let output = try NativeImageTranscoder.prepareForUpload(
            data: png, mimeType: "image/png", fileName: "shot.png"
        )

        #expect(output.data == png)
        #expect(output.mimeType == "image/png")
        #expect(output.fileName == "shot.png")
    }

    /// The output has to be a real JPEG, not merely bytes that were produced
    /// without an error being thrown.
    @Test func transcodeProducesADecodableJPEG() throws {
        let source = try makeImageData(type: .tiff, width: 12, height: 9)
        let output = try NativeImageTranscoder.transcodeToJPEG(
            data: source, fileName: "IMG_0042.HEIC"
        )

        #expect(output.mimeType == "image/jpeg")
        #expect(output.fileName == "IMG_0042.jpg")

        // JPEG's own magic bytes — the same check the server makes.
        #expect(output.data.prefix(3) == Data([0xFF, 0xD8, 0xFF]))

        let reread = try #require(CGImageSourceCreateWithData(output.data as CFData, nil))
        #expect(CGImageSourceGetCount(reread) == 1)
        let decoded = try #require(CGImageSourceCreateImageAtIndex(reread, 0, nil))
        #expect(decoded.width == 12)
        #expect(decoded.height == 9)
    }

    /// The defect this prevents: strip metadata without applying the rotation
    /// first and every portrait photo uploads sideways. A `.right` orientation
    /// means the stored pixels are landscape and must come out portrait, so the
    /// dimensions have to swap.
    @Test func orientationIsBakedIntoThePixels() throws {
        let rotated = try makeImageData(
            type: .tiff, width: 20, height: 10, orientation: .right
        )
        let output = try NativeImageTranscoder.transcodeToJPEG(
            data: rotated, fileName: "portrait.heic"
        )

        let reread = try #require(CGImageSourceCreateWithData(output.data as CFData, nil))
        let decoded = try #require(CGImageSourceCreateImageAtIndex(reread, 0, nil))
        #expect(
            decoded.width == 10 && decoded.height == 20,
            "A .right orientation must be applied to the pixels, not carried as a tag."
        )

        // And the tag must not survive to rotate it a second time.
        let properties = CGImageSourceCopyPropertiesAtIndex(reread, 0, nil) as? [CFString: Any]
        let tag = properties?[kCGImagePropertyOrientation] as? UInt32
        #expect(
            tag == nil || tag == CGImagePropertyOrientation.up.rawValue,
            "Applying the rotation and keeping the tag would rotate the image twice."
        )
    }

    /// Uploading someone's location because they attached a photo is not a
    /// trade-off worth making.
    @Test func gpsMetadataDoesNotSurviveTheTranscode() throws {
        let located = try makeImageData(
            type: .tiff, width: 8, height: 8,
            gps: [kCGImagePropertyGPSLatitude: 48.8584, kCGImagePropertyGPSLongitude: 2.2945]
        )
        // Precondition: the fixture really does carry GPS, or the test proves nothing.
        let sourceImage = try #require(CGImageSourceCreateWithData(located as CFData, nil))
        let sourceProperties = try #require(
            CGImageSourceCopyPropertiesAtIndex(sourceImage, 0, nil) as? [CFString: Any]
        )
        #expect(sourceProperties[kCGImagePropertyGPSDictionary] != nil)

        let output = try NativeImageTranscoder.transcodeToJPEG(
            data: located, fileName: "holiday.heic"
        )

        let reread = try #require(CGImageSourceCreateWithData(output.data as CFData, nil))
        let properties = CGImageSourceCopyPropertiesAtIndex(reread, 0, nil) as? [CFString: Any]
        #expect(properties?[kCGImagePropertyGPSDictionary] == nil)
    }

    /// A file that is not an image at all must fail here, with a message a
    /// reader can act on, rather than as a confusing 415 from the server.
    @Test func nonImageDataIsRejectedBeforeUpload() {
        let notAnImage = Data("this is not an image".utf8)
        #expect(throws: NativeImageTranscoder.TranscodeError.unreadableSource) {
            try NativeImageTranscoder.transcodeToJPEG(data: notAnImage, fileName: "x.heic")
        }
    }

    @Test func fileNameLosesTheStaleExtension() {
        #expect(NativeImageTranscoder.jpegFileName(from: "IMG_0042.HEIC") == "IMG_0042.jpg")
        #expect(NativeImageTranscoder.jpegFileName(from: "no-extension") == "no-extension.jpg")
        #expect(NativeImageTranscoder.jpegFileName(from: "") == "image.jpg")
    }

    // MARK: - Fixtures

    private func makeImageData(
        type: UTType,
        width: Int,
        height: Int,
        orientation: CGImagePropertyOrientation? = nil,
        gps: [CFString: Any]? = nil
    ) throws -> Data {
        let context = try #require(CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.9, green: 0.3, blue: 0.2, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())

        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(
            data, type.identifier as CFString, 1, nil
        ))
        var properties: [CFString: Any] = [:]
        if let orientation { properties[kCGImagePropertyOrientation] = orientation.rawValue }
        if let gps { properties[kCGImagePropertyGPSDictionary] = gps }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }
}
