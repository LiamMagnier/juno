import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UniformTypeIdentifiers

/// **Settings** — one page, no sub-navigation.
///
/// The build this replaces was a seven-tab `TabView(.tabBarOnly)` living inside
/// the window's own sidebar-selected Settings destination: two navigation
/// systems stacked, two competing `.navigationTitle`s, and the reader made to
/// guess which of General / Appearance / Memory / Shared links / Account /
/// Usage / Diagnostics held the switch they came for. Inside each tab was a
/// grouped `Form` of full-width bordered sections, every one with a header *and*
/// a footer paragraph — the General tab alone stacked six explanatory
/// paragraphs, and each section printed its own name twice, once as
/// `Section("Default model")` and again forty points below as
/// `Picker("Default model")`.
///
/// The website settled this a long time ago and the app now follows it: a serif
/// heading, the account underneath, and a two-column grid of ``JunoSettingsTile``
/// cards capped at ``JunoSettingsMetrics/readingWidth``. A card's monospaced
/// eyebrow *is* the section's name, so no control inside has to introduce
/// itself. The control vocabulary is the web's too — ``JunoChoiceCard`` for any
/// choice small enough to show at once (theme, response style), a menu only for
/// a genuinely long list (the model catalog, the twenty-two interface locales),
/// switches for booleans, and destructive actions behind a typed confirmation.
///
/// Three things this page deliberately does *not* do:
///
/// - **It does not report an ideal height.** `NavigationSplitView` grows its
///   AppKit split view to satisfy a detail's ideal size, so a settings pane that
///   reports the height of its content resizes the *window* — measured once at
///   1069pt taller than the window, with the sidebar pushed off-screen.
///   ``JunoDetailPage`` is the packaged fix and every surface here goes through
///   it.
/// - **It does not paint the reading canvas.** The detail column already does
///   (`DesktopChatWorkspace`), and the ⌘, window does it once at scene level.
///   The old ``DesktopSettingsClamp`` applied `.junoReadingCanvas()` a second
///   time inside the page.
/// - **It does not reimplement Usage.** That screen exists, reads
///   `/api/profile/usage/breakdown`, and is reachable from the sidebar; this page
///   links to it rather than keeping a thinner second copy with its own wire
///   types pointed at a different route.
///
/// Deep memory management moved out for the same reason it moved out on the web
/// and on the phone: it is a corpus editor, not a preference. Settings keeps the
/// switch; ``DesktopMemoryScreen`` is the manager, and this page swaps to it
/// behind a back control the way `/memory` does on the web.
struct DesktopSettingsScreen: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    let authModel: NativeAuthModel
    let session: NativeAuthenticatedSession
    let accountDataClient: NativeAccountDataClient?
    /// Lists and revokes the account's public links.
    let shareClient: NativeShareClient?
    /// The account's model catalog, for the default-model and favourites tiles.
    /// Empty until the signed-in manifest arrives, and those tiles say so rather
    /// than offering an empty menu.
    var modelCatalog: [NativeChatModelOption] = []
    /// The account photo's bytes, already fetched through the authenticated file
    /// route by `NativeAvatarModel`.
    var avatarData: Data?
    var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    var outbox: (any MutationOutboxRepository)?
    /// Selects the window's Usage destination. Nil in the ⌘, window, which has no
    /// sidebar to navigate — the tile is absent there rather than offering a link
    /// that cannot go anywhere.
    var openUsage: (() -> Void)?
    /// Hosting for Juno Code Remote. Nil where the window has no host — the
    /// tile is absent rather than showing a switch that controls nothing.
    var codeHostModel: DesktopCodeHostModel?
    /// Whether this Mac serves Juno Work, and on what terms. Nil for the same
    /// reason `codeHostModel` is: a consent surface for a capability the window
    /// cannot actually grant is worse than no surface, because the reader would
    /// leave believing they had granted it.
    var workHostModel: DesktopWorkHostModel?

    /// Whether the grid has room for two columns. Read from the page's own width
    /// rather than assumed, because the same view is 520pt wide in the ⌘, window
    /// and 900pt wide in the workspace.
    @State private var isWide = true
    @State private var sheet: DesktopSettingsSheet?
    /// Whether the memory manager has taken over the surface.
    ///
    /// One page swapping for another, with a back control, exactly as the web
    /// does it at `/memory` and the phone does it with a push — *not* a second
    /// navigation container nested in the window's own. It also means the
    /// manager is handed the same model object this page is already showing,
    /// rather than looking the account up a second time somewhere that could
    /// disagree.
    @State private var isShowingMemory = false

    var body: some View {
        Group {
            if isShowingMemory {
                DesktopMemoryScreen(model: model, back: { isShowingMemory = false })
            } else {
                page
            }
        }
        .accessibilityIdentifier("juno.desktop.settings")
    }

    private var page: some View {
        JunoDetailPage(maxWidth: JunoSettingsMetrics.readingWidth) {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                header
                tiles
            }
            // Width only. Changing the column count changes the page's height,
            // never its width, so this cannot feed back into itself.
            .onGeometryChange(for: Bool.self) { proxy in
                proxy.size.width >= JunoSettingsMetrics.twoColumnThreshold
            } action: { isWide = $0 }
        }
        .overlay(alignment: .bottom) { statusChrome }
        .sheet(item: $sheet) { sheet in
            DesktopSettingsSheetHost(sheet: sheet) {
                switch sheet {
                case .sharedLinks:
                    NativeSharedLinksView(client: shareClient, accountID: session.profile.id)
                case .diagnostics:
                    // The shared pane, not a second copy of it. The whole value
                    // of Diagnostics is that the Mac, the phone and the server
                    // report the same facts in the same words.
                    NativeDiagnosticsView(
                        syncModel: syncModel,
                        outbox: outbox,
                        accountID: StorageAccountID(session.profile.id.rawValue)
                    )
                    .formStyle(.grouped)
                    .scrollContentBackground(.hidden)
                }
            }
        }
    }

    // MARK: - Header

    /// The web's header, in the app's voice: an eyebrow, the account in the
    /// editorial serif, and the address underneath. The photo is here and
    /// nowhere else on the page — the old Account pane restated name and email
    /// one scroll below where they already appeared.
    private var header: some View {
        HStack(alignment: .center, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Settings")
                    .junoSettingsEyebrow()
                Text(session.profile.name ?? "Your account")
                    .font(JunoSerif.pageHeading())
                Text(session.profile.email)
                    .junoCaption()
                    .textSelection(.enabled)
            }
            Spacer(minLength: JunoSpace.regular)
            JunoAvatar(
                imageData: avatarData,
                imageURL: session.profile.imageURL,
                name: session.profile.name ?? session.profile.email,
                size: DesktopSettingsMetrics.avatarSize
            )
        }
    }

    // MARK: - Grid

    /// Two orderings of the same tiles, because the difference between them is
    /// genuinely only which ones share a row. Building it from an array of
    /// erased views would cost every tile its identity across the transition.
    @ViewBuilder
    private var tiles: some View {
        if isWide {
            Grid(
                horizontalSpacing: JunoSpace.regular,
                verticalSpacing: JunoSpace.regular
            ) {
                if let openUsage {
                    GridRow { usageTile(openUsage).gridCellColumns(2) }
                }
                if let settings = model.settings {
                    GridRow { appearanceTile(settings).gridCellColumns(2) }
                    GridRow { defaultModelTile(settings).gridCellColumns(2) }
                    if !modelCatalog.isEmpty {
                        GridRow { favoritesTile(settings).gridCellColumns(2) }
                    }
                    GridRow {
                        responseLanguageTile(settings)
                        interfaceLanguageTile(settings)
                    }
                    GridRow { styleTile(settings).gridCellColumns(2) }
                    GridRow { instructionsTile(settings).gridCellColumns(2) }
                } else {
                    GridRow { unavailableTile.gridCellColumns(2) }
                }
                GridRow {
                    memoryTile
                    accountTile
                }
                // Both host tiles are full width and `@ViewBuilder`-guarded, so
                // the outer `if` is only here to stop an empty `GridRow` from
                // claiming a row of vertical spacing when the model is nil.
                if codeHostModel != nil {
                    GridRow { remoteHostTile.gridCellColumns(2) }
                }
                if workHostModel != nil {
                    GridRow { workHostTile.gridCellColumns(2) }
                }
                if let settings = model.settings {
                    GridRow { notificationsTile(settings).gridCellColumns(2) }
                }
                GridRow { aboutTile.gridCellColumns(2) }
                GridRow { dangerTile.gridCellColumns(2) }
            }
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                if let openUsage { usageTile(openUsage) }
                if let settings = model.settings {
                    appearanceTile(settings)
                    defaultModelTile(settings)
                    if !modelCatalog.isEmpty { favoritesTile(settings) }
                    responseLanguageTile(settings)
                    interfaceLanguageTile(settings)
                    styleTile(settings)
                    instructionsTile(settings)
                } else {
                    unavailableTile
                }
                memoryTile
                accountTile
                remoteHostTile
                workHostTile
                if let settings = model.settings { notificationsTile(settings) }
                aboutTile
                dangerTile
            }
        }
    }

    /// Why the preference tiles are missing, with the model's retry attached.
    private var unavailableTile: some View {
        JunoSettingsTile("Preferences") {
            Label(settingsUnavailableMessage, systemImage: "clock.arrow.circlepath")
                .junoRowLabel()
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
            Button("Reload settings") { Task { await model.refresh() } }
                .accessibilityIdentifier("juno.desktop.settings.reload")
        }
    }

    /// Why a settings tile has no controls yet, in the model's own words.
    private var settingsUnavailableMessage: String {
        switch model.phase {
        case .idle, .loading:
            "Loading your account settings…"
        case .offline:
            DesktopStatusCopy(subject: "settings", singular: "setting")
                .humanized(
                    model.lastErrorDescription,
                    fallback: "Offline — your settings will appear once Juno reconnects."
                )
        case .failed:
            DesktopStatusCopy(subject: "settings", singular: "setting")
                .humanized(
                    model.lastErrorDescription,
                    fallback: "Juno could not load your settings."
                )
        case .ready:
            "Account settings have not finished synchronizing."
        }
    }

    // MARK: - Tiles

    /// A link, not a second dashboard. The plan, the rolling windows and the
    /// per-surface breakdown all live on ``DesktopUsageScreen``, which reads the
    /// ledger route; this page used to read a *different* route and draw its own
    /// meters beside it, which is two answers to one question.
    private func usageTile(_ open: @escaping () -> Void) -> some View {
        JunoSettingsTile("Usage") {
            DesktopSettingsAction(
                title: "Plan, limits and spend",
                detail: "Your rolling windows and what every surface has cost, read from the billing ledger.",
                symbol: "chart.line.uptrend.xyaxis",
                action: open
            )
            .accessibilityIdentifier("juno.desktop.settings.usage-link")
        }
    }

    private func appearanceTile(_ settings: NativeAccountSettings) -> some View {
        DesktopSettingsAppearanceTile(
            settings: settings,
            disabled: model.isMutating,
            update: update
        )
    }

    private func defaultModelTile(_ settings: NativeAccountSettings) -> some View {
        DesktopSettingsModelTile(
            settings: settings,
            modelCatalog: modelCatalog,
            disabled: model.isMutating,
            update: update
        )
    }

    private func favoritesTile(_ settings: NativeAccountSettings) -> some View {
        DesktopSettingsFavoritesTile(
            settings: settings,
            modelCatalog: modelCatalog,
            disabled: model.isMutating,
            update: update
        )
    }

    private func responseLanguageTile(_ settings: NativeAccountSettings) -> some View {
        JunoSettingsTile("Response language") {
            Text("The language Juno replies in.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            Picker(
                "Response language",
                selection: junoSettingsBinding(
                    settings, \.responseLanguage, update: update
                ) { NativeSettingsPatch(responseLanguage: $0) }
            ) {
                ForEach(
                    junoKnownOrCurrent(
                        DesktopSettingsCatalog.responseLanguages,
                        current: settings.responseLanguage
                    ),
                    id: \.self
                ) { language in
                    Text(language == "auto" ? "Auto-detect" : language).tag(language)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            .disabled(model.isMutating)
            .accessibilityLabel("Response language")
            .accessibilityIdentifier("juno.desktop.settings.response-language")
        }
    }

    /// Twenty-two locales, each naming itself in its own script — a list only a
    /// menu can hold, which is exactly where the web draws the line too.
    private func interfaceLanguageTile(_ settings: NativeAccountSettings) -> some View {
        JunoSettingsTile("Interface language") {
            Text("The language this app's buttons and menus are in.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            Picker(
                "Interface language",
                selection: junoSettingsBinding(
                    settings, \.interfaceLocale, update: update
                ) { NativeSettingsPatch(interfaceLocale: $0) }
            ) {
                ForEach(
                    junoKnownOrCurrent(
                        DesktopSettingsCatalog.interfaceLocales,
                        current: settings.interfaceLocale
                    ),
                    id: \.self
                ) { locale in
                    Text(DesktopSettingsCatalog.localeLabel(locale)).tag(locale)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            .disabled(model.isMutating)
            .accessibilityLabel("Interface language")
            .accessibilityIdentifier("juno.desktop.settings.interface-language")
        }
    }

    private func styleTile(_ settings: NativeAccountSettings) -> some View {
        DesktopSettingsStyleTile(
            settings: settings,
            disabled: model.isMutating,
            update: update
        )
    }

    private func instructionsTile(_ settings: NativeAccountSettings) -> some View {
        DesktopSettingsInstructionsTile(
            settings: settings,
            disabled: model.isMutating,
            update: update
        )
    }

    /// The switch and the link, as the web has it. A tile whose only control was
    /// "go and look" cannot answer the question people most often open settings
    /// with: is memory on?
    private var memoryTile: some View {
        JunoSettingsTile("Memory") {
            Toggle(isOn: memoryBinding) {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text("Reference saved memories")
                        .junoRowLabel()
                    Text("Juno keeps helpful details from your chats and uses them as context.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .toggleStyle(.switch)
            .tint(Color.junoAccent)
            .disabled(model.isMutating || model.settings == nil)
            .accessibilityLabel("Reference saved memories")
            .accessibilityIdentifier("juno.desktop.settings.memory-enabled")

            Spacer(minLength: JunoSpace.snug)

            Text("^[\(model.memories.count) saved fact](inflect: true)")
                .junoCaption()
            Button {
                isShowingMemory = true
            } label: {
                Text("Open memory manager").junoWideButtonLabel()
            }
            .accessibilityIdentifier("juno.desktop.settings.memory-manager")

            Divider()

            // Where the work the switch above enables is allowed to send what
            // it reads. In the same tile deliberately: the switch decides
            // *whether* Juno extracts from your chats, and this decides *who
            // sees them* when it does. Showing the first without the second is
            // how extraction could go to whichever provider answered fastest
            // with nothing in the product saying so.
            Picker(
                "Background processing",
                selection: Binding(
                    get: { model.settings?.backgroundProviderMode ?? .default },
                    set: { update(NativeSettingsPatch(backgroundProviderMode: $0)) }
                )
            ) {
                ForEach(BackgroundProviderMode.allCases, id: \.self) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .disabled(model.isMutating || model.settings == nil)
            .accessibilityIdentifier("juno.desktop.settings.background-provider")

            Text((model.settings?.backgroundProviderMode ?? .default).explanation)
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            // Only the mode that can actually cross is flagged. A caution on
            // every option would train the reader to ignore the one that means
            // something.
            if (model.settings?.backgroundProviderMode ?? .default).permitsCrossProvider {
                Label(
                    "Content may reach a provider you did not pick.",
                    systemImage: "exclamationmark.triangle"
                )
                .junoCaption()
                .foregroundStyle(Color.junoCaution)
            }
        }
    }

    /// Hosting for Juno Code Remote — off until someone at this Mac says
    /// otherwise.
    ///
    /// The switch is the whole feature's consent. Signing in is not consent to
    /// let a phone run commands here, so the default is off and the only way to
    /// change it is at the machine that would be doing the work. Turning it off
    /// takes effect immediately rather than at the next heartbeat, because "I
    /// have stopped sharing this Mac" is not a thing to be eventually true.
    @ViewBuilder
    private var remoteHostTile: some View {
        if let host = codeHostModel {
            JunoSettingsTile("Juno Code Remote") {
                Toggle(
                    isOn: Binding(
                        get: { host.servesQueuedTasks },
                        set: { host.servesQueuedTasks = $0 }
                    )
                ) {
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text("Allow remote Juno Code on this Mac")
                            .junoRowLabel()
                        Text(
                            "Lets your phone and the web start Juno Code sessions that run here, "
                                + "in the workspaces you have shared. Off, this Mac stays visible "
                                + "but runs nothing sent to it."
                        )
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .toggleStyle(.switch)
                .tint(Color.junoAccent)
                .accessibilityIdentifier("juno.desktop.settings.remote-host-enabled")

                if host.servesQueuedTasks {
                    Divider()
                    Text(
                        "Remote sessions start in ask-before-changes and cannot be raised from "
                            + "another device. Approvals still come to this Mac."
                    )
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)

                    Button(role: .destructive) {
                        host.stopServingRemoteWork()
                    } label: {
                        Text("Stop serving remote work now").junoWideButtonLabel()
                    }
                    .accessibilityIdentifier("juno.desktop.settings.remote-host-kill")
                }
            }
        }
    }

    /// Juno Work's consent surface, which is a whole card of its own.
    ///
    /// It lives in ``DesktopWorkHostTile`` rather than inline here for the
    /// reason the appearance and model tiles moved out: this page is already
    /// 1600 lines, and a tile carrying eleven controls, two editable lists and a
    /// confirmation would make the shape of the *page* — the grid, the two
    /// orderings, the status chrome — impossible to see. The guard stays here so
    /// the registration below reads identically to `remoteHostTile`'s.
    @ViewBuilder
    private var workHostTile: some View {
        if let workHost = workHostModel {
            DesktopWorkHostTile(host: workHost)
        }
    }

    /// Identity is in the header; this tile is what you can *do* with the
    /// account. Shared links sits here because a link you handed out is a thing
    /// the world already has of yours, and it is only safe to hand one out if it
    /// can be taken back from somewhere findable.
    private var accountTile: some View {
        JunoSettingsTile("Account") {
            DesktopSettingsAccountActions(
                authModel: authModel,
                session: session,
                accountDataClient: accountDataClient,
                showsSharedLinks: shareClient != nil,
                openSharedLinks: { sheet = .sharedLinks }
            )
        }
    }

    private func notificationsTile(_ settings: NativeAccountSettings) -> some View {
        JunoSettingsTile("Email notifications") {
            DesktopSettingsSwitchRow(
                title: "Budget alerts",
                detail: "Email me at 80% of my monthly budget.",
                isOn: junoSettingsBinding(
                    settings, \.emailBudgetAlerts, update: update
                ) { NativeSettingsPatch(emailBudgetAlerts: $0) }
            )
            .disabled(model.isMutating)
            .accessibilityIdentifier("juno.desktop.settings.budget-alerts")

            Divider()

            DesktopSettingsSwitchRow(
                title: "Weekly digest",
                detail: "Usage recap every Monday.",
                isOn: junoSettingsBinding(
                    settings, \.emailWeeklyDigest, update: update
                ) { NativeSettingsPatch(emailWeeklyDigest: $0) }
            )
            .disabled(model.isMutating)
            .accessibilityIdentifier("juno.desktop.settings.weekly-digest")
        }
    }

    /// The build's own identity, and the pane that compares it against the
    /// server. Nothing here is a preference — it is the answer to "which Juno am
    /// I running", which is the first question any support conversation asks.
    private var aboutTile: some View {
        JunoSettingsTile("About") {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text("Juno for Mac \(JunoBuildInfo.current.displayVersion)")
                        .junoRowLabel()
                        .textSelection(.enabled)
                    Text("Channel \(JunoBuildInfo.current.channel) · contract \(JunoBuildInfo.current.contractVersion)")
                        .junoCodeSmall()
                        .junoSecondaryInk()
                        .textSelection(.enabled)
                }
                Spacer(minLength: JunoSpace.snug)
                Button("Diagnostics…") { sheet = .diagnostics }
                    .accessibilityIdentifier("juno.desktop.settings.diagnostics")
            }
        }
    }

    /// Same calm container as every other tile, with the destructive edge the
    /// web gives it. The danger lives in the button and in the typed
    /// confirmation behind it, not in a shouting border.
    private var dangerTile: some View {
        JunoSettingsTile("Danger zone") {
            DesktopSettingsDangerActions(
                authModel: authModel,
                session: session,
                accountDataClient: accountDataClient
            )
        }
        .overlay(
            RoundedRectangle(
                cornerRadius: JunoSettingsMetrics.tileRadius,
                style: .continuous
            )
            .strokeBorder(Color.junoDanger.opacity(0.28), lineWidth: 1)
        )
    }

    // MARK: - Plumbing

    private var memoryBinding: Binding<Bool> {
        Binding(
            get: { model.settings?.memoryEnabled ?? true },
            set: { enabled in
                Task {
                    await model.updateSettings(NativeSettingsPatch(memoryEnabled: enabled))
                }
            }
        )
    }

    private func update(_ patch: NativeSettingsPatch) {
        Task { await model.updateSettings(patch) }
    }

    /// The one transient thing on this screen, and therefore the one thing that
    /// floats: a conflict that needs a decision, or a save queued behind the
    /// network. The controls inside are plain — the capsule already carries the
    /// material.
    @ViewBuilder
    private var statusChrome: some View {
        if model.conflictedMutationCount > 0 {
            floatingStatus(
                symbol: "exclamationmark.arrow.triangle.2.circlepath",
                message: "Memory or settings changed on another device."
            ) {
                Button("Keep mine") {
                    Task { await model.resolveConflicts(keepLocalChanges: true) }
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.junoAccent)
                .accessibilityIdentifier("juno.desktop.settings.keep-local")

                Button("Use server version") {
                    Task { await model.resolveConflicts(keepLocalChanges: false) }
                }
                .buttonStyle(.plain)
                .junoSecondaryInk()
                .accessibilityIdentifier("juno.desktop.settings.use-server")
            }
        } else if model.phase == .offline || model.phase == .failed,
            let message = model.lastErrorDescription
        {
            floatingStatus(
                symbol: model.phase == .offline ? "wifi.slash" : "exclamationmark.circle",
                message: DesktopStatusCopy(subject: "settings", singular: "setting")
                    .humanized(
                        message,
                        fallback: "Juno couldn't sync your settings."
                    )
            ) {
                Button("Retry") { Task { await model.refresh() } }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.junoAccent)
                    .accessibilityIdentifier("juno.desktop.settings.retry")
            }
        }
    }

    private func floatingStatus<Actions: View>(
        symbol: String,
        message: String,
        @ViewBuilder actions: () -> Actions
    ) -> some View {
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.cozy) {
                Image(systemName: symbol)
                    .junoSecondaryInk()
                    .accessibilityHidden(true)
                Text(message)
                    .junoRowLabel()
                    .lineLimit(2)
                actions()
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.cozy)
            .junoFloatingChrome()
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: JunoSettingsMetrics.readingWidth)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.settings.status")
    }
}

// MARK: - Shared furniture

/// The two package-owned panes this page hosts rather than restyles.
///
/// Both are shared with the iPhone, which renders the same `Form`. Presenting
/// them as sheets keeps that code untouched and keeps the settings page itself a
/// single scroll — the alternative was two more tabs in a tab bar this rebuild
/// exists to delete.
private enum DesktopSettingsSheet: String, Identifiable {
    case sharedLinks
    case diagnostics

    var id: String { rawValue }

    var title: String {
        switch self {
        case .sharedLinks: "Shared links"
        case .diagnostics: "Diagnostics"
        }
    }
}

/// A sheet with a title and one way out.
///
/// The frame is explicit on purpose: a presented surface that negotiates its own
/// size re-lays out the window underneath it as it appears, and this shell has
/// fallen into a constraint loop over exactly that.
private struct DesktopSettingsSheetHost<Content: View>: View {
    let sheet: DesktopSettingsSheet
    @ViewBuilder var content: Content

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(sheet.title)
                    .junoTitle()
                Spacer(minLength: JunoSpace.regular)
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.vertical, JunoSpace.cozy)
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(
            width: DesktopSettingsMetrics.sheetWidth,
            height: DesktopSettingsMetrics.sheetHeight
        )
        // Sheet contract: this host is the root of every Settings sheet, so the
        // warm ground goes on once here rather than in each pane. Without it the
        // panes stood on the system's neutral window grey while the Settings page
        // behind them was warm. The platter stays the system's.
        .junoSheetSurface(.fitted)
    }
}

enum DesktopSettingsMetrics {
    /// The signed-in account's photo in the page header.
    static let avatarSize: CGFloat = 44
    /// A presented surface's size. Explicit — see ``DesktopSettingsSheetHost``.
    static let sheetWidth: CGFloat = 560
    static let sheetHeight: CGFloat = 520
    /// The narrow confirmation sheets: a paragraph and a field, nothing more.
    static let confirmWidth: CGFloat = 460
    /// A multi-line editor's floor: enough that a short paragraph is visible
    /// without scrolling, small enough to fit the 460pt ⌘, window.
    static let editorMinHeight: CGFloat = 132
    /// An accent swatch in the appearance tile.
    static let swatchSize: CGFloat = 28
    /// A provider mark beside a model's name.
    static let providerMark: CGFloat = 20
}

private extension View {
    /// The small monospaced caps above a page heading — the web's `eyebrow`.
    func junoSettingsEyebrow() -> some View {
        junoCodeSmall()
            .junoSecondaryInk()
            .textCase(.uppercase)
    }

    /// A button label that fills its tile, as the web's `w-full` outline buttons
    /// do. The frame belongs on the *label*: on the button it only widens the hit
    /// area and leaves the bezel floating in the middle of the card.
    func junoWideButtonLabel() -> some View {
        frame(maxWidth: .infinity)
            .padding(.vertical, 1)
    }
}

/// A full-width action row: a glyph, what it does, and a chevron.
///
/// Used where a tile's job is to lead somewhere rather than to hold a control,
/// so those tiles read as one kind of thing instead of each inventing its own
/// button.
///
/// The glyph is neutral. The website's settings page spends `--primary` on
/// exactly two things — a plan's feature ticks and the tick beside a chosen
/// option — and never on the icon of a row that merely leads somewhere. A coral
/// glyph on every navigation row made the accent mean "this is a row" rather
/// than "this is the one thing to do here", which is the whole job it has.
private struct DesktopSettingsAction: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    let symbol: String
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: JunoSpace.cozy) {
                Image(systemName: symbol)
                    .font(.system(size: 15))
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(title)
                        .junoRowLabel()
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)
                    Text(detail)
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: JunoSpace.snug)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .junoMetaInk()
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug + 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .fill(isHovering ? Color.junoRowHover : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityHint(detail)
    }
}

/// A switch with one line of explanation — the *only* line of explanation.
///
/// The row this replaces printed its own sentence and then let the enclosing
/// section's footer print a second one, so each email switch was described
/// twice, in two registers, forty points apart.
private struct DesktopSettingsSwitchRow: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(title)
                    .junoRowLabel()
                Text(detail)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
            // The label claims the row so the switch sits on the trailing edge.
            // Without it a `Toggle` hugs its label, and two rows with different
            // sentence lengths put their switches at two different x positions.
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        .tint(Color.junoAccent)
        // The explanation is a hint, not part of the name: VoiceOver reads the
        // name on every focus and the hint only when the reader waits for it.
        .accessibilityLabel(title)
        .accessibilityHint(detail)
    }
}

/// A binding onto one field of the account's settings record.
///
/// The patch is only sent when the value actually changes: a `Picker` writes its
/// selection on every layout pass in some styles, and without this guard the
/// outbox filled with no-op mutations.
/// Every piece this captures is `Sendable`, because `Binding`'s accessors are
/// `@Sendable` in the macOS 26 SDK. Without the constraints the four captures —
/// the key path, the metatype, and the two closures — are each rejected under
/// Swift 6. They read as warnings on some toolchains and as errors on the one CI
/// builds with, which is how this reached `main` looking clean.
private func junoSettingsBinding<Value: Equatable & Sendable>(
    _ settings: NativeAccountSettings,
    _ keyPath: KeyPath<NativeAccountSettings, Value> & Sendable,
    update: @escaping @MainActor @Sendable (NativeSettingsPatch) -> Void,
    patch: @escaping @Sendable (Value) -> NativeSettingsPatch
) -> Binding<Value> {
    Binding(
        get: { settings[keyPath: keyPath] },
        set: { value in
            guard value != settings[keyPath: keyPath] else { return }
            // SwiftUI drives a `Binding`'s setter on the main actor, but the
            // accessor itself is non-isolated `@Sendable` in the macOS 26 SDK,
            // so the isolation has to be re-stated rather than inferred.
            // `assumeIsolated` records that invariant instead of hiding it in a
            // `Task`, which would also make the write land a turn late — long
            // enough for a `Picker` to read back its old value and flicker.
            MainActor.assumeIsolated { update(patch(value)) }
        }
    )
}

/// Keeps a stored value the picker does not recognize selectable, so opening a
/// menu can never silently rewrite a preference this build has not shipped.
private func junoKnownOrCurrent(_ known: [String], current: String) -> [String] {
    known.contains(current) ? known : [current] + known
}

/// The two language lists, mirrored from the website.
private enum DesktopSettingsCatalog {
    static let responseLanguages = [
        "auto", "English", "Spanish", "French", "German", "Portuguese",
        "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic",
    ]

    static let interfaceLocales = [
        "auto", "en", "es", "fr", "de", "it", "pt-BR", "nl", "pl", "tr", "ru",
        "uk", "sv", "id", "vi", "th", "hi", "ja", "ko", "zh-Hans", "zh-Hant",
    ]

    /// Each language names itself, as it does on the web — someone looking for
    /// their own language finds it written the way they write it, not translated
    /// into the one currently in force.
    static func localeLabel(_ locale: String) -> String {
        guard locale != "auto" else { return "Match system" }
        let identifier = Locale(identifier: locale)
        return identifier.localizedString(forIdentifier: locale)
            ?? Locale.current.localizedString(forIdentifier: locale)
            ?? locale
    }
}

// MARK: - Appearance

/// Theme and accent, the two choices small enough to show whole.
///
/// Both were dropdowns-in-a-form before — a segmented control for three themes
/// and a radio group of five named colours with a dot beside each name. The web
/// shows the three themes as cards and the accents as the colours themselves,
/// which is the only version where the reader picks by looking rather than by
/// reading a word for a colour.
private struct DesktopSettingsAppearanceTile: View {
    let settings: NativeAccountSettings
    let disabled: Bool
    let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

    private static let themes: [(value: NativeThemePreference, title: LocalizedStringKey, detail: LocalizedStringKey, symbol: String)] = [
        (.system, "System", "Follows this Mac's appearance.", "circle.lefthalf.filled"),
        (.light, "Light", "Always the paper canvas.", "sun.max"),
        (.dark, "Dark", "Always the warm near-black.", "moon"),
    ]

    var body: some View {
        JunoSettingsTile("Appearance") {
            Text("Theme")
                .junoCaption()
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                ForEach(Self.themes, id: \.value) { theme in
                    JunoChoiceCard(
                        title: theme.title,
                        detail: theme.detail,
                        isSelected: settings.theme == theme.value,
                        isEnabled: !disabled,
                        trailing: {
                            Image(systemName: theme.symbol)
                                .font(.system(size: 13))
                                .junoSecondaryInk()
                        },
                        select: { update(NativeSettingsPatch(theme: theme.value)) }
                    )
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Theme")
            .accessibilityIdentifier("juno.desktop.settings.theme")

            Text("Accent color")
                .junoCaption()
                .padding(.top, JunoSpace.snug)
            HStack(spacing: JunoSpace.cozy) {
                ForEach(JunoAccent.allCases) { accent in
                    DesktopAccentSwatch(
                        accent: accent,
                        isSelected: JunoAccent(setting: settings.accent) == accent
                            && JunoAccent(rawValue: settings.accent.lowercased()) != nil,
                        isEnabled: !disabled,
                        select: { update(NativeSettingsPatch(accent: accent.rawValue)) }
                    )
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Accent color")
            .accessibilityIdentifier("juno.desktop.settings.accent")

            // Said only when it is true. The web can store an arbitrary hex
            // accent and this app ships five; resolving that to Coral without
            // saying so would look like the picker had silently changed the
            // account's colour.
            if JunoAccent(rawValue: settings.accent.lowercased()) == nil {
                Text("This account has a custom accent set on the web. Juno for Mac draws it as Coral; choosing one here replaces it.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// One accent, as the colour itself.
private struct DesktopAccentSwatch: View {
    let accent: JunoAccent
    let isSelected: Bool
    let isEnabled: Bool
    let select: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: select) {
            Circle()
                .fill(accent.color)
                .frame(
                    width: DesktopSettingsMetrics.swatchSize,
                    height: DesktopSettingsMetrics.swatchSize
                )
                .overlay {
                    if isSelected {
                        // On the accent, not white: amber and the lifted dark
                        // accents fail contrast under a white checkmark, which
                        // is the whole reason `onAccent` exists.
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(accent.onAccent)
                    }
                }
                // A ring outside the swatch rather than a border on it, so the
                // colour a reader is judging is never thinned by its own
                // selection indicator.
                .overlay {
                    Circle()
                        .strokeBorder(Color.primary.opacity(isSelected ? 0.85 : 0), lineWidth: 2)
                        .padding(-3)
                }
                .scaleEffect(isHovering && isEnabled ? 1.08 : 1)
                .animation(JunoMotion.fast, value: isHovering)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .onHover { isHovering = $0 }
        .help(accent.displayName)
        .accessibilityLabel(accent.displayName)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - Default model

/// The account's default model, chosen in the app's own catalog browser.
///
/// This used to be a `Picker` of sixty flat rows. ``JunoModelSelector`` — the
/// provider rail, the searchable catalog and the spec sheet — already ships in
/// the design system and is what the composer opens; there was never a reason
/// for settings to offer a worse view of the same manifest.
private struct DesktopSettingsModelTile: View {
    let settings: NativeAccountSettings
    let modelCatalog: [NativeChatModelOption]
    let disabled: Bool
    let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

    @State private var isPresented = false

    private var descriptors: [JunoModelDescriptor] {
        modelCatalog.map(\.junoDescriptor)
    }

    private var selected: JunoModelDescriptor? {
        descriptors.first { $0.id == settings.defaultModel }
    }

    var body: some View {
        JunoSettingsTile("Default model") {
            Text("New chats start here. Any chat can still be moved to another model from the composer.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            if modelCatalog.isEmpty {
                Text("Juno is still loading your model catalog. Until it arrives this account uses \(junoDisplayModelName(settings.defaultModel)).")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                trigger
                if let summary = selected?.summary, !summary.isEmpty {
                    Text(summary)
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var trigger: some View {
        Button {
            isPresented = true
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                JunoProviderMark(
                    providerID: selected?.providerID ?? "juno",
                    providerName: selected?.providerName ?? "Juno",
                    size: DesktopSettingsMetrics.providerMark
                )
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(selected?.displayName ?? junoDisplayModelName(settings.defaultModel))
                        .junoRowLabel()
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)
                    Text(selected?.providerName ?? "Not in this account's catalog")
                        .junoCaption()
                }
                Spacer(minLength: JunoSpace.snug)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption.weight(.semibold))
                    .junoSecondaryInk()
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug + 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel("Default model")
        .accessibilityValue(selected?.displayName ?? settings.defaultModel)
        .accessibilityIdentifier("juno.desktop.settings.default-model")
        // Dismissed with its anchor, always. A `.popover` whose anchor leaves
        // the hierarchy while it is presented makes SwiftUI re-run
        // `showRelativeToRect:` against a window already being ordered, and the
        // process takes SIGTRAP.
        .onDisappear { isPresented = false }
        .popover(
            isPresented: $isPresented,
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .bottom
        ) {
            // Explicit frame, twice over: the selector sizes itself and the
            // popover is told the same numbers. A self-sizing popover over a
            // split view has crashed this app before.
            JunoModelSelector(
                models: descriptors,
                selectedModelID: settings.defaultModel,
                select: { descriptor in
                    isPresented = false
                    guard descriptor.id != settings.defaultModel else { return }
                    update(NativeSettingsPatch(defaultModel: descriptor.id))
                }
            )
            .frame(
                width: JunoModelSelectorMetrics.standard.width,
                height: JunoModelSelectorMetrics.standard.height
            )
        }
    }
}

// MARK: - Favorite models

/// The models pinned to the top of the composer's menu.
///
/// This was a `Table` with a checkbox column, fixed at 210pt, scrolling inside a
/// scrolling form — a spreadsheet for a set that is usually three rows long. A
/// favourite is a short list you curate, so it is drawn as the list: what is in
/// it, one action to remove each, and a provider-grouped menu to add.
private struct DesktopSettingsFavoritesTile: View {
    let settings: NativeAccountSettings
    let modelCatalog: [NativeChatModelOption]
    let disabled: Bool
    let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

    /// In the account's own order, not the catalog's — the order is the reader's
    /// ranking and reshuffling it on every render would erase that.
    private var favorites: [NativeChatModelOption] {
        settings.favoriteModels.compactMap { id in
            modelCatalog.first { $0.id == id }
        }
    }

    /// Provider name → its models, in catalog order, minus what is already
    /// favourited. Grouped because a flat menu of sixty is a scroll, not a choice.
    private var addable: [(provider: String, models: [NativeChatModelOption])] {
        let remaining = modelCatalog.filter { !settings.favoriteModels.contains($0.id) }
        var order: [String] = []
        var grouped: [String: [NativeChatModelOption]] = [:]
        for option in remaining {
            if grouped[option.providerName] == nil { order.append(option.providerName) }
            grouped[option.providerName, default: []].append(option)
        }
        return order.map { ($0, grouped[$0] ?? []) }
    }

    var body: some View {
        JunoSettingsTile("Favorite models") {
            Text("Favorites sit at the top of the composer's model menu, ahead of the full catalog.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            if favorites.isEmpty {
                Text("None yet — the menu shows the whole catalog until you pin something.")
                    .junoCaption()
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(favorites.enumerated()), id: \.element.id) { index, option in
                        if index > 0 { Divider() }
                        row(option)
                    }
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.hairline)
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                        .strokeBorder(Color.junoBorder, lineWidth: 1)
                )
                .accessibilityIdentifier("juno.desktop.settings.favorite-models")
            }

            if !addable.isEmpty {
                Menu("Add a favorite…") {
                    ForEach(addable, id: \.provider) { group in
                        Menu(group.provider) {
                            ForEach(group.models) { option in
                                Button(option.displayName) { setFavorite(option.id, true) }
                            }
                        }
                    }
                }
                .menuStyle(.button)
                .fixedSize()
                .disabled(disabled)
                .accessibilityIdentifier("juno.desktop.settings.add-favorite")
            }
        }
    }

    private func row(_ option: NativeChatModelOption) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoProviderMark(
                providerID: option.providerID,
                providerName: option.providerName,
                size: DesktopSettingsMetrics.providerMark
            )
            Text(option.displayName)
                .junoRowLabel()
            Text(option.providerName)
                .junoCaption()
            Spacer(minLength: JunoSpace.snug)
            Button {
                setFavorite(option.id, false)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .junoMetaInk()
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .help("Remove \(option.displayName) from favorites")
            .accessibilityLabel("Remove \(option.displayName) from favorites")
        }
        .padding(.vertical, JunoSpace.snug)
    }

    private func setFavorite(_ modelID: String, _ isFavorite: Bool) {
        var favorites = settings.favoriteModels
        if isFavorite {
            guard !favorites.contains(modelID) else { return }
            favorites.append(modelID)
        } else {
            guard favorites.contains(modelID) else { return }
            favorites.removeAll { $0 == modelID }
        }
        update(NativeSettingsPatch(favoriteModels: favorites))
    }
}

// MARK: - Response style

/// Six presets, all visible. A dropdown would hide five of them and give the
/// reader no way to compare what they promise, which is the whole content of
/// the choice.
private struct DesktopSettingsStyleTile: View {
    let settings: NativeAccountSettings
    let disabled: Bool
    let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

    private static let columns = [
        GridItem(.flexible(), spacing: JunoSpace.snug),
        GridItem(.flexible(), spacing: JunoSpace.snug),
    ]

    var body: some View {
        JunoSettingsTile("Response style") {
            Text("How Juno writes. Your custom instructions still take priority.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            // A preset this build has never heard of stays named and selected,
            // so a style chosen on the web after this app shipped is not
            // silently demoted the moment settings are opened.
            if JunoResponseStyle.named(settings.personality) == nil {
                Text("This account uses “\(settings.personality)”, a style Juno for Mac does not ship. Choosing one below replaces it.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }

            LazyVGrid(columns: Self.columns, alignment: .leading, spacing: JunoSpace.snug) {
                ForEach(JunoResponseStyle.all) { style in
                    JunoChoiceCard(
                        title: style.localizedLabel,
                        detail: style.localizedDetail,
                        isSelected: settings.personality == style.id,
                        isEnabled: !disabled,
                        select: { update(NativeSettingsPatch(personality: style.id)) }
                    )
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Response style")
            .accessibilityIdentifier("juno.desktop.settings.personality")
        }
    }
}

// MARK: - Custom instructions

private struct DesktopSettingsInstructionsTile: View {
    let settings: NativeAccountSettings
    let disabled: Bool
    let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

    @State private var draft = ""
    /// What the field was last handed by the account record. Compared against the
    /// draft to tell "untouched" from "half-written", so a settings push landing
    /// mid-sentence cannot erase what is being typed.
    @State private var baseline: String?

    var body: some View {
        JunoSettingsTile("Custom instructions") {
            Text("Juno keeps these in mind in every conversation on this account. There is no character cap — the model's context window is the only real limit.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            ZStack(alignment: .bottomTrailing) {
                TextEditor(text: $draft)
                    .junoBody()
                    .frame(minHeight: DesktopSettingsMetrics.editorMinHeight)
                    .scrollContentBackground(.hidden)
                    .padding(JunoSpace.snug)
                    // Room for the counter, which sits inside the field as it
                    // does on the web rather than becoming another row of chrome.
                    .padding(.bottom, JunoSpace.regular)
                    .junoPanel(cornerRadius: JunoRadius.panel)
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                            .strokeBorder(Color.junoBorder, lineWidth: 1)
                    )
                    .accessibilityLabel("Custom instructions")
                    .accessibilityIdentifier("juno.desktop.settings.instructions")

                // Not a limit — the one number that tells you a long paste
                // actually landed.
                Text("\(draft.count.formatted()) chars")
                    .junoCodeSmall()
                    .junoMetaInk()
                    .padding(.trailing, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.snug)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }

            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Revert") { draft = settings.customInstructions }
                    .disabled(draft == settings.customInstructions)
                Button("Save") {
                    update(NativeSettingsPatch(customInstructions: draft))
                }
                .keyboardShortcut("s", modifiers: .command)
                .help("Save your custom instructions (⌘S)")
                .disabled(disabled || draft == settings.customInstructions)
                .accessibilityIdentifier("juno.desktop.settings.save-instructions")
            }
        }
        .task(id: settings.customInstructions) {
            let stored = settings.customInstructions
            if draft == (baseline ?? "") {
                draft = stored
            }
            baseline = stored
        }
    }
}

// MARK: - Account actions

/// What you can do with the account, as opposed to who it is.
private struct DesktopSettingsAccountActions: View {
    let authModel: NativeAuthModel
    let session: NativeAuthenticatedSession
    let accountDataClient: NativeAccountDataClient?
    let showsSharedLinks: Bool
    let openSharedLinks: () -> Void

    @State private var isExporting = false
    @State private var exportDocument: DesktopSettingsExportDocument?
    @State private var exportContentType: UTType = .json
    @State private var exportFilename = ""
    @State private var showingExporter = false
    @State private var showingSignOut = false
    @State private var exportError: String?

    var body: some View {
        if showsSharedLinks {
            Button(action: openSharedLinks) {
                Text("Shared links…").junoWideButtonLabel()
            }
            .help("Every public link this account has handed out, and the way to take one back")
            .accessibilityIdentifier("juno.desktop.settings.shared-links")
        }

        // Two buttons rather than one with a menu behind it. There are exactly
        // two formats, and a dropdown that hides one of two options costs a
        // click to discover and saves nothing — the same rule that put the
        // response styles on cards.
        if accountDataClient != nil {
            Button { export(.json) } label: {
                Text("Export your data as JSON…").junoWideButtonLabel()
            }
            .disabled(isExporting)
            .help("Every conversation, project, file and memory on this account")
            .accessibilityIdentifier("juno.desktop.settings.export-json")
            // Attached to the control that starts it rather than to the tile:
            // two presentations on one view is where SwiftUI drops one.
            .fileExporter(
                isPresented: $showingExporter,
                document: exportDocument,
                contentType: exportContentType,
                defaultFilename: exportFilename
            ) { result in
                if case .failure(let error) = result {
                    exportError = error.localizedDescription
                }
                exportDocument = nil
            }

            Button { export(.csv) } label: {
                Text("Export your data as CSV…").junoWideButtonLabel()
            }
            .disabled(isExporting)
            .help("The same export as a spreadsheet")
            .accessibilityIdentifier("juno.desktop.settings.export-csv")

            if isExporting {
                HStack(spacing: JunoSpace.snug) {
                    ProgressView().controlSize(.small)
                    Text("Downloading your export…").junoCaption()
                }
            }
        }

        if let exportError {
            Label(exportError, systemImage: "exclamationmark.circle")
                .junoCaption()
                .foregroundStyle(Color.junoCaution)
                .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: JunoSpace.snug)

        Button { showingSignOut = true } label: {
            Text("Sign out").junoWideButtonLabel()
        }
            .accessibilityIdentifier("juno.desktop.settings.sign-out")
            .confirmationDialog("Sign out of Juno?", isPresented: $showingSignOut) {
                Button("Sign out", role: .destructive) {
                    Task { await authModel.signOut() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Juno removes this Mac's local copy of your conversations and settings. Nothing is deleted on the server.")
            }
    }

    /// Downloads the export, then hands it to `.fileExporter`.
    ///
    /// Two steps rather than one because the file does not exist until the
    /// request comes back: a save panel opened first would be asking where to
    /// put something Juno might fail to fetch. The shared client writes the
    /// response to a temporary file, so the bytes are read back from there —
    /// that keeps the export rules (row caps, CSV quoting) in the one place both
    /// apps share.
    private func export(_ format: NativeAccountDataClient.ExportFormat) {
        guard let accountDataClient else { return }
        isExporting = true
        exportError = nil
        Task {
            defer { isExporting = false }
            do {
                let url = try await accountDataClient.export(
                    format: format,
                    for: session.profile.id
                )
                let data = try Data(contentsOf: url)
                try? FileManager.default.removeItem(at: url)
                exportDocument = DesktopSettingsExportDocument(data: data)
                exportContentType = format == .csv ? .commaSeparatedText : .json
                // Stem only: the save panel appends the extension for the
                // content type, and passing the client's full file name gave the
                // sheet "juno-export-2026-07-26.json.json" to save.
                exportFilename = URL(fileURLWithPath: format.fileName(on: Date()))
                    .deletingPathExtension()
                    .lastPathComponent
                showingExporter = true
            } catch {
                exportError = error.localizedDescription
            }
        }
    }
}

// MARK: - Danger zone

private struct DesktopSettingsDangerActions: View {
    let authModel: NativeAuthModel
    let session: NativeAuthenticatedSession
    let accountDataClient: NativeAccountDataClient?

    @State private var showingDelete = false
    @State private var confirmation = ""
    @State private var isDeleting = false
    @State private var deleteError: String?

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Delete account")
                    .junoRowLabel()
                    .fontWeight(.medium)
                Text("Permanently removes your account, conversations, projects, files and memories — everywhere, not just on this Mac.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: JunoSpace.snug)
            if accountDataClient == nil {
                Text("Unavailable on this Mac")
                    .junoCaption()
            } else {
                Button("Delete account…", role: .destructive) {
                    confirmation = ""
                    deleteError = nil
                    showingDelete = true
                }
                .disabled(isDeleting)
                .accessibilityIdentifier("juno.desktop.settings.delete-account")
            }
        }
        .sheet(isPresented: $showingDelete) { confirmSheet }
    }

    private var confirmSheet: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Delete your account?")
                .junoEmptyTitle()
            Text("This permanently deletes every conversation, project, file and memory on this account. It cannot be undone.")
                .junoBody()
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
            Text("Type \(session.profile.email) to confirm.")
                .junoCaption()
            TextField("Email", text: $confirmation)
                .accessibilityLabel("Confirm your email address")
                .accessibilityIdentifier("juno.desktop.settings.delete-confirm")
            if let deleteError {
                Label(deleteError, systemImage: "exclamationmark.circle")
                    .junoCaption()
                    .foregroundStyle(Color.junoCaution)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel") { showingDelete = false }
                    .keyboardShortcut(.cancelAction)
                if isDeleting {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Delete account", role: .destructive, action: deleteAccount)
                        .disabled(!confirmationMatches)
                }
            }
        }
        .padding(JunoSpace.roomy)
        // An explicit width. A presented surface that negotiates its own width
        // re-lays out the window underneath it while it appears, and that
        // re-measure is what this shell has previously fallen into a constraint
        // loop over.
        .frame(width: DesktopSettingsMetrics.confirmWidth)
        // Sheet contract: the warm ground inside the content, the platter left to
        // the system. `.fitted` honours the explicit width above.
        .junoSheetSurface(.fitted)
    }

    /// The same comparison the server makes, so the button is dead until the
    /// confirmation is right rather than live and then refused —
    /// `/api/account/delete` allows three attempts an hour.
    private var confirmationMatches: Bool {
        !session.profile.email.isEmpty
            && confirmation
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .caseInsensitiveCompare(session.profile.email) == .orderedSame
    }

    private func deleteAccount() {
        guard let accountDataClient else { return }
        isDeleting = true
        deleteError = nil
        Task {
            defer { isDeleting = false }
            do {
                try await accountDataClient.deleteAccount(
                    confirmEmail: confirmation,
                    accountEmail: session.profile.email,
                    for: session.profile.id
                )
                showingDelete = false
                // The account is gone; the local mirror has to go too, and
                // signing out is what tears down every model holding a copy.
                await authModel.signOut()
            } catch {
                deleteError = error.localizedDescription
            }
        }
    }
}

// MARK: - Export document

/// A snapshot on its way to a file the reader chooses — the account export from
/// the server, or the memory export written locally.
///
/// Write-only: reading one back into the app is not a thing Juno does, so the
/// read initializer refuses rather than pretending to import.
struct DesktopSettingsExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json, .commaSeparatedText] }

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        throw CocoaError(.fileReadUnsupportedScheme)
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
