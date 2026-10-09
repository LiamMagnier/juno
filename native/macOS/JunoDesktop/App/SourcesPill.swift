import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

// MARK: - Favicons

/// Sources' logos, from each source's **own** origin (`https://host/favicon.ico`).
///
/// The web's rule, kept (`source-chip.tsx`): never a favicon proxy — Google s2,
/// DuckDuckGo, Clearbit — because a proxy is handed the domain of every source
/// the reader looks at. The source's own site learns nothing the reader is not
/// one click from telling it anyway. The cost is the web's too: a site that
/// declares its icon only in `<link rel="icon">` shows its letter.
///
/// An ephemeral session with no cookies and no referrer, 64 KB at most per
/// icon, one request per host per launch, held in memory only.
@MainActor
@Observable
final class SourceFaviconLoader {
    private var images: [String: NSImage] = [:]
    @ObservationIgnored private var requested = Set<String>()
    @ObservationIgnored private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 8
        return URLSession(configuration: configuration)
    }()

    func image(for host: String) -> NSImage? {
        images[host]
    }

    func load(_ url: URL) {
        guard let host = url.host(), let scheme = url.scheme?.lowercased(),
            scheme == "https" || scheme == "http", requested.insert(host).inserted,
            let icon = URL(string: "\(scheme)://\(host)/favicon.ico")
        else { return }
        let session = session
        Task { @MainActor [weak self] in
            guard let (data, response) = try? await session.data(from: icon),
                let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                data.count <= 64 * 1_024,
                let image = NSImage(data: data), image.size.width > 0
            else { return }
            self?.images[host] = image
        }
    }
}

extension EnvironmentValues {
    /// The window's favicon loader. Nil draws letters — the snapshot harness,
    /// which has no network.
    @Entry var junoFavicons: SourceFaviconLoader? = nil
}

/// A source's logo in a fixed box, with its host's first letter underneath
/// until — and unless — the icon arrives, so a slow or missing icon never
/// moves anything.
struct SourceFavicon: View {
    let url: URL
    var size: CGFloat = 18
    /// A circle in a cluster; a rounded square in a list.
    var circular = true

    @Environment(\.junoFavicons) private var favicons
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var host: String { SourceHost.name(url) }

    private var letter: String? {
        guard let first = host.first, first.isLetter || first.isNumber else { return nil }
        return String(first).uppercased()
    }

    var body: some View {
        let image = url.host().flatMap { favicons?.image(for: $0) }
        ZStack {
            Group {
                if let letter {
                    Text(letter)
                        .junoFont(size: max(8, size * 0.5), relativeTo: .caption2, weight: .semibold)
                } else {
                    JunoIconView(.web, size: max(8, size * 0.6))
                }
            }
            .foregroundStyle(Color.junoSecondaryInk)
            .opacity(image == nil ? 1 : 0)
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .transition(.opacity)
            }
        }
        .frame(width: size, height: size)
        .background(Color.junoMuted)
        .clipShape(RoundedRectangle(cornerRadius: circular ? size / 2 : JunoRadius.xs, style: .continuous))
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: image != nil)
        .onAppear { favicons?.load(url) }
        .accessibilityHidden(true)
    }
}

/// The web's `hostOf` and `titleOf`.
enum SourceHost {
    /// The bare host, without the `www.` that carries no information.
    static func name(_ url: URL) -> String {
        guard let host = url.host() else { return url.absoluteString }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// A human title, or the host when the model handed a URL as the title.
    static func title(_ source: NativeChatSource) -> String {
        let title = source.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty || title == source.url.absoluteString || title.lowercased().hasPrefix("http") {
            return name(source.url)
        }
        return title
    }
}

/// Up to three logos, one per site, overlapping — the stacked-avatar
/// convention, the first on top, each cut out of what it sits on with a ring
/// of that fill. Five citations of one site read as one site, not as breadth.
struct SourceFaviconStack: View {
    let sources: [NativeChatSource]
    var size: CGFloat = 18
    var overlap: CGFloat = 6
    var ring: Color = .junoCard
    var limit = 3
    /// A "+N" after the logos when more sites stand behind them (the run
    /// line's stack, SPEC §7.5).
    var showsMore = false

    /// Distinct sites, in the order they first appeared — never reshuffled
    /// when later ones arrive.
    private var sites: [NativeChatSource] {
        var seen = Set<String>()
        var result: [NativeChatSource] = []
        for source in sources where seen.insert(SourceHost.name(source.url)).inserted {
            result.append(source)
        }
        return result
    }

    var body: some View {
        let all = sites
        let items = Array(all.prefix(limit))
        HStack(spacing: JunoSpace.hairline) {
            HStack(spacing: -overlap) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, source in
                    SourceFavicon(url: source.url, size: size)
                        .padding(JunoSpace.micro)
                        .background(Circle().fill(ring))
                        .zIndex(Double(items.count - index))
                }
            }
            if showsMore, all.count > items.count {
                Text("+\(all.count - items.count)")
                    .junoFont(size: 11, relativeTo: .caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - The pill

/// The answer's bibliography (spec §6.7, the web's `SourcesPill`): a pill that
/// says how many sources backed the reply and opens, in place, into the list.
///
/// A 32pt opaque capsule — `--card` under a 1pt `--border` — holding the
/// logos, "Sources", the count and a caret. Open, each source is a 36pt row:
/// its logo, its title, its site and its number. The inline citations are what
/// a reader follows mid-sentence; this is what they open afterwards.
struct DesktopMessageSources: View {
    let sources: [NativeChatSource]
    @State private var expanded: Bool
    @State private var hovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    /// `startsExpanded` opens the list at once — for the snapshot harness,
    /// which cannot click the pill.
    init(sources: [NativeChatSource], startsExpanded: Bool = false) {
        self.sources = sources
        _expanded = State(initialValue: startsExpanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Button {
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    expanded.toggle()
                }
            } label: {
                pillFace
            }
            .buttonStyle(.plain)
            .contentShape(Capsule())
            .onHover { hovered = $0 }
            .help(expanded ? "Hide sources" : "Show sources")
            .accessibilityLabel("Sources, \(sources.count)")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("juno.desktop.chat.sources")

            if expanded {
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                        SourceRow(source: source, number: index + 1)
                    }
                }
                .frame(maxWidth: 576, alignment: .leading)
                .transition(.opacity.combined(with: .offset(y: JunoMotion.shift(-4, reduceMotion: reduceMotion))))
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var pillFace: some View {
        HStack(spacing: JunoSpace.snug) {
            SourceFaviconStack(sources: sources, ring: expanded || hovered ? .junoHover : .junoCard)
            // SF, not the web's mono: a label (§10.2 rule 6); the count is a
            // count and keeps it.
            Text("Sources")
                .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                .foregroundStyle(hovered ? Color.junoForeground : Color.junoSecondaryInk)
            Text(sources.count.formatted())
                .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
            JunoIconView(.chevronDown, size: 10, weight: .bold)
                .foregroundStyle(Color.junoSecondaryInk)
                .rotationEffect(.degrees(expanded ? 180 : 0))
        }
        .padding(.leading, JunoSpace.hairline)
        .padding(.trailing, JunoSpace.cozy)
        .frame(height: 32)
        .background(Capsule().fill(expanded || hovered ? Color.junoHover : Color.junoCard))
        .overlay(
            Capsule().strokeBorder(
                Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased)),
                lineWidth: 1
            )
        )
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
    }
}

/// One source in the open list: a 36pt row that opens the page.
struct SourceRow: View {
    let source: NativeChatSource
    let number: Int
    @State private var hovered = false
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            openURL(source.url)
        } label: {
            HStack(spacing: JunoSpace.close) {
                SourceFavicon(url: source.url, size: 18, circular: false)
                Text(SourceHost.title(source))
                    .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                Text(SourceHost.name(source.url))
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: JunoSpace.snug)
                Text(number.formatted())
                    .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 36)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(Color.junoHover)
                    .opacity(hovered ? 1 : 0)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        }
        .buttonStyle(.plain)
        .contentShape(.rect)
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        .help(source.url.absoluteString)
        .accessibilityLabel("Source \(number): \(SourceHost.title(source)), \(SourceHost.name(source.url))")
    }
}

// MARK: - Citations

/// What a citation chip opens: the source, as the web's hover card shows it —
/// site, title and the passage the answer leaned on — at 320 × 140, with the
/// page one click further.
struct SourceCitationPopover: View {
    let source: NativeChatSource
    let number: Int
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.snug) {
                SourceFavicon(url: source.url, size: 16, circular: false)
                Text(SourceHost.name(source.url))
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                Spacer(minLength: JunoSpace.snug)
                Text(number.formatted())
                    .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Text(SourceHost.title(source))
                .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                .lineLimit(2)
            let snippet = source.snippet.trimmingCharacters(in: .whitespacesAndNewlines)
            if !snippet.isEmpty {
                Text(snippet)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            Button("Open Page") { openURL(source.url) }
                .buttonStyle(.link)
                .contentShape(.rect)
        }
        .padding(JunoSpace.cozy)
        .frame(width: 320, height: 140, alignment: .topLeading)
    }
}
