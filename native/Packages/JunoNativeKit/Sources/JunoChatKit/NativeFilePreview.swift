import CoreGraphics
import Foundation
import ImageIO
import JunoCore
import JunoDesignSystem
import Observation
import QuickLookThumbnailing
import SwiftUI

/// Turns a stored file into a thumbnail, once — and draws it.
///
/// One implementation for every surface that lists the account's files: the
/// Library on both platforms, and the "attach from Library" picker on both. Those
/// four had three different answers to "what does a file look like", and only one
/// of them showed the file. The picker in particular listed a row of `doc.text`
/// glyphs with the name beside it, which asks the reader to recognise a
/// screenshot by its filename — and nobody remembers `IMG_4821.HEIC`.
///
/// **Two rules, unchanged from the version this replaces.** Nothing is fetched
/// until its card is on screen, and nothing is fetched twice. Failures are
/// remembered as well, so a file the server cannot serve is attempted once rather
/// than on every appearance — a grid that re-downloaded on every scroll costs
/// real money on a metered connection.
///
/// **Why `CGImage`.** The previous loader produced `UIImage`, which is why it
/// could not move down here and the Mac could not use it. `CGImage` is what both
/// ImageIO and QuickLook hand back anyway, and SwiftUI draws it directly through
/// `Image(decorative:scale:)`.
@MainActor
@Observable
public final class NativeFilePreviewLoader {

    public enum State {
        case loading
        case ready(CGImage)
        /// No thumbnail can be drawn: the fetch failed, the bytes were not
        /// renderable, or the file is too large to be worth pulling.
        case unavailable
    }

    /// Documents are rendered by QuickLook, which needs the whole file on disk.
    /// Above this a card keeps its typed fallback rather than pulling tens of
    /// megabytes to draw a 300pt square.
    public static let documentByteLimit = 25 * 1_024 * 1_024

    /// The longest edge a thumbnail is decoded to. Comfortably above the largest
    /// tile either platform draws at 3× so a card is never soft, and far below
    /// the source so a 4000px photo is not held in memory to fill 150pt.
    public static let thumbnailPixelSize = 700

    private var cache: [String: State] = [:]

    public init() {}

    public func state(for id: String) -> State { cache[id] ?? .loading }

    /// - Parameter access: fetches the bytes. A closure rather than a client, so
    ///   a card never holds the model it came from and the two library models —
    ///   which resolve a file by different routes — can both feed this.
    public func load(
        _ file: NativeFilePreviewRequest,
        using access: () async -> NativeProjectFileAccess?
    ) async {
        guard cache[file.id] == nil else { return }
        cache[file.id] = .loading

        guard file.isImage || file.byteSize <= Self.documentByteLimit else {
            cache[file.id] = .unavailable
            return
        }
        guard let resolved = await access(), let data = await Self.bytes(of: resolved) else {
            cache[file.id] = .unavailable
            return
        }

        let image = file.isImage
            ? Self.thumbnail(from: data)
            : await Self.documentThumbnail(data, fileName: file.fileName)
        cache[file.id] = image.map(State.ready) ?? .unavailable
    }

    private static func bytes(of access: NativeProjectFileAccess) async -> Data? {
        switch access {
        case .downloaded(let data):
            return data
        case .remote(let url):
            // A signed storage URL: no bearer token, and no reason to route it
            // through the app's authenticated sender.
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                (response as? HTTPURLResponse)?.statusCode ?? 200 < 400
            else { return nil }
            return data
        }
    }

    /// Decoded straight to thumbnail size by ImageIO, never full size first. A
    /// grid of twenty 12-megapixel photographs decoded at full resolution is
    /// hundreds of megabytes, and the phone kills the app for it.
    static func thumbnail(from data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: thumbnailPixelSize,
            ] as CFDictionary
        )
    }

    /// A document's first page, drawn by QuickLook — the same thumbnail the Files
    /// app and the Finder draw, so a PDF looks like *that* PDF rather than like
    /// the idea of a PDF.
    private static func documentThumbnail(_ data: Data, fileName: String) async -> CGImage? {
        // The extension is what tells QuickLook which generator to use, so it is
        // carried over — stripped to letters and digits, because the name came
        // off the wire and is about to become a path.
        let fileExtension = URL(fileURLWithPath: fileName).pathExtension
            .filter { $0.isLetter || $0.isNumber }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
            "juno-thumb-\(UUID().uuidString)" + (fileExtension.isEmpty ? "" : ".\(fileExtension)")
        )
        guard (try? data.write(to: url, options: [.atomic])) != nil else { return nil }
        defer { try? FileManager.default.removeItem(at: url) }

        let request = QLThumbnailGenerator.Request(
            fileAt: url,
            size: CGSize(width: 600, height: 600),
            scale: 1,
            representationTypes: .thumbnail
        )
        let representation = try? await QLThumbnailGenerator.shared
            .generateBestRepresentation(for: request)
        return representation?.cgImage
    }
}

extension NativeFilePreviewLoader.State: Equatable {
    /// `CGImage` is a class, so two states are the same picture only when they
    /// are the same object — which is exactly what the cache guarantees.
    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.loading, .loading), (.unavailable, .unavailable): true
        case (.ready(let left), .ready(let right)): left === right
        default: false
        }
    }
}

/// The four facts a thumbnail needs about a file.
///
/// A small struct rather than the concrete row type, because the Library screens
/// and the pickers list the same files through two different models
/// (``NativeProjectFile`` and ``NativeLibraryItem``) and neither should have to
/// know about the other.
public struct NativeFilePreviewRequest: Equatable, Sendable, Identifiable {
    public let id: String
    public let fileName: String
    public let isImage: Bool
    public let byteSize: Int

    public init(id: String, fileName: String, isImage: Bool, byteSize: Int) {
        self.id = id
        self.fileName = fileName
        self.isImage = isImage
        self.byteSize = byteSize
    }

    public var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(byteSize), countStyle: .file)
    }

    public init(_ item: NativeLibraryItem) {
        self.init(
            id: item.id,
            fileName: item.fileName,
            isImage: item.isImage,
            byteSize: item.size
        )
    }

    public init(_ file: NativeProjectFile) {
        self.init(
            id: file.id,
            fileName: file.fileName,
            isImage: file.kind.uppercased() == "IMAGE",
            byteSize: file.size
        )
    }
}

/// One file as a square card: the picture where there is one, and the file's own
/// type, name and size where there is not.
///
/// The fallback is deliberately still a *card* rather than a blank tile — a file
/// whose preview cannot be drawn is still a file, and the grid should not develop
/// holes in it.
public struct NativeFilePreviewTile: View {
    private let file: NativeFilePreviewRequest
    private let state: NativeFilePreviewLoader.State
    private let cornerRadius: CGFloat

    public init(
        file: NativeFilePreviewRequest,
        state: NativeFilePreviewLoader.State,
        cornerRadius: CGFloat
    ) {
        self.file = file
        self.state = state
        self.cornerRadius = cornerRadius
    }

    public var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { surface }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Color.junoHairline, lineWidth: 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    @ViewBuilder
    private var surface: some View {
        switch state {
        case .ready(let image):
            Image(decorative: image, scale: 1)
                .resizable()
                .scaledToFill()
                // A photo is recognised by its middle; a document is recognised
                // by its first lines. Cropping a page to its centre shows a
                // paragraph from nowhere.
                .frame(
                    maxWidth: .infinity,
                    maxHeight: .infinity,
                    alignment: file.isImage ? .center : .top
                )
                .transition(.opacity)
        case .loading:
            // No spinner. Most previews land in a few hundred milliseconds, and a
            // grid of spinners reads as the screen being broken.
            Color.junoSurface
        case .unavailable:
            fallback
        }
    }

    private var fallback: some View {
        VStack(alignment: .leading, spacing: 8) {
            JunoIconView(systemImage: file.isImage ? "photo" : "doc.text")
                .junoFont(size: 26, relativeTo: .body)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text(file.fileName)
                .junoFont(size: 14, relativeTo: .body, weight: .medium)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .truncationMode(.middle)
            Text(file.sizeLabel)
                .junoFont(size: 11, relativeTo: .body, weight: .medium, design: .monospaced)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.junoSurface)
    }
}

/// A card presses in slightly, as a photo in a grid should. No wash: a tint over
/// a picture changes the picture.
public struct NativeFilePreviewPressStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(JunoMotion.fast, value: configuration.isPressed)
    }
}
