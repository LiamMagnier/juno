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
    /// Starts the fetch. A second call for the same version is a no-op.
    func loadDesignPreview(artifactID: String, version: Int) async
}

/// Fetches and caches the picture of a Juno Design document for the inline
/// card: `GET /api/design/{id}/export?format=svg`, authenticated, one request
/// per version, kept in memory and at
/// `~/Library/Caches/<bundle>/DesignPreviews/<account>/<id>-v<n>.svg`.
///
/// The web shows a design artifact inline as its JSON; the Mac draws it
/// (§0.8 register, entry 14). The server already renders the SVG for Export,
/// so the Mac asks for the same picture rather than running a second renderer.
@MainActor
@Observable
public final class NativeDesignPreviewLoader: DesignPreviewProviding {
    /// The largest SVG the card will draw. A design with an embedded
    /// photograph runs to a few hundred kilobytes; past this is not a preview.
    public static let maximumBytes = 8 * 1_024 * 1_024

    private let sender: (any NativeAuthenticatedRequestSending)?
    private let accountID: AccountID
    private let cacheDirectory: URL?
    private var states: [String: NativeDesignPreviewState] = [:]
    @ObservationIgnored private var inFlight: Set<String> = []

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

    public func loadDesignPreview(artifactID: String, version: Int) async {
        let key = Self.key(artifactID, version)
        switch states[key] {
        case .ready, .unavailable: return
        case .loading, .failed, .none: break
        }
        guard !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }
        states[key] = .loading

        let file = cacheDirectory?.appendingPathComponent("\(Self.safeComponent(artifactID))-v\(version).svg")
        if let file, let cached = try? String(contentsOf: file, encoding: .utf8), Self.isSVG(cached) {
            states[key] = .ready(svg: cached)
            return
        }
        guard let sender, Self.isValidIdentifier(artifactID) else {
            states[key] = .failed
            return
        }
        do {
            let request = try NativeBearerRequest(
                path: "/api/design/\(artifactID)/export",
                queryItems: [URLQueryItem(name: "format", value: "svg")],
                headers: try HTTPHeaders(["accept": "image/svg+xml"])
            )
            let response = try await sender.send(request, for: accountID)
            switch response.statusCode {
            case 200..<300:
                guard response.body.count <= Self.maximumBytes,
                    let svg = String(data: response.body, encoding: .utf8),
                    Self.isSVG(svg)
                else {
                    states[key] = .unavailable
                    return
                }
                states[key] = .ready(svg: svg)
                if let file, let directory = cacheDirectory {
                    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try? Data(svg.utf8).write(to: file, options: .atomic)
                }
            case 400..<500 where response.statusCode != 401 && response.statusCode != 429, 500..<600:
                states[key] = .unavailable
            default:
                states[key] = .failed
            }
        } catch {
            states[key] = .failed
        }
    }

    static func key(_ id: String, _ version: Int) -> String { "\(id)#\(version)" }

    static func isSVG(_ text: String) -> Bool {
        text.range(of: #"^\s*(<\?xml[^>]*>\s*)?<svg[\s>]"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The ids this route takes: server-minted, URL-safe, bounded.
    static func isValidIdentifier(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 128 && id.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
    }

    private static func safeComponent(_ value: String) -> String {
        String(value.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" }.prefix(128))
    }
}
