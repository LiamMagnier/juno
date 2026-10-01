import Foundation
import JunoCodeRuntime
import UniformTypeIdentifiers

#if canImport(AppKit)
import AppKit
#endif
#if canImport(PDFKit)
import PDFKit
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

    /// The largest file the composer reads to make an attachment from. A
    /// picture over the per-image limit is still read here, because it may
    /// shrink when re-encoded; a file past this is not read at all.
    public static let maximumFileBytes = 64 * 1_024 * 1_024

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
        loadAll(contentsOf: url).first
    }

    /// Reads a file the reader dropped, chose or pasted: an image is one
    /// attachment; a PDF is its first pages, one picture each (§5.11), so a
    /// model that sees images can read a dropped document.
    ///
    /// Only a regular file that says it is a picture or a PDF, and no larger
    /// than ``maximumFileBytes``, is read at all: ⌘V with a disk image copied
    /// in Finder, or a dropped folder, must not pull gigabytes into memory on
    /// the way to finding out it is not a picture.
    public static func loadAll(contentsOf url: URL, maximumPages: Int = 4) -> [CodeAttachment] {
        guard url.isFileURL,
              let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true,
              let size = values.fileSize, size <= maximumFileBytes
        else { return [] }
        // A file with no extension may still be a picture (a temporary
        // capture); one that names another type is not read.
        let type = url.pathExtension.isEmpty ? nil : UTType(filenameExtension: url.pathExtension)
        let isPDF = type?.conforms(to: .pdf) == true
        guard isPDF || type == nil || type?.conforms(to: .image) == true else { return [] }
        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]), data.count <= maximumFileBytes else {
            return []
        }
        if isPDF {
            return pdfPages(data: data, name: url.lastPathComponent, maximumPages: maximumPages)
        }
        let declared = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        guard let image = makeImage(data: data, declaredMediaType: declared) else {
            return []
        }
        return [CodeAttachment(name: url.lastPathComponent, image: image)]
    }

    /// A PDF's first `maximumPages` pages as PNGs, at most 1,600 points on
    /// the long side. Empty for data that is not a PDF.
    public static func pdfPages(data: Data, name: String, maximumPages: Int = 4) -> [CodeAttachment] {
        #if canImport(PDFKit) && canImport(AppKit)
        guard let document = PDFDocument(data: data), document.pageCount > 0 else { return [] }
        var pages: [CodeAttachment] = []
        for index in 0..<min(document.pageCount, maximumPages) {
            guard let page = document.page(at: index) else { continue }
            let bounds = page.bounds(for: .mediaBox)
            let scale = min(1, 1_600 / max(bounds.width, bounds.height, 1)) * 2
            let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
            let image = page.thumbnail(of: size, for: .mediaBox)
            guard let tiff = image.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:])
            else { continue }
            let label = document.pageCount == 1 ? name : "\(name), page \(index + 1)"
            pages.append(CodeAttachment(name: label, image: ModelImage(mediaType: "image/png", data: png, detail: .auto)))
        }
        return pages
        #else
        return []
        #endif
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
