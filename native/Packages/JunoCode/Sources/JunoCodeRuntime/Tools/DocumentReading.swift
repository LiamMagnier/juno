import Foundation
import ImageIO
import JunoCodeCore
import PDFKit
import UniformTypeIdentifiers

/// What a file is, judged from its first bytes rather than its name: a
/// `.png` that is really text reads as text, and a PDF saved as `.dat` still
/// reads as a PDF.
enum FileSniffer {
    static let sniffBytes = 8 * 1_024

    enum Kind: Equatable {
        case text
        case image(mediaType: String)
        case pdf
        case binary
    }

    static func kind(of data: Data) -> Kind {
        let bytes = [UInt8](data.prefix(16))
        func starts(with signature: [UInt8], at offset: Int = 0) -> Bool {
            bytes.count >= offset + signature.count
                && Array(bytes[offset..<(offset + signature.count)]) == signature
        }
        if starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return .image(mediaType: "image/png") }
        if starts(with: [0xFF, 0xD8, 0xFF]) { return .image(mediaType: "image/jpeg") }
        if starts(with: Array("GIF87a".utf8)) || starts(with: Array("GIF89a".utf8)) {
            return .image(mediaType: "image/gif")
        }
        if starts(with: Array("RIFF".utf8)), starts(with: Array("WEBP".utf8), at: 8) {
            return .image(mediaType: "image/webp")
        }
        if starts(with: Array("%PDF-".utf8)) { return .pdf }
        // A NUL byte never appears in text a person edits. Anything else that
        // is not UTF-8 is left to the text read to discover.
        return data.contains(0) ? .binary : .text
    }

    /// A one-line account of a file read_file will not show.
    static func binaryDescription(path: String, head: FileDataReadResult) -> String {
        let format = formatName(head.data).map { ",\"format\":\"\($0)\"" } ?? ""
        return "{\"path\":\(ReadFileTool.quoted(path)),\"binary\":true,\"bytes\":\(head.totalByteCount)\(format),"
            + "\"note\":\"binary file; read_file shows text, images and PDFs only\"}"
    }

    private static func formatName(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(16))
        guard bytes.count >= 4 else { return nil }
        let first4 = Array(bytes[0..<4])
        switch first4 {
        case [0xFE, 0xED, 0xFA, 0xCE], [0xFE, 0xED, 0xFA, 0xCF], [0xCE, 0xFA, 0xED, 0xFE],
             [0xCF, 0xFA, 0xED, 0xFE], [0xCA, 0xFE, 0xBA, 0xBE]:
            return "Mach-O"
        case [0x7F, 0x45, 0x4C, 0x46]:
            return "ELF"
        case [0x50, 0x4B, 0x03, 0x04]:
            return "zip"
        case [0x00, 0x61, 0x73, 0x6D]:
            return "WebAssembly"
        default:
            break
        }
        if bytes.starts(with: [0x1F, 0x8B]) { return "gzip" }
        if data.starts(with: Data("SQLite format 3".utf8)) { return "SQLite" }
        return nil
    }
}

/// An image made ready to send to a model: within the provider's size limits,
/// scaled down when it is not.
enum ImageAttachment {
    /// The largest file read_file will load to look at.
    static let maximumSourceBytes = 32 * 1_024 * 1_024
    /// The largest image sent as-is. Base64 grows it by a third, which keeps
    /// it under the 5 MB providers accept for one image.
    static let maximumSentBytes = 3_750_000
    /// Providers refuse an image with an edge longer than this.
    static let maximumEdgePixels = 8_000
    /// The long edge a resized image gets: what vision models see at full
    /// detail without being downscaled again on the provider's side.
    static let resizedEdgePixels = 1_568

    struct PixelSize: Equatable {
        let width: Int
        let height: Int
    }

    struct Prepared: Equatable {
        let data: Data
        let mediaType: String
        let originalSize: PixelSize?
        /// Set when the image was scaled down to be sent.
        let resizedSize: PixelSize?
    }

    /// The image to send, or nil when it cannot be decoded.
    static func prepare(_ data: Data, mediaType: String) -> Prepared? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0
        else { return nil }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let width = properties?[kCGImagePropertyPixelWidth] as? Int ?? 0
        let height = properties?[kCGImagePropertyPixelHeight] as? Int ?? 0
        guard width > 0, height > 0 else { return nil }
        let size = PixelSize(width: width, height: height)
        if data.count <= maximumSentBytes, max(width, height) <= maximumEdgePixels {
            return Prepared(data: data, mediaType: mediaType, originalSize: size, resizedSize: nil)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: resizedEdgePixels,
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        let resized = PixelSize(width: thumbnail.width, height: thumbnail.height)
        // Keep a lossless image lossless where it fits; a photo, or a PNG
        // still too large at the smaller size, goes as JPEG.
        let prefersPNG = mediaType == "image/png" || mediaType == "image/gif"
        if prefersPNG, let png = encode(thumbnail, as: .png, quality: nil), png.count <= maximumSentBytes {
            return Prepared(data: png, mediaType: "image/png", originalSize: size, resizedSize: resized)
        }
        guard let jpeg = encode(thumbnail, as: .jpeg, quality: 0.85), jpeg.count <= maximumSentBytes else {
            return nil
        }
        return Prepared(data: jpeg, mediaType: "image/jpeg", originalSize: size, resizedSize: resized)
    }

    private static func encode(_ image: CGImage, as type: UTType, quality: Double?) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output as CFMutableData,
            type.identifier as CFString,
            1,
            nil
        ) else { return nil }
        let properties: [CFString: Any] = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] } ?? [:]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}

/// A PDF's text, page by page, through PDFKit.
enum PDFText {
    /// The largest PDF read_file will open.
    static let maximumSourceBytes = 64 * 1_024 * 1_024

    struct Failure: Error, Equatable {
        let message: String
    }

    struct Extract: Equatable {
        let text: String
        let totalPages: Int
        let firstPage: Int
        let lastPage: Int
        let note: String?
    }

    /// The text of `pages` ("3", "2-5"; the first pages when nil), each page
    /// under a `--- page N ---` line, within `maximumBytes`. Stops at a page
    /// boundary when the budget runs out and says where to continue.
    static func extract(
        from data: Data,
        pages: String?,
        maximumPages: Int,
        maximumBytes: Int
    ) throws -> Extract {
        guard let document = PDFDocument(data: data) else {
            throw Failure(message: "not a readable PDF")
        }
        guard !document.isLocked else {
            throw Failure(message: "the PDF is password-protected")
        }
        let total = document.pageCount
        guard total > 0 else { throw Failure(message: "the PDF has no pages") }

        let requested: ClosedRange<Int>
        var note: String?
        if let pages {
            requested = try parse(pages, total: total)
            guard requested.count <= maximumPages else {
                throw Failure(message: "at most \(maximumPages) pages per read; ask for a smaller range")
            }
        } else {
            requested = 1...min(total, maximumPages)
            if total > maximumPages {
                note = "showing pages 1-\(maximumPages) of \(total); pass pages \"\(maximumPages + 1)-\(min(total, maximumPages * 2))\" to continue"
            }
        }

        var sections: [String] = []
        var used = 0
        var last = requested.lowerBound - 1
        var sawText = false
        for number in requested {
            let pageText = document.page(at: number - 1)?.string ?? ""
            if !pageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sawText = true }
            let section = "--- page \(number) ---\n" + pageText
            let cost = section.utf8.count + (sections.isEmpty ? 0 : 2)
            if used + cost > maximumBytes {
                if sections.isEmpty {
                    // One page larger than the whole budget: its head, not nothing.
                    let head = OutputLimiter.apply(OutputLimit(maximumBytes: maximumBytes, truncationNotice: ""), to: section).text
                    sections.append(head)
                    last = number
                    note = "page \(number) is longer than \(maximumBytes / 1_024) KB; only its start is shown"
                        + (number < total ? "; pass pages \"\(number + 1)\" to continue" : "")
                } else {
                    note = "stopped at page \(last) to stay within \(maximumBytes / 1_024) KB; pass pages \"\(number)-\(min(total, number + maximumPages - 1))\" to continue"
                }
                break
            }
            used += cost
            sections.append(section)
            last = number
        }
        if !sawText {
            note = [note, "these pages have no extractable text (they may be scanned images)"]
                .compactMap { $0 }
                .joined(separator: "; ")
        }
        return Extract(
            text: sections.joined(separator: "\n\n"),
            totalPages: total,
            firstPage: requested.lowerBound,
            lastPage: last,
            note: note
        )
    }

    static func parse(_ text: String, total: Int) throws -> ClosedRange<Int> {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        let numbers = parts.compactMap { Int($0) }
        guard numbers.count == parts.count, (1...2).contains(numbers.count) else {
            throw Failure(message: "pages must look like \"3\" or \"2-5\"")
        }
        let first = numbers[0]
        let last = numbers.count == 2 ? numbers[1] : numbers[0]
        guard first >= 1, first <= last else {
            throw Failure(message: "pages must look like \"3\" or \"2-5\", counting from 1")
        }
        guard last <= total else {
            throw Failure(message: "the PDF has \(total) page\(total == 1 ? "" : "s")")
        }
        return first...last
    }
}
