import AppKit
import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The shared vocabulary for a diff line, so unified and side-by-side cannot
/// disagree about what "added" looks like.
enum DiffLinePresentation {
    /// Gutters are fixed so line numbers stay column-aligned into four digits;
    /// past that the number is allowed to run rather than the row re-flowing.
    static let gutterWidth: CGFloat = 34
    static let markerWidth: CGFloat = 14
    /// Narrower than a comfortable reading measure on purpose: two columns of
    /// code side by side are only useful if each one still shows a statement.
    static let minimumPairedColumnWidth: CGFloat = 320

    static func marker(_ kind: DiffLineKind?) -> String {
        switch kind {
        case .added: "+"
        case .removed: "−"
        case .context, .none: " "
        }
    }

    static func markerColor(_ kind: DiffLineKind?) -> Color {
        switch kind {
        case .added: .junoSuccess
        case .removed: .junoDanger
        case .context, .none: .secondary
        }
    }

    static func fill(_ kind: DiffLineKind?) -> Color {
        switch kind {
        case .added: .junoDiffAdded
        case .removed: .junoDiffRemoved
        case .context, .none: .clear
        }
    }

    static func accessibilityLabel(_ line: DiffLine) -> String {
        switch line.kind {
        case .context: "Unchanged: \(line.text)"
        case .added: "Added: \(line.text)"
        case .removed: "Removed: \(line.text)"
        }
    }

    /// Empty lines still need a glyph or the row collapses to zero height and
    /// the diff loses a line the file actually has.
    static func text(_ line: DiffLine?) -> String {
        guard let text = line?.text, !text.isEmpty else { return " " }
        return text
    }
}

/// One hunk, unified.
///
/// Machine text is column-aligned and fixed-width; soft wrapping breaks the
/// alignment and doubles the height of every long line, so the hunk scrolls
/// horizontally instead. The scroller is per hunk rather than per canvas so the
/// file headers and the hunk actions stay where the reader left them.
struct UnifiedHunkLines: View {
    let hunk: DiffHunk
    /// The visible canvas width, so a short hunk's row fills tint the whole
    /// line rather than stopping at the longest line in the hunk.
    let minimumWidth: CGFloat
    let onComment: ((DiffLine) -> Void)?

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                    row(line)
                }
            }
            .frame(minWidth: minimumWidth, alignment: .leading)
        }
        .background(Color.junoTerminal)
    }

    private func row(_ line: DiffLine) -> some View {
        HStack(spacing: 0) {
            Text(line.oldLineNumber.map(String.init) ?? "")
                .frame(width: DiffLinePresentation.gutterWidth, alignment: .trailing)
                .foregroundStyle(.tertiary)
            Text(line.newLineNumber.map(String.init) ?? "")
                .frame(width: DiffLinePresentation.gutterWidth, alignment: .trailing)
                .foregroundStyle(.tertiary)
            Text(DiffLinePresentation.marker(line.kind))
                .frame(width: DiffLinePresentation.markerWidth)
                .foregroundStyle(DiffLinePresentation.markerColor(line.kind))
            Text(DiffLinePresentation.text(line))
                .foregroundStyle(line.kind == .context ? .secondary : .primary)
                .textSelection(.enabled)
            Spacer(minLength: JunoSpace.cozy)
        }
        .junoCodeSmall()
        .monospacedDigit()
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DiffLinePresentation.fill(line.kind))
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(DiffLinePresentation.accessibilityLabel(line))
        .commentAction(for: line, perform: onComment)
    }
}

/// One hunk, genuinely paired.
///
/// Replacement runs are aligned by index and context is repeated on both sides,
/// so the reader is not left correlating two independently filtered lists. Each
/// column truncates rather than scrolling: two nested horizontal scrollers in
/// one row is worse than a visible ellipsis plus the unified layout one click
/// away.
struct PairedHunkLines: View {
    let hunk: DiffHunk
    let columnWidth: CGFloat
    let onComment: ((DiffLine) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(DiffPairing.rows(for: hunk)) { row in
                HStack(spacing: 0) {
                    side(row.left, isOld: true)
                    Divider()
                    side(row.right, isOld: false)
                }
            }
        }
        .background(Color.junoTerminal)
    }

    private func side(_ line: DiffLine?, isOld: Bool) -> some View {
        HStack(spacing: 0) {
            Text(lineNumber(line, isOld: isOld))
                .frame(width: DiffLinePresentation.gutterWidth, alignment: .trailing)
                .foregroundStyle(.tertiary)
            Text(DiffLinePresentation.marker(line?.kind))
                .frame(width: DiffLinePresentation.markerWidth)
                .foregroundStyle(DiffLinePresentation.markerColor(line?.kind))
            Text(DiffLinePresentation.text(line))
                .foregroundStyle(line?.kind == .context ? .secondary : .primary)
                .textSelection(.enabled)
                .truncationMode(.tail)
            Spacer(minLength: JunoSpace.snug)
        }
        .junoCodeSmall()
        .monospacedDigit()
        .lineLimit(1)
        .frame(width: columnWidth, alignment: .leading)
        .background(DiffLinePresentation.fill(line?.kind))
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.map(DiffLinePresentation.accessibilityLabel) ?? "No line")
        .help(line?.text ?? "")
        .commentAction(for: line, perform: onComment)
    }

    private func lineNumber(_ line: DiffLine?, isOld: Bool) -> String {
        guard let line else { return "" }
        return (isOld ? line.oldLineNumber : line.newLineNumber).map(String.init) ?? ""
    }
}

private extension View {
    /// A line note is offered where the line is, but only when the surface
    /// showing it can accept one.
    @ViewBuilder
    func commentAction(for line: DiffLine?, perform: ((DiffLine) -> Void)?) -> some View {
        if let line, let perform {
            contextMenu {
                Button("Comment on This Line") { perform(line) }
                Button("Copy Line") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(line.text, forType: .string)
                }
            }
        } else {
            self
        }
    }
}

struct PairedDiffRow: Identifiable {
    let id: Int
    let left: DiffLine?
    let right: DiffLine?
}

/// Pairs a hunk's lines into left/right rows. Pure, so the alignment rule can
/// be reasoned about without a view.
enum DiffPairing {
    static func rows(for hunk: DiffHunk) -> [PairedDiffRow] {
        var result: [PairedDiffRow] = []
        var index = 0
        while index < hunk.lines.count {
            let line = hunk.lines[index]
            if line.kind == .context {
                result.append(PairedDiffRow(id: result.count, left: line, right: line))
                index += 1
                continue
            }
            var removed: [DiffLine] = []
            while index < hunk.lines.count, hunk.lines[index].kind == .removed {
                removed.append(hunk.lines[index])
                index += 1
            }
            var added: [DiffLine] = []
            while index < hunk.lines.count, hunk.lines[index].kind == .added {
                added.append(hunk.lines[index])
                index += 1
            }
            for pairIndex in 0..<max(removed.count, added.count) {
                result.append(
                    PairedDiffRow(
                        id: result.count,
                        left: pairIndex < removed.count ? removed[pairIndex] : nil,
                        right: pairIndex < added.count ? added[pairIndex] : nil
                    )
                )
            }
        }
        return result
    }
}
