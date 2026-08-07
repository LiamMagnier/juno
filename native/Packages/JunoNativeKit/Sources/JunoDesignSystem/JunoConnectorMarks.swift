import SwiftUI

#if canImport(AppKit)
import AppKit
typealias PlatformImage = NSImage
#elseif canImport(UIKit)
import UIKit
typealias PlatformImage = UIImage
#endif

/// A connector's real brand mark.
///
/// This exists because the desktop was drawing connectors with SF Symbols —
/// `paintbrush.pointed` for Figma, `chevron.left.forwardslash.chevron.right` for
/// GitHub, `note.text` for Notion. A generic glyph standing in for a brand is
/// the single clearest tell that a screen was assembled rather than designed:
/// the user knows exactly what GitHub's mark looks like, and a wrench is not it.
///
/// Three sources, in order, and the order is the whole design:
///
/// 1. **The real installed application's icon**, for connectors that are a Mac
///    app the user already has — Calendar, Mail, Music. `NSWorkspace` hands back
///    the actual icon the user sees in their Dock, at whatever size is asked
///    for, already correct for their macOS version. Nothing hand-drawn can beat
///    that for recognition, and it can never drift when Apple restyles an icon.
/// 2. **The bundled brand artwork**, for the third-party services — the same
///    vector marks the website ships in `connector-logos.tsx`, so the two
///    surfaces cannot disagree about what Figma's logo is.
/// 3. **A monogram**, and only for a connector the server added after this build
///    shipped. Never an SF Symbol pretending to be a logo — that is the failure
///    this type was written to remove.
public struct JunoConnectorMark: View {
    private let connectorID: String
    private let connectorName: String
    private let logoURL: URL?
    private let size: CGFloat

    @State private var remoteImage: PlatformImage?

    public init(
        connectorID: String,
        connectorName: String,
        logoURL: URL? = nil,
        size: CGFloat = 22
    ) {
        self.connectorID = connectorID
        self.connectorName = connectorName
        self.logoURL = logoURL
        self.size = size
    }

    public var body: some View {
        Group {
            #if canImport(AppKit)
            if let icon = JunoConnectorMark.applicationIcon(for: connectorID) {
                Image(nsImage: icon)
                    .resizable()
                    .scaledToFit()
            } else if bundledAssetExists {
                bundledMark
            } else if let remoteImage {
                remoteMark(remoteImage)
            } else {
                monogram
            }
            #else
            if bundledAssetExists {
                bundledMark
            } else if let remoteImage {
                remoteMark(remoteImage)
            } else {
                monogram
            }
            #endif
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        // Only the catalog's hundreds of managed apps reach here; the connectors
        // Juno ships resolve above without ever touching the network.
        .task(id: logoURL) {
            guard let logoURL else { return }
            remoteImage = await JunoConnectorLogoCache.shared.image(for: logoURL)
        }
    }

    /// The fetched logo, never tinted.
    ///
    /// A brand mark arrives with its own colours; forcing it to the foreground
    /// style would turn every third-party logo into a monochrome silhouette,
    /// which is a different failure from the SF Symbols this type replaced but
    /// just as wrong.
    private func remoteMark(_ image: PlatformImage) -> some View {
        #if canImport(AppKit)
        Image(nsImage: image).resizable().scaledToFit()
        #else
        Image(uiImage: image).resizable().scaledToFit()
        #endif
    }

    // MARK: - Bundled artwork

    private var assetName: String { "connector-\(connectorID.lowercased())" }

    private var bundledAssetExists: Bool {
        #if canImport(UIKit)
        UIImage(named: assetName) != nil
        #elseif canImport(AppKit)
        NSImage(named: assetName) != nil
        #else
        false
        #endif
    }

    /// Template marks (GitHub, Notion) take the surrounding foreground colour so
    /// they read in both appearances; Figma's is `original` in the catalog and
    /// keeps its own five brand colours, so the tint applied here is ignored for
    /// it by design.
    private var bundledMark: some View {
        Image(assetName)
            .resizable()
            .scaledToFit()
            .foregroundStyle(Color.junoForeground)
    }

    private var monogram: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(Color.junoMuted)
            .overlay {
                Text(String(connectorName.prefix(1)).uppercased())
                    .font(.system(size: size * 0.55, weight: .semibold, design: .rounded))
                    .junoSecondaryInk()
            }
    }

    // MARK: - Installed applications

    #if canImport(AppKit)
    /// The bundle identifier of the Mac app a connector actually talks to.
    ///
    /// Only first-party apps that ship with macOS are listed. A connector whose
    /// service happens to *have* a Mac app the user may not have installed is
    /// deliberately absent: falling back to bundled artwork is predictable,
    /// whereas an icon that appears on one Mac and not another is not.
    static func applicationBundleIdentifier(for connectorID: String) -> String? {
        switch connectorID {
        case "apple-calendar": "com.apple.iCal"
        case "apple-mail": "com.apple.mail"
        case "apple-music": "com.apple.Music"
        case "apple-reminders": "com.apple.reminders"
        case "apple-notes": "com.apple.Notes"
        case "apple-contacts": "com.apple.AddressBook"
        default: nil
        }
    }

    /// The installed app's icon, or nil if the app is not present.
    ///
    /// Cached because this is called from a view body: `urlForApplication` is a
    /// Launch Services lookup and `icon(forFile:)` reads the bundle from disk,
    /// and a grid of connector cards re-rendering on hover would otherwise do
    /// both on every frame.
    ///
    /// `@MainActor` rather than lock-guarded. The only caller is a SwiftUI body,
    /// which is already on the main actor, so the isolation is free — and it is
    /// what lets the cache hold `NSImage` honestly. The previous version wrapped
    /// it in a hand-rolled mutex behind a `Sendable` struct with a non-`Sendable`
    /// `NSImage` stored inside it: a conformance that claimed something untrue
    /// about AppKit, to buy concurrency this code never uses.
    @MainActor
    static func applicationIcon(for connectorID: String) -> NSImage? {
        // A miss is cached too — `nil` here means "looked, not installed", which
        // is exactly as worth remembering as a hit, so the double lookup is
        // deliberate rather than a nil-coalescing slip.
        if let cached = iconCache[connectorID] { return cached }

        guard let identifier = applicationBundleIdentifier(for: connectorID),
            let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier)
        else {
            iconCache[connectorID] = NSImage?.none
            return nil
        }
        let icon = NSWorkspace.shared.icon(forFile: url.path)
        // Ask for a size the mark is actually drawn at, so AppKit picks the
        // right representation instead of scaling the 512pt one down.
        icon.size = NSSize(width: 64, height: 64)
        iconCache[connectorID] = icon
        return icon
    }

    @MainActor
    private static var iconCache: [String: NSImage?] = [:]
    #endif
}

/// Fetches and caches the catalog's own logo artwork.
///
/// **Why not `AsyncImage`.** Observed: every managed-catalog app (Gmail, Slack,
/// Drive, Linear…) rendered as a letter monogram in the directory, while the
/// connectors Juno bundles rendered fine — so the logo URLs were arriving and
/// the images were not appearing. Verified separately: `NSImage(data:)` decodes
/// SVG, which is the format the catalog serves most of these in.
///
/// The inference joining those two facts — that `AsyncImage` is what failed on
/// SVG — is not proven here. What *is* certain is that constructing the image
/// from fetched `Data` handles both SVG and raster, and that failure needs
/// somewhere to live: `AsyncImage` shows its placeholder for "loading" and
/// "failed" alike, which is exactly why the monograms looked deliberate rather
/// than like a broken fetch. If a logo still fails to appear, the fault is now
/// observable at this call rather than hidden behind a placeholder.
///
/// Cached in memory for the process lifetime, misses included. The directory is
/// a scrolling grid of hundreds of tiles that recycles as it scrolls, and
/// re-fetching a logo every time a row comes back into view would put the
/// catalog's CDN in the scroll path.
/// `@MainActor`, not an actor, for the same reason the icon cache is: the only
/// caller is a SwiftUI body. An `actor` here would have to hand a non-`Sendable`
/// `NSImage`/`UIImage` back across an isolation boundary on every hit, which is
/// a promise about AppKit that cannot be kept — and it would buy nothing, since
/// every read and write already happens on the main actor.
///
/// Only the network fetch leaves the main actor, which is where the work
/// actually is; decoding lands back here.
@MainActor
final class JunoConnectorLogoCache {
    static let shared = JunoConnectorLogoCache()

    /// `nil` value = fetched and failed. Distinct from "absent", so a broken
    /// logo URL is attempted once rather than on every appearance.
    private var entries: [URL: PlatformImage?] = [:]
    /// Deduplicates concurrent requests for the same logo. A grid scrolling past
    /// twenty cards backed by one CDN would otherwise start twenty identical
    /// fetches before the first returned.
    private var inFlight: [URL: Task<Data?, Never>] = [:]

    func image(for url: URL) async -> PlatformImage? {
        if let cached = entries[url] { return cached }

        let task = inFlight[url] ?? Task<Data?, Never> {
            var request = URLRequest(url: url)
            // A logo is decoration: it must never hold a view in a loading state
            // for longer than a reader would wait for one.
            request.timeoutInterval = 10
            request.cachePolicy = .returnCacheDataElseLoad
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                let http = response as? HTTPURLResponse,
                (200...299).contains(http.statusCode),
                !data.isEmpty
            else { return nil }
            return data
        }
        inFlight[url] = task

        // `Data` crosses the boundary, not the image: `Data` is `Sendable` and
        // the platform image types are not, so decoding happens here rather than
        // inside the task.
        let data = await task.value
        inFlight[url] = nil
        let image = data.flatMap(PlatformImage.init(data:))
        entries[url] = image
        return image
    }
}

// The hand-rolled `Mutex` that used to live here is gone with the caches it
// guarded. Both are `@MainActor` now, which is where their only callers already
// were, so the lock was protecting against concurrency this code never had.
