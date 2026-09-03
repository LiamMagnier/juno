import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// **Connections** — every app Juno can act through, as the website's directory
/// of cards rather than a source list with an inspector.
///
/// Two backends, one list. Juno's own integrations and Composio's managed catalog
/// have different plumbing, but "connect Gmail" is one thought, and the web
/// dashboard already learned that rendering them as two sections made the page
/// look broken whenever Composio was unconfigured.
///
/// **Why this is a grid of raised cards and no longer a list plus an inspector.**
/// The list painted its rows straight onto the window's warm canvas, so the whole
/// page read as one flat cream field — the opposite of the web, which puts white
/// `--card` tiles *over* `--background`. And the trailing inspector spent a third
/// of the window restating one connector's two sentences, which meant the reader
/// paid that width permanently to read something the card can carry inline. Every
/// sentence the inspector held now lives somewhere it is always visible: the
/// server's own capability line is the card's subtitle, how the authorisation
/// round trip works is the Connect button's tooltip, and the account-wide caveat
/// is the page's closing note — the same three places the website puts them.
///
/// **The one control this page does not put in the toolbar is search.**
/// Connections is the only account page the app renders inside *two* different
/// shells — Chat's window and Juno Code's — and Code's detail column already
/// spends the window's single search field on its sessions. This page carries its
/// own field instead, which is a crash fix rather than a preference;
/// ``searchField`` has the report.
struct DesktopConnectionsScreen: View {
    @Bindable var model: NativeConnectorModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var disconnectTarget: NativeConnector?
    /// The connector whose authorisation page this app has opened in the browser.
    ///
    /// Held so the card can say "waiting" without claiming a result, and so
    /// returning to the app re-reads the state only when a flow was actually
    /// started — window focus alone is not evidence that anything changed.
    @State private var awaitingAuthorization: String?

    private let backend = URL(string: JunoBackend.productionURLString)

    var body: some View {
        content
            .toolbar { toolbar }
            .confirmationDialog(
                disconnectTarget.map { "Disconnect \($0.label)?" } ?? "",
                isPresented: Binding(
                    get: { disconnectTarget != nil },
                    set: { if !$0 { disconnectTarget = nil } }
                ),
                titleVisibility: .visible,
                presenting: disconnectTarget
            ) { target in
                Button("Disconnect", role: .destructive) {
                    disconnectTarget = nil
                    Task { await model.disconnect(target) }
                }
                Button("Cancel", role: .cancel) { disconnectTarget = nil }
            } message: { target in
                Text(
                    "Juno will lose access to your \(target.label) account and chats will stop offering its tools. You can reconnect at any time."
                )
            }
            // The authorisation round trip happens in the browser and ends on
            // Juno's own web page, so nothing reports back into this process. The
            // only honest move on return is to re-read the state rather than
            // assume the reader completed it.
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, awaitingAuthorization != nil else { return }
                awaitingAuthorization = nil
                Task { await model.connectFlowFinished() }
            }
            .accessibilityIdentifier("juno.desktop.connections")
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading connections")
        case .failed:
            JunoEmptyState(
                title: "Connections unavailable",
                message: DesktopStatusCopy(subject: "connections", singular: "connection")
                    .humanized(
                        model.lastErrorDescription,
                        fallback: "Juno could not read this account's connections."
                    ),
                icon: .triangleAlert,
                actionLabel: "Try again",
                action: { Task { await model.refresh() } }
            )
        case .ready:
            directory
        }
    }

    /// The page. `JunoDetailPage` is what keeps it from resizing the window: a
    /// detail column reports an ideal height upward and `NavigationSplitView`
    /// grows its split view to satisfy it, so a catalog page of eighty cards would
    /// otherwise push the sidebar off-screen rather than simply scrolling.
    private var directory: some View {
        JunoDetailPage(maxWidth: DesktopConnectorGrid.pageWidth) {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                header
                notices
                filters
                results
                loadMore
                footnote
            }
            .animation(
                JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
                value: connectedIDs
            )
        }
    }

    /// The web's page head: the editorial serif line, one sentence of what this
    /// page is for, and the count. The window's own title already says
    /// "Connections", so the heading here is the website's sentence rather than
    /// the same word a second time forty points lower.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Connect your tools")
                    .junoPageHeading()
                Text(
                    "Link an app so Juno can work with your repositories, designs, docs, and workspace tools."
                )
                .font(.callout)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: JunoSpace.snug)
            if model.connectedCount > 0 {
                Text("\(model.connectedCount) connected")
                    .font(.junoCodeSmall)
                    .junoSecondaryInk()
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.tight)
                    .background(Capsule(style: .continuous).fill(Color.junoMuted))
                    .fixedSize()
                    .accessibilityLabel("\(model.connectedCount) apps connected")
            }
        }
    }

    // MARK: Filters

    /// The two ways into a catalog of a thousand apps, as one block. They are a
    /// pair — a name and a kind — so the gap between them is a control's gap and
    /// not a section's.
    private var filters: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            searchField
            categories
        }
    }

    /// Search, as a field in the page rather than as a `.searchable`.
    ///
    /// **This is a crash fix, not a layout preference.** Connections is the only
    /// account page rendered inside two different shells, and Juno Code's detail
    /// column already declares `.searchable(…, prompt: "Search sessions")` on the
    /// whole column this page occupies (``DesktopCodeWorkspace``). SwiftUI serves
    /// one search field per navigation container, so a second one nested inside
    /// that column is not a cosmetic collision: selecting Connections in the Code
    /// window threw out of AppKit's layout pass and took SIGTRAP every time.
    /// Making the *shell's* field conditional would trade one crash for the
    /// other — adding and removing a `.searchable` rebuilds the AppKit toolbar
    /// under a live window, which is the rebuild that drove that shell's
    /// split-view constraint loop, and the reason every item in ``toolbar`` is
    /// present in every state.
    ///
    /// ``DesktopArtifactsScreen`` had already reached the same field for the
    /// milder version of the reason: a `.searchable` renders in the *window's*
    /// titlebar, where a control that filters one page's directory reads as
    /// searching the whole window.
    ///
    /// It also closes a hole the toolbar field left open. `NativeConnectorModel`
    /// is a single instance shared by every window, and `query` drives a
    /// server-side catalog reload — so a word typed here and left behind used to
    /// empty the directory in the *other* window, which had no field bound to it
    /// and therefore no way to clear it. The filter is now visible, and
    /// clearable, wherever the page is being read.
    ///
    /// The shape is the web's own: `connector-directory.tsx` draws a `bg-card`
    /// input with a leading magnifier immediately above the category chips, which
    /// is where this one now sits. The titlebar was the divergence, not this.
    private var searchField: some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(.search, size: DesktopConnectorGrid.searchGlyphSize)
                .junoSecondaryInk()
                .accessibilityHidden(true)
            // The web's placeholder, which names three apps rather than repeating
            // the label: what a reader needs to know here is that the field
            // searches a catalog of apps, not that it is a search field.
            TextField("Search Gmail, Slack, GitHub…", text: $model.query)
                .textFieldStyle(.plain)
                .accessibilityLabel("Search apps")
                .accessibilityIdentifier("connections.search")
            if !model.query.isEmpty {
                // An SF Symbol on purpose: clearing a field is an OS affordance
                // and this is the glyph macOS already uses for it, where the
                // magnifier beside it names a thing the product has a mark for.
                Button {
                    model.query = ""
                } label: {
                    JunoIconView(.circleX)
                        .junoMetaInk()
                }
                .buttonStyle(.plain)
                .help("Clear the search")
                .accessibilityLabel("Clear search")
                .accessibilityIdentifier("connections.search.clear")
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: DesktopConnectorGrid.chipHeight)
        // Raised and bordered, not a filled pill: the chips below are filters and
        // read as one control each, while this is somewhere to type. `junoCard`
        // would be wrong for the same reason — it throws a shadow, and an input
        // is not a card floating over the page.
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .fill(Color.junoRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
        .frame(maxWidth: DesktopConnectorGrid.searchFieldWidth, alignment: .leading)
    }

    /// Composio ships around a thousand toolkits, so categories are the only thing
    /// between the reader and an endlessly-paged flat list — which is why they are
    /// a visible row here rather than a menu in the toolbar, exactly as on the web.
    /// Hidden on the Connected filter: that set is small enough to read whole, and
    /// the catalog endpoint cannot narrow it by category.
    @ViewBuilder
    private var categories: some View {
        if !model.categories.isEmpty, !model.showsConnectedOnly {
            ScrollView(.horizontal) {
                HStack(spacing: JunoSpace.tight) {
                    categoryChip(id: nil, label: "All categories", count: nil)
                    ForEach(model.categories) { category in
                        categoryChip(
                            id: category.id,
                            label: category.label,
                            count: category.count
                        )
                    }
                }
                .padding(.vertical, JunoSpace.hairline)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            .accessibilityLabel("Filter by category")
        }
    }

    /// A filled pill, never an outlined one. Ten outlined chips read as ten boxes
    /// competing with the cards below; a filled set reads as one control. Selected
    /// inverts to the label colour on the canvas colour — the web's
    /// `bg-foreground text-background` — rather than going coral, which is spent
    /// on primary actions and never on a filter.
    private func categoryChip(id: String?, label: String, count: Int?) -> some View {
        let active = model.selectedCategory == id
        return Button {
            model.selectedCategory = active ? nil : id
        } label: {
            HStack(spacing: JunoSpace.hairline) {
                Text(label)
                    .font(.callout.weight(.medium))
                if let count {
                    Text(count, format: .number)
                        .font(.junoCodeSmall)
                        .foregroundStyle(active ? Color.junoCanvasWarm : Color.junoMutedForeground)
                }
            }
            .foregroundStyle(active ? Color.junoCanvasWarm : Color.junoForeground)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: DesktopConnectorGrid.chipHeight)
            .background(
                Capsule(style: .continuous)
                    .fill(active ? AnyShapeStyle(Color.primary) : AnyShapeStyle(Color.junoMuted))
            )
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("connections.category.\(id ?? "all")")
    }

    // MARK: Results

    /// Connected first, then everything else. The two sets answer different
    /// questions — "what can Juno already do" and "what could it do" — and the web
    /// separates them with its Connected filter; on a window this wide both fit at
    /// once, so they are two labelled bands instead of two tabs.
    @ViewBuilder
    private var results: some View {
        if connectedConnectors.isEmpty, availableConnectors.isEmpty {
            emptyState
                .frame(maxWidth: .infinity)
                .padding(.vertical, JunoSpace.region)
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                if !connectedConnectors.isEmpty {
                    section("Connected · \(connectedConnectors.count)", connectedConnectors)
                }
                if !availableConnectors.isEmpty {
                    // No count on this band: it holds one page of a catalog with
                    // hundreds more behind the cursor, so a number here would be a
                    // lie about how many apps exist.
                    section(
                        connectedConnectors.isEmpty ? "All apps" : "Available",
                        availableConnectors
                    )
                }
            }
        }
    }

    private func section(_ title: String, _ connectors: [NativeConnector]) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text(title)
                .junoSidebarSection()
            LazyVGrid(columns: DesktopConnectorGrid.columns, alignment: .leading, spacing: JunoSpace.regular) {
                ForEach(connectors) { card($0) }
            }
        }
    }

    /// One app, as a raised white tile on the warm canvas.
    ///
    /// This is the difference the brief is about: the canvas is a backdrop and the
    /// thing a reader actually reads sits on ``SwiftUI/View/junoCard(cornerRadius:)``
    /// above it. Solid, never glass — glass is reserved for chrome that floats.
    private func card(_ connector: NativeConnector) -> some View {
        let cardState = state(connector)
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                DesktopConnectorMark(connector: connector)

                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(connector.label)
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)
                    Text(descriptionText(connector, state: cardState))
                        .junoCaption()
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: JunoSpace.snug)
                DesktopConnectorStatusPill(state: cardState)
            }

            Spacer(minLength: 0)
            action(connector, state: cardState)
        }
        // Padding inside the sizing frame, never outside it: "everything plus 16"
        // is the unsatisfiable ask that makes a split view oversize its window.
        .padding(JunoSpace.regular)
        .frame(minHeight: DesktopConnectorGrid.cardMinimumHeight, alignment: .top)
        .junoCard(cornerRadius: JunoRadius.card)
        .contextMenu { cardMenu(connector, state: cardState) }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func action(_ connector: NativeConnector, state: DesktopConnectorState) -> some View {
        switch state {
        case .connected:
            wideButton("Disconnect", role: .destructive) { disconnectTarget = connector }
                .disabled(model.isMutating)
                .help("Revoke Juno's access to \(connector.label)")
                .accessibilityLabel("Disconnect \(connector.label)")
                .accessibilityIdentifier("connections.disconnect.\(connector.id)")

        case .available, .connecting:
            wideButton(state == .connecting ? "Waiting for your browser…" : "Connect") {
                beginAuthorization(connector)
            }
            .disabled(state == .connecting)
            .help(authorizationText(connector))
            .accessibilityLabel("Connect \(connector.label)")
            .accessibilityIdentifier("connections.connect.\(connector.id)")

        case .setup:
            // Composio hosts no shared OAuth app for this toolkit, so its connect
            // endpoint 400s until an auth config exists. The dashboard is where
            // that is created, which is the only action that can move this card on
            // — a Connect button here is guaranteed to bounce.
            wideButton("Set up in Composio…") {
                guard let url = composioSetupURL(connector) else { return }
                NSWorkspace.shared.open(url)
            }
            .disabled(composioSetupURL(connector) == nil)
            .help(
                "Composio has no shared sign-in for \(connector.label). Add your own \(connector.label) app credentials in the Composio dashboard, then connect it here."
            )
            .accessibilityIdentifier("connections.setup.\(connector.id)")

        case .unavailable:
            // Deliberately no control. A button that is guaranteed to fail is
            // worse than a sentence saying why there isn't one.
            Text("The Juno server this app talks to has no OAuth app for \(connector.label) yet.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The same actions for a right-click, plus the identifier the retired
    /// inspector used to expose. No accessibility identifiers here: two controls
    /// answering to one identifier makes a UI test ambiguous.
    @ViewBuilder
    private func cardMenu(_ connector: NativeConnector, state: DesktopConnectorState) -> some View {
        switch state {
        case .connected:
            Button("Disconnect \(connector.label)", role: .destructive) {
                disconnectTarget = connector
            }
            .disabled(model.isMutating)
        case .available, .connecting:
            Button("Connect \(connector.label)") { beginAuthorization(connector) }
                .disabled(state == .connecting)
        case .setup:
            if let url = composioSetupURL(connector) {
                Button("Set up in Composio…") { NSWorkspace.shared.open(url) }
            }
        case .unavailable:
            EmptyView()
        }
        Divider()
        Button("Copy identifier") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(connector.id, forType: .string)
        }
    }

    private func wideButton(
        _ title: String,
        role: ButtonRole? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            Text(title)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
    }

    @ViewBuilder
    private var loadMore: some View {
        if model.catalogCursor != nil {
            HStack {
                Spacer()
                Button {
                    model.loadMoreCatalog()
                } label: {
                    if model.isLoadingCatalog {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Load more apps")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(model.isLoadingCatalog)
                .accessibilityLabel("Load more apps")
                .accessibilityIdentifier("connections.load-more")
                Spacer()
            }
        }
    }

    /// The account-wide caveat the inspector used to repeat per connector. It is
    /// the same fact for every app, so it belongs once, at the foot of the page —
    /// which is where the website puts it.
    private var footnote: some View {
        Text(
            "A connected app is offered to the model only when you pick it in a chat's composer. Each provider shows the exact permissions on its own consent screen before you approve."
        )
        .junoCaption()
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Every one of these names a thing the website has a mark for — a connector
    /// and a search — so they use those rather than SF's `powerplug` and
    /// `magnifyingglass`. The category state is the exception: a category is a
    /// filter this screen invented for the Mac's wider column, and the web draws
    /// it with no glyph at all, so it keeps the platform's own grid symbol rather
    /// than borrowing a mark that names something else.
    @ViewBuilder
    private var emptyState: some View {
        if model.showsConnectedOnly {
            JunoEmptyState(
                title: "No connected apps",
                message: "Connect an app and Juno can work with it from a chat.",
                icon: .connections,
                actionLabel: "Show all apps",
                action: { model.showsConnectedOnly = false }
            )
        } else if !trimmedQuery.isEmpty {
            JunoEmptyState(
                title: "No matching apps",
                message: "Nothing matches “\(trimmedQuery)”.",
                icon: .search,
                actionLabel: "Clear search",
                action: { model.query = "" }
            )
        } else if model.selectedCategory != nil {
            JunoEmptyState(
                title: "No apps in this category",
                message: "The managed catalog returned nothing for this category.",
                icon: .grid,
                actionLabel: "All categories",
                action: { model.selectedCategory = nil }
            )
        } else {
            JunoEmptyState(
                title: "No apps available",
                message: "This account has no connectors to show.",
                icon: .connections,
                actionLabel: "Refresh",
                action: { Task { await model.refresh() } }
            )
        }
    }

    // MARK: Notices

    /// Failures and server-configuration facts, as cards in the page's own flow so
    /// an empty result and an outage are never confused for one another.
    @ViewBuilder
    private var notices: some View {
        if hasNotice {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                if let error = model.lastErrorDescription, model.phase == .ready {
                    DesktopConnectionsNotice(
                        message: DesktopStatusCopy(
                            subject: "connections",
                            singular: "connection"
                        ).humanized(
                            error,
                            fallback: "Juno couldn't refresh your connections."
                        ),
                        icon: .triangleAlert,
                        tint: Color.junoDanger,
                        actionLabel: "Try again"
                    ) {
                        Task { await model.refresh() }
                    }
                }
                if !model.composioConfigured, model.phase == .ready {
                    // The website tells its reader to set `COMPOSIO_API_KEY` on the
                    // server, because whoever is looking at that page is usually
                    // running it. A Mac reader is a client of Juno's hosted backend
                    // and cannot edit its environment, so this states the fact and
                    // stops rather than handing out an instruction they cannot act on.
                    DesktopConnectionsNotice(
                        message: "The managed app directory is off on this server, so only the apps built into Juno are listed.",
                        icon: .about,
                        tint: Color.junoCaution
                    )
                }
                if let catalogError = model.catalogErrorDescription {
                    DesktopConnectionsNotice(
                        message: "The managed app directory could not be read: \(catalogError)",
                        icon: .triangleAlert,
                        tint: Color.junoCaution,
                        actionLabel: "Try again"
                    ) {
                        Task { await model.refresh() }
                    }
                }
            }
        }
    }

    private var hasNotice: Bool {
        if model.catalogErrorDescription != nil { return true }
        guard model.phase == .ready else { return false }
        return model.lastErrorDescription != nil || !model.composioConfigured
    }

    // MARK: Toolbar

    /// Every item is present in every state and disables rather than vanishing: a
    /// `ToolbarItem` that comes and goes makes SwiftUI rebuild the AppKit toolbar
    /// under a live window, which is what drove this shell's split-view constraint
    /// loop. Neither the category filter nor the search field is here — both are
    /// the page's own controls, where the reader can see what is filtering the
    /// results; ``searchField`` says why that is load-bearing rather than tidy.
    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Picker("Show", selection: $model.showsConnectedOnly) {
                Text("All apps").tag(false)
                Text("Connected").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .help("Show every app, or only the ones this account has connected")
            .accessibilityLabel("Filter apps")
            .accessibilityIdentifier("connections.filter")
        }

        ToolbarItem(placement: .primaryAction) {
            Button {
                // Also the way out of a stuck wait: if the browser never hands
                // focus back to this app, a card must not sit on "waiting" for
                // the rest of the session.
                awaitingAuthorization = nil
                Task { await model.refresh() }
            } label: {
                Label("Refresh", icon: .refresh)
            }
            .keyboardShortcut("r", modifiers: .command)
            .help("Re-read this account's connections (⌘R)")
            .accessibilityLabel("Refresh connections")
            .accessibilityIdentifier("connections.refresh")
        }
    }

    // MARK: Data

    private var trimmedQuery: String {
        model.query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var connectedConnectors: [NativeConnector] {
        model.visibleConnectors.filter(\.connected)
    }

    private var availableConnectors: [NativeConnector] {
        model.visibleConnectors.filter { !$0.connected }
    }

    /// Animating on the connected set alone. Animating on the whole visible list
    /// would re-run the transition on every keystroke of a server-side search,
    /// which is churn; connecting and disconnecting is the change worth showing.
    private var connectedIDs: [String] {
        connectedConnectors.map(\.id)
    }

    /// True for a connector that came from `/api/connectors`, whose `detail` is
    /// the server's own capability sentence. Catalog rows carry no such sentence.
    private func isLinkedEntry(_ connector: NativeConnector) -> Bool {
        model.linked.contains { $0.id == connector.id }
    }

    private func isAwaiting(_ connector: NativeConnector) -> Bool {
        awaitingAuthorization == connector.id
    }

    private func state(_ connector: NativeConnector) -> DesktopConnectorState {
        if connector.connected { return .connected }
        if isAwaiting(connector) { return .connecting }
        // The two halves of `NativeConnector.canConnect`, told apart because they
        // need different words and different actions: a first-party connector is
        // missing an OAuth app on Juno's server, a catalog app is missing one in
        // Composio and the reader can add it themselves.
        switch connector.source {
        case .native where !connector.configured: return .unavailable
        case .composio where !connector.managedAuth: return .setup
        default: return .available
        }
    }

    /// The card's second line. Mirrors the website's `description`, with one
    /// native-only guard: `NativeConnector.detail` for a *catalog* row is a
    /// localized key resolved through the main bundle, and this app ships no
    /// string catalog, so rendering it would draw "connections.composio.detail"
    /// into the window. Only a `/api/connectors` entry carries real server prose.
    private func descriptionText(
        _ connector: NativeConnector,
        state: DesktopConnectorState
    ) -> String {
        switch state {
        case .connected:
            if let account = connector.accountLabel, !account.isEmpty,
                account != connector.label
            {
                return account
            }
            return "Connected and ready"
        case .connecting:
            return "Finishing in your browser…"
        case .unavailable:
            return "Not set up on this Juno server"
        case .setup:
            return "Needs its own app credentials in Composio"
        case .available:
            if isLinkedEntry(connector), !connector.detail.isEmpty { return connector.detail }
            return "Available to connect"
        }
    }

    private func authorizationText(_ connector: NativeConnector) -> String {
        switch connector.source {
        case .native where connector.kind == "credentials":
            return "\(connector.label) signs in with an app-specific password. Juno opens your Connections page in your browser to collect it — passwords are never typed into this app."
        case .native:
            return "Juno opens \(connector.label)'s authorisation page in your browser. You approve the permissions there, and Juno keeps only the resulting token, encrypted."
        case .composio:
            return "Juno opens \(connector.label)'s authorisation page in your browser through Composio, the managed connector service. You approve the permissions there."
        }
    }

    // MARK: Actions

    /// Opens the connector's authorisation page in the reader's own browser.
    ///
    /// Not `ASWebAuthenticationSession`, which is right for signing in to Juno:
    /// that API completes on a custom-scheme callback, and a connector's OAuth
    /// round trip ends on Juno's *web* `/connections` page instead — the session
    /// would sit there forever waiting for a callback that never arrives. The
    /// browser also already holds the Juno session cookie these routes need.
    private func beginAuthorization(_ connector: NativeConnector) {
        guard connector.canConnect, let url = authorizationURL(for: connector) else { return }
        awaitingAuthorization = connector.id
        NSWorkspace.shared.open(url)
    }

    private func authorizationURL(for connector: NativeConnector) -> URL? {
        guard let backend else { return nil }
        switch connector.source {
        // Credentials connectors have no OAuth redirect to follow; the web
        // dashboard collects their app-specific password in a dialog, so that is
        // the page to open rather than a redirect that would only bounce.
        case .native where connector.kind == "credentials":
            return backend.appendingPathComponent("connections")
        case .native:
            return backend.appendingPathComponent("api/connectors/\(connector.id)/connect")
        case .composio:
            guard let slug = connector.slug else { return nil }
            return backend.appendingPathComponent("api/connectors/composio/\(slug)/connect")
        }
    }

    private func composioSetupURL(_ connector: NativeConnector) -> URL? {
        guard let slug = connector.slug,
            let marketplace = URL(string: "https://platform.composio.dev/marketplace")
        else { return nil }
        return marketplace.appendingPathComponent(slug)
    }
}

/// What a connector's card is saying right now. The same five states the web
/// directory names, so the two surfaces cannot drift into different vocabularies.
private enum DesktopConnectorState: Equatable {
    case connected
    /// This app opened the authorisation page and has not been back yet. A local
    /// fact about what the app did, never a claim about what the provider decided.
    case connecting
    case available
    /// Composio hosts no shared OAuth app for the toolkit; the reader can add one.
    case setup
    /// This Juno server has no OAuth app for a first-party connector.
    case unavailable
}

/// Grid and card geometry.
///
/// Named here rather than inline for the reason ``JunoSidebarMetrics`` exists: a
/// number that decides how many columns a window shows deserves to say what it is
/// for, and the alternative is the same literal drifting apart in four places.
private enum DesktopConnectorGrid {
    /// The web's `max-w-5xl` reading measure, so a wide window keeps three columns
    /// of readable cards rather than stretching them across the whole display.
    static let pageWidth: CGFloat = 1024
    /// Narrow enough that the sidebar can stay open on a laptop and still show two
    /// columns; wide enough that a card never becomes a banner on a large display.
    static let minimumCardWidth: CGFloat = 268
    static let maximumCardWidth: CGFloat = 420
    /// Matches the website's card skeleton, so a one-line and a two-line
    /// description do not make neighbouring cards different heights.
    static let cardMinimumHeight: CGFloat = 138
    /// The web's `size-10` app logo well.
    static let markSize: CGFloat = 40
    /// The mark inside that well — the web's `h-[22px]` glyph, leaving an even
    /// inset on all four sides.
    static let markGlyphSize: CGFloat = 22
    static let chipHeight: CGFloat = 30
    /// The search field, capped rather than stretched: a field the width of a
    /// 1024pt page invites a sentence, and what this one takes is one app's name.
    /// Its height is the chip's, so search and categories read as one filter block.
    static let searchFieldWidth: CGFloat = 320
    /// The magnifier inside it. Lucide's 2pt stroke at caption size — smaller than
    /// ``JunoIconView``'s sidebar default, which would outweigh the field's text.
    static let searchGlyphSize: CGFloat = 14
    /// A status dot. Small enough to read as punctuation beside its label.
    static let statusDot: CGFloat = 6

    static let columns: [GridItem] = [
        GridItem(
            .adaptive(minimum: minimumCardWidth, maximum: maximumCardWidth),
            spacing: JunoSpace.regular,
            alignment: .top
        )
    ]
}

/// A connector's logo, as an inset well on the card.
///
/// The mark itself is ``JunoConnectorMark``, which prefers the real installed
/// Mac app's icon, then the same brand artwork the website ships, and only
/// falls back to a monogram for a service this build has never heard of. This
/// view owns nothing but the well around it.
///
/// The catalog's remote `logoURL` still wins when the server supplies one — that
/// is the connector's own artwork and is more current than anything compiled in
/// — but it is no longer the *only* source, which is what left the built-in
/// connectors showing SF Symbols.
private struct DesktopConnectorMark: View {
    let connector: NativeConnector

    var body: some View {
        ZStack {
            // The canvas colour inside a white card, so the mark reads as an inset
            // well rather than as a second card floating on the first.
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .fill(Color.junoCanvasWarm)
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(Color.junoBorder)
            content
        }
        .frame(width: DesktopConnectorGrid.markSize, height: DesktopConnectorGrid.markSize)
        .accessibilityHidden(true)
    }

    /// One mark, one fallback chain.
    ///
    /// The `AsyncImage` that used to live here is gone: it could not decode the
    /// SVG logos the managed catalog serves, so every Composio app fell back to
    /// a monogram, and its placeholder made "loading" and "failed" look
    /// identical. ``JunoConnectorMark`` now owns the whole order — the real
    /// installed Mac app's icon, then Juno's bundled brand artwork, then the
    /// catalog's own logo, then a monogram — so there is one place to reason
    /// about what a connector looks like.
    private var content: some View {
        JunoConnectorMark(
            connectorID: connector.id,
            connectorName: connector.label,
            logoURL: connector.logoURL,
            size: DesktopConnectorGrid.markGlyphSize
        )
    }
}

/// The card's state, as one small pill in its top-right corner.
///
/// One shape and one fill for all five states, with only the dot and the label
/// carrying colour. The web tints the whole pill per state, which works there
/// because it has a full alpha ramp of each hue; the design system here has one
/// value per status, and washing it out by hand would mean inventing opacities
/// that nothing else in the app shares.
private struct DesktopConnectorStatusPill: View {
    let state: DesktopConnectorState

    var body: some View {
        HStack(spacing: JunoSpace.hairline) {
            dot
            Text(label)
                .lineLimit(1)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(tint)
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.hairline)
        .background(Capsule(style: .continuous).fill(Color.junoMuted))
        .fixedSize()
        .accessibilityLabel(label)
    }

    /// Filled where the state is settled, hollow where it is merely possible —
    /// the same distinction the web draws with a solid versus an outlined dot.
    @ViewBuilder
    private var dot: some View {
        switch state {
        case .connected, .connecting:
            Circle()
                .fill(tint)
                .frame(width: DesktopConnectorGrid.statusDot, height: DesktopConnectorGrid.statusDot)
        case .available, .setup, .unavailable:
            Circle()
                .strokeBorder(tint, lineWidth: 1)
                .frame(width: DesktopConnectorGrid.statusDot, height: DesktopConnectorGrid.statusDot)
        }
    }

    private var label: String {
        switch state {
        case .connected: "Connected"
        case .connecting: "Connecting"
        case .available: "Available"
        case .setup: "Setup needed"
        case .unavailable: "Unavailable"
        }
    }

    private var tint: Color {
        switch state {
        case .connected: Color.junoSuccess
        case .connecting: Color.junoCaution
        case .available, .setup, .unavailable: Color.junoMutedForeground
        }
    }
}

/// A failure, or a fact about how this server is configured.
///
/// A raised card like everything else on this page, not a full-bleed bar pinned
/// under the toolbar: it belongs to the content it describes, and a band of fill
/// spanning the window would put a second horizontal rule directly beneath the
/// one the toolbar already draws.
private struct DesktopConnectionsNotice: View {
    let message: String
    let icon: JunoIcon
    let tint: Color
    var actionLabel: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(icon, size: 16)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(message)
                .junoCaption()
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: JunoSpace.snug)
            if let actionLabel, let action {
                Button(actionLabel, action: action)
                    .controlSize(.small)
            }
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
        .accessibilityElement(children: .contain)
    }
}
