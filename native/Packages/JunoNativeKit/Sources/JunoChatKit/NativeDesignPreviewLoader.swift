import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// Where a Juno Design document's picture stands.
public enum NativeDesignPreviewState: Equatable, Sendable {
    case loading
    /// The server's SVG of the document's first page.
    case ready(svg: String)
    /// The server could not draw it — a missing Library asset (422
    /// `MISSING_ASSET`) or an export failure (5xx) — or the answer was not an
    /// SVG. Remembered: asking again draws the same failure.
    case unavailable
    /// The request never completed. Not remembered, so the next appearance
    /// tries again.
    case failed
}

/// What the transcript's design preview reads from: the loader, or the
/// snapshot harness's stand-in.
@MainActor
public protocol DesignPreviewProviding: AnyObject {
    func designPreviewState(artifactID: String, version: Int) -> NativeDesignPreviewState
    /// Starts the fetch. A second call for the same version is a no-op, except
    /// that the current version (`isCurrent`) is revalidated once per loader.
    func loadDesignPreview(artifactID: String, version: Int, isCurrent: Bool) async
}

public extension DesignPreviewProviding {
    /// A sealed version: one that a later version has superseded.
    func loadDesignPreview(artifactID: String, version: Int) async {
        await loadDesignPreview(artifactID: artifactID, version: version, isCurrent: false)
    }
}

/// Fetches and caches the picture of a Juno Design document: the server's
/// **poster** first, `GET /api/artifacts/{id}/poster?v={n}&r=1` — the web's
/// `designPosterUrl` — and the SVG export (`GET /api/design/{id}/export
/// ?format=svg`) when there is no poster to be had.
///
/// One loader draws every place a design shows as a picture: the transcript's
/// card, the canvas dock's older versions, and the Artifacts page's tiles and
/// rows (Phase 4 A3). Pictures are kept in memory and at
/// `~/Library/Caches/<bundle>/DesignPreviews/<account>/`:
/// `<id>-v<n>-r1.svg` for a poster (with its `ETag` beside it in
/// `<id>-v<n>-r1.etag`), `<id>-v<n>.svg` for an export.
///
/// **Caching follows the route's.** A version a later one has superseded can
/// never change, so it is read from the cache forever. The current version can
/// (design edits fold into it, `poster/route.ts` "CACHING"), so the first load
/// of it in a loader's life asks again with `If-None-Match`, and a 304 keeps
/// the cached picture.
///
/// **Falling back.** A poster 404 with a JSON body is the route answering "not
/// a readable design of yours": the export is tried once for that version, and
/// its outcome remembered. A 404 that is not JSON is a server with no poster
/// route at all; the loader remembers that for its life and goes straight to
/// the export for every design after it.
@MainActor
@Observable
public final class NativeDesignPreviewLoader: DesignPreviewProviding {
    /// The largest SVG the card will draw. A design with an embedded
    /// photograph runs to a few hundred kilobytes; past this is not a preview.
    public static let maximumBytes = 8 * 1_024 * 1_024

    /// The web's `POSTER_RENDERER` (`src/lib/design/poster-url.ts`). Part of
    /// the poster URL and of its cache file name, so a new renderer never
    /// reads an old picture. Bump it when the web bumps its own.
    public static let posterRenderer = 1

    private let sender: (any NativeAuthenticatedRequestSending)?
    private let accountID: AccountID
    private let cacheDirectory: URL?
    private var states: [String: NativeDesignPreviewState] = [:]
    @ObservationIgnored private var inFlight: Set<String> = []
    /// Current versions already revalidated in this loader's life.
    @ObservationIgnored private var revalidated: Set<String> = []
    /// Versions whose poster the route refused (JSON 404): the export only.
    @ObservationIgnored private var exportOnly: Set<String> = []
    /// The server has no poster route (a 404 that is not JSON). For the
    /// loader's life every design goes straight to the export.
    @ObservationIgnored public private(set) var posterRouteMissing = false

    public init(
        sender: (any NativeAuthenticatedRequestSending)?,
        accountID: AccountID,
        cacheRoot: URL? = NativeDesignPreviewLoader.defaultCacheRoot
    ) {
        self.sender = sender
        self.accountID = accountID
        cacheDirectory = cacheRoot?.appendingPathComponent(
            Self.safeComponent(accountID.rawValue),
            isDirectory: true
        )
    }

    /// `~/Library/Caches/<bundle id>/DesignPreviews`.
    public nonisolated static var defaultCacheRoot: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "Juno", isDirectory: true)
            .appendingPathComponent("DesignPreviews", isDirectory: true)
    }

    /// Removes every cached design picture, for every account — on sign-out,
    /// with the transcript's other files.
    public nonisolated static func purgeCachedPreviews(at root: URL? = defaultCacheRoot) {
        guard let root else { return }
        try? FileManager.default.removeItem(at: root)
    }

    public func designPreviewState(artifactID: String, version: Int) -> NativeDesignPreviewState {
        states[Self.key(artifactID, version)] ?? .loading
    }

    public func loadDesignPreview(artifactID: String, version: Int, isCurrent: Bool) async {
        let key = Self.key(artifactID, version)
        switch states[key] {
        case .ready:
            // Drawn already; only the current version asks again, once.
            guard isCurrent, !revalidated.contains(key), !exportOnly.contains(key), !posterRouteMissing else { return }
        case .unavailable:
            return
        case .loading, .failed, .none:
            break
        }
        guard !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }

        let poster = cachedSVG(Self.posterFileName(artifactID, version))
        let export = cachedSVG(Self.exportFileName(artifactID, version))
        if states[key] == nil || states[key] == .failed {
            states[key] = (poster ?? export).map { .ready(svg: $0) } ?? .loading
        }

        // A sealed version never changes: whatever the cache holds is final.
        if !isCurrent, let cached = poster ?? export {
            states[key] = .ready(svg: cached)
            return
        }
        if isCurrent, revalidated.contains(key), let cached = poster ?? export {
            states[key] = .ready(svg: cached)
            return
        }
        guard let sender, Self.isValidIdentifier(artifactID) else {
            states[key] = (poster ?? export).map { .ready(svg: $0) } ?? .failed
            return
        }

        if posterRouteMissing || exportOnly.contains(key) {
            states[key] = await loadExport(artifactID, version, cached: export, sender: sender)
            return
        }

        let outcome = await loadPoster(artifactID, version, cached: poster, sender: sender)
        switch outcome {
        case .drawn(let state):
            if isCurrent { revalidated.insert(key) }
            states[key] = state
        case .notADesignOfYours:
            exportOnly.insert(key)
            states[key] = await loadExport(artifactID, version, cached: export, sender: sender)
        case .noRoute:
            posterRouteMissing = true
            states[key] = await loadExport(artifactID, version, cached: export, sender: sender)
        }
    }

    // MARK: - Requests

    private enum PosterOutcome {
        case drawn(NativeDesignPreviewState)
        /// 404 with a JSON body: the route answered, and there is no poster.
        case notADesignOfYours
        /// 404 without JSON: this server has no poster route.
        case noRoute
    }

    private func loadPoster(
        _ artifactID: String,
        _ version: Int,
        cached: String?,
        sender: any NativeAuthenticatedRequestSending
    ) async -> PosterOutcome {
        let fileName = Self.posterFileName(artifactID, version)
        do {
            var headers = try HTTPHeaders(["accept": "image/svg+xml"])
            if cached != nil, let tag = cachedETag(fileName) {
                try headers.set(tag, for: "if-none-match")
            }
            let request = try NativeBearerRequest(
                path: Self.posterPath(artifactID),
                queryItems: Self.posterQuery(version),
                headers: headers
            )
            let response = try await sender.send(request, for: accountID)
            switch response.statusCode {
            case 304:
                if let cached { return .drawn(.ready(svg: cached)) }
                return .drawn(.failed)
            case 200..<300:
                guard let svg = Self.drawableSVG(response.body) else {
                    return .drawn(cached.map { .ready(svg: $0) } ?? .unavailable)
                }
                store(svg, as: fileName, etag: response.headers["etag"])
                return .drawn(.ready(svg: svg))
            case 404:
                return Self.isJSON(response) ? .notADesignOfYours : .noRoute
            case 401, 429:
                return .drawn(cached.map { .ready(svg: $0) } ?? .failed)
            case 400..<600:
                return .drawn(cached.map { .ready(svg: $0) } ?? .unavailable)
            default:
                return .drawn(cached.map { .ready(svg: $0) } ?? .failed)
            }
        } catch {
            return .drawn(cached.map { .ready(svg: $0) } ?? .failed)
        }
    }

    private func loadExport(
        _ artifactID: String,
        _ version: Int,
        cached: String?,
        sender: any NativeAuthenticatedRequestSending
    ) async -> NativeDesignPreviewState {
        if let cached { return .ready(svg: cached) }
        do {
            let request = try NativeBearerRequest(
                path: "/api/design/\(artifactID)/export",
                queryItems: [URLQueryItem(name: "format", value: "svg")],
                headers: try HTTPHeaders(["accept": "image/svg+xml"])
            )
            let response = try await sender.send(request, for: accountID)
            switch response.statusCode {
            case 200..<300:
                guard let svg = Self.drawableSVG(response.body) else { return .unavailable }
                store(svg, as: Self.exportFileName(artifactID, version), etag: nil)
                return .ready(svg: svg)
            case 401, 429:
                return .failed
            case 400..<600:
                return .unavailable
            default:
                return .failed
            }
        } catch {
            return .failed
        }
    }

    // MARK: - Cache

    private func cachedSVG(_ fileName: String) -> String? {
        guard let file = cacheDirectory?.appendingPathComponent(fileName),
            let text = try? String(contentsOf: file, encoding: .utf8),
            Self.isSVG(text)
        else { return nil }
        return text
    }

    private func cachedETag(_ fileName: String) -> String? {
        guard let file = cacheDirectory?.appendingPathComponent(Self.etagFileName(fileName)),
            let tag = try? String(contentsOf: file, encoding: .utf8)
        else { return nil }
        let trimmed = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func store(_ svg: String, as fileName: String, etag: String?) {
        guard let directory = cacheDirectory else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? Data(svg.utf8).write(to: directory.appendingPathComponent(fileName), options: .atomic)
        let tagFile = directory.appendingPathComponent(Self.etagFileName(fileName))
        if let etag, !etag.isEmpty {
            try? Data(etag.utf8).write(to: tagFile, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: tagFile)
        }
    }

    // MARK: - Names and checks

    static func key(_ id: String, _ version: Int) -> String { "\(id)#\(version)" }

    /// The web's `designPosterUrl(id)` path.
    static func posterPath(_ id: String) -> String { "/api/artifacts/\(id)/poster" }

    /// `?v={n}&r={renderer}`, in the web's order.
    static func posterQuery(_ version: Int) -> [URLQueryItem] {
        [URLQueryItem(name: "v", value: String(version)), URLQueryItem(name: "r", value: String(posterRenderer))]
    }

    /// `<id>-v<n>-r<renderer>.svg`.
    static func posterFileName(_ id: String, _ version: Int) -> String {
        "\(safeComponent(id))-v\(version)-r\(posterRenderer).svg"
    }

    /// `<id>-v<n>.svg`, the export's name from before posters.
    static func exportFileName(_ id: String, _ version: Int) -> String {
        "\(safeComponent(id))-v\(version).svg"
    }

    static func etagFileName(_ svgFileName: String) -> String {
        (svgFileName as NSString).deletingPathExtension + ".etag"
    }

    static func isSVG(_ text: String) -> Bool {
        text.range(of: #"^\s*(<\?xml[^>]*>\s*)?<svg[\s>]"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func drawableSVG(_ body: Data) -> String? {
        guard body.count <= maximumBytes, let svg = String(data: body, encoding: .utf8), isSVG(svg) else { return nil }
        return svg
    }

    /// Whether a 404 is the route's own JSON answer rather than a server's
    /// page for a path it does not have.
    private static func isJSON(_ response: HTTPResponse) -> Bool {
        if let type = response.headers["content-type"]?.lowercased(), type.contains("json") { return true }
        return (try? JSONSerialization.jsonObject(with: response.body)) is [String: Any]
    }

    /// The ids this route takes: server-minted, URL-safe, bounded.
    static func isValidIdentifier(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 128 && id.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
    }

    private static func safeComponent(_ value: String) -> String {
        String(value.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" }.prefix(128))
    }
}
