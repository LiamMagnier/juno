import Foundation
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// A file that travels with a message: a photo the reader attached to a
/// question, or the picture Juno generated as its answer.
///
/// Carried on ``NativeChatMessage`` rather than looked up at render time,
/// because the transcript is the one place the join is always needed and a row
/// that has to ask a second store for its own pictures is a row that flickers.
/// The server keeps attachments as their own sync entity with a `messageId`;
/// ``NativeConversationStore`` joins them here when it loads the snapshot.
public struct NativeChatAttachment: Identifiable, Equatable, Sendable, Hashable {
    public let id: String
    public let fileName: String
    public let mimeType: String
    /// `IMAGE` or `FILE`, as the server classifies it.
    public let kind: String
    public let size: Int
    public let width: Int?
    public let height: Int?
    /// Where the bytes are: the stable, authenticated `/api/files/<key>` path
    /// the server's `getViewUrl` hands out, and nothing else — a signed or
    /// absolute URL is dropped on the way in (``NativeAttachmentFilePath``).
    /// Nil on a row synced before the path was kept, which then resolves its
    /// file through the entity lookup instead.
    public let url: String?
    /// How far the server's indexer has read the file (`parserState`), when
    /// it says.
    public let parserState: String?

    public init(
        id: String, fileName: String, mimeType: String, kind: String, size: Int,
        width: Int?, height: Int?, url: String? = nil, parserState: String? = nil
    ) {
        self.id = id
        self.fileName = fileName
        self.mimeType = mimeType
        self.kind = kind
        self.size = size
        self.width = width
        self.height = height
        self.url = NativeAttachmentFilePath.stable(url)
        self.parserState = parserState
    }

    public var isImage: Bool { kind == "IMAGE" || mimeType.hasPrefix("image/") }
    public var isVideo: Bool { mimeType.hasPrefix("video/") }

    /// The server classified it as a picture — the web's `kind === "IMAGE"`,
    /// which is what decides between an image tile and a file tile. A picture
    /// stored as a FILE is drawn as a document, as it is on the web.
    public var isImageKind: Bool { kind.uppercased() == "IMAGE" }

    /// Width over height, when the server measured the picture — used to lay
    /// out a placeholder the right shape before the bytes arrive.
    public var aspectRatio: CGFloat? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return CGFloat(width) / CGFloat(height)
    }

    // MARK: What the file is, in a reader's words

    /// The extension, lowercased, or "" for a name that has none — the web's
    /// `fileExtension` (`lib/documents/viewer-kind.ts`).
    public var fileExtension: String {
        guard let dot = fileName.lastIndex(of: "."),
            dot > fileName.startIndex,
            fileName.index(after: dot) < fileName.endIndex
        else { return "" }
        return String(fileName[fileName.index(after: dot)...]).lowercased()
    }

    /// The name without its extension — the tile's first caption line.
    public var stem: String {
        let ext = fileExtension
        guard !ext.isEmpty else { return fileName }
        let stem = String(fileName.dropLast(ext.count + 1))
        return stem.isEmpty ? fileName : stem
    }

    /// The extension as a tile prints it when there is nothing else to draw:
    /// the web's `extensionOf` (`components/chat/file-preview.tsx`) — up to five
    /// letters and digits, uppercased, or a short subtype of the MIME type for
    /// a name that has none.
    public var extensionBadge: String {
        let raw = fileExtension
        if !raw.isEmpty, raw.count <= 5, raw.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) {
            return raw.uppercased()
        }
        let subtype = mimeType.split(separator: "/", maxSplits: 1).dropFirst().first.map(String.init) ?? mimeType
        let head = subtype.split(whereSeparator: { ".+;".contains($0) }).first.map(String.init) ?? ""
        return head.isEmpty ? "FILE" : String(head.prefix(5)).uppercased()
    }

    /// Which viewer the web would open this in (`viewerKindOf`). The extension
    /// leads and the MIME type follows, because senders label files badly and
    /// the name is the evidence that survives a wrong label.
    public var viewerKind: NativeAttachmentViewerKind {
        let ext = fileExtension
        let mime = mimeType.lowercased().split(separator: ";").first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        if isImageKind { return .image }
        if ext == "pdf" || mime == "application/pdf" { return .pdf }
        if Self.officeExtensions.contains(ext) { return .document }
        if Self.textExtensions.contains(ext) { return .text }
        if mime.hasPrefix("video/") { return .video }
        if mime.hasPrefix("audio/") { return .audio }
        if Self.officeMIMEPrefixes.contains(where: { mime.hasPrefix($0) }) { return .document }
        if mime.hasPrefix("text/") || Self.textMIMETypes.contains(mime) { return .text }
        if ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(mime) { return .image }
        return .unsupported
    }

    /// What the file is called in a caption: "PDF", "Excel workbook",
    /// "PowerPoint deck", "Markdown" — the web's `formatLabelOf`, word for word.
    public var formatLabel: String {
        let ext = fileExtension
        switch viewerKind {
        case .pdf: return "PDF"
        case .image: return "Image"
        case .video: return "Video"
        case .audio: return "Audio"
        case .document:
            switch ext {
            case "docx", "docm": return "Word document"
            case "pptx", "pptm": return "PowerPoint deck"
            case "xlsx", "xlsm": return "Excel workbook"
            case "odt", "fodt": return "OpenDocument text"
            case "ods": return "OpenDocument spreadsheet"
            case "odp": return "OpenDocument presentation"
            case "rtf": return "Rich text"
            default: return "Document"
            }
        case .text:
            switch ext {
            case "md", "markdown", "mdx": return "Markdown"
            case "csv": return "CSV"
            case "tsv": return "TSV"
            case "txt", "text", "log", "": return "Text"
            default: return ext.uppercased()
            }
        case .unsupported:
            return ext.isEmpty ? "File" : ext.uppercased()
        }
    }

    /// The size as the web prints it: `formatBytes` — base 1024, one decimal,
    /// a trailing ".0" dropped. 248000 → "242.2 KB", 90112 → "88 KB".
    public var byteLabel: String { Self.byteLabel(size) }

    /// "Excel workbook · 88 KB": a tile's second caption line. The size is
    /// left off when the server never recorded one, as the web leaves it off.
    public var captionMeta: String {
        size > 0 ? "\(formatLabel) · \(byteLabel)" : formatLabel
    }

    /// `formatBytes(bytes, 1)`, ported: `parseFloat((bytes / 1024^i).toFixed(1))`.
    public static func byteLabel(_ bytes: Int) -> String {
        guard bytes > 0 else { return "0 B" }
        let units = ["B", "KB", "MB", "GB"]
        let exponent = min(units.count - 1, Int(floor(log(Double(bytes)) / log(1024))))
        let scaled = Double(bytes) / pow(1024, Double(exponent))
        // `toFixed(1)` then `parseFloat`: one place, then no trailing ".0".
        let rounded = (scaled * 10).rounded(.toNearestOrAwayFromZero) / 10
        let text = rounded == rounded.rounded()
            ? String(Int(rounded))
            : String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), rounded)
        return "\(text) \(units[exponent])"
    }

    private static let officeExtensions: Set<String> = [
        "docx", "docm", "pptx", "pptm", "xlsx", "xlsm", "odt", "ods", "odp", "fodt", "rtf",
    ]

    private static let officeMIMEPrefixes = [
        "application/vnd.openxmlformats-officedocument.",
        "application/vnd.ms-word.",
        "application/vnd.ms-excel.",
        "application/vnd.ms-powerpoint.",
        "application/vnd.oasis.opendocument.",
        "application/rtf",
        "text/rtf",
    ]

    private static let textExtensions: Set<String> = [
        "txt", "text", "log", "md", "markdown", "mdx", "csv", "tsv", "json", "jsonc",
        "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
        "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
        "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql",
        "css", "scss", "less", "gradle", "graphql", "proto", "tex", "r", "lua", "dart",
        "scala", "pl", "vue", "svelte",
    ]

    private static let textMIMETypes: Set<String> = [
        "application/json", "application/xml", "application/javascript",
        "application/typescript", "application/x-yaml", "application/yaml",
        "application/sql", "application/toml",
    ]
}

/// The web's `ViewerKind` (`lib/documents/viewer-kind.ts`): which viewer a file
/// opens in, and so what a caption calls it.
public enum NativeAttachmentViewerKind: String, Equatable, Sendable {
    /// Drawn page by page.
    case pdf
    case image
    /// The file's own characters: prose, data, source.
    case text
    /// An office document: Word, PowerPoint, Excel, OpenDocument, RTF.
    case document
    case video
    case audio
    /// Nothing to show beyond its name.
    case unsupported
}

/// Fetches and caches the bytes of images in the transcript.
///
/// Images live behind the authenticated `/api/attachments/{id}` route, which
/// `AsyncImage` cannot reach: it has no way to carry a bearer. So the bytes are
/// fetched through the same transport as everything else and kept in memory,
/// keyed by attachment id, for as long as the screen lives. A failed fetch is
/// remembered too, so a broken image does not retry on every scroll.
@MainActor
@Observable
public final class NativeChatImageLoader {
    public enum State: Equatable, Sendable {
        case loading
        case loaded(Data)
        case failed
    }

    /// Bounded so a very long transcript full of pictures cannot grow without
    /// limit. Evicted oldest-first.
    public static let capacity = 60

    private var cache: [String: State] = [:]
    private var order: [String] = []
    private var inFlight: Set<String> = []
    private let sender: (any NativeAuthenticatedRequestSending)?
    private let accountID: AccountID?

    public init(sender: (any NativeAuthenticatedRequestSending)?, accountID: AccountID?) {
        self.sender = sender
        self.accountID = accountID
    }

    public func state(for id: String) -> State { cache[id] ?? .loading }

    /// Starts a fetch when nothing is cached or in flight. Safe to call from a
    /// row's `task`: a second call for the same id is a no-op.
    public func load(_ id: String) async {
        guard cache[id] == nil, !inFlight.contains(id) else { return }
        guard let sender, let accountID else {
            store(.failed, for: id)
            return
        }
        inFlight.insert(id)
        defer { inFlight.remove(id) }
        do {
            let response = try await sender.send(
                try NativeBearerRequest(path: "/api/attachments/\(id)"),
                for: accountID
            )
            guard (200...299).contains(response.statusCode), !response.body.isEmpty else {
                store(.failed, for: id)
                return
            }
            store(.loaded(response.body), for: id)
        } catch {
            store(.failed, for: id)
        }
    }

    /// Lets a caller that already has the bytes — a just-uploaded photo — seed
    /// the cache so the row never shows a placeholder for a picture the phone
    /// took a second ago.
    public func seed(_ data: Data, for id: String) {
        store(.loaded(data), for: id)
    }

    private func store(_ state: State, for id: String) {
        if cache[id] == nil { order.append(id) }
        cache[id] = state
        while order.count > Self.capacity, let oldest = order.first {
            order.removeFirst()
            cache[oldest] = nil
        }
    }
}
