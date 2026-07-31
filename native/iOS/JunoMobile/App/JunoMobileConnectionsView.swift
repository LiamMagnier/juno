import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// **Connections** — every app Juno can act through, in one searchable list.
///
/// The two backends are deliberately not separated. Juno's own integrations and
/// Composio's managed catalog have different plumbing, but from the reader's
/// side "connect Gmail" is one thought, and the web dashboard already learned
/// that splitting them made the page look broken whenever Composio was off.
/// Categories are the organising axis, exactly as on the web: the chips filter
/// the catalog server-side, and the first-party connectors carry a hand-mapped
/// category set so they never vanish when one is picked.
struct JunoMobileConnectionsView: View {
    @Bindable var model: NativeConnectorModel

    @State private var connectURL: URL?
    @State private var disconnectTarget: NativeConnector?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let backend = URL(string: JunoBackend.productionURLString)

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                JunoMobileQuietLoading()
            case .failed:
                ContentUnavailableView {
                    Label("connections.unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(model.lastErrorDescription ?? String(localized: "connections.retry"))
                } actions: {
                    Button("Retry") { Task { await model.refresh() } }
                        .buttonStyle(.borderedProminent)
                }
            case .ready:
                list
            }
        }
        .background(Color.junoCanvas)
        // The serif heading in the scroll view is this screen's title, exactly
        // as on the web. A second copy in the navigation bar was the same word
        // twice, 40pt apart.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $model.query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: Text("connections.search")
        )
        .refreshable { await model.refresh() }
        .sheet(item: $connectURL) { url in
            JunoMobileWebFlow(url: url) {
                connectURL = nil
                Task { await model.connectFlowFinished() }
            }
            .ignoresSafeArea()
        }
        .confirmationDialog(
            disconnectTarget.map { String(format: String(localized: "connections.disconnect.confirm"), $0.label) } ?? "",
            isPresented: Binding(
                get: { disconnectTarget != nil },
                set: { if !$0 { disconnectTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("connections.disconnect", role: .destructive) {
                guard let target = disconnectTarget else { return }
                disconnectTarget = nil
                Task { await model.disconnect(target) }
            }
            Button("Cancel", role: .cancel) { disconnectTarget = nil }
        } message: {
            Text("connections.disconnect.detail")
        }
        .accessibilityIdentifier("juno.mobile.connections")
    }

    // MARK: List

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10, pinnedViews: []) {
                header
                filters
                if let error = model.lastErrorDescription {
                    JunoInlineError(message: error) { Task { await model.refresh() } }
                }

                let connectors = model.visibleConnectors
                if connectors.isEmpty {
                    empty
                } else {
                    let connected = connectors.filter(\.connected)
                    let available = connectors.filter { !$0.connected }
                    if !connected.isEmpty {
                        JunoGroupLabel(text: String(localized: "connections.group.connected"))
                        ForEach(connected) { row($0) }
                    }
                    if !available.isEmpty {
                        JunoGroupLabel(
                            text: connected.isEmpty
                                ? String(localized: "connections.group.all")
                                : String(localized: "connections.group.available")
                        )
                        ForEach(available) { row($0) }
                    }
                }

                if let catalogError = model.catalogErrorDescription {
                    JunoInlineError(message: catalogError)
                }
                if model.catalogCursor != nil {
                    Button {
                        model.loadMoreCatalog()
                    } label: {
                        HStack {
                            Spacer()
                            if model.isLoadingCatalog {
                                ProgressView().controlSize(.small)
                            } else {
                                Text("connections.load-more")
                                    .font(.system(size: 15, weight: .semibold))
                            }
                            Spacer()
                        }
                        .frame(height: 44)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.junoAccent)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
            .animation(
                JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
                value: model.visibleConnectors.map(\.id)
            )
        }
    }

    private var header: some View {
        JunoPageTitle(title: "navigation.connections", subtitle: "connections.subtitle")
            .padding(.top, 6)
            .padding(.bottom, 2)
    }

    /// The Connected filter, then the category chips. Both are filters over one
    /// list rather than separate screens — the web page's shape.
    private var filters: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Juno's own switch rather than `.pickerStyle(.segmented)`, whose
            // selected segment takes the app tint and painted this filter coral.
            // The website's tabs are neutral — the accent belongs to actions.
            JunoMobileSegmented(
                options: [
                    JunoMobileSegmented<Bool>.Option(
                        false, String(localized: "connections.filter.all")
                    ),
                    JunoMobileSegmented<Bool>.Option(
                        true, String(localized: "connections.filter.connected")
                    ),
                ],
                selection: $model.showsConnectedOnly,
                accessibilityLabel: String(localized: "connections.filter")
            )

            if !model.categories.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        categoryChip(id: nil, label: String(localized: "connections.category.all"), count: nil)
                        ForEach(model.categories) { category in
                            categoryChip(
                                id: category.id, label: category.label, count: category.count
                            )
                        }
                    }
                    .padding(.vertical, 1)
                }
                .scrollIndicators(.hidden)
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .padding(.bottom, 2)
    }

    private func categoryChip(id: String?, label: String, count: Int?) -> some View {
        let active = model.selectedCategory == id
        return Button {
            model.selectedCategory = id
        } label: {
            HStack(spacing: 5) {
                Text(label).font(.system(size: 14, weight: .medium))
                if let count {
                    Text("\(count)")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(active ? .white.opacity(0.75) : .secondary)
                }
            }
            .foregroundStyle(active ? Color.white : Color.primary)
            .padding(.horizontal, 13)
            .frame(height: 32)
            .background(
                Capsule().fill(active ? Color.junoAccent : Color.primary.opacity(0.06))
            )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Image(systemName: "app.dashed")
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
            Text("connections.empty")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
    }

    // MARK: Row

    private func row(_ connector: NativeConnector) -> some View {
        JunoCard(padding: 14) {
            HStack(alignment: .center, spacing: 13) {
                JunoMobileConnectorTile(connector: connector)
                VStack(alignment: .leading, spacing: 2) {
                    Text(connector.label)
                        .font(.system(size: 16, weight: .semibold))
                        .lineLimit(1)
                    if connector.connected, let account = connector.accountLabel, !account.isEmpty {
                        Text(account)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    } else if let blocked = connector.blockedReason {
                        Text(blocked)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    } else if !connector.detail.isEmpty {
                        Text(connector.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 6)
                action(for: connector)
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func action(for connector: NativeConnector) -> some View {
        if connector.connected {
            Button {
                disconnectTarget = connector
            } label: {
                Text("connections.connected")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.junoAccent)
                    .padding(.horizontal, 13)
                    .frame(height: 32)
                    .background(Capsule().fill(Color.junoAccent.opacity(0.13)))
            }
            .buttonStyle(.plain)
            .disabled(model.isMutating)
            .accessibilityLabel(
                Text(String(format: String(localized: "connections.disconnect.label"), connector.label))
            )
        } else if connector.canConnect {
            Button {
                connectURL = connectURL(for: connector)
            } label: {
                Text("connections.connect")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 15)
                    .frame(height: 32)
                    .modifier(JunoAccentGlassCapsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                Text(String(format: String(localized: "connections.connect.label"), connector.label))
            )
        } else {
            // No button at all where Connect cannot work. A disabled control with
            // a tooltip is a desktop idiom; on a phone the reason belongs in the
            // row's own subtitle, which `blockedReason` already supplies.
            Image(systemName: "lock")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
    }

    /// The web OAuth entry point for this connector. Credentials connectors —
    /// Apple Mail, Apple Calendar, Apple Music — have no OAuth flow; the web
    /// dashboard collects their app-specific password in a dialog, and that is
    /// the flow this opens too rather than a redirect that would only bounce.
    private func connectURL(for connector: NativeConnector) -> URL? {
        guard let backend else { return nil }
        switch connector.source {
        case .native where connector.kind == "credentials":
            return backend.appendingPathComponent("connections")
        case .native:
            return backend
                .appendingPathComponent("api/connectors/\(connector.id)/connect")
        case .composio:
            guard let slug = connector.slug else { return nil }
            return backend
                .appendingPathComponent("api/connectors/composio/\(slug)/connect")
        }
    }
}

/// A connector's real brand mark on its own tile.
///
/// The mark itself is ``JunoConnectorMark`` from the design system — the same
/// type the Mac draws, so the two apps cannot disagree about what GitHub's logo
/// is. This view is only the tile around it.
///
/// It replaced a local version that did two things wrong, one per kind of
/// connector:
///
/// - **The apps Juno ships** (GitHub, Figma, Notion, the Apple three) carry no
///   `logoURL`, so they fell through to an **SF Symbol tinted coral** — a wrench
///   for Figma, `chevron.left.forwardslash.chevron.right` for GitHub. A generic
///   glyph standing in for a brand is the clearest tell that a screen was
///   assembled rather than designed: the reader knows what GitHub's mark looks
///   like, and that is not it. They now come from bundled artwork traced from
///   the website's own `connector-logos.tsx`.
/// - **The catalog's managed apps** (Gmail, Slack, Drive, Linear…) *do* carry a
///   `logoURL`, and it was handed to `AsyncImage` — which does not decode the
///   SVG most of them are served as. Every one of them showed the placeholder.
///   The shared mark fetches the bytes itself and builds a `UIImage`, which
///   handles SVG and raster alike, and caches the result so a scrolling
///   directory does not re-fetch a logo per row.
private struct JunoMobileConnectorTile: View {
    let connector: NativeConnector

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(Color.junoCanvas)
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
            JunoConnectorMark(
                connectorID: connector.id,
                connectorName: connector.label,
                logoURL: connector.logoURL,
                size: 22
            )
        }
        .frame(width: 40, height: 40)
        .accessibilityHidden(true)
    }
}

/// `sheet(item:)` needs an `Identifiable`, and a bare `URL` is the natural thing
/// to hold for a one-shot browser flow.
extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}
