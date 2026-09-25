import CoreGraphics
import Foundation
import ImageIO
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation
import PDFKit
import QuickLookThumbnailing

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

// MARK: - What the transcript asks for

/// A picture in the transcript, as far as it has got.
public enum NativeTranscriptImageState: Equatable, Sendable {
    /// Nothing to draw yet: the frame holds its place.
    case loading
    /// Decoded, and downsampled to a size the transcript can draw.
    case ready(CGImage)
    /// The bytes could not be had or could not be decoded. Remembered, so a
    /// broken picture is asked for once rather than on every scroll.
    case failed

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.loading, .loading), (.failed, .failed): true
        // `CGImage` is a class: two states are the same picture only when
        // they hold the same object, which is what the cache guarantees.
        case (.ready(let left), .ready(let right)): left === right
        default: false
        }
    }
}

/// What a file tile can draw on its page: a picture of the first page, or
/// the opening lines — the web's `FilePreview` ladder. Both nil means the tile
/// prints its extension, which is what it would show anyway.
public struct NativeTranscriptFilePreview: Equatable, Sendable {
    public var thumbnail: CGImage?
    public var excerpt: String?

    public init(thumbnail: CGImage? = nil, excerpt: String? = nil) {
        self.thumbnail = thumbnail
        self.excerpt = excerpt
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.thumbnail === rhs.thumbnail && lhs.excerpt == rhs.excerpt
    }
}

/// A file tile's page, as far as it has got.
public enum NativeTranscriptPreviewState: Equatable, Sendable {
    case loading
    /// Settled. A failed preview is not an error state — it is an empty one,
    /// and the tile shows its extension (the web caches the same `EMPTY`).
    case ready(NativeTranscriptFilePreview)
}

/// Why a file could not be put on disk.
public enum NativeTranscriptFileError: Error, Equatable, LocalizedError, Sendable {
    /// Over the transport's response ceiling, so it cannot be fetched whole.
    case tooLarge(maximumBytes: Int)
    /// The server would not hand it over, or it is gone.
    case unavailable
    /// No signed-in account to ask with.
    case signedOut

    public var errorDescription: String? {
        switch self {
        case .tooLarge(let maximumBytes):
            "This file is larger than \(maximumBytes / 1_048_576) MB, so Juno can’t open it here."
        case .unavailable:
            "Juno couldn’t download this file. Try again in a moment."
        case .signedOut:
            "Sign in to open this file."
        }
    }
}

/// What the transcript's media views read their pictures, pages and files
/// from.
///
/// A protocol so the offscreen snapshot harness can stand in deterministic
/// pictures for the network: ``NativeChatMediaLoader`` is the real one, and
/// the harness's `SnapshotMediaProvider` answers from drawn stills. Views ask
/// for a state and start a load from their `task`; a provider that is
/// `@Observable` redraws them when the state moves.
@MainActor
public protocol TranscriptMediaProviding: AnyObject, Sendable {
    /// A sent photo or a generated picture.
    func imageState(for attachment: NativeChatAttachment) -> NativeTranscriptImageState
    /// Starts the picture's fetch and decode. A second call is a no-op.
    func loadImage(_ attachment: NativeChatAttachment) async
    /// A file tile's page: its first page, or its opening lines.
    func previewState(for attachment: NativeChatAttachment) -> NativeTranscriptPreviewState
    /// Starts the tile's preview. A second call is a no-op.
    func loadPreview(_ attachment: NativeChatAttachment) async
    /// The file on disk — for Quick Look, Save As, Open With and a video's
    /// player. Downloaded once and kept for the session's account.
    func fileURL(for attachment: NativeChatAttachment) async throws -> URL
    /// Bytes this device already has for a picture it just uploaded, so the
    /// sent turn never shows a placeholder for a photo taken a second ago.
    func seed(_ data: Data, for attachmentID: String)
}

// MARK: - The loader

/// Fetches, decodes and caches everything the transcript draws from a file:
/// the pictures people send and Juno generates, the pages of the documents on
/// either side, and the files themselves when a reader opens one.
///
/// **Three routes, all authenticated.** Pictures come through
/// `GET /api/attachments/{id}` (``NativeChatImageLoader``, images only). A
/// tile's page comes through `GET /api/attachments/{id}/preview` — a bounded
/// excerpt and the address of a rendered first page — and
/// `GET /api/attachments/{id}/thumbnail`. A whole file comes through the
/// stable `GET /api/files/<key>` path the attachment carries, falling back to
/// the entity lookup for a row synced before that path was kept.
///
/// **Decoding is off the main thread and downsampled.** A generated picture is
/// 1024–2048px and a phone photo 4000px; the transcript draws them at 320pt
/// and 144pt. ImageIO decodes straight to ``imagePixelSize``, so a long
/// transcript of pictures costs thumbnails, not originals.
///
/// **Where the page picture comes from.** The server's rendered first page
/// when it has one; otherwise, for a PDF, PDFKit draws page one from the file;
/// for a picture stored as a file, ImageIO does; and for an Office or iWork
/// document QuickLook does — the same thumbnail Finder draws, which is more
/// than the web shows (it stops at the excerpt). Each of these reads the whole
/// file, so only files up to ``thumbnailByteLimit`` are worth it.
///
/// **Files live in the Caches directory**, per account and attachment, and
/// are removed on sign-out (``purgeCachedFiles()``). Anything the system
/// evicts is simply fetched again.
@MainActor
@Observable
public final class NativeChatMediaLoader: TranscriptMediaProviding {
    /// The transport's response ceiling (`HTTPMessageLimits.standard`), which
    /// is also the upload ceiling: every file a message can carry fits.
    public nonisolated static let fileByteLimit = HTTPMessageLimits.standard.maximumResponseBodyBytes
    /// A local page picture reads the whole file, so above this a tile keeps
    /// its excerpt or extension rather than pulling tens of megabytes to draw
    /// 116 points of page. The Library's own ceiling for the same work
    /// (`NativeFilePreviewLoader.documentByteLimit`).
    public nonisolated static let thumbnailByteLimit = 25 * 1_024 * 1_024
    /// The longest edge a picture is decoded to: a 320pt frame at 2× with
    /// room to spare, and far below a phone photo.
    public nonisolated static let imagePixelSize = 1_024
    /// The longest edge of a page picture: a 116pt page at 2× and then some.
    public nonisolated static let pagePixelSize = 480
    /// Pictures kept decoded at once. Evicted oldest-first; a row scrolled
    /// back into view asks again.
    public static let imageCapacity = 60
    /// Page pictures kept at once.
    public static let previewCapacity = 120

    public let accountID: AccountID?

    @ObservationIgnored private let sender: (any NativeAuthenticatedRequestSending)?
    @ObservationIgnored private let images: NativeChatImageLoader
    @ObservationIgnored private let cacheRoot: URL?

    private var imageStates: [String: NativeTranscriptImageState] = [:]
    private var previewStates: [String: NativeTranscriptPreviewState] = [:]

    @ObservationIgnored private var imageOrder: [String] = []
    @ObservationIgnored private var previewOrder: [String] = []
    @ObservationIgnored private var imageLoads: Set<String> = []
    @ObservationIgnored private var previewLoads: Set<String> = []
    @ObservationIgnored private var files: [String: URL] = [:]
    @ObservationIgnored private var fileTasks: [String: Task<URL, any Error>] = [:]
    /// Files the server refused or that are too large: remembered, so the same
    /// answer is not fetched twice. A network failure is not remembered.
    @ObservationIgnored private var fileFailures: [String: NativeTranscriptFileError] = [:]

    public init(
        sender: (any NativeAuthenticatedRequestSending)?,
        accountID: AccountID?,
        cacheRoot: URL? = NativeChatMediaLoader.defaultCacheRoot
    ) {
        self.sender = sender
        self.accountID = accountID
        self.images = NativeChatImageLoader(sender: sender, accountID: accountID)
        self.cacheRoot = cacheRoot
    }

    /// `~/Library/Caches/<bundle id>/TranscriptFiles`.
    public nonisolated static var defaultCacheRoot: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "Juno", isDirectory: true)
            .appendingPathComponent("TranscriptFiles", isDirectory: true)
    }

    /// Removes every file the transcript downloaded, for every account. Called
    /// on sign-out: another person's documents must not wait on disk for the
    /// next one.
    public nonisolated static func purgeCachedFiles(at root: URL? = defaultCacheRoot) {
        guard let root else { return }
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: Pictures

    public func imageState(for attachment: NativeChatAttachment) -> NativeTranscriptImageState {
        imageStates[attachment.id] ?? .loading
    }

    public func loadImage(_ attachment: NativeChatAttachment) async {
        let id = attachment.id
        guard imageStates[id] == nil, !imageLoads.contains(id) else { return }
        imageLoads.insert(id)
        defer { imageLoads.remove(id) }

        let data: Data?
        if attachment.isImageKind {
            await images.load(id)
            if case .loaded(let bytes) = images.state(for: id) { data = bytes } else { data = nil }
        } else if let url = try? await fileURL(for: attachment) {
            // A picture stored as a file: the image route refuses anything
            // that is not IMAGE, so it is read from the downloaded file.
            data = await Task.detached(priority: .userInitiated) { try? Data(contentsOf: url) }.value
        } else {
            data = nil
        }
        guard let data else {
            storeImage(.failed, for: id)
            return
        }
        let decoded = await Task.detached(priority: .userInitiated) {
            Self.downsample(data, maxPixelSize: Self.imagePixelSize)
        }.value
        storeImage(decoded.map(NativeTranscriptImageState.ready) ?? .failed, for: id)
    }

    public func seed(_ data: Data, for attachmentID: String) {
        guard !data.isEmpty else { return }
        images.seed(data, for: attachmentID)
        // A failure recorded before the bytes arrived no longer holds.
        if imageStates[attachmentID] == .failed { imageStates[attachmentID] = nil }
    }

    private func storeImage(_ state: NativeTranscriptImageState, for id: String) {
        if imageStates[id] == nil { imageOrder.append(id) }
        imageStates[id] = state
        while imageOrder.count > Self.imageCapacity, let oldest = imageOrder.first {
            imageOrder.removeFirst()
            imageStates[oldest] = nil
        }
    }

    // MARK: Pages

    public func previewState(for attachment: NativeChatAttachment) -> NativeTranscriptPreviewState {
        previewStates[attachment.id] ?? .loading
    }

    public func loadPreview(_ attachment: NativeChatAttachment) async {
        let id = attachment.id
        guard previewStates[id] == nil, !previewLoads.contains(id) else { return }
        previewLoads.insert(id)
        defer { previewLoads.remove(id) }

        var preview = NativeTranscriptFilePreview()
        let answer = await previewAnswer(for: attachment)
        preview.excerpt = answer?.excerpt
        // The excerpt paints first and the page covers it once it arrives —
        // the web's ladder — so a tile shows words while a page is drawn.
        if preview.excerpt != nil { storePreview(.ready(preview), for: id) }

        if let path = answer?.thumbnailPath {
            preview.thumbnail = await serverThumbnail(path)
        }
        if preview.thumbnail == nil, let kind = Self.localThumbnailKind(for: attachment),
            let url = try? await fileURL(for: attachment)
        {
            preview.thumbnail = await Self.localThumbnail(kind, at: url)
        }
        storePreview(.ready(preview), for: id)
    }

    private func storePreview(_ state: NativeTranscriptPreviewState, for id: String) {
        if previewStates[id] == nil { previewOrder.append(id) }
        previewStates[id] = state
        while previewOrder.count > Self.previewCapacity, let oldest = previewOrder.first {
            previewOrder.removeFirst()
            previewStates[oldest] = nil
        }
    }

    /// `GET /api/attachments/{id}/preview`: `{text, previewable, thumbnailUrl,
    /// truncated}`. Nil on any failure, which draws the extension.
    private func previewAnswer(
        for attachment: NativeChatAttachment
    ) async -> (excerpt: String?, thumbnailPath: String?)? {
        guard let sender, let accountID, Self.isSafeIdentifier(attachment.id),
            let request = try? NativeBearerRequest(
                path: "/api/attachments/\(attachment.id)/preview",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            let response = try? await sender.send(request, for: accountID),
            (200...299).contains(response.statusCode),
            let body = try? JSONDecoder().decode(PreviewWire.self, from: response.body)
        else { return nil }
        let text = body.text.flatMap {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : String($0.prefix(900))
        }
        // Only the route this client knows, for this attachment: a preview
        // body is data, not a place to be sent.
        let thumbnail = body.thumbnailUrl.flatMap {
            $0 == "/api/attachments/\(attachment.id)/thumbnail" ? $0 : nil
        }
        return (text, thumbnail)
    }

    /// The server's rendering of the first page: a bounded JPEG.
    private func serverThumbnail(_ path: String) async -> CGImage? {
        guard let sender, let accountID,
            let request = try? NativeBearerRequest(
                path: path,
                headers: try HTTPHeaders(["accept": "image/*"])
            ),
            let response = try? await sender.send(request, for: accountID),
            (200...299).contains(response.statusCode), !response.body.isEmpty
        else { return nil }
        let body = response.body
        return await Task.detached(priority: .utility) {
            Self.downsample(body, maxPixelSize: Self.pagePixelSize)
        }.value
    }

    // MARK: Files

    public func fileURL(for attachment: NativeChatAttachment) async throws -> URL {
        let id = attachment.id
        if let failure = fileFailures[id] { throw failure }
        if let known = files[id], FileManager.default.fileExists(atPath: known.path) { return known }
        guard attachment.size <= Self.fileByteLimit else {
            fileFailures[id] = .tooLarge(maximumBytes: Self.fileByteLimit)
            throw NativeTranscriptFileError.tooLarge(maximumBytes: Self.fileByteLimit)
        }
        if let running = fileTasks[id] { return try await running.value }

        let destination = cacheFile(for: attachment)
        if let destination, FileManager.default.fileExists(atPath: destination.path) {
            files[id] = destination
            return destination
        }
        let task = Task { @MainActor [weak self] () throws -> URL in
            guard let self else { throw NativeTranscriptFileError.unavailable }
            return try await self.download(attachment, to: destination)
        }
        fileTasks[id] = task
        defer { fileTasks[id] = nil }
        do {
            let url = try await task.value
            files[id] = url
            return url
        } catch let failure as NativeTranscriptFileError {
            if failure != .signedOut { fileFailures[id] = failure }
            throw failure
        } catch HTTPValidationError.responseBodyTooLarge(let maximum) {
            fileFailures[id] = .tooLarge(maximumBytes: maximum)
            throw NativeTranscriptFileError.tooLarge(maximumBytes: maximum)
        } catch URLSessionTransportError.responseBodyTooLarge(let maximum) {
            fileFailures[id] = .tooLarge(maximumBytes: maximum)
            throw NativeTranscriptFileError.tooLarge(maximumBytes: maximum)
        }
    }

    private func download(_ attachment: NativeChatAttachment, to destination: URL?) async throws -> URL {
        guard let sender, let accountID else { throw NativeTranscriptFileError.signedOut }
        let data: Data
        if let path = attachment.url {
            let response = try await sender.send(
                try NativeBearerRequest(path: path, headers: try HTTPHeaders(["accept": "*/*"])),
                for: accountID
            )
            switch response.statusCode {
            case 200...299 where !response.body.isEmpty: data = response.body
            case 401, 403, 404, 410: throw NativeTranscriptFileError.unavailable
            default: throw URLError(.badServerResponse)
            }
        } else {
            // A row synced before the path was kept: the entity lookup
            // resolves a fresh one (`NativeProjectAPIClient.accessFile`).
            switch try await NativeProjectAPIClient(sender: sender).accessFile(id: attachment.id, for: accountID) {
            case .downloaded(let bytes):
                data = bytes
            case .remote(let url):
                let (bytes, response) = try await URLSession.shared.data(from: url)
                guard ((response as? HTTPURLResponse)?.statusCode ?? 200) < 400 else {
                    throw NativeTranscriptFileError.unavailable
                }
                data = bytes
            }
        }
        guard !data.isEmpty else { throw NativeTranscriptFileError.unavailable }
        guard data.count <= Self.fileByteLimit else {
            throw NativeTranscriptFileError.tooLarge(maximumBytes: Self.fileByteLimit)
        }
        let target = destination ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent(Self.sanitisedFileName(attachment.fileName))
        try await Task.detached(priority: .userInitiated) {
            try FileManager.default.createDirectory(
                at: target.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try data.write(to: target, options: [.atomic])
        }.value
        return target
    }

    /// `<root>/<account>/<attachment>/<name>`: the attachment id keeps two
    /// files with one name apart, and the name is what Quick Look, Save As and
    /// the Finder show.
    private func cacheFile(for attachment: NativeChatAttachment) -> URL? {
        guard let cacheRoot, let accountID,
            Self.isSafeIdentifier(accountID.rawValue), Self.isSafeIdentifier(attachment.id)
        else { return nil }
        return cacheRoot
            .appendingPathComponent(accountID.rawValue, isDirectory: true)
            .appendingPathComponent(attachment.id, isDirectory: true)
            .appendingPathComponent(Self.sanitisedFileName(attachment.fileName))
    }

    // MARK: Helpers

    /// A name that came off the wire, made safe to be a path component: no
    /// separators, no control characters, no leading dot, at most 120
    /// characters with its extension kept.
    nonisolated static func sanitisedFileName(_ name: String) -> String {
        let forbidden = CharacterSet(charactersIn: "/\\:").union(.controlCharacters)
        var cleaned = String(String.UnicodeScalarView(
            name.unicodeScalars.map { forbidden.contains($0) ? "-" : $0 }
        )).trimmingCharacters(in: .whitespacesAndNewlines)
        while cleaned.hasPrefix(".") { cleaned.removeFirst() }
        if cleaned.count > 120 {
            let ext = (cleaned as NSString).pathExtension
            let keep = 120 - (ext.isEmpty ? 0 : ext.count + 1)
            cleaned = String(cleaned.prefix(keep)) + (ext.isEmpty ? "" : ".\(ext)")
        }
        return cleaned.isEmpty ? "file" : cleaned
    }

    nonisolated static func isSafeIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 128
            && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Decoded straight to `maxPixelSize` by ImageIO, never full size first.
    nonisolated static func downsample(_ data: Data, maxPixelSize: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            ] as CFDictionary
        )
    }

    public enum LocalThumbnail: Equatable, Sendable {
        case pdf, image, quickLook
    }

    /// Which local renderer can draw this file's first page, if any is worth
    /// reading the whole file for.
    public nonisolated static func localThumbnailKind(for attachment: NativeChatAttachment) -> LocalThumbnail? {
        guard attachment.size <= thumbnailByteLimit else { return nil }
        switch attachment.viewerKind {
        case .pdf: return .pdf
        case .image: return .image
        case .document: return .quickLook
        default:
            // iWork files have no web viewer kind, and QuickLook draws them.
            return ["pages", "numbers", "key"].contains(attachment.fileExtension) ? .quickLook : nil
        }
    }

    public nonisolated static func localThumbnail(_ kind: LocalThumbnail, at url: URL) async -> CGImage? {
        switch kind {
        case .image:
            return await Task.detached(priority: .utility) {
                guard let data = try? Data(contentsOf: url) else { return nil }
                return downsample(data, maxPixelSize: pagePixelSize)
            }.value
        case .pdf:
            return await Task.detached(priority: .utility) { pdfFirstPage(at: url) }.value
        case .quickLook:
            // 288×192 at 2×: the size the brief sets for a document's page.
            let request = QLThumbnailGenerator.Request(
                fileAt: url,
                size: CGSize(width: 288, height: 192),
                scale: 2,
                representationTypes: .thumbnail
            )
            let representation = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request)
            return representation?.cgImage
        }
    }

    /// Page one of a PDF, drawn by PDFKit at ``pagePixelSize`` wide.
    nonisolated static func pdfFirstPage(at url: URL) -> CGImage? {
        guard let document = PDFDocument(url: url), let page = document.page(at: 0) else { return nil }
        let bounds = page.bounds(for: .cropBox)
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let scale = CGFloat(pagePixelSize) / bounds.width
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        let thumbnail = page.thumbnail(of: size, for: .cropBox)
        #if canImport(AppKit)
        return thumbnail.cgImage(forProposedRect: nil, context: nil, hints: nil)
        #else
        return thumbnail.cgImage
        #endif
    }
}

private struct PreviewWire: Decodable {
    let text: String?
    let thumbnailUrl: String?
}
