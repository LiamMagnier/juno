#if DEBUG
import CoreGraphics
import CoreText
import Foundation

/// The bytes behind the preview world's documents, so a Library or project
/// tile draws a real QuickLook thumbnail of a real file rather than its
/// fallback glyph.
///
/// Like ``PreviewImageFixtures``, drawn at launch rather than bundled: a PDF
/// page set in CoreText, and a CSV as plain text. Each goes through the same
/// `NativeFilePreviewLoader` path a server file does (bytes on disk with the
/// file's own extension, then `QLThumbnailGenerator`), so a screenshot of the
/// grid is also evidence that path works.
public enum PreviewDocumentFixtures {
    public struct Document: Sendable {
        public let contentType: String
        public let data: Data
    }

    /// The document for an attachment id, or nil for an id this fixture does
    /// not draw.
    public static func document(for id: String) -> Document? {
        lock.lock()
        defer { lock.unlock() }
        if let cached = cache[id] { return cached }
        let made: Document?
        switch id {
        case "sc-file-1", "file-1":
            made = pdf(
                title: id == "file-1" ? "Quasar notes" : "Field Notes 2.0",
                subtitle: id == "file-1" ? "Observing log, spring run" : "Launch brief",
                paragraphs: [
                    "Field Notes 2.0 ships on 14 October with sync on cellular, the new editor and shared notebooks.",
                    "Goals: double weekly active writers, keep churn under 3%, and land two press features in launch week.",
                    "Audience: students and researchers who already keep notes on more than one device.",
                    "Channels: the launch email, the press kit, a rooftop party in Lisbon and a short film.",
                ]
            ).map { Document(contentType: "application/pdf", data: $0) }
        case "sc-file-2":
            let rows = [
                "theme,reports,severity,example",
                "Sync on cellular,19,high,Lost a paragraph on the train",
                "Search ranking,14,medium,Old notes come first",
                "Selection handles,8,low,Hard to grab on small text",
                "Export to PDF,6,low,Margins too wide",
                "Onboarding,5,low,Skipped the tour by accident",
            ]
            made = Document(contentType: "text/csv", data: Data(rows.joined(separator: "\n").utf8))
        default:
            made = nil
        }
        cache[id] = made
        return made
    }

    private static let lock = NSLock()
    private nonisolated(unsafe) static var cache: [String: Document?] = [:]

    /// One A4-proportioned page: a large title, a subtitle, a rule and a few
    /// paragraphs — enough that the first-page thumbnail reads as a document.
    private static func pdf(title: String, subtitle: String, paragraphs: [String]) -> Data? {
        let data = NSMutableData()
        var box = CGRect(x: 0, y: 0, width: 595, height: 842)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
            let context = CGContext(consumer: consumer, mediaBox: &box, nil)
        else { return nil }
        context.beginPDFPage(nil)
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(box)

        var y: CGFloat = 842 - 96
        func line(_ text: String, size: CGFloat, weight: CGFloat, gray: CGFloat, width: CGFloat = 475) {
            let font = CTFontCreateWithName((weight > 0.3 ? "Helvetica-Bold" : "Helvetica") as CFString, size, nil)
            let attributes: [NSAttributedString.Key: Any] = [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: gray, alpha: 1),
            ]
            let string = NSAttributedString(string: text, attributes: attributes)
            let setter = CTFramesetterCreateWithAttributedString(string)
            let fit = CTFramesetterSuggestFrameSizeWithConstraints(
                setter, CFRange(location: 0, length: 0), nil, CGSize(width: width, height: 400), nil
            )
            let frame = CTFramesetterCreateFrame(
                setter,
                CFRange(location: 0, length: 0),
                CGPath(rect: CGRect(x: 60, y: y - fit.height, width: width, height: fit.height), transform: nil),
                nil
            )
            CTFrameDraw(frame, context)
            y -= fit.height
        }

        // A coral band, the brand's one warm accent, across the top.
        context.setFillColor(CGColor(red: 0.91, green: 0.42, blue: 0.29, alpha: 1))
        context.fill(CGRect(x: 0, y: 842 - 24, width: 595, height: 24))
        line(title, size: 44, weight: 0.6, gray: 0.1)
        y -= 8
        line(subtitle, size: 22, weight: 0, gray: 0.4)
        y -= 24
        context.setFillColor(CGColor(gray: 0.85, alpha: 1))
        context.fill(CGRect(x: 60, y: y, width: 475, height: 1.5))
        y -= 28
        for paragraph in paragraphs {
            line(paragraph, size: 16, weight: 0, gray: 0.25)
            y -= 18
        }
        context.endPDFPage()
        context.closePDF()
        return data as Data
    }
}
#endif
