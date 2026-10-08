import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

#if DEBUG
    import JunoPreviewSupport
#endif

/// **Connections** — every app Alevr can act through, in one searchable list.
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
    /// The app whose details are open: status, last used, what runs without
    /// asking, Disconnect (`app-detail-sheet.tsx`).
    @State private var appDetail: NativeAppDetailModel?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let backend = URL(string: JunoBackend.productionURLString)

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                JunoMobileQuietLoading()
            case .failed:
                ContentUnavailableView {
                    Label("connections.unavailable", icon: .triangleAlert, size: 44)
                } description: {
                    Text(model.lastErrorDescription ?? String(localized: "connections.retry"))
                } actions: {
                    Button("Retry") { Task { await model.refresh() } }
                        .buttonStyle(.bordered)
                        .contentShape(.rect)
                }
            case .ready:
                list
            }
        }
        // The page names itself in the navigation bar, as a large title in the
        // display face, so the search field sits under the title rather than
        // above it and the name collapses into the bar on scroll.
        .navigationTitle("navigation.connections")
        .navigationBarTitleDisplayMode(.large)
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
        .sheet(item: $appDetail) { detail in
            JunoMobileAppDetailView(
                detail: detail,
                disconnect: {
                    appDetail = nil
                    disconnectTarget = detail.connector
                },
                close: { appDetail = nil }
            )
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
            .contentShape(.rect)
            Button("Cancel", role: .cancel) { disconnectTarget = nil }
            .contentShape(.rect)
        } message: {
            Text("connections.disconnect.detail")
        }
        .accessibilityIdentifier("juno.mobile.connections")
        #if DEBUG
            .task(id: model.phase) {
                guard model.phase == .ready, appDetail == nil,
                    let id = JunoPreviewEnvironment.initialAppDetail,
                    let connector = model.linked.first(where: { $0.id == id })
                else { return }
                appDetail = model.makeAppDetailModel(for: connector)
            }
        #endif
    }

    // MARK: List

    private var list: some View {
        List {
            Section {
                JunoMobileCustomizeLinks()
            } header: {
                Text("connections.subtitle")
                    .textCase(nil)
            }

            Section {
                Picker("connections.filter", selection: $model.showsConnectedOnly) {
                    Text("connections.filter.all").tag(false)
                    Text("connections.filter.connected").tag(true)
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
                if !model.categories.isEmpty {
                    Picker("Category", selection: $model.selectedCategory) {
                        Text("connections.category.all").tag(String?.none)
                        ForEach(model.categories) { category in
                            Text(category.label).tag(Optional(category.id))
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("juno.mobile.connections-category")
                }
            }

            if let error = model.lastErrorDescription {
                Section {
                    Label(verbatim: error, icon: .triangleAlert)
                        .foregroundStyle(.secondary)
                    Button("Retry") { Task { await model.refresh() } }
                }
            }

            let connectors = model.visibleConnectors
            if connectors.isEmpty {
                Section {
                    Text("connections.empty")
                        .foregroundStyle(.secondary)
                }
            } else {
                let connected = connectors.filter(\.connected)
                let available = connectors.filter { !$0.connected }
                if !connected.isEmpty {
                    Section("connections.group.connected") {
                        ForEach(connected) { row($0) }
                    }
                }
                if !available.isEmpty {
                    Section(connected.isEmpty ? "connections.group.all" : "connections.group.available") {
                        ForEach(available) { row($0) }
                    }
                }
            }

            if model.catalogErrorDescription != nil || model.catalogCursor != nil {
                Section {
                    if let catalogError = model.catalogErrorDescription {
                        Text(catalogError).foregroundStyle(.secondary)
                    }
                    if model.catalogCursor != nil {
                        Button {
                            model.loadMoreCatalog()
                        } label: {
                            HStack {
                                Text("connections.load-more")
                                Spacer()
                                if model.isLoadingCatalog { ProgressView() }
                            }
                            .contentShape(.rect)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .junoGroupedPage()
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
            value: model.visibleConnectors.map(\.id)
        )
    }

    // MARK: Row

    /// One app as a stock row: its mark, its name, a quiet second line, and
    /// either a chevron into its details (connected) or Connect.
    @ViewBuilder
    private func row(_ connector: NativeConnector) -> some View {
        if connector.connected {
            Button {
                appDetail = model.makeAppDetailModel(for: connector)
            } label: {
                HStack(spacing: 12) {
                    rowLabel(connector)
                    JunoIconView(.chevronRight, size: 13)
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(model.isMutating)
            .accessibilityLabel("\(connector.label) details")
            .accessibilityIdentifier("juno.mobile.connections-details.\(connector.id)")
        } else {
            HStack(spacing: 12) {
                rowLabel(connector)
                if connector.canConnect {
                    Button("connections.connect") {
                        connectURL = connectURL(for: connector)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .accessibilityLabel(
                        Text(String(format: String(localized: "connections.connect.label"), connector.label))
                    )
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                } else {
                    // No button where Connect cannot work; the reason is the
                    // row's own subtitle.
                    JunoIconView(.lock, size: 16)
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            .accessibilityElement(children: .contain)
        }
    }

    private func rowLabel(_ connector: NativeConnector) -> some View {
        HStack(spacing: 12) {
            JunoMobileConnectorTile(connector: connector)
            VStack(alignment: .leading, spacing: 2) {
                Text(connector.label)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                if connector.connected, let account = connector.accountLabel, !account.isEmpty {
                    Text(account)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if let blocked = connector.blockedReason {
                    Text(blocked)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                } else if !connector.detail.isEmpty {
                    Text(connector.detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
        case .custom:
            // A custom MCP server signs in on its own page, as on the Mac.
            return NativeCustomConnectorPath.connectURL(backend: backend, id: connector.id)
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
        JunoConnectorMark(
            connectorID: connector.id,
            connectorName: connector.label,
            logoURL: connector.logoURL,
            size: 24
        )
        .frame(width: 32, height: 32)
        .accessibilityHidden(true)
    }
}

/// `sheet(item:)` needs an `Identifiable`, and a bare `URL` is the natural thing
/// to hold for a one-shot browser flow.
extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

// MARK: - App details

/// **An app's details** (`app-detail-sheet.tsx`): status, last used, what
/// Alevr may do without asking (each grant revocable back to Ask first), and
/// Disconnect. A native inset-grouped list; every line is a real server state.
struct JunoMobileAppDetailView: View {
    @Bindable var detail: NativeAppDetailModel
    let disconnect: () -> Void
    let close: () -> Void

    private var connector: NativeConnector { detail.connector }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Status", value: connector.connected ? "Connected" : "Not connected")
                    if let account = connector.accountLabel, !account.isEmpty, account != connector.label {
                        LabeledContent("Account", value: account)
                    }
                    LabeledContent("Last used") { lastUsed }
                }

                Section {
                    grants
                } header: {
                    Text("What Alevr can do without asking")
                } footer: {
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        Text("Anything that changes something in \(connector.label) asks you first, unless you chose to allow it here.")
                        if let error = detail.grantError {
                            Label(verbatim: error, icon: .triangleAlert)
                                .foregroundStyle(.red)
                        }
                    }
                }

                if connector.connected {
                    Section {
                        Button(role: .destructive, action: disconnect) {
                            Text(connector.isCustomMCP ? "Remove \(connector.label)" : "Disconnect \(connector.label)")
                        }
                        .accessibilityIdentifier("juno.mobile.connections-detail-disconnect")
                    } footer: {
                        Text(detail.consequence)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(connector.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: close)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await detail.load() }
        .accessibilityIdentifier("juno.mobile.connections-detail")
    }

    @ViewBuilder
    private var lastUsed: some View {
        switch detail.usage {
        case .loading:
            ProgressView()
        case .loaded(nil):
            Text("Not used yet")
                .foregroundStyle(.secondary)
        case .loaded(let usage?):
            Text(usage.line())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
    }

    @ViewBuilder
    private var grants: some View {
        if let grants = detail.grants {
            if grants.isEmpty {
                Text("Nothing. Every change asks first.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(grants) { grant in
                    HStack(spacing: JunoSpace.cozy) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(grant.action)
                            Text(grant.scopeLine)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: JunoSpace.snug)
                        if detail.revokingID == grant.id {
                            ProgressView()
                        } else {
                            Button("Ask first") { Task { await detail.revoke(grant) } }
                                .buttonStyle(.borderless)
                                .disabled(detail.revokingID != nil)
                                .accessibilityLabel("Revoke \(grant.action)")
                                .contentShape(.rect)
                        }
                    }
                }
            }
        } else {
            HStack(spacing: JunoSpace.snug) {
                ProgressView()
                Text("Loading…").foregroundStyle(.secondary)
            }
        }
    }
}
