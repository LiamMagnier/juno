import Foundation
import JunoCodeRuntime
import UniformTypeIdentifiers

#if canImport(AppKit)
import AppKit
#endif

/// An image the reader attached to the message they are composing.
///
/// Wraps ``ModelImage`` with the two things the *composer* needs and the wire
/// does not: a stable identity, so a thumbnail can be removed from a list without
/// comparing megabytes of pixel data, and a name to show under it.
public struct CodeAttachment: Identifiable, Hashable, Sendable {
    public let id: UUID
    /// What to call it in the composer. A pasted image has no filename, so this
    /// says so rather than inventing one.
    public let name: String
    public let image: ModelImage

    public init(id: UUID = UUID(), name: String, image: ModelImage) {
        self.id = id
        self.name = name
        self.image = image
    }

    /// A human-readable size, for the thumbnail's tooltip.
    public var sizeDescription: String {
        ByteCountFormatter.string(
            fromByteCount: Int64(image.data.count),
            countStyle: .file
        )
    }

    /// The image formats every vision model in the catalog accepts.
    ///
    /// Deliberately not "any image UTI": HEIC is the default capture format on
    /// Apple hardware and *no* provider in the catalog accepts it, so a dropped
    /// iPhone photo would have been a hard 400 rather than an answer. Those are
    /// transcoded below instead of refused.
    public static let acceptedTypes: [UTType] = [.png, .jpeg, .gif, .webP, .heic, .heif, .tiff, .bmp]

    private static let wireMediaTypes: Set<String> = [
        "image/png", "image/jpeg", "image/gif", "image/webp",
    ]

    /// Reads a file the reader dropped or chose.
    ///
    /// Returns nil for anything that is not a decodable image, which is the honest
    /// answer for a dropped `.zip` — the caller reports it rather than attaching
    /// something the model cannot read.
    public static func load(contentsOf url: URL) -> CodeAttachment? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let declared = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        guard let image = makeImage(data: data, declaredMediaType: declared) else {
            return nil
        }
        return CodeAttachment(name: url.lastPathComponent, image: image)
    }

    /// Builds an attachment from raw bytes on the pasteboard.
    public static func pasted(data: Data, declaredMediaType: String?) -> CodeAttachment? {
        guard let image = makeImage(data: data, declaredMediaType: declaredMediaType) else {
            return nil
        }
        return CodeAttachment(name: "Pasted image", image: image)
    }

    /// Normalises to a format the providers actually accept.
    ///
    /// PNG/JPEG/GIF/WebP pass through untouched — re-encoding them would cost
    /// quality and size for nothing. Everything else decodable (HEIC, TIFF, BMP) is
    /// re-encoded to PNG once, here, so no other layer has to know which formats
    /// are on the wire allowlist.
    static func makeImage(data: Data, declaredMediaType: String?) -> ModelImage? {
        if let declaredMediaType, wireMediaTypes.contains(declaredMediaType) {
            return ModelImage(mediaType: declaredMediaType, data: data, detail: .auto)
        }
        #if canImport(AppKit)
        guard let bitmap = NSBitmapImageRep(data: data),
              let png = bitmap.representation(using: .png, properties: [:])
        else { return nil }
        return ModelImage(mediaType: "image/png", data: png, detail: .auto)
        #else
        return nil
        #endif
    }
}
