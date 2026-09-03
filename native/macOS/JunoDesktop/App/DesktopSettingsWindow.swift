import AppKit
import JunoAuth
import JunoChatKit
import JunoCodeUI
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// The sections of Settings — the website's rail, one for one.
///
/// `src/components/settings/settings-sections.ts` is the registry this mirrors:
/// how Juno looks, how it talks, what it remembers, which models it uses, what
/// it may reach, how it sounds — then the account and the money. Code is the
/// one addition, because only the Mac has a Code runtime with standing
/// preferences of its own. Irreversible operations live at the bottom of
/// Account and Data & privacy rather than in a "danger zone" of their own.
enum DesktopSettingsSection: String, CaseIterable, Identifiable {
    case general
    case personalization
    case memory
    case models
    case connectors
    case voice
    case code
    case data
    case account
    case billing

    var id: String { rawValue }

    static let storageKey = "juno.desktop.settings.section"

    /// The names older call sites route by. `usage` is the plan's own page now
    /// and `connections` is what the web calls connectors.
    static var usage: DesktopSettingsSection { .billing }
    static var connections: DesktopSettingsSection { .connectors }

    var label: String {
        switch self {
        case .general: "General"
        case .personalization: "Personalization"
        case .memory: "Memory"
        case .models: "Models"
        case .connectors: "Connectors"
        case .voice: "Voice"
        case .code: "Code"
        case .data: "Data & privacy"
        case .account: "Account"
        case .billing: "Plan & billing"
        }
    }

    /// The web's one-line description, read out as the rail row's hint.
    var summary: String {
        switch self {
        case .general: "Theme, accent and language."
        case .personalization: "How Juno writes and what it keeps in mind."
        case .memory: "What Juno may remember between conversations."
        case .models: "Which model answers by default, and your favorites."
        case .connectors: "The apps Juno can read from and act on."
        case .voice: "How Juno sounds when it reads aloud."
        case .code: "Permissions, model, environment and hosting for Juno Code."
        case .data: "Export, shared links and diagnostics."
        case .account: "Who you are to Juno, and how you sign in."
        case .billing: "Your plan, what you have used, and the ceiling."
        }
    }

    var icon: JunoIcon {
        switch self {
        case .general: .sliders
        case .personalization: .writing
        case .memory: .memory
        case .models: .models
        case .connectors: .connections
        case .voice: .mic
        case .code: .code
        case .data: .shield
        case .account: .user
        case .billing: .usage
        }
    }

    /// The labels of the rows the section's form holds, for the sidebar's
    /// search field. A static table rather than a walk of the live form: the
    /// rows are known at build time, and a search that reads the view tree
    /// would have to build every section to answer one keystroke.
    var searchTerms: [String] {
        switch self {
        case .general:
            ["Appearance", "Theme", "Light", "Dark", "Accent color", "Interface language", "Updates", "Version", "Diagnostics", "About"]
        case .personalization:
            ["Response style", "Response language", "Custom instructions", "Personality"]
        case .memory:
            ["Saved memories", "Memory manager", "What Juno noticed", "Background processing", "Provider"]
        case .models:
            ["Default model", "Favorites", "Catalog"]
        case .connectors:
            ["Connections", "Integrations", "Apps", "OAuth"]
        case .voice:
            ["Read aloud", "Dictation", "Speech"]
        case .code:
            ["Permissions", "Environment", "MCP", "Hooks", "Skills", "Agents", "Remote", "Juno Work", "Hosting", "Pair"]
        case .data:
            ["Export", "JSON", "CSV", "Shared links", "Diagnostics", "Sync"]
        case .account:
            ["Profile", "Email", "Sign out", "Budget alerts", "Weekly digest", "Notifications", "Delete account"]
        case .billing:
            ["Plan", "Usage", "Budget", "Spend", "Limit", "Upgrade"]
        }
    }

    /// The sections a search string leaves visible — all of them for an empty
    /// string. Matched against the name, the summary and the row labels, case-
    /// and diacritic-insensitively, so "colour" still finds "Accent color".
    static func matching(_ query: String) -> [DesktopSettingsSection] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return allCases }
        return allCases.filter { section in
            ([section.label, section.summary] + section.searchTerms).contains { term in
                term.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }
        }
    }
}

/// Opens the Settings window on a section, from anywhere in the app.
///
/// The `Settings` scene has no `openWindow(value:)`, so the section crosses
/// through `UserDefaults` — written here, read by the window's rail on the
/// next frame. `@AppStorage` on both sides makes the window follow a write
/// made while it is already open.
@MainActor
enum DesktopSettingsRouter {
    static func select(_ section: DesktopSettingsSection) {
        UserDefaults.standard.set(section.rawValue, forKey: DesktopSettingsSection.storageKey)
    }

    /// Selects the section and brings the Settings window up.
    ///
    /// `showSettingsWindow:` is the responder-chain action the `Settings` scene
    /// installs behind ⌘, — the same one the application menu's item sends —
    /// so this is reachable from a closure with no view environment, which is
    /// where the sidebar footer and the menu bar item call it from.
    static func open(_ section: DesktopSettingsSection) {
        select(section)
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }
}

/// The ⌘, window: a source list of sections beside the section's form.
struct DesktopSettingsWindow: View {
    let configuration: JunoDesktopConfiguration?

    @AppStorage(DesktopSettingsSection.storageKey) private var storedSection =
        DesktopSettingsSection.general.rawValue

    private var section: Binding<DesktopSettingsSection> {
        Binding(
            get: { DesktopSettingsSection(rawValue: storedSection) ?? .general },
            set: { storedSection = $0.rawValue }
        )
    }

    var body: some View {
        Group {
            if let configuration,
               let settingsModel = configuration.memorySettingsModel,
               case .signedIn(let session) = configuration.authModel.phase
            {
                DesktopSettingsShell(section: section) { section in
                    DesktopSettingsScreen(
                        section: section,
                        configuration: configuration,
                        settingsModel: settingsModel,
                        session: session
                    )
                }
            } else {
                JunoEmptyState(
                    title: "Sign in to change settings",
                    message: "Juno's settings belong to your account and sync across your devices.",
                    icon: .user
                )
                .junoReadingCanvas()
            }
        }
        .frame(
            minWidth: DesktopSettingsMetrics.windowMinimum.width,
            idealWidth: DesktopSettingsMetrics.windowIdeal.width,
            minHeight: DesktopSettingsMetrics.windowMinimum.height,
            idealHeight: DesktopSettingsMetrics.windowIdeal.height
        )
        .accessibilityIdentifier("juno.desktop.settings.window")
    }
}

/// The shape of Settings — System Settings' shape — shared by the ⌘, window
/// and the in-window sheet so the two cannot come to disagree about what
/// Settings contains.
///
/// A `NavigationSplitView`: the sections are a real source list on the left,
/// so arrow keys, type-select, the focus ring and Increase Contrast are the
/// platform's, and the selected section's name and one-line summary are the
/// window's own title and subtitle rather than a heading painted into the
/// page. The sidebar column is vibrant, as every Mac source list is; only the
/// detail paints the reading canvas, and it paints it once here so no page
/// has to. The sidebar toggle is removed because a settings window with its
/// sections hidden is a window nobody can use.
///
/// `detail` builds the page for a section. The window hands over the whole
/// configuration; the modal has to work from the individual models its
/// callers already pass it, which is why the shell does not build the page
/// itself.
struct DesktopSettingsShell<Detail: View>: View {
    @Binding var section: DesktopSettingsSection
    /// Present in the modal, where the shell has to offer its own way out.
    var onDismiss: (() -> Void)? = nil
    @ViewBuilder let detail: (DesktopSettingsSection) -> Detail

    @State private var query = ""
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            DesktopSettingsSidebar(selection: $section, query: $query)
        } detail: {
            detail(section)
                .navigationTitle(section.label)
                .navigationSubtitle(section.summary)
                .junoReadingCanvas()
        }
        .toolbar(removing: .sidebarToggle)
        .toolbar {
            if let onDismiss {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onDismiss)
                        .keyboardShortcut(.defaultAction)
                        // The one primary action on the sheet, in Juno's
                        // accent rather than whatever the system's is.
                        .buttonStyle(.borderedProminent)
                        .tint(Color.junoAccent)
                        .help("Close settings")
                        .accessibilityIdentifier("juno.desktop.settings.done")
                }
            }
        }
        // Esc still leaves, as it did when the rail drew its own close control.
        .onExitCommand { onDismiss?() }
    }
}

/// The sections, as the platform's own source list.
///
/// Once hand-drawn, because a `List(selection:)` painted the platform's
/// full-bleed accent selection — a coral slab. The main sidebar has since
/// solved that with the pair in `JunoDesktopChrome`: the tint on the list for
/// the states it reaches, and the row's own fill for the emphasized state
/// macOS 26 paints in the system accent regardless. With that solved, there
/// is no reason left to draw a list by hand.
///
/// The search field filters the sections by their name, their summary and
/// the labels of the rows each form holds, so "accent" finds General and
/// "digest" finds Account without either word being in the section's name.
struct DesktopSettingsSidebar: View {
    @Binding var selection: DesktopSettingsSection
    @Binding var query: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var visible: [DesktopSettingsSection] {
        DesktopSettingsSection.matching(query)
    }

    /// `List(selection:)` wants an optional. Deselecting — ⌘-click on the
    /// selected row — is not a state Settings has, so nil keeps what was there.
    private var listSelection: Binding<DesktopSettingsSection?> {
        Binding(
            get: { selection },
            set: { if let section = $0 { selection = section } }
        )
    }

    var body: some View {
        List(selection: listSelection) {
            ForEach(visible) { section in
                row(section)
            }
        }
        .listStyle(.sidebar)
        // The selection is still the platform's — only its colour is Juno's.
        .junoSidebarSelectionTint()
        .searchable(text: $query, placement: .sidebar, prompt: "Search settings")
        .overlay {
            if visible.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .navigationSplitViewColumnWidth(
            min: DesktopSettingsMetrics.railMinimum,
            ideal: DesktopSettingsMetrics.railWidth,
            max: DesktopSettingsMetrics.railMaximum
        )
        .accessibilityLabel("Settings sections")
        .accessibilityIdentifier("juno.desktop.settings.rail")
    }

    private func row(_ section: DesktopSettingsSection) -> some View {
        // The ink is stated on the mark as well as on the label: a `Label` in a
        // `.sidebar` list resolves its icon slot against the system accent, and
        // an inherited `foregroundStyle` does not reach it. The rail is
        // greyscale, as the web's is — the mark rests on the sidebar ink and
        // lifts with its label when selected.
        let selected = selection == section
        let ink = selected ? Color.junoForeground : Color.junoSidebarForeground

        return Label {
            Text(section.label)
        } icon: {
            JunoIconView(section.icon, size: 16)
                .foregroundStyle(ink)
        }
        .foregroundStyle(ink)
        // A colour crossfade in place — tint-tier motion, which Reduce Motion
        // leaves alone, so it is deliberately not gated behind the preference.
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint),
            value: selected
        )
        .junoSidebarRowSelection(selected)
        .tag(section)
        .help(section.summary)
        .accessibilityIdentifier("juno.desktop.settings.section.\(section.rawValue)")
    }
}

extension DesktopSettingsScreen {
    /// The page for a section, with everything it reads taken from the window's
    /// configuration.
    init(
        section: DesktopSettingsSection,
        configuration: JunoDesktopConfiguration,
        settingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>,
        session: NativeAuthenticatedSession
    ) {
        let workbench = DesktopWorkbenchRegistry.shared.workbench
        self.init(
            section: section,
            model: settingsModel,
            authModel: configuration.authModel,
            session: session,
            accountDataClient: configuration.accountDataClient,
            shareClient: configuration.shareClient,
            modelCatalog: configuration.conversationModel?.selectableModels ?? [],
            avatarData: configuration.avatarModel?.imageData,
            syncModel: configuration.syncModel,
            outbox: configuration.outbox,
            connectorModel: configuration.connectorModel,
            requestSender: configuration.requestSender,
            codeWorkbench: workbench,
            codeModels: workbench?.availableModels ?? [],
            codeHostModel: configuration.codeHostModel,
            workHostModel: configuration.workHostModel,
            learningModel: configuration.memoryLearningModel
        )
    }
}

/// The Code section: the package's page, with this app's two hosting tiles
/// handed in — remote Code sessions, and Juno Work on this Mac. Both are
/// "what may another device make this Mac do", which is why they sit
/// together at the bottom of Code rather than each in a section of its own.
struct DesktopCodeSettingsScreen: View {
    let workbench: WorkbenchModel?
    let availableModels: [ModelOption]
    let codeHostModel: DesktopCodeHostModel?
    var workHostModel: DesktopWorkHostModel? = nil

    var body: some View {
        CodeSettingsView(
            workbench: workbench,
            availableModels: availableModels
        ) {
            DesktopCodeRemoteHostTile(host: codeHostModel)
            if let workHostModel {
                DesktopWorkHostTile(host: workHostModel)
            }
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
struct DesktopCodeRemoteHostTile: View {
    let host: DesktopCodeHostModel?

    var body: some View {
        if let host {
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
                        Text("Stop serving remote work now").frame(maxWidth: .infinity)
                    }
                    .contentShape(.rect)
                    .accessibilityIdentifier("juno.desktop.settings.remote-host-kill")
                }

                DesktopCodeHostRevokeSection(host: host)
            }
        }
    }
}

/// Unpair + re-pair for this Mac's Remote pairing, shared by the ⌘, window's
/// Code section and the settings page so the two tiles cannot disagree about
/// what revoking does.
///
/// Revoking deletes this Mac's row on the relay: the phone stops listing it,
/// its sessions and pending approvals go with the row, and the heartbeat stops
/// so it cannot resurrect the pairing. Re-pairing registers fresh — the old
/// row is gone, so replaying its id would only earn another 404.
struct DesktopCodeHostRevokeSection: View {
    let host: DesktopCodeHostModel

    @State private var confirmingRevoke = false

    var body: some View {
        if host.phase == .revoked {
            Divider()
            Text(
                "This Mac was unpaired and no longer appears on your other devices. "
                    + "Pair it again to run Juno Code sessions from your phone."
            )
            .junoCaption()
            .fixedSize(horizontal: false, vertical: true)

            Button {
                host.pairAgain()
            } label: {
                Text("Pair this Mac again").frame(maxWidth: .infinity)
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
            .accessibilityIdentifier("juno.desktop.settings.remote-host-pair-again")
        } else if host.deviceID != nil {
            Divider()
            if let error = host.revokeError {
                Text(error)
                    .junoCaption()
                    .foregroundStyle(Color.junoDanger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(role: .destructive) {
                confirmingRevoke = true
            } label: {
                HStack(spacing: JunoSpace.snug) {
                    if host.isRevoking {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("Revoking this Mac")
                    }
                    Text(host.isRevoking ? "Revoking…" : "Revoke this Mac…")
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
            .disabled(!host.canRevokeThisDevice)
            .help("Unlist this Mac from your other devices")
            .accessibilityIdentifier("juno.desktop.settings.remote-host-revoke")
            .confirmationDialog(
                "Revoke this Mac?",
                isPresented: $confirmingRevoke,
                titleVisibility: .visible
            ) {
                Button("Revoke this Mac", role: .destructive) {
                    host.revokeThisDevice()
                }
                .contentShape(.rect)
                Button("Cancel", role: .cancel) {}
                    .contentShape(.rect)
            } message: {
                Text(
                    "This Mac stops being listed on your other devices, and anything "
                        + "it was running for them stops with it. Pair it again here any time."
                )
            }
        }
    }
}
