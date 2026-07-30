import SwiftUI

/// AIcss "Code Block" — the numbered-gutter shell.
///
/// Two things it does that the previous native block did not. The header sits at
/// the frame's edge with the rule under it as the card's own inlay, rather than a
/// second border drawn inside the card. And every line carries a number against a
/// full-height hairline, which is what makes a model's "line 14" findable without
/// counting.
///
/// Wrapping stays off, for the reason the old block gave and which still holds:
/// soft-wrapping code doubles a long line's height and destroys the indentation
/// the reader is using to parse it. The code column scrolls horizontally; the
/// gutter does not scroll with it, so the numbers stay put.
public struct JunoAIcssCodeBlock: View {
    private let label: String
    private let source: String

    @State private var didCopy = false

    /// - Parameters:
    ///   - label: a filename when one is known, else the language.
    public init(label: String, source: String) {
        self.label = label
        self.source = source
    }

    private var lines: [String] {
        source.hasSuffix("\n")
            ? String(source.dropLast()).components(separatedBy: "\n")
            : source.components(separatedBy: "\n")
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            JunoAIcssBlockHeader(icon: "chevron.left.forwardslash.chevron.right", label: label) {
                Button {
                    JunoPasteboard.copy(source)
                    didCopy = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        didCopy = false
                    }
                } label: {
                    Label(didCopy ? "Copied" : "Copy", systemImage: didCopy ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12))
                        .labelStyle(.iconOnly)
                        .foregroundStyle(Color.junoMutedForeground)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .help(didCopy ? "Copied" : "Copy code")
                .accessibilityLabel(didCopy ? "Code copied" : "Copy code")
            }

            JunoAIcssGutterBody(gutters: 1) {
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    HStack(spacing: 0) {
                        JunoAIcssLineNumber(index + 1)
                        Text(line.isEmpty ? " " : line)
                            .font(.system(size: 12.5, design: .monospaced))
                            .foregroundStyle(Color.primary)
                            .textSelection(.enabled)
                            .padding(.leading, 8)
                            .padding(.trailing, 12)
                            .frame(minHeight: 20, alignment: .leading)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
            }
        }
        .background(Color.junoSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
    }
}

/// One row of a unified diff.
public struct JunoAIcssDiffRow: Identifiable, Hashable, Sendable {
    public enum Kind: Sendable {
        case context
        case added
        case removed
    }

    public let id: Int
    /// Line number in the old file, or nil for an addition.
    public let old: Int?
    /// Line number in the new file, or nil for a deletion.
    public let new: Int?
    public let kind: Kind
    public let text: String

    public init(id: Int, old: Int?, new: Int?, kind: Kind, text: String) {
        self.id = id
        self.old = old
        self.new = new
        self.kind = kind
        self.text = text
    }
}

/// AIcss "File Diff".
///
/// Two number columns and a sign column, so a row states both where a line was and
/// where it is now. The left accent bar carries the sign a SECOND time — solid for
/// an addition, a 45° hatch for a deletion — which is what keeps the diff readable
/// by someone who cannot separate the greens from the reds. With colour alone, the
/// two tint bands are the only thing distinguishing adding a line from deleting
/// one.
public struct JunoAIcssDiff: View {
    private let file: String
    private let rows: [JunoAIcssDiffRow]

    public init(file: String, rows: [JunoAIcssDiffRow]) {
        self.file = file
        self.rows = rows
    }

    private var added: Int { rows.count { $0.kind == .added } }
    private var removed: Int { rows.count { $0.kind == .removed } }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            JunoAIcssBlockHeader(icon: "arrow.left.arrow.right", label: file) {
                HStack(spacing: 8) {
                    Text("+\(added)").foregroundStyle(Color.junoSuccess)
                    Text("-\(removed)").foregroundStyle(Color.junoDanger)
                }
                .font(.system(size: 12, design: .monospaced))
            }

            JunoAIcssGutterBody(gutters: 2) {
                ForEach(rows) { row in
                    HStack(spacing: 0) {
                        JunoAIcssLineNumber(row.old, tint: row.kind == .removed ? .junoDanger : nil)
                        JunoAIcssLineNumber(row.new, tint: row.kind == .added ? .junoSuccess : nil)
                        Text(sign(row.kind))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(tint(row.kind) ?? Color.junoMutedForeground.opacity(0.8))
                            .frame(width: 18)
                        Text(row.text.isEmpty ? " " : row.text)
                            .font(.system(size: 12.5, design: .monospaced))
                            .foregroundStyle(row.kind == .context ? Color.junoMutedForeground : Color.primary)
                            .textSelection(.enabled)
                            .padding(.leading, 8)
                            .padding(.trailing, 12)
                            .frame(minHeight: 20, alignment: .leading)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .background(alignment: .leading) {
                        ZStack(alignment: .leading) {
                            fill(row.kind)
                            accent(row.kind).frame(width: 3)
                        }
                    }
                }
            }
        }
        .background(Color.junoSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
    }

    private func sign(_ kind: JunoAIcssDiffRow.Kind) -> String {
        switch kind {
        case .added: "+"
        case .removed: "-"
        case .context: ""
        }
    }

    private func tint(_ kind: JunoAIcssDiffRow.Kind) -> Color? {
        switch kind {
        case .added: .junoSuccess
        case .removed: .junoDanger
        case .context: nil
        }
    }

    @ViewBuilder
    private func fill(_ kind: JunoAIcssDiffRow.Kind) -> some View {
        switch kind {
        case .added: Color.junoDiffAdded
        case .removed: Color.junoDiffRemoved
        case .context: Color.clear
        }
    }

    /// Solid for an addition; a hatch for a deletion. The hatch is the redundant
    /// channel — the one that survives being read without colour.
    @ViewBuilder
    private func accent(_ kind: JunoAIcssDiffRow.Kind) -> some View {
        switch kind {
        case .added:
            Color.junoSuccess
        case .removed:
            Canvas { context, size in
                var path = Path()
                var offset = -size.height
                while offset < size.width + size.height {
                    path.move(to: CGPoint(x: offset, y: size.height))
                    path.addLine(to: CGPoint(x: offset + size.height, y: 0))
                    offset += 3
                }
                context.stroke(path, with: .color(.junoDanger), lineWidth: 1.5)
            }
        case .context:
            Color.clear
        }
    }
}

/// Parse a unified diff into rows.
///
/// Deliberately narrow: it reads `@@ -a,b +c,d @@` headers for the line numbers
/// and then walks the body. A malformed patch yields the lines it could read
/// rather than throwing, because this renders inside a transcript where an
/// exception costs the whole message and a short diff costs a scroll.
public func junoAIcssParseUnifiedDiff(_ patch: String) -> [JunoAIcssDiffRow] {
    var rows: [JunoAIcssDiffRow] = []
    var oldLine = 0
    var newLine = 0
    var id = 0

    for line in patch.components(separatedBy: "\n") {
        if line.hasPrefix("@@") {
            // "@@ -12,3 +12,5 @@" — take the first number after each sign.
            let numbers = line
                .split(separator: " ")
                .compactMap { token -> Int? in
                    guard token.hasPrefix("-") || token.hasPrefix("+") else { return nil }
                    return Int(token.dropFirst().split(separator: ",").first ?? "")
                }
            if numbers.count >= 2 {
                oldLine = numbers[0]
                newLine = numbers[1]
            }
            continue
        }
        // File headers carry no line content.
        if ["diff ", "index ", "--- ", "+++ ", "new file", "deleted file", "similarity", "rename "]
            .contains(where: line.hasPrefix) { continue }
        // "\ No newline at end of file" is a note about the patch, not a line in it.
        if line.hasPrefix("\\") { continue }

        if line.hasPrefix("+") {
            rows.append(.init(id: id, old: nil, new: newLine, kind: .added, text: String(line.dropFirst())))
            newLine += 1
        } else if line.hasPrefix("-") {
            rows.append(.init(id: id, old: oldLine, new: nil, kind: .removed, text: String(line.dropFirst())))
            oldLine += 1
        } else {
            let text = line.hasPrefix(" ") ? String(line.dropFirst()) : line
            rows.append(.init(id: id, old: oldLine, new: newLine, kind: .context, text: text))
            oldLine += 1
            newLine += 1
        }
        id += 1
    }
    return rows
}

// MARK: - Shared shell

/// The header both blocks use: an icon, a label, and one trailing control, pulled
/// out to the frame's edge so the rule beneath it is the card's inlay.
struct JunoAIcssBlockHeader<Trailing: View>: View {
    let icon: String
    let label: String
    @ViewBuilder let trailing: Trailing

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.junoMutedForeground)
                Text(label)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                trailing
            }
            .padding(.leading, 16)
            .padding(.trailing, 12)
            .padding(.vertical, 8)

            Rectangle()
                .fill(Color.junoHairline)
                .frame(height: 0.5)
        }
    }
}

/// The scrolling body, with the gutter hairline running its full height.
///
/// The rule is drawn as an overlay rather than as a border on the numbers, so it
/// spans the whole column instead of stopping short of the first and last row —
/// and so it sits above the diff's tinted fills rather than under them.
struct JunoAIcssGutterBody<Content: View>: View {
    /// How many 32pt number columns precede the code.
    let gutters: Int
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.automatic)
        .padding(.vertical, 6)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Color.junoHairline)
                .frame(width: 0.5)
                .padding(.leading, Double(gutters) * 32)
        }
    }
}

/// One right-aligned, un-selectable line number.
struct JunoAIcssLineNumber: View {
    private let number: Int?
    private let tint: Color?

    init(_ number: Int?, tint: Color? = nil) {
        self.number = number
        self.tint = tint
    }

    var body: some View {
        Text(number.map(String.init) ?? "")
            .font(.system(size: 11, design: .monospaced))
            .monospacedDigit()
            .foregroundStyle(tint ?? Color.junoMutedForeground.opacity(0.8))
            .frame(width: 32, alignment: .trailing)
            .padding(.trailing, 7)
            .frame(width: 32)
    }
}

#if DEBUG
#Preview("AIcss code and diff") {
    ScrollView {
        VStack(alignment: .leading, spacing: 20) {
            JunoAIcssCodeBlock(
                label: "utils.ts",
                source: """
                export const sum = (a: number, b: number) =>
                  a + b;

                export const clamp = (n: number, min: number, max: number) =>
                  Math.min(Math.max(n, min), max);
                """
            )
            JunoAIcssDiff(
                file: "src/auth.ts",
                rows: junoAIcssParseUnifiedDiff("""
                @@ -12,3 +12,5 @@
                 export function getToken() {
                -  return localStorage.token;
                +  const t = cookies.get("session");
                +  if (!t) throw new Error("no session");
                +  return t;
                 }
                """)
            )
        }
        .padding(20)
    }
    .background(Color.junoCanvas)
}
#endif
