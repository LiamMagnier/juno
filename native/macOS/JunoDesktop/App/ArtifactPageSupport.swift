import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI
import UniformTypeIdentifiers

// Kept from the Artifacts page the Phase 4 rewrite replaced: the version diff,
// the source file a download writes, the detached artifact window, and the
// kinds' names. The artifact page (`ArtifactPage.swift`) uses all four.

// MARK: - Diff canvas

/// The comparison, on the same raised page as the source it describes.
///
/// Row fills come from `junoDiffAdded`/`junoDiffRemoved` — low-chroma by design,
/// because the whole row is tinted and has to sit *under* monospaced text in both
/// appearances — with a solid bar in the status hue carrying the sign for anyone
/// who cannot rely on the fill alone.
///
/// Only the diff itself is carded. "Comparing…" and "No changes" are states of
/// the page, not documents on it, and a lone empty white panel with a sentence
/// floating in the middle of it reads as a broken view.
struct DesktopArtifactDiffCanvas: View {
    let lines: [DesktopArtifactDiffLine]
    let computing: Bool
    let baseVersion: Int?
    let targetVersion: Int

    private var hasChanges: Bool {
        lines.contains { $0.change != .context }
    }

    var body: some View {
        if computing {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Comparing versions")
        } else if !hasChanges {
            JunoEmptyState(
                title: "No changes",
                message: baseVersion.map {
                    "v\($0) and v\(targetVersion) have identical content."
                } ?? "These versions have identical content.",
                icon: .equal
            )
        } else {
            // A diff keeps its horizontal scroll where prose gets a wrap: column
            // alignment is the thing being read, and soft-wrapping a changed line
            // hides which characters actually moved.
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(lines) { line in
                        row(line)
                    }
                }
                .padding(.vertical, JunoSpace.snug)
            }
            .clipShape(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
            )
            .junoCard()
            .padding(JunoSpace.region)
            .accessibilityLabel(
                baseVersion.map {
                    "Changes from version \($0) to version \(targetVersion)"
                } ?? "Changes in version \(targetVersion)"
            )
            .accessibilityIdentifier("juno.artifact-diff")
        }
    }

    private func row(_ line: DesktopArtifactDiffLine) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            Rectangle()
                .fill(barColor(line.change))
                .frame(width: 2)
                .accessibilityHidden(true)
            Text(gutter(line.baseLine))
                .junoCodeSmall()
                .monospacedDigit()
                .junoMetaInk()
                .frame(width: 34, alignment: .trailing)
            Text(gutter(line.targetLine))
                .junoCodeSmall()
                .monospacedDigit()
                .junoMetaInk()
                .frame(width: 34, alignment: .trailing)
            Text(sign(line.change))
                .junoCode()
                .junoSecondaryInk()
                .frame(width: 10, alignment: .leading)
            Text(line.text.isEmpty ? " " : line.text)
                .junoCode()
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.trailing, JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(fill(line.change))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText(line))
    }

    private func gutter(_ value: Int?) -> String {
        value.map(String.init) ?? " "
    }

    private func sign(_ change: DesktopArtifactDiffLine.Change) -> String {
        switch change {
        case .added: "+"
        case .removed: "−"
        case .context: " "
        }
    }

    private func fill(_ change: DesktopArtifactDiffLine.Change) -> Color {
        switch change {
        case .added: Color.junoDiffAdded
        case .removed: Color.junoDiffRemoved
        case .context: Color.clear
        }
    }

    private func barColor(_ change: DesktopArtifactDiffLine.Change) -> Color {
        switch change {
        case .added: Color.junoSuccess
        case .removed: Color.junoDanger
        case .context: Color.clear
        }
    }

    private func accessibilityText(_ line: DesktopArtifactDiffLine) -> String {
        switch line.change {
        case .added: "Added: \(line.text)"
        case .removed: "Removed: \(line.text)"
        case .context: line.text
        }
    }
}

// MARK: - Diff engine

struct DesktopArtifactDiffRequest: Equatable, Sendable {
    let artifactID: String
    let base: Int
    let target: Int
    let versionCount: Int
}

struct DesktopArtifactDiffLine: Identifiable, Sendable {
    enum Change: Sendable, Equatable {
        case context
        case added
        case removed
    }

    let id: Int
    let change: Change
    let text: String
    let baseLine: Int?
    let targetLine: Int?
}

/// A line diff between two stored versions.
///
/// Deliberately the same shape as the web Canvas's `line-diff.ts`, so the same
/// two versions describe the same change on both clients: trim the shared prefix
/// and suffix, then align only the middle. The cap matters — a version may hold
/// 200,000 characters, and past a few thousand changed lines an aligned diff
/// stops being readable at all — so beyond it the middle is reported honestly as
/// one removed block followed by one added block instead of a fabricated
/// alignment.
enum DesktopArtifactDiff {
    static let middleLineCap = 1500

    static func lines(from base: String, to target: String) -> [DesktopArtifactDiffLine] {
        let baseLines = split(base)
        let targetLines = split(target)

        var out: [DesktopArtifactDiffLine] = []
        func append(
            _ change: DesktopArtifactDiffLine.Change,
            _ text: String,
            base baseLine: Int?,
            target targetLine: Int?
        ) {
            out.append(
                DesktopArtifactDiffLine(
                    id: out.count,
                    change: change,
                    text: text,
                    baseLine: baseLine,
                    targetLine: targetLine
                )
            )
        }

        let shared = min(baseLines.count, targetLines.count)
        var prefix = 0
        while prefix < shared, baseLines[prefix] == targetLines[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < shared - prefix,
            baseLines[baseLines.count - 1 - suffix] == targetLines[targetLines.count - 1 - suffix]
        {
            suffix += 1
        }

        for index in 0..<prefix {
            append(.context, baseLines[index], base: index + 1, target: index + 1)
        }

        let baseMiddle = Array(baseLines[prefix..<(baseLines.count - suffix)])
        let targetMiddle = Array(targetLines[prefix..<(targetLines.count - suffix)])

        if baseMiddle.count > middleLineCap || targetMiddle.count > middleLineCap {
            for (offset, text) in baseMiddle.enumerated() {
                append(.removed, text, base: prefix + offset + 1, target: nil)
            }
            for (offset, text) in targetMiddle.enumerated() {
                append(.added, text, base: nil, target: prefix + offset + 1)
            }
        } else {
            let difference = targetMiddle.difference(from: baseMiddle)
            var removed = Set<Int>()
            var inserted = Set<Int>()
            for change in difference {
                switch change {
                case .remove(let offset, _, _):
                    removed.insert(offset)
                case .insert(let offset, _, _):
                    inserted.insert(offset)
                }
            }

            var baseIndex = 0
            var targetIndex = 0
            while baseIndex < baseMiddle.count || targetIndex < targetMiddle.count {
                if baseIndex < baseMiddle.count, removed.contains(baseIndex) {
                    append(
                        .removed,
                        baseMiddle[baseIndex],
                        base: prefix + baseIndex + 1,
                        target: nil
                    )
                    baseIndex += 1
                } else if targetIndex < targetMiddle.count, inserted.contains(targetIndex) {
                    append(
                        .added,
                        targetMiddle[targetIndex],
                        base: nil,
                        target: prefix + targetIndex + 1
                    )
                    targetIndex += 1
                } else if baseIndex < baseMiddle.count, targetIndex < targetMiddle.count {
                    append(
                        .context,
                        baseMiddle[baseIndex],
                        base: prefix + baseIndex + 1,
                        target: prefix + targetIndex + 1
                    )
                    baseIndex += 1
                    targetIndex += 1
                } else if baseIndex < baseMiddle.count {
                    append(
                        .removed,
                        baseMiddle[baseIndex],
                        base: prefix + baseIndex + 1,
                        target: nil
                    )
                    baseIndex += 1
                } else {
                    append(
                        .added,
                        targetMiddle[targetIndex],
                        base: nil,
                        target: prefix + targetIndex + 1
                    )
                    targetIndex += 1
                }
            }
        }

        for offset in 0..<suffix {
            let baseIndex = baseLines.count - suffix + offset
            let targetIndex = targetLines.count - suffix + offset
            append(
                .context,
                baseLines[baseIndex],
                base: baseIndex + 1,
                target: targetIndex + 1
            )
        }
        return out
    }

    /// A real unified diff, so what lands on the pasteboard can be read by a
    /// person *and* applied by `patch`.
    static func unified(
        _ lines: [DesktopArtifactDiffLine],
        baseLabel: String,
        targetLabel: String
    ) -> String {
        let context = 3
        var out = ["--- \(baseLabel)", "+++ \(targetLabel)"]
        let changed = lines.indices.filter { lines[$0].change != .context }
        guard !changed.isEmpty else { return out.joined(separator: "\n") }

        var hunks: [(start: Int, end: Int)] = []
        var start = changed[0]
        var end = changed[0]
        for index in changed.dropFirst() {
            if index - end <= context * 2 {
                end = index
            } else {
                hunks.append((start, end))
                start = index
                end = index
            }
        }
        hunks.append((start, end))

        for hunk in hunks {
            let from = max(0, hunk.start - context)
            let to = min(lines.count - 1, hunk.end + context)
            var baseStart = 0
            var targetStart = 0
            var baseCount = 0
            var targetCount = 0
            for index in from...to {
                if let line = lines[index].baseLine {
                    if baseCount == 0 { baseStart = line }
                    baseCount += 1
                }
                if let line = lines[index].targetLine {
                    if targetCount == 0 { targetStart = line }
                    targetCount += 1
                }
            }
            // An empty side anchors to the line before the hunk, which is the
            // unified-diff convention for a pure insertion or deletion.
            if baseCount == 0 { baseStart = lastLine(before: from, in: lines, base: true) }
            if targetCount == 0 { targetStart = lastLine(before: from, in: lines, base: false) }
            out.append(
                "@@ -\(range(baseStart, baseCount)) +\(range(targetStart, targetCount)) @@"
            )
            for index in from...to {
                let line = lines[index]
                let sign =
                    switch line.change {
                    case .added: "+"
                    case .removed: "-"
                    case .context: " "
                    }
                out.append(sign + line.text)
            }
        }
        return out.joined(separator: "\n")
    }

    private static func split(_ value: String) -> [String] {
        value.isEmpty ? [] : value.components(separatedBy: "\n")
    }

    private static func range(_ start: Int, _ count: Int) -> String {
        count == 1 ? "\(start)" : "\(start),\(count)"
    }

    private static func lastLine(
        before index: Int,
        in lines: [DesktopArtifactDiffLine],
        base: Bool
    ) -> Int {
        var cursor = index - 1
        while cursor >= 0 {
            if let value = base ? lines[cursor].baseLine : lines[cursor].targetLine {
                return value
            }
            cursor -= 1
        }
        return 0
    }
}

// MARK: - Export

struct DesktopArtifactFile {
    let document: DesktopArtifactDocument
    let name: String
}

/// Carries bytes the backend already produced (an Office export) or the version's
/// own source, so `.fileExporter` — the system's save flow, with its sandbox
/// grant and its replace confirmation — does the writing rather than a bare
/// `NSSavePanel` and a `try?`.
struct DesktopArtifactDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

// MARK: - Detached artifact window

/// "Open in New Window" as a real window, not a sheet.
///
/// The app has one `WindowGroup`, so there is no scene to route an
/// `openWindow(value:)` through; the window is therefore built here and held by
/// this presenter until AppKit tells it the window closed. It renders an
/// immutable snapshot of one version on purpose — a detached window that silently
/// followed later edits would misrepresent the version named in its subtitle.
@MainActor
final class DesktopArtifactWindows: NSObject, NSWindowDelegate {
    static let shared = DesktopArtifactWindows()

    private var windows: [NSWindow] = []

    func present(
        title: String,
        subtitle: String,
        kind: NativeArtifactKind,
        content: String,
        mode: DesktopArtifactViewMode
    ) {
        let controller = NSHostingController(
            rootView: DesktopArtifactWindowContent(kind: kind, content: content, mode: mode)
        )
        let window = NSWindow(contentViewController: controller)
        window.title = title
        window.subtitle = subtitle
        window.setContentSize(NSSize(width: 820, height: 620))
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        windows.append(window)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow else { return }
        windows.removeAll { $0 === closing }
    }
}

struct DesktopArtifactWindowContent: View {
    let kind: NativeArtifactKind
    let content: String
    let mode: DesktopArtifactViewMode

    var body: some View {
        Group {
            if kind.isDesignDocument {
                // Read-only, which is what "immutable snapshot of one version"
                // means once the thing on screen can be dragged: this window has no
                // Save, no draft and no route back to the model, so an editor that
                // accepted edits here would be collecting work it could only throw
                // away when the window closed.
                DesktopDesignSurface(content: content, readOnly: true)
            } else if kind.isSemantic, mode == .preview {
                SemanticArtifactView(kind: kind, content: content)
            } else if mode == .canvas {
                // The canvas torn off into its own window is the best version of
                // it there is: `.sideBySide` at 820pt gives the source and the
                // running document a readable half each, and the console keeps
                // reporting while the reader works in the main window.
                DesktopArtifactLiveCanvas(
                    kind: kind,
                    content: content,
                    layout: .sideBySide
                )
            } else if mode == .preview, kind == .markdown {
                // Same renderer and same page as the main canvas, so a document
                // torn off into its own window is the document the reader was
                // just looking at rather than a second, worse rendering of it.
                JunoDetailPage {
                    JunoMarkdownText(content)
                        .padding(JunoSpace.section)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .junoCard()
                }
            } else {
                NativeArtifactPreview(kind: kind, content: content, mode: mode.displayMode, policy: .inline)
            }
        }
        .frame(minWidth: 480, minHeight: 360)
        // This *is* the window level for a detached window, which is the one
        // place a page paints the canvas itself.
        .junoReadingCanvas()
    }
}

// MARK: - Vocabulary

/// The product's words for an artifact, in one place.
///
/// The wire values are shouted enum names (`MARKDOWN`), and a window subtitle
/// full of capitals reads as an error code. These are the same nouns the web
/// Canvas uses so the two clients describe the same document the same way.
enum DesktopArtifactKindName {
    static func singular(_ kind: NativeArtifactKind) -> String {
        switch kind {
        case .html: "Page"
        case .react: "Component"
        case .code: "Code"
        case .markdown: "Document"
        case .svg: "Graphic"
        case .mermaid: "Diagram"
        case .design: "Design"
        case .spreadsheet: "Spreadsheet"
        case .document: "Document"
        case .presentation: "Deck"
        }
    }

    /// The filter chips' labels — a *category* of artifact, matching the web's
    /// `TYPE_LABELS`.
    ///
    /// Plurals of the singulars above rather than a straight copy of the web
    /// list: the web calls an HTML artifact a "Site" in its chips and a "Page"
    /// everywhere else, and both native clients already say "Page". Introducing a
    /// third noun for the same object here would be worse than the small
    /// divergence.
    static func plural(_ kind: NativeArtifactKind) -> String {
        switch kind {
        case .html: "Pages"
        case .react: "Components"
        case .code: "Code"
        case .markdown: "Documents"
        case .svg: "Graphics"
        case .mermaid: "Diagrams"
        case .design: "Designs"
        case .spreadsheet: "Spreadsheets"
        case .document: "Documents"
        case .presentation: "Decks"
        }
    }

    /// The web's `artifact-inline-card.tsx` ICONS map, in the website's marks.
    static func icon(_ kind: NativeArtifactKind) -> JunoIcon {
        switch kind {
        case .html: .web
        case .react: .code
        case .code: .fileCode
        case .markdown: .file
        case .svg: .image
        case .mermaid: .branch
        case .design: .design
        case .spreadsheet: .grid
        case .document: .file
        case .presentation: .squareStack
        }
    }

    static func origin(_ origin: NativeArtifactOrigin) -> String {
        switch origin {
        case .generated: "Generated"
        case .edit: "Edited"
        case .restore: "Restored"
        }
    }

    static func exportLabel(_ format: NativeArtifactExportFormat) -> String {
        switch format {
        case .docx: "Word Document (.docx)"
        case .xlsx: "Excel Workbook (.xlsx)"
        case .pptx: "PowerPoint Deck (.pptx)"
        }
    }

    /// The version number is part of the file name because the source of a *past*
    /// version is a different document from the current one, and a folder of
    /// same-named files is how that distinction gets lost.
    static func sourceFileName(
        title: String,
        kind: NativeArtifactKind,
        language: String?,
        version: Int
    ) -> String {
        let forbidden = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
        let cleaned = String(
            title.unicodeScalars.map { forbidden.contains($0) ? " " : Character($0) }
        )
        .trimmingCharacters(in: .whitespacesAndNewlines)
        let base = cleaned.isEmpty ? "artifact" : String(cleaned.prefix(80))
        return "\(base) v\(version).\(sourceExtension(kind: kind, language: language))"
    }

    private static func sourceExtension(kind: NativeArtifactKind, language: String?) -> String {
        switch kind {
        case .html: "html"
        case .react: "tsx"
        case .markdown: "md"
        case .svg: "svg"
        case .mermaid: "mmd"
        case .design: "juno.design.json"
        case .spreadsheet, .document, .presentation: "json"
        case .code: codeExtension(language)
        }
    }

    private static func codeExtension(_ language: String?) -> String {
        switch language?.lowercased() {
        case "swift": "swift"
        case "python", "py": "py"
        case "typescript", "ts": "ts"
        case "tsx": "tsx"
        case "javascript", "js": "js"
        case "jsx": "jsx"
        case "rust", "rs": "rs"
        case "go": "go"
        case "ruby", "rb": "rb"
        case "java": "java"
        case "kotlin", "kt": "kt"
        case "c": "c"
        case "cpp", "c++": "cpp"
        case "css": "css"
        case "json": "json"
        case "yaml", "yml": "yaml"
        case "sql": "sql"
        case "sh", "bash", "shell": "sh"
        default: "txt"
        }
    }
}

// MARK: - Excerpt

/// What an artifact's source looks like at tile size: the web's
/// `ArtifactPreview`. An SVG as a picture drawn by AppKit (no script, no
/// network); anything else as its first twenty lines, set as `<pre>` is on
/// the web in the micro rung under a fade.
///
/// **Never a live render.** A page of tiles each booting a web view is the
/// cost the web's own comment rules out for a list of two hundred, and an
/// excerpt is honest about being one. Shared by the Outputs popover and the
/// Artifacts grid, so the two draw one artifact the same way.
struct DesktopArtifactExcerpt: View {
    let source: String
    let kind: NativeArtifactKind
    /// The well behind the excerpt, which the fade dissolves into.
    var well: Color = Color.junoCanvas

    var body: some View {
        if kind == .svg, let image = Self.svgImage(source) {
            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .padding(JunoSpace.cozy)
        } else {
            Text(verbatim: Self.firstLines(source))
                .junoType(.micro)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: true, vertical: false)
                .padding(JunoSpace.cozy)
                // `minWidth: 0` holds the tile to its own width: the unwrapped
                // lines overflow to the right and are clipped, never centred.
                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
                .overlay(alignment: .bottom) {
                    // The clip, said out loud: the excerpt fades into the well
                    // rather than ending mid-glyph.
                    LinearGradient(colors: [well.opacity(0), well], startPoint: .top, endPoint: .bottom)
                        .frame(height: 48)
                }
                .clipped()
        }
    }

    static func firstLines(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false).prefix(20).joined(separator: "\n")
    }

    /// An SVG as a picture, drawn by AppKit: no script, no network. Nil
    /// for anything that is not a complete document.
    static func svgImage(_ source: String) -> NSImage? {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("<svg") || trimmed.hasPrefix("<?xml"), trimmed.hasSuffix("</svg>"),
            let data = trimmed.data(using: .utf8)
        else { return nil }
        return NSImage(data: data)
    }
}

// MARK: - Keyboard

extension View {
    /// A page object that opens on a click (a tile, a row with its own Pin
    /// and More inside it, so never wrapped in a Button): reachable with Full
    /// Keyboard Access, with the system's focus ring, and opened with Return,
    /// as the web's focusable link is.
    func desktopKeyboardOpen(_ open: @escaping () -> Void) -> some View {
        focusable(interactions: .activate)
            .onKeyPress(.return) {
                open()
                return .handled
            }
    }
}

