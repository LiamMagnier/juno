import Foundation
import JunoDesignSystem
import SwiftUI

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// Sources' logos, from each source's **own** origin (`https://host/favicon.ico`)
/// — the web's rule (`source-chip.tsx`), shared by the Mac and the phone.
///
/// Never a favicon proxy (Google s2, DuckDuckGo, Clearbit): a proxy is handed
/// the domain of every source the reader looks at. An ephemeral session with
/// no cookies and no referrer, 64 KB at most per icon, one request per host per
/// launch, held in memory only. A site that declares its icon only in
/// `<link rel="icon">` shows its letter.
@MainActor
@Observable
public final class NativeSourceFavicons {
    private var images: [String: Image] = [:]
    @ObservationIgnored private var requested = Set<String>()
    @ObservationIgnored private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 8
        return URLSession(configuration: configuration)
    }()

    public init() {}

    public func image(for url: URL) -> Image? {
        url.host().flatMap { images[$0] }
    }

    public func load(_ url: URL) {
        guard NativePrivateSourceKind.of(url) == nil,
            let host = url.host(), let scheme = url.scheme?.lowercased(),
            scheme == "https" || scheme == "http", requested.insert(host).inserted,
            let icon = URL(string: "\(scheme)://\(host)/favicon.ico")
        else { return }
        let session = session
        Task { @MainActor [weak self] in
            guard let (data, response) = try? await session.data(from: icon),
                let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                data.count <= 64 * 1_024
            else { return }
            #if canImport(AppKit) && !targetEnvironment(macCatalyst)
            guard let image = NSImage(data: data), image.size.width > 0 else { return }
            self?.images[host] = Image(nsImage: image)
            #elseif canImport(UIKit)
            guard let image = UIImage(data: data), image.size.width > 0 else { return }
            self?.images[host] = Image(uiImage: image)
            #endif
        }
    }
}

public extension EnvironmentValues {
    /// The window's favicon loader. Nil draws letters — the snapshot harness,
    /// which has no network.
    @Entry var nativeSourceFavicons: NativeSourceFavicons? = nil
}

/// A source's logo in a fixed box, with its host's first letter underneath
/// until — and unless — the icon arrives, so a slow or missing icon never
/// moves anything.
public struct NativeSourceIcon: View {
    let url: URL
    var size: CGFloat
    var circular: Bool

    @Environment(\.nativeSourceFavicons) private var favicons
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(url: URL, size: CGFloat = 16, circular: Bool = false) {
        self.url = url
        self.size = size
        self.circular = circular
    }

    private var letter: String? {
        guard let first = NativeResearchReport.host(url).first, first.isLetter || first.isNumber else { return nil }
        return String(first).uppercased()
    }

    public var body: some View {
        let image = favicons?.image(for: url)
        ZStack {
            Group {
                if let own = NativePrivateSourceKind.of(url) {
                    JunoIconView(own.icon, size: max(8, size * 0.6))
                } else if let letter {
                    Text(letter)
                        .junoFont(size: max(8, size * 0.52), relativeTo: .caption2, weight: .medium)
                } else {
                    JunoIconView(.web, size: max(8, size * 0.6))
                }
            }
            .foregroundStyle(Color.junoSecondaryInk)
            .opacity(image == nil ? 1 : 0)
            if let image {
                image
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .transition(.opacity)
            }
        }
        .frame(width: size, height: size)
        .background(Color.junoMuted)
        .clipShape(RoundedRectangle(cornerRadius: circular ? size / 2 : max(3, size * 0.22), style: .continuous))
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: image != nil)
        .onAppear { favicons?.load(url) }
        .accessibilityHidden(true)
    }
}

/// Up to `limit` logos, one per site, overlapping — the first on top, each
/// cut out of what it sits on with a ring of that fill.
public struct NativeSourceIconStack: View {
    let sources: [URL]
    var size: CGFloat
    var limit: Int
    var ring: Color

    public init(sources: [URL], size: CGFloat = 18, limit: Int = 5, ring: Color = .junoCard) {
        self.sources = sources
        self.size = size
        self.limit = limit
        self.ring = ring
    }

    private var sites: [URL] {
        var seen = Set<String>()
        return sources.filter { seen.insert(NativeResearchReport.host($0)).inserted }.prefix(limit).map { $0 }
    }

    public var body: some View {
        HStack(spacing: -size * 0.3) {
            ForEach(Array(sites.enumerated()), id: \.offset) { index, url in
                NativeSourceIcon(url: url, size: size, circular: true)
                    .padding(1.5)
                    .background(Circle().fill(ring))
                    .zIndex(Double(limit - index))
            }
        }
        .accessibilityHidden(true)
    }
}
