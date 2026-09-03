import SwiftUI

/// One source in an AIcss search block.
public struct JunoAIcssSearchSite: Identifiable, Hashable, Sendable {
    /// How far the run has got with this source.
    ///
    /// `pending` and `loading` are only for callers that can honestly report
    /// per-source progress. Chat cannot: a `visit` event is emitted at the moment
    /// a source has been read, and until the search returns, the URL is not even
    /// known — so a fetching row there would be a state the app cannot observe,
    /// drawn in the shape that says it did. Chat's rows are all `done`, and the
    /// in-flight state lives on the label, which shimmers.
    public enum State: Sendable {
        case pending
        case loading
        case done
    }

    public let id: String
    public let title: String
    /// The bare display form: host + path, no scheme.
    public let label: String
    public let url: URL
    public let state: State

    public init(title: String, label: String, url: URL, state: State) {
        self.id = url.absoluteString
        self.title = title
        self.label = label
        self.url = url
        self.state = state
    }

    /// host + path with the scheme and any `www.` dropped — what AIcss's rows show.
    public static func label(for url: URL) -> String {
        let host = (url.host() ?? url.absoluteString).replacingOccurrences(
            of: "^www\\.", with: "", options: .regularExpression
        )
        let path = url.path()
        return path.isEmpty || path == "/" ? host : host + path
    }
}

/// AIcss "Web Search" — the query, then the sources it found.
///
/// AIcss stages this: three hardcoded sites on a discover/finish timer that loops
/// forever. Here the rows are whatever the run reported. The three-glyph bullet is
/// stacked rather than swapped, so a row's baseline cannot move as a source
/// resolves — which matters when several resolve at once.
public struct JunoAIcssWebSearch: View {
    private let query: String?
    private let sites: [JunoAIcssSearchSite]
    private let settled: Bool

    @State private var open: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - query: the query, verbatim, when the run recorded one. Absent on the
    ///     provider-tool search paths, where sources arrive from grounding
    ///     metadata and the query the model typed never reaches us — the label row
    ///     is then omitted rather than shown empty or filled in with a guess.
    public init(query: String?, sites: [JunoAIcssSearchSite], settled: Bool, defaultOpen: Bool = true) {
        self.query = query
        self.sites = sites
        self.settled = settled
        self._open = State(initialValue: defaultOpen)
    }

    /// With no label there is no control to fold it with.
    private var expanded: Bool { query == nil || open }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let query { labelRow(query) }
            if expanded, !sites.isEmpty { results }
        }
        .animation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion), value: expanded)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: sites.count)
    }

    private func labelRow(_ query: String) -> some View {
        HStack(spacing: 6) {
            JunoIconView(.search)
                .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                .foregroundStyle(Color.junoMutedForeground)
            JunoAIcssThinkingLabel(
                "\(settled ? "Searched" : "Searching") “\(query)”",
                tone: .strong,
                settled: settled
            )
            .lineLimit(1)
            .truncationMode(.tail)
            if !sites.isEmpty {
                Button { open.toggle() } label: {
                    JunoIconView(.chevronUp)
                        .junoFont(size: 9, relativeTo: .caption2, weight: .semibold)
                        .foregroundStyle(Color.junoMutedForeground)
                        .rotationEffect(.degrees(open ? 0 : 180))
                        .frame(width: 16, height: 16)
                }
                .buttonStyle(.junoPress)
                .accessibilityLabel(open ? "Hide results" : "Show results")
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 20)
    }

    private var results: some View {
        HStack(alignment: .top, spacing: 6) {
            // The rail hangs the results off the search glyph's own centre.
            Rectangle()
                .fill(Color.junoHairline)
                .frame(width: 1)
                .padding(.leading, 5.5)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(sites) { site in
                    row(site)
                }
            }
            .padding(.leading, 6)
            .padding(.top, 4)
            .padding(.bottom, 2)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func row(_ site: JunoAIcssSearchSite) -> some View {
        // Only a read source is a link. A pending row points at a URL the run has
        // not fetched, and offering it as a tap would be offering someone else's
        // guess as a destination.
        if site.state == .done {
            Link(destination: site.url) { rowBody(site) }
                .buttonStyle(.junoPress)
        } else {
            rowBody(site)
        }
    }

    private func rowBody(_ site: JunoAIcssSearchSite) -> some View {
        HStack(spacing: 6) {
            bullet(site.state)
            Text(site.title)
                .junoFont(size: 12, relativeTo: .footnote, weight: .regular)
                .foregroundStyle(site.state == .pending ? Color.junoMutedForeground : Color.junoForeground)
                .lineLimit(1)
                .layoutPriority(1)
            Text("·")
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoMutedForeground)
            Text(site.label)
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoMutedForeground)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 18)
    }

    /// Dashed ring → globe → check, in one 12pt box.
    private func bullet(_ state: JunoAIcssSearchSite.State) -> some View {
        ZStack {
            JunoIconView(.circleDashed)
                .junoFont(size: 11, relativeTo: .caption)
                .foregroundStyle(Color.junoMutedForeground)
                .opacity(state == .pending ? 1 : 0)
            JunoIconView(.web)
                .junoFont(size: 11, relativeTo: .caption)
                .foregroundStyle(Color.junoMutedForeground)
                .opacity(state == .loading ? 1 : 0)
                .scaleEffect(state == .loading ? 1 : 0.85)
            JunoIconView(.circleCheck)
                .junoFont(size: 11, relativeTo: .caption)
                .foregroundStyle(Color.junoSuccess)
                .opacity(state == .done ? 1 : 0)
                .scaleEffect(state == .done ? 1 : 1.175)
        }
        .frame(width: 12, height: 12)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: state)
    }
}

#if DEBUG
#Preview("AIcss web search") {
    VStack(alignment: .leading, spacing: 24) {
        JunoAIcssWebSearch(
            query: "JWT auth vulnerabilities and middleware security best practices",
            sites: [
                .init(title: "JWT verification best practices", label: "auth0.com/blog/jwt-security", url: URL(string: "https://auth0.com/blog/jwt-security")!, state: .done),
                .init(title: "Node.js authentication guide", label: "owasp.org/www-project-nodejs-goat", url: URL(string: "https://owasp.org/www-project-nodejs-goat")!, state: .loading),
                .init(title: "JWT attacks · Web Security Academy", label: "portswigger.net/web-security/jwt", url: URL(string: "https://portswigger.net/web-security/jwt")!, state: .pending),
            ],
            settled: false
        )
    }
    .padding(20)
    .frame(width: 380, alignment: .leading)
    .background(Color.junoCanvas)
}
#endif
