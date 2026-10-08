import CoreGraphics
import Foundation
import JunoDesignSystem
import SwiftUI

/// A research report as a PDF: A4, the light appearance, the article's own
/// typography, paginated between blocks — a page never breaks inside a
/// paragraph, a list or a table unless that one block is taller than a page.
///
/// Drawn with `ImageRenderer` into a PDF context block by block, so it needs no
/// web view, no print panel and no window: the same code on the Mac and the
/// phone, offscreen.
@MainActor
public enum NativeResearchReportPDF {
    /// A4 in points.
    public static let pageSize = CGSize(width: 595, height: 842)
    static let margin: CGFloat = 54
    static let gap: CGFloat = 10

    public static func data(for report: NativeResearchReport, accessed: Date = Date()) -> Data? {
        let width = pageSize.width - margin * 2
        let contentHeight = pageSize.height - margin * 2 - 18
        let output = NSMutableData()
        var media = CGRect(origin: .zero, size: pageSize)
        guard let consumer = CGDataConsumer(data: output as CFMutableData),
            let context = CGContext(consumer: consumer, mediaBox: &media, [
                kCGPDFContextTitle as String: report.title,
                kCGPDFContextCreator as String: "Alevr",
            ] as CFDictionary)
        else { return nil }

        var page = 0
        var y: CGFloat = 0
        func newPage() {
            if page > 0 { context.endPDFPage() }
            context.beginPDFPage(nil)
            page += 1
            y = 0
            drawFolio(page, title: report.title, in: context)
        }
        newPage()

        for block in blocks(of: report) {
            let renderer = ImageRenderer(content: block
                .frame(width: width, alignment: .leading)
                .environment(\.colorScheme, .light)
                .environment(\.junoProseStyle, .reading)
                .environment(\.junoCitationCount, report.citationCount))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            var height: CGFloat = 0
            renderer.render { size, _ in height = size.height }
            guard height > 0 else { continue }
            if y > 0, y + height > contentHeight { newPage() }
            if height <= contentHeight {
                context.saveGState()
                context.translateBy(x: margin, y: pageSize.height - margin - y - height)
                renderer.render { _, draw in draw(context) }
                context.restoreGState()
                y += height + gap
            } else {
                // One block taller than a page: drawn in page-high slices.
                if y > 0 { newPage() }
                var offset: CGFloat = 0
                while offset < height {
                    context.saveGState()
                    context.clip(to: CGRect(x: margin, y: pageSize.height - margin - contentHeight, width: width, height: contentHeight))
                    context.translateBy(x: margin, y: pageSize.height - margin - height + offset)
                    renderer.render { _, draw in draw(context) }
                    context.restoreGState()
                    offset += contentHeight
                    if offset < height { newPage() }
                }
                y = height - (offset - contentHeight) + gap
            }
        }
        context.endPDFPage()
        context.closePDF()
        return output as Data
    }

    /// The article cut where a page may break.
    static func blocks(of report: NativeResearchReport) -> [AnyView] {
        var blocks: [AnyView] = [AnyView(NativeResearchReportCover(report: report, compact: true))]
        for section in report.sections {
            var pieces = NativeResearchReport.blocks(of: section.markdown)
            if section.level > 0 {
                // A heading keeps its first block with it: never alone at the
                // foot of a page.
                let size: CGFloat = section.level >= 3 ? 16 : 21
                let first = pieces.isEmpty ? nil : pieces.removeFirst()
                blocks.append(AnyView(
                    VStack(alignment: .leading, spacing: 8) {
                        Text(section.title)
                            .font(JunoSerif.font(size: size, relativeTo: .title3))
                            .foregroundStyle(Color.junoForeground)
                        if let first {
                            JunoMarkdownText(first).foregroundStyle(Color.junoForeground)
                        }
                    }
                    .padding(.top, section.level >= 3 ? 8 : 18)
                ))
            }
            for markdown in pieces {
                blocks.append(AnyView(
                    JunoMarkdownText(markdown)
                        .foregroundStyle(Color.junoForeground)
                ))
            }
        }
        if !report.sources.isEmpty {
            blocks.append(AnyView(
                Text("Sources")
                    .font(JunoSerif.font(size: 21, relativeTo: .title3))
                    .foregroundStyle(Color.junoForeground)
                    .padding(.top, 18)
            ))
            for (index, source) in report.sources.enumerated() {
                blocks.append(AnyView(
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("[\(index + 1)]")
                            .junoFont(size: 9, relativeTo: .caption2, design: .monospaced)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .frame(width: 26, alignment: .leading)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(NativeResearchReport.displayTitle(source))
                                .junoFont(size: 10, relativeTo: .caption)
                                .foregroundStyle(Color.junoForeground)
                            Text(source.url.absoluteString)
                                .junoFont(size: 8.5, relativeTo: .caption2)
                                .foregroundStyle(Color.junoSecondaryInk)
                        }
                    }
                ))
            }
        }
        return blocks
    }

    private static func drawFolio(_ page: Int, title: String, in context: CGContext) {
        let folio = Text("\(title)  \u{00B7}  \(page)")
            .junoFont(size: 8, relativeTo: .caption2, design: .monospaced)
            .foregroundStyle(Color.junoSecondaryInk)
            .environment(\.colorScheme, .light)
            .lineLimit(1)
            .frame(width: pageSize.width - margin * 2, alignment: .trailing)
        let renderer = ImageRenderer(content: folio)
        context.saveGState()
        context.translateBy(x: margin, y: margin * 0.45)
        renderer.render { _, draw in draw(context) }
        context.restoreGState()
    }
}
