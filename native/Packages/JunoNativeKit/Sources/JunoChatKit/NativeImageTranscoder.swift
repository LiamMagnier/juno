import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Prepares a camera or photo-library image for upload.
///
/// The server's accepted image set is PNG, JPEG, WebP and GIF, identified by
/// magic bytes rather than by what the client claims. HEIC — which is what an
/// iPhone camera produces by default — is deliberately *not* in that set, and
/// this is the reason it does not need to be: the transcode happens here, on
/// the device that already has the decoder, rather than by teaching the server
/// to decode a format the web cannot display anyway.
///
/// Three things happen besides the format change, and each matters:
///
/// - **Orientation is baked in.** A photo taken in portrait usually stores its
///   pixels landscape plus an EXIF orientation tag. Strip the metadata without
///   applying the rotation first and every such photo uploads sideways. This
///   draws the image through a transform so the pixels themselves are upright.
/// - **Metadata is dropped.** Camera images carry GPS coordinates by default.
///   Uploading someone's location because they attached a photo is not a
///   trade-off worth making, so the output carries only what is needed to
///   display it.
/// - **The result is validated.** The bytes are re-read as an image before
///   being returned, so a transcode that silently produced something
///   unreadable fails here rather than as a confusing 415 from the server.
public enum NativeImageTranscoder {
    public enum TranscodeError: Error, Equatable, LocalizedError, Sendable {
        case unreadableSource
        case encodingFailed
        case outputNotAnImage

        public var errorDescription: String? {
            switch self {
            case .unreadableSource: "That image could not be read."
            case .encodingFailed: "That image could not be prepared for upload."
            case .outputNotAnImage: "That image could not be prepared for upload."
            }
        }
    }

    public struct Output: Equatable, Sendable {
        public let data: Data
        public let mimeType: String
        public let fileName: String

        public init(data: Data, mimeType: String, fileName: String) {
            self.data = data
            self.mimeType = mimeType
            self.fileName = fileName
        }
    }

    /// Types the server accepts as-is. Passing these through untouched keeps a
    /// PNG screenshot lossless instead of round-tripping it through JPEG.
    public static let passthroughMIMETypes: Set<String> = [
        "image/png", "image/jpeg", "image/webp", "image/gif",
    ]

    public static func needsTranscoding(mimeType: String) -> Bool {
        !passthroughMIMETypes.contains(mimeType.lowercased())
    }

    /// JPEG quality for transcoded output. High enough that the recompression
    /// is not visible on a photograph, low enough that a 12-megapixel capture
    /// does not arrive as a 10 MB upload and trip the plan ceiling.
    public static let jpegQuality: CGFloat = 0.82

    public static func prepareForUpload(
        data: Data,
        mimeType: String,
        fileName: String
    ) throws -> Output {
        guard needsTranscoding(mimeType: mimeType) else {
            return Output(data: data, mimeType: mimeType.lowercased(), fileName: fileName)
        }
        return try transcodeToJPEG(data: data, fileName: fileName)
    }

    public static func transcodeToJPEG(data: Data, fileName: String) throws -> Output {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
            CGImageSourceGetCount(source) > 0
        else { throw TranscodeError.unreadableSource }

        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let orientation = (properties?[kCGImagePropertyOrientation] as? UInt32).flatMap(
            CGImagePropertyOrientation.init(rawValue:)
        ) ?? .up

        guard let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw TranscodeError.unreadableSource
        }
        let upright = try applyOrientation(orientation, to: decoded)

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, UTType.jpeg.identifier as CFString, 1, nil
        ) else { throw TranscodeError.encodingFailed }

        // Only the compression quality is passed. Not copying the source
        // properties is what drops GPS, timestamps and device identifiers —
        // the orientation is already applied to the pixels, so nothing is lost
        // by leaving the tag behind.
        CGImageDestinationAddImage(destination, upright, [
            kCGImageDestinationLossyCompressionQuality: jpegQuality,
        ] as CFDictionary)

        guard CGImageDestinationFinalize(destination) else {
            throw TranscodeError.encodingFailed
        }

        let encoded = output as Data
        // Re-read rather than trust: a destination can finalize successfully and
        // still leave bytes the decoder will not take.
        guard let check = CGImageSourceCreateWithData(encoded as CFData, nil),
            CGImageSourceGetCount(check) > 0
        else { throw TranscodeError.outputNotAnImage }

        return Output(
            data: encoded,
            mimeType: "image/jpeg",
            fileName: jpegFileName(from: fileName)
        )
    }

    /// `IMG_0042.HEIC` → `IMG_0042.jpg`, so the stored name does not claim a
    /// format the bytes no longer are.
    public static func jpegFileName(from fileName: String) -> String {
        let base = (fileName as NSString).deletingPathExtension
        let stem = base.isEmpty ? "image" : base
        return "\(stem).jpg"
    }

    private static func applyOrientation(
        _ orientation: CGImagePropertyOrientation,
        to image: CGImage
    ) throws -> CGImage {
        guard orientation != .up else { return image }

        let width = image.width
        let height = image.height
        let swapsAxes: Bool
        switch orientation {
        case .left, .leftMirrored, .right, .rightMirrored: swapsAxes = true
        default: swapsAxes = false
        }
        let outputWidth = swapsAxes ? height : width
        let outputHeight = swapsAxes ? width : height

        guard let context = CGContext(
            data: nil,
            width: outputWidth,
            height: outputHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: image.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { throw TranscodeError.encodingFailed }

        context.concatenate(transform(for: orientation, width: width, height: height))
        context.draw(
            image,
            in: CGRect(
                x: 0, y: 0,
                width: swapsAxes ? outputHeight : outputWidth,
                height: swapsAxes ? outputWidth : outputHeight
            )
        )

        guard let rotated = context.makeImage() else { throw TranscodeError.encodingFailed }
        return rotated
    }

    private static func transform(
        for orientation: CGImagePropertyOrientation,
        width: Int,
        height: Int
    ) -> CGAffineTransform {
        let w = CGFloat(width)
        let h = CGFloat(height)
        switch orientation {
        case .up:
            return .identity
        case .upMirrored:
            return CGAffineTransform(translationX: w, y: 0).scaledBy(x: -1, y: 1)
        case .down:
            return CGAffineTransform(translationX: w, y: h).rotated(by: .pi)
        case .downMirrored:
            return CGAffineTransform(translationX: 0, y: h).scaledBy(x: 1, y: -1)
        case .left:
            return CGAffineTransform(translationX: 0, y: w).rotated(by: -.pi / 2)
        case .leftMirrored:
            return CGAffineTransform(translationX: 0, y: 0).rotated(by: -.pi / 2).scaledBy(x: -1, y: 1)
        case .right:
            return CGAffineTransform(translationX: h, y: 0).rotated(by: .pi / 2)
        case .rightMirrored:
            return CGAffineTransform(translationX: h, y: w).rotated(by: .pi / 2).scaledBy(x: -1, y: 1)
        @unknown default:
            return .identity
        }
    }
}
