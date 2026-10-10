import Foundation

#if os(macOS)
    import AppKit
    import PDFKit

    /// The text inside a document that is not plain text: PDF through PDFKit,
    /// Word, RTF and OpenDocument through the text system. Both are on every
    /// Mac and read locally, which is what "cheap" means here — nothing is
    /// uploaded to be converted.
    public enum ChatFolderDocumentText {
        /// Nil when the file holds no text (a scanned PDF) or cannot be read.
        public static func extract(from url: URL) -> String? {
            switch url.pathExtension.lowercased() {
            case "pdf":
                guard let document = PDFDocument(url: url) else { return nil }
                if document.isLocked { return nil }
                var pages: [String] = []
                for index in 0..<document.pageCount {
                    guard let text = document.page(at: index)?.string else { continue }
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty { pages.append("[Page \(index + 1)]\n\(trimmed)") }
                }
                return pages.isEmpty ? nil : pages.joined(separator: "\n\n")
            case "docx", "doc", "rtf", "rtfd", "odt":
                // Plain text out, never HTML: no web content is loaded for a
                // document a stranger may have written.
                let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [:]
                guard let attributed = try? NSAttributedString(url: url, options: options, documentAttributes: nil) else {
                    return nil
                }
                let text = attributed.string.trimmingCharacters(in: .whitespacesAndNewlines)
                return text.isEmpty ? nil : text
            default:
                return nil
            }
        }
    }
#endif
