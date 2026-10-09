import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

#if DEBUG
    import JunoPreviewSupport
#endif

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
/// **Nothing of this page is in the toolbar** (spec §3, §9). Its search, its
/// All apps / Connected switch and Refresh live in the `JunoPage` header and
/// controls row. That was already a crash fix for search: Connections is the
/// only account page rendered inside *two* shells — Chat's window and the
/// Settings window — and a second `.searchable` beside a shell's own took the
/// process down; ``searchField`` has the report.
struct DesktopConnectionsScreen: View {
    @Bindable var model: NativeConnectorModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var disconnectTarget: NativeConnector?
    @State private var showsMCP = false
    @State private var editingMCP: NativeConnector?
    /// The connector whose authorisation page this app has opened in the browser.
    ///
    /// Held so the card can say "waiting" without claiming a result, and so
    /// returning to the app re-reads the state only when a flow was actually
    /// started — window focus alone is not evidence that anything changed.
    @State private var awaitingAuthorization: String?
    /// The connector that came back connected from the browser, held in
    /// "Finishing connection…" for a beat before it settles into Connected —
    /// the web's `connectingId` hold after the OAuth redirect (the page's
    /// signature, Phase 4 B2).
    @State private var settlingID: String?
    /// The add flow while its sheet is open. Made fresh each time, so a
    /// second visit starts from an empty address rather than the last refusal.
    @State private var serverDraft: NativeCustomConnectorDraft?
    /// The server whose manage sheet is open.
    @State private var serverEditor: NativeCustomConnectorEditor?
    /// The app whose details sheet is open: status, last used, what runs
    /// without asking, Disconnect (`app-detail-sheet.tsx`).
    @State private var appDetail: NativeAppDetailModel?
    @Environment(\.junoToast) private var toast

    private let backend = URL(string: JunoBackend.productionURLString)

    var body: some View {
        page
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
                    Task {
                        if await model.disconnect(target) {
                            toast(.success("Disconnected \(target.label)."))
                        } else {
                            toast(.error("Couldn’t disconnect. Please try again."))
                        }
                    }
                }
                .contentShape(.rect)
                Button("Cancel", role: .cancel) { disconnectTarget = nil }
                    .contentShape(.rect)
            } message: { target in
                Text("Alevr will lose access to your \(target.label) account. You can reconnect anytime.")
            }
            // The authorisation round trip happens in the browser and ends on
            // Juno's own web page, so nothing reports back into this process. The
            // only honest move on return is to re-read the state rather than
            // assume the reader completed it.
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, let awaited = awaitingAuthorization else { return }
                Task { await settle(awaited) }
            }
            .sheet(isPresented: $showsMCP) {
                DesktopMCPServerSheet(model: model, editing: editingMCP)
            }
            .sheet(item: $serverDraft) { draft in
                DesktopAddServerSheet(
                    draft: draft,
                    signIn: { connector in
                        serverDraft = nil
                        beginCustomSignIn(connector.id)
                        // The new tile, not yet signed in, holding
                        // "Connecting" while the browser has it.
                        Task { await model.refresh() }
                    },
                    close: { serverDraft = nil }
                )
            }
            .sheet(item: $appDetail) { detail in
                DesktopAppDetailSheet(
                    detail: detail,
                    disconnect: {
                        appDetail = nil
                        disconnectTarget = detail.connector
                    },
                    close: { appDetail = nil }
                )
            }
            .sheet(item: $serverEditor) { editor in
                DesktopManageServerSheet(
                    editor: editor,
                    signIn: { id in
                        serverEditor = nil
                        beginCustomSignIn(id)
                    },
                    close: { serverEditor = nil }
                )
            }
            .accessibilityIdentifier("juno.desktop.connections")
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

    // MARK: Content

    /// The page template (spec §9): the header, the controls row — the
    /// search and the All apps / Connected switch, which used to be a
    /// toolbar `Picker` — and the directory. Nothing in the toolbar (§3), so
    /// the page reads the same in the Chat window and in Settings.
    /// `JunoPage` is what keeps it from resizing the window: a catalog page of
    /// eighty cards scrolls rather than pushing the sidebar off-screen.
    private var page: some View {
        JunoPage(measure: .wide) {
            // No count in the header: the Connected segment carries it, and
            // it is the control that filters to them (the web removed its
            // badge for that reason).
            JunoPageHeader(
                "Connections",
                lede: "Link an app so Alevr can work with your repositories, designs, docs, and workspace tools."
            ) {
                Button {
                    editingMCP = nil
                    showsMCP = true
                } label: { Label("Add MCP server", icon: .plus) }
                .buttonStyle(.junoProminent)
                .accessibilityIdentifier("connections.add-mcp")
                .contentShape(.rect)
                // A Mac extra: the browser hand-off reports nothing back, so
                // re-reading is the reader's to ask for. Also the way out of a
                // stuck wait.
                DesktopQuietIconButton(icon: .refresh, label: "Refresh connections", help: "Re-read this account’s connections (⌘R)") {
                    awaitingAuthorization = nil
                    settlingID = nil
                    Task { await model.refresh() }
                }
                .keyboardShortcut("r", modifiers: .command)
                .accessibilityIdentifier("connections.refresh")
                // Bring your own: the page's one header action, beside the
                // quiet refresh — the web's "Add MCP server".
                DesktopOutlineButton(title: "Add MCP Server", icon: .plus) { addServer() }
                    .disabled(model.phase != .ready)
                    .help("Add a remote MCP server by its address")
                    .accessibilityIdentifier("connections.add-server")
            }
        } controls: {
            if model.phase == .ready {
                JunoPageControls {
                    JunoSegmented(
                        options: [
                            JunoSegmented<Bool>.Option(false, "All apps"),
                            JunoSegmented<Bool>.Option(
                                true, "Connected", count: model.connectedCount > 0 ? model.connectedCount : nil
                            ),
                        ],
                        selection: $model.showsConnectedOnly,
                        accessibilityLabel: "Filter apps"
                    )
                    .fixedSize()
                    .help("Show every app, or only the ones this account has connected")
                    .accessibilityIdentifier("connections.filter")
                    searchField
                } trailing: {
                    let count = model.visibleConnectors.count
                    Text("\(count) \(count == 1 ? "app" : "apps")")
                        .junoType(.ui)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
        } content: {
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .loading:
            LazyVGrid(columns: DesktopConnectorGrid.columns, alignment: .leading, spacing: JunoSpace.regular) {
                ForEach(0..<6, id: \.self) { _ in DesktopConnectorTileSkeleton() }
            }
            .accessibilityElement()
            .accessibilityLabel("Loading connections")
        case .failed:
            JunoEmptyState(
                title: "Couldn’t load your connections",
                message: "The server may still be starting up, or the database isn’t reachable yet.",
                icon: .error,
                actionLabel: "Try again",
                action: { Task { await model.refresh() } },
                size: .panel,
                tone: .error
            )
        case .ready:
            directory
        }
    }

    private var directory: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            categories
            notices
            results
            loadMore
            footnote
        }
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
            value: connectedIDs
        )
    }

    // MARK: Filters

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
        // The web's placeholder, which names three apps rather than repeating
        // the label: what a reader needs to know here is that the field
        // searches a catalog of apps, not that it is a search field.
        JunoPageSearchField(
            text: $model.query,
            prompt: "Search Gmail, Slack, GitHub…",
            accessibilityIdentifier: "connections.search"
        )
    }

    /// Composio ships around a thousand toolkits, so categories are the only thing
    /// between the reader and an endlessly-paged flat list — which is why they are
    /// a visible row here rather than a menu in the toolbar, exactly as on the web.
    /// Hidden on the Connected filter: that set is small enough to read whole, and
    /// the catalog endpoint cannot narrow it by category.
    @ViewBuilder
    private var categories: some View {
        // A menu, never a row of capsules: the category is a filter over one
        // directory, and a filter reads as plain text with a chevron.
        if !model.categories.isEmpty, !model.showsConnectedOnly {
            Picker(selection: $model.selectedCategory) {
                Text("All categories").tag(String?.none)
                Divider()
                ForEach(model.categories) { category in
                    Text(category.count.map { "\(category.label) · \($0)" } ?? category.label)
                        .tag(Optional(category.id))
                }
            } label: {
                Text("Category")
            }
            .pickerStyle(.menu)
            .fixedSize()
            .accessibilityLabel("Filter by category")
            .accessibilityIdentifier("connections.category")
        }
    }

    // MARK: Results

    /// Connected first, then everything else. The two sets answer different
    /// questions — "what can Juno already do" and "what could it do" — and the web
    /// separates them with its Connected filter; on a window this wide both fit at
    /// once, so they are two labelled bands instead of two tabs.
    @ViewBuilder
    private var results: some View {
        if connectedConnectors.isEmpty, availableConnectors.isEmpty, !showsAddTile {
            emptyState
                .frame(maxWidth: .infinity)
                .padding(.vertical, JunoSpace.region)
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                if !connectedConnectors.isEmpty {
                    section("Connected", "Linked and available to your chats.", connectedConnectors)
                }
                if !model.showsConnectedOnly, !availableConnectors.isEmpty || showsAddTile {
                    // No count on this band: it holds one page of a catalog with
                    // hundreds more behind the cursor, so a number here would be a
                    // lie about how many apps exist.
                    section(
                        "Available", "Connect an app to let Alevr work inside it.", availableConnectors,
                        endsWithAddTile: showsAddTile
                    )
                }
            }
        }
    }

    /// Bring your own is always the last tile of Available, so the way to add
    /// a server is where the reader is already looking for an app — except
    /// while searching, where it would read as a result.
    private var showsAddTile: Bool {
        !model.showsConnectedOnly && trimmedQuery.isEmpty
    }

    private func section(
        _ title: String,
        _ lede: String,
        _ connectors: [NativeConnector],
        endsWithAddTile: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(title)
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text(lede)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            LazyVGrid(columns: DesktopConnectorGrid.columns, alignment: .leading, spacing: JunoSpace.regular) {
                ForEach(connectors) { card($0) }
                if endsWithAddTile {
                    DesktopAddServerTile(minimumHeight: DesktopConnectorGrid.cardMinimumHeight) { addServer() }
                }
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
            HStack(alignment: .center, spacing: JunoSpace.cozy) {
                DesktopConnectorMark(connector: connector)
                Text(connector.label)
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: JunoSpace.snug)
                DesktopConnectorStatusPill(state: cardState, isCustom: connector.isCustom)
            }
            // Under the name and pill, at the tile's full width: squeezed
            // beside the pill it truncated after four words above a gap.
            Text(descriptionText(connector, state: cardState))
                .junoCaption()
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

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
        if connector.isCustom {
            customAction(connector, state: state)
        } else if connector.isCustomMCP {
            HStack {
                Toggle("Use in chats", isOn: Binding(
                    get: { connector.connected },
                    set: { enabled in Task { await model.setMCPEnabled(connector, enabled: enabled) } }
                ))
                .toggleStyle(.switch)
                .controlSize(.small)
                .disabled(model.isMutating)
                Spacer()
                Button("Manage") { editingMCP = connector; showsMCP = true }
                    .buttonStyle(.bordered)
                    .contentShape(.rect)
            }
        } else {
            builtInAction(connector, state: state)
        }
    }

    /// A custom server's footer. Its tools are chosen one by one and signing
    /// out lives with them, so a linked server gets one Manage door rather
    /// than a Disconnect that would leave those choices unreachable; one not
    /// yet signed in gets Sign In beside it.
    @ViewBuilder
    private func customAction(_ connector: NativeConnector, state: DesktopConnectorState) -> some View {
        HStack(spacing: JunoSpace.snug) {
            wideButton("Manage") { manageServer(connector) }
                .help("Rename \(connector.label), choose its tools, sign out or remove it")
                .accessibilityLabel("Manage \(connector.label)")
                .accessibilityIdentifier("connections.manage.\(connector.id)")
            if !connector.connected {
                wideButton(state == .connecting ? "Waiting…" : "Sign In") {
                    beginCustomSignIn(connector.id)
                }
                .disabled(state == .connecting)
                .help("Alevr opens this server’s sign-in page in your browser. You approve Alevr there, then choose its tools here.")
                .accessibilityLabel("Sign in to \(connector.label)")
                .accessibilityIdentifier("connections.sign-in.\(connector.id)")
            }
        }
    }

    @ViewBuilder
    private func builtInAction(_ connector: NativeConnector, state: DesktopConnectorState) -> some View {
        switch state {
        case .connected:
            HStack(spacing: JunoSpace.snug) {
                wideButton("Details") { showDetails(connector) }
                    .help("Last used, what runs without asking, and Disconnect")
                    .accessibilityLabel("\(connector.label) details")
                    .accessibilityIdentifier("connections.details.\(connector.id)")
                wideButton("Disconnect", role: .destructive) { disconnectTarget = connector }
                    .disabled(model.isMutating)
                    .help("Revoke Alevr's access to \(connector.label)")
                    .accessibilityLabel("Disconnect \(connector.label)")
                    .accessibilityIdentifier("connections.disconnect.\(connector.id)")
            }

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
            Text("The Alevr server this app talks to has no OAuth app for \(connector.label) yet.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The same actions for a right-click, plus the identifier the retired
    /// inspector used to expose. No accessibility identifiers here: two controls
    /// answering to one identifier makes a UI test ambiguous.
    @ViewBuilder
    private func cardMenu(_ connector: NativeConnector, state: DesktopConnectorState) -> some View {
        if connector.isCustom {
            Button("Manage \(connector.label)…") { manageServer(connector) }
            if connector.connected {
                Button("\(connector.label) Details…") { showDetails(connector) }
                    .contentShape(.rect)
            }
            if !connector.connected {
                Button("Sign In to \(connector.label)") { beginCustomSignIn(connector.id) }
                    .disabled(state == .connecting)
            }
            if let url = connector.url {
                Divider()
                Button("Copy Address") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url, forType: .string)
                }
            }
        } else if connector.isCustomMCP {
            Button("Manage MCP server") { editingMCP = connector; showsMCP = true }
                .contentShape(.rect)
            Button("Remove server", role: .destructive) { disconnectTarget = connector }
                .disabled(model.isMutating)
                .contentShape(.rect)
        } else {
            builtInMenu(connector, state: state)
        }
    }

    @ViewBuilder
    private func builtInMenu(_ connector: NativeConnector, state: DesktopConnectorState) -> some View {
        switch state {
        case .connected:
            Button("\(connector.label) Details…") { showDetails(connector) }
                .contentShape(.rect)
            Button("Disconnect \(connector.label)", role: .destructive) {
                disconnectTarget = connector
            }
            .disabled(model.isMutating)
            .contentShape(.rect)
        case .available, .connecting:
            Button("Connect \(connector.label)") { beginAuthorization(connector) }
                .disabled(state == .connecting)
                .contentShape(.rect)
        case .setup:
            if let url = composioSetupURL(connector) {
                Button("Set Up in Composio…") { NSWorkspace.shared.open(url) }
                    .contentShape(.rect)
            }
        case .unavailable:
            EmptyView()
        }
        Divider()
        Button("Copy Identifier") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(connector.id, forType: .string)
        }
        .contentShape(.rect)
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
        .contentShape(.rect)
        // Neutral, as the web's secondary tile buttons are: the column's
        // accent tint would turn Connect and Disconnect coral (§0.4).
        .tint(nil)
        .controlSize(.large)
        // The control radius every page button uses, not the capsule
        // `.large` draws on macOS 26.
        .buttonBorderShape(.roundedRectangle(radius: JunoRadius.control))
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
                .contentShape(.rect)
                Spacer()
            }
        }
    }

    /// The account-wide caveat the inspector used to repeat per connector. It is
    /// the same fact for every app, so it belongs once, at the foot of the page —
    /// which is where the website puts it.
    private var footnote: some View {
        Text(
            "Connected tools are available to the model when you enable them in a chat. Each provider shows the exact permissions during its consent flow."
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
        let category = model.categories.first { $0.id == model.selectedCategory }?.label.lowercased()
        if model.showsConnectedOnly {
            JunoEmptyState(
                title: "No connected apps yet",
                message: "Connect one from All apps and it will show up here.",
                icon: .connections,
                actionLabel: "Browse all apps",
                action: { model.showsConnectedOnly = false }
            )
        } else if !trimmedQuery.isEmpty {
            JunoEmptyState(
                title: "Nothing here",
                message: "No apps match “\(trimmedQuery)”" + (category.map { " in \($0)" } ?? "") + ".",
                icon: .connections,
                actionLabel: "Clear filters",
                action: {
                    model.query = ""
                    model.selectedCategory = nil
                }
            )
        } else if let category {
            JunoEmptyState(
                title: "Nothing here",
                message: "No apps in \(category).",
                icon: .connections,
                actionLabel: "Clear filters",
                action: { model.selectedCategory = nil }
            )
        } else {
            JunoEmptyState(
                title: "No apps available",
                message: "The catalog came back empty.",
                icon: .connections
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
                            fallback: "Alevr couldn't refresh your connections."
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
                        message: "The managed app directory is off on this server, so only the apps built into Alevr are listed.",
                        icon: .about,
                        tint: Color.junoCaution
                    )
                }
                if let catalogError = model.catalogErrorDescription {
                    JunoEmptyState(
                        title: "The app directory couldn’t be loaded",
                        message: catalogError,
                        icon: .error,
                        actionLabel: "Try again",
                        action: { Task { await model.refresh() } },
                        size: .panel,
                        tone: .error
                    )
                }
            }
        }
    }

    private var hasNotice: Bool {
        if model.catalogErrorDescription != nil { return true }
        guard model.phase == .ready else { return false }
        return model.lastErrorDescription != nil || !model.composioConfigured
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
        awaitingAuthorization == connector.id || settlingID == connector.id
    }

    private func state(_ connector: NativeConnector) -> DesktopConnectorState {
        if settlingID == connector.id { return .connecting }
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
        if connector.isCustom {
            // The web's custom line: how many tools, and where, once linked;
            // what is left to do before then.
            let host = connector.accountLabel ?? ""
            switch state {
            case .connected:
                guard let count = connector.toolCount else { return host }
                return "\(count) \(count == 1 ? "tool" : "tools") · \(host)"
            case .connecting:
                return "Finishing sign-in…"
            default:
                return "Sign in to finish adding · \(host)"
            }
        }
        if connector.isCustomMCP {
            if connector.mcpStatus == "error" { return connector.lastError ?? "Connection failed. Manage this server to test again." }
            let count = connector.toolCount ?? 0
            return "\(count) \(count == 1 ? "tool" : "tools") · \(connector.connected ? "Enabled" : "Disabled")"
        }
        switch state {
        case .connected:
            if let account = connector.accountLabel, !account.isEmpty,
                account != connector.label
            {
                return account
            }
            return "Connected and ready"
        case .connecting:
            return "Finishing connection…"
        case .unavailable:
            return "Not set up on this Alevr server"
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
            return "\(connector.label) signs in with an app-specific password. Alevr opens your Connections page in your browser to collect it — passwords are never typed into this app."
        case .native:
            return "Alevr opens \(connector.label)'s authorisation page in your browser. You approve the permissions there, and Alevr keeps only the resulting token, encrypted."
        case .composio:
            return "Alevr opens \(connector.label)'s authorisation page in your browser through Composio, the managed connector service. You approve the permissions there."
        case .custom:
            return "Alevr opens this server’s sign-in page in your browser. You approve Alevr there."
        }
    }

    // MARK: Actions

    /// The reader is back from the browser. The state is re-read rather
    /// than assumed; a connector that came back connected holds "Finishing
    /// connection…" for the web's 1.4s, then settles into Connected with the
    /// web's sentence. One that did not simply returns to Connect.
    private func settle(_ id: String) async {
        settlingID = id
        await model.connectFlowFinished()
        awaitingAuthorization = nil
        guard let connector = model.linked.first(where: { $0.id == id }) ?? model.catalog.first(where: { $0.id == id }),
            connector.connected
        else {
            settlingID = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(1400))
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
            settlingID = nil
        }
        toast(.success("\(connector.label) is connected and ready to use."))
    }

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
        case .custom:
            return NativeCustomConnectorPath.connectURL(backend: backend, id: connector.id)
        }
    }

    // MARK: Custom servers

    private func showDetails(_ connector: NativeConnector) {
        appDetail = model.makeAppDetailModel(for: connector)
    }

    private func addServer() {
        serverDraft = model.makeCustomConnectorDraft()
    }

    private func manageServer(_ connector: NativeConnector) {
        serverEditor = model.makeCustomConnectorEditor(id: connector.id)
    }

    /// A custom server's sign-in, in the reader's browser like every other
    /// connector's: the same wait, the same re-read on return.
    private func beginCustomSignIn(_ id: String) {
        guard let backend, let url = NativeCustomConnectorPath.connectURL(backend: backend, id: id) else { return }
        awaitingAuthorization = id
        NSWorkspace.shared.open(url)
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
    /// The magnifier inside it, at caption size — smaller than
    /// ``JunoIconView``'s sidebar default, which would outweigh the field's text.
    static let searchGlyphSize: CGFloat = 14

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
    @ViewBuilder
    private var content: some View {
        if connector.isCustom {
            // A server the reader added has no brand mark to borrow: its
            // monogram, in the foreground ink, on the same well.
            Text(NativeCustomConnectorPath.monogram(connector.label))
                .font(.system(size: DesktopConnectorGrid.markSize * 0.42, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.junoForeground)
        } else {
            JunoConnectorMark(
                connectorID: connector.id,
                connectorName: connector.label,
                logoURL: connector.logoURL,
                size: DesktopConnectorGrid.markGlyphSize
            )
        }
    }
}

/// The card's state, as text in its top-right corner — never a pill or a dot
/// (owner directive). Connecting shimmers; Setup needed is the one state
/// that asks something of the reader.
private struct DesktopConnectorStatusPill: View {
    let state: DesktopConnectorState
    /// A custom server that is not linked was added and never signed in (or
    /// signed out): "Available" would claim it is something to discover.
    var isCustom = false

    var body: some View {
        DesktopStatusText(label, kind: kind)
    }

    private var kind: DesktopStatusText.Kind {
        switch state {
        case .connecting: .working
        case .setup: .attention
        case .connected, .available, .unavailable: .quiet
        }
    }

    private var label: String {
        switch state {
        case .connected: "Connected"
        case .connecting: "Connecting"
        case .available: isCustom ? "Not signed in" : "Available"
        case .setup: "Setup needed"
        case .unavailable: "Unavailable"
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
                    .contentShape(.rect)
            }
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard()
        .accessibilityElement(children: .contain)
    }
}

/// A tile's shape while the directory loads: the mark well, two lines, the
/// footer — so nothing moves when the cards land.
private struct DesktopConnectorTileSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                JunoSkeleton(height: DesktopConnectorGrid.markSize, width: DesktopConnectorGrid.markSize, cornerRadius: JunoRadius.field)
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    JunoSkeleton(height: 12, width: 110)
                    JunoSkeleton(height: 10)
                }
            }
            Spacer(minLength: 0)
            JunoSkeleton(height: 28, cornerRadius: JunoRadius.control)
        }
        .padding(JunoSpace.regular)
        .frame(minHeight: DesktopConnectorGrid.cardMinimumHeight, alignment: .top)
        .junoCard(cornerRadius: JunoRadius.card)
        .accessibilityHidden(true)
    }
}

/// Native management for account MCP servers; credentials stay write-only.
struct DesktopMCPServerSheet: View {
    let model: NativeConnectorModel
    let editing: NativeConnector?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = ""
    @State private var credential = ""
    @State private var clearAuth = false
    @State private var testing = false
    @State private var saving = false
    @State private var probe: NativeMCPProbe?
    @State private var error: String?

    private var busy: Bool { testing || saving }
    private var validURL: Bool {
        guard let endpoint = URL(string: url.trimmingCharacters(in: .whitespacesAndNewlines)),
              endpoint.host != nil, endpoint.user == nil, endpoint.password == nil else { return false }
        return endpoint.scheme == "https"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text(editing == nil ? "Add MCP server" : "Manage MCP server").junoType(.heading)
                Text("Connect tools from your own remote server. Alevr stores your credential encrypted.")
                    .junoType(.ui).foregroundStyle(Color.junoSecondaryInk)
            }
            Form {
                TextField("Name", text: $name)
                TextField("Server URL", text: $url)
                SecureField(editing?.hasAuthHeader == true ? "Replacement credential (optional)" : "Authorization header (optional)", text: $credential)
                if editing?.hasAuthHeader == true {
                    Toggle("Remove stored credential", isOn: $clearAuth)
                }
            }
            .textFieldStyle(.roundedBorder)
            .disabled(busy)
            Text("Use a public HTTPS endpoint reachable by Alevr. For a local server, use the project’s MCP settings in Alevr Code.")
                .junoType(.caption).foregroundStyle(Color.junoSecondaryInk)
            HStack(spacing: JunoSpace.snug) {
                Button(testing ? "Testing…" : "Test connection") { test() }
                    .disabled(busy || !validURL)
                    .contentShape(.rect)
                if testing { ProgressView().controlSize(.small) }
                else if let probe {
                    Text(probe.ok ? "\(probe.toolNames?.count ?? 0) tools found" : "Connection failed")
                        .junoType(.ui)
                        .foregroundStyle(probe.ok ? Color.junoSecondaryInk : Color.junoDestructiveInk)
                }
            }
            if let probe, probe.ok, let names = probe.toolNames, !names.isEmpty {
                ScrollView { Text(names.joined(separator: "\n")).junoType(.caption).textSelection(.enabled) }
                    .frame(maxHeight: 100)
            }
            if let error { Text(error).junoType(.ui).foregroundStyle(Color.junoDestructiveInk) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                    .contentShape(.rect)
                Button(saving ? "Saving…" : editing == nil ? "Add server" : "Save changes") { save() }
                    .buttonStyle(.junoProminent).keyboardShortcut(.defaultAction)
                    .disabled(busy || !validURL || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .contentShape(.rect)
            }
        }
        .padding(JunoSpace.roomy)
        .frame(width: 480)
        .interactiveDismissDisabled(busy)
        .onAppear { name = editing?.label ?? ""; url = editing?.mcpURL ?? "" }
        .onChange(of: url) { _, _ in probe = nil; error = nil }
        .onChange(of: credential) { _, _ in probe = nil; error = nil }
        .onChange(of: clearAuth) { _, _ in probe = nil; error = nil }
    }

    private func test() {
        guard !busy else { return }
        testing = true; error = nil; probe = nil
        Task {
            do {
                let result = try await model.testMCP(url: url.trimmingCharacters(in: .whitespacesAndNewlines), authHeader: credential, clearAuth: clearAuth, editing: editing)
                probe = result
                error = result.ok ? nil : result.error
            } catch { self.error = error.localizedDescription }
            testing = false
        }
    }

    private func save() {
        guard !busy else { return }
        saving = true; error = nil
        Task {
            if await model.saveMCP(name: name.trimmingCharacters(in: .whitespacesAndNewlines), url: url.trimmingCharacters(in: .whitespacesAndNewlines), authHeader: credential, clearAuth: clearAuth, editing: editing) {
                dismiss()
            } else { error = model.lastErrorDescription ?? "Couldn’t save this server. Try again." }
            saving = false
        }
    }
}

// MARK: - App details


/// **An app's details** (`app-detail-sheet.tsx`), in the order a person asks:
/// which account, when it was last used, what it may do without asking (each
/// standing grant revocable back to Ask first), and how to stop it.
///
/// A grouped `Form` in a sheet: every line is a real server state, nothing is a
/// local toggle the server does not read.
struct DesktopAppDetailSheet: View {
    @Bindable var detail: NativeAppDetailModel
    /// Asks to disconnect; the screen owns the confirmation.
    let disconnect: () -> Void
    let close: () -> Void

    private var connector: NativeConnector { detail.connector }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Status") {
                        Text(connector.connected ? "Connected" : "Not connected")
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                    if let account = connector.accountLabel, !account.isEmpty, account != connector.label {
                        LabeledContent("Account") {
                            Text(account)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .textSelection(.enabled)
                        }
                    }
                    LabeledContent("Last used") {
                        lastUsed
                    }
                }

                Section {
                    grants
                } header: {
                    Text("What Alevr can do without asking")
                } footer: {
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        Text("Anything that changes something in \(connector.label) asks you first, unless you chose to allow it here.")
                        if let error = detail.grantError {
                            Label {
                                Text(error)
                            } icon: {
                                JunoIconView(.triangleAlert, size: 12)
                            }
                            .foregroundStyle(Color.junoDestructiveInk)
                        }
                    }
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                }

                if connector.connected {
                    Section {
                        Button(connector.isCustomMCP ? "Remove \(connector.label)…" : "Disconnect \(connector.label)…", role: .destructive) {
                            disconnect()
                        }
                        .accessibilityIdentifier("connections.detail.disconnect")
                    } footer: {
                        Text(detail.consequence)
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(connector.label)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: close)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .frame(minWidth: 460, idealWidth: 480, minHeight: 420)
        .task { await detail.load() }
        .accessibilityIdentifier("connections.detail")
    }

    @ViewBuilder
    private var lastUsed: some View {
        switch detail.usage {
        case .loading:
            ProgressView().controlSize(.small)
        case .loaded(nil):
            Text("Alevr hasn’t used it yet.")
                .foregroundStyle(Color.junoSecondaryInk)
        case .loaded(let usage?):
            Text(usage.line())
                .foregroundStyle(Color.junoSecondaryInk)
                .multilineTextAlignment(.trailing)
        }
    }

    @ViewBuilder
    private var grants: some View {
        if let grants = detail.grants {
            if grants.isEmpty {
                Text("Nothing. Every change asks first.")
                    .foregroundStyle(Color.junoSecondaryInk)
            } else {
                ForEach(grants) { grant in
                    HStack(alignment: .center, spacing: JunoSpace.cozy) {
                        VStack(alignment: .leading, spacing: JunoSpace.micro) {
                            Text(grant.action)
                                .foregroundStyle(Color.junoForeground)
                            Text(grant.scopeLine)
                                .junoType(.caption)
                                .foregroundStyle(Color.junoSecondaryInk)
                        }
                        Spacer(minLength: JunoSpace.snug)
                        Button {
                            Task { await detail.revoke(grant) }
                        } label: {
                            if detail.revokingID == grant.id {
                                ProgressView().controlSize(.small)
                            } else {
                                Text("Ask First")
                            }
                        }
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .controlSize(.small)
                        .disabled(detail.revokingID != nil)
                        .help("Revoke: Alevr will ask before doing this again")
                        .accessibilityLabel("Revoke \(grant.action)")
                        .contentShape(.rect)
                    }
                }
            }
        } else {
            HStack(spacing: JunoSpace.snug) {
                ProgressView().controlSize(.small)
                Text("Loading…").foregroundStyle(Color.junoSecondaryInk)
            }
        }
    }
}
