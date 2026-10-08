import AppKit
import JunoAuth
import JunoCore
import JunoChatKit
import JunoCodeUI
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoWorkKit
import SwiftUI

/// The sections of Settings, in the web's order (`settings-sections.ts`, held
/// by the shell contract): General · Personalization · Memory · Models ·
/// Connectors · Devices · Voice · Data & privacy · Account · Plan & usage,
/// then the Mac-only Code section last until Code's redesign (P3-3). The
/// names, marks and aliases are the contract's (`JunoShellSettingsSection`);
/// a test holds the order to it.
///
/// Raw values are stored (`storageKey`) and routed by, so they never change:
/// Plan & usage is still `billing`.
enum DesktopSettingsSection: String, CaseIterable, Identifiable {
    case general
    case personalization
    case memory
    case models
    case connectors
    case devices
    case voice
    case data
    case account
    case billing
    case code

    var id: String { rawValue }

    static let storageKey = "juno.desktop.settings.section"

    /// The names older call sites route by. `usage` is Plan & usage and
    /// `connections` is what the web calls connectors.
    static var usage: DesktopSettingsSection { .billing }
    static var connections: DesktopSettingsSection { .connectors }

    /// The web's aliases (`ALIASES` in `settings-sections.ts`, through the
    /// shell contract), plus the Mac's own `connections`. The web's win a
    /// clash, so a name the web starts routing elsewhere follows the web.
    static let aliases: [String: DesktopSettingsSection] = JunoShellSettingsSection.aliases
        .mapValues { DesktopSettingsSection($0) }
        .merging(["connections": .connectors]) { web, _ in web }

    /// A section id or one of the web's aliases, else the web's default
    /// (General).
    static func resolve(_ name: String?) -> DesktopSettingsSection {
        let key = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return DesktopSettingsSection(rawValue: key) ?? aliases[key]
            ?? DesktopSettingsSection(JunoShellSettingsSection.defaultSection)
    }

    /// The web's name for the section (the shell contract); Code's is the
    /// Mac's own.
    var label: String {
        shell?.label ?? "Code"
    }

    /// The web's `SettingsIcons` (and `CodeIcons.device` for Devices), as the
    /// shell contract names them; Code wears the Code mark.
    var icon: JunoIcon {
        shell?.icon ?? .code
    }

    /// The labels of the rows each pane holds, for the sidebar's search field.
    /// A static table rather than a walk of the live form: the rows are known
    /// at build time.
    var searchTerms: [String] {
        switch self {
        case .general:
            ["Appearance", "Theme", "Light", "Dark", "System", "Accent color", "Custom accent color", "Text size", "About", "Version", "Updates", "Diagnostics"]
        case .personalization:
            ["What Alevr calls you", "Name", "Custom instructions", "Responses", "Personality", "Response language"]
        case .memory:
            ["Reference saved memories", "Learn from past chats in the background", "Memories", "Sensitive subjects", "Health", "Politics", "Money", "Background work", "Who may read your chats for it", "What Alevr noticed"]
        case .models:
            ["Default model", "On this device", "Fast mode", "Favorites", "Pinned models"]
        case .connectors:
            ["Connected apps", "Browse apps", "Permissions", "When Alevr acts in an app", "Lockdown"]
        case .devices:
            ["This Mac", "Your Macs", "Work", "Hosts", "Permissions"]
        case .voice:
            ["Read aloud", "Voice", "Preview", "Dictation"]
        case .data:
            ["Export your data", "JSON", "Alevr package", "CSV", "Import chat history", "ChatGPT", "Claude", "Gemini", "Shared links", "Delete all conversations"]
        case .account:
            ["Profile picture", "Change name", "Sign-in and security", "Two-step verification", "Password", "Email address", "This session", "Sign out", "Sign out everywhere", "Notifications", "Budget alerts", "Weekly digest", "When something needs you", "Updates", "Delete account"]
        case .billing:
            ["Plan", "Upgrade", "Change plan", "Manage billing", "Usage", "This month", "Current session", "This week", "Spend ceiling", "Monthly ceiling", "History"]
        case .code:
            ["Alevr Code", "Permissions", "Environment", "MCP", "Remote", "Pair"]
        }
    }

    /// The rail's groups, in the contract's order: how Juno looks and
    /// answers; what it knows and reaches; your data, account and plan; then
    /// Code. Flattened, it is `allCases` exactly (a test holds it), so
    /// grouping changes the rail's rhythm and never its order.
    static let railGroups: [[DesktopSettingsSection]] = [
        [.general, .personalization],
        [.memory, .models, .connectors, .devices, .voice],
        [.data, .account, .billing],
        [.code],
    ]

    /// The sections a search string leaves visible — all of them for an empty
    /// string. Matched against the name and the row labels, case- and
    /// diacritic-insensitively.
    static func matching(_ query: String) -> [DesktopSettingsSection] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return allCases }
        return allCases.filter { section in
            ([section.label] + section.searchTerms).contains { term in
                term.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }
        }
    }
}

/// Opens the Settings window on a section, from anywhere in the app.
///
/// The `Settings` scene has no `openWindow(value:)`, so the section crosses
/// through `UserDefaults` — written here, read by the window's source list.
/// `@AppStorage` on both sides makes the window follow a write made while it
/// is already open.
@MainActor
enum DesktopSettingsRouter {
    static func select(_ section: DesktopSettingsSection) {
        UserDefaults.standard.set(section.rawValue, forKey: DesktopSettingsSection.storageKey)
    }

    /// Selects the section and brings the Settings window up, through the
    /// responder-chain action the `Settings` scene installs behind ⌘,.
    static func open(_ section: DesktopSettingsSection) {
        select(section)
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }

    /// Selects the section and opens Settings through SwiftUI's own action.
    static func open(_ section: DesktopSettingsSection, using openSettings: OpenSettingsAction) {
        select(section)
        openSettings()
    }

    /// Opens a section by its id or one of the web's aliases (`usage`,
    /// `permissions`, `profile`…).
    static func open(named name: String) {
        open(DesktopSettingsSection.resolve(name))
    }
}

/// The ⌘, window: a source list of sections beside the section's pane.
///
/// It applies the account's theme, the accent and this Mac's text size
/// itself (§C1), and hosts its own toasts and the Upgrade sheet.
#if DEBUG
/// The preview harness's world, handed to the Settings scene: the scene is
/// built before the main window composes its throwaway account, so it reads
/// this and redraws when the account lands.
@MainActor @Observable
final class DesktopPreviewSettingsWorld {
    static let shared = DesktopPreviewSettingsWorld()
    var configuration: JunoDesktopConfiguration?
    var session: NativeAuthenticatedSession?
}
#endif

struct DesktopSettingsWindow: View {
    let configuration: JunoDesktopConfiguration?

    private var resolved: (JunoDesktopConfiguration, NativeAuthenticatedSession)? {
        #if DEBUG
        let world = DesktopPreviewSettingsWorld.shared
        if configuration == nil, let previewConfiguration = world.configuration, let session = world.session {
            return (previewConfiguration, session)
        }
        #endif
        guard let configuration, case .signedIn(let session) = configuration.authModel.phase else { return nil }
        return (configuration, session)
    }

    var body: some View {
        Group {
            if let (configuration, session) = resolved,
               let settingsModel = configuration.memorySettingsModel
            {
                DesktopSettingsSignedInWindow(
                    configuration: configuration,
                    settingsModel: settingsModel,
                    session: session
                )
                .id(session.profile.id)
            } else {
                JunoEmptyState(
                    title: "Sign in to change settings",
                    message: "Alevr’s settings belong to your account and sync across your devices.",
                    icon: .user
                )
            }
        }
        .frame(
            minWidth: DesktopSettingsMetrics.windowMinimum.width,
            idealWidth: DesktopSettingsMetrics.windowIdeal.width,
            minHeight: DesktopSettingsMetrics.windowMinimum.height,
            idealHeight: DesktopSettingsMetrics.windowIdeal.height
        )
        .containerBackground(Color.junoCanvas, for: .window)
        .preferredColorScheme(Self.colorScheme((configuration ?? resolved?.0)?.memorySettingsModel?.settings?.theme))
        .junoAccentTint()
        .desktopTextScale()
        .accessibilityIdentifier("juno.desktop.settings.window")
    }

    static func colorScheme(_ theme: NativeThemePreference?) -> ColorScheme? {
        switch theme {
        case .light: .light
        case .dark: .dark
        case .system, .none: nil
        }
    }
}

/// The window for a signed-in account: one ``DesktopSettingsContext`` for the
/// window's life.
private struct DesktopSettingsSignedInWindow: View {
    @State private var context: DesktopSettingsContext
    @AppStorage(DesktopSettingsSection.storageKey) private var storedSection =
        DesktopSettingsSection.general.rawValue

    init(
        configuration: JunoDesktopConfiguration,
        settingsModel: DesktopSettingsContext.SettingsModel,
        session: NativeAuthenticatedSession
    ) {
        let workbench = DesktopWorkbenchRegistry.shared.workbench
        let authModel = configuration.authModel
        var hostsLoader: (@Sendable (AccountID) async throws -> [WorkHostSummary])?
        if let runtime = configuration.runtime {
            hostsLoader = { accountID in
                try await NativeWorkClient(sender: runtime, streamer: runtime).hosts(for: accountID)
            }
        }
        var services = DesktopSettingsContext.Services()
        services.sender = configuration.requestSender
        services.accountData = configuration.accountDataClient
        services.shareClient = configuration.shareClient
        services.messageActions = configuration.messageActionsClient
        services.connectorModel = configuration.connectorModel
        services.workHostModel = configuration.workHostModel
        services.hostsLoader = hostsLoader
        services.syncModel = configuration.syncModel
        services.outbox = configuration.outbox
        services.learningModel = configuration.memoryLearningModel
        services.avatarModel = configuration.avatarModel
        services.codeWorkbench = workbench
        services.codeModels = workbench?.availableModels ?? []
        services.codeHostModel = configuration.codeHostModel
        let signOut: @MainActor () async -> Void = { await authModel.signOut() }
        let context = DesktopSettingsContext(
            profile: session.profile,
            settingsModel: settingsModel,
            services: services,
            modelCatalog: configuration.conversationModel?.selectableModels ?? [],
            signOut: signOut
        )
        _context = State(initialValue: context)
    }

    private var section: Binding<DesktopSettingsSection> {
        Binding(
            get: { DesktopSettingsSection.resolve(storedSection) },
            set: { storedSection = $0.rawValue }
        )
    }

    var body: some View {
        DesktopSettingsShell(section: section, context: context)
            .task { await context.loadServerSettings() }
            .desktopUpgradeSheet(host: .settings, sender: context.services.sender, accountID: context.accountID)
    }
}

/// The shape of Settings: System Settings' shape, in the ⌘, window.
///
/// A `NavigationSplitView` (the window's one): the sections are a real source
/// list on the left, so arrow keys, type-select, the focus ring and Increase
/// Contrast are the platform's, and the selected section's name is the
/// window's title rather than a heading painted into the pane (decision 17:
/// no subtitle). The sidebar toggle is removed because a settings window with
/// its sections hidden is a window nobody can use.
struct DesktopSettingsShell: View {
    @Binding var section: DesktopSettingsSection
    let context: DesktopSettingsContext

    @State private var query = ""
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            DesktopSettingsSidebar(selection: $section, query: $query)
        } detail: {
            DesktopSettingsScreen(section: section, context: context)
                .junoToastHost(context.toasts)
                .navigationTitle(section.label)
        }
        .toolbar(removing: .sidebarToggle)
    }
}

/// The sections, as the platform's own source list, with the web's glyphs and
/// a search field that also finds a section by the rows it holds ("accent"
/// finds General, "digest" finds Account) — P3-1.
struct DesktopSettingsSidebar: View {
    @Binding var selection: DesktopSettingsSection
    @Binding var query: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var visible: [DesktopSettingsSection] {
        DesktopSettingsSection.matching(query)
    }

    private var visibleGroups: [[DesktopSettingsSection]] {
        let shown = Set(visible)
        return DesktopSettingsSection.railGroups
            .map { $0.filter(shown.contains) }
            .filter { !$0.isEmpty }
    }

    /// `List(selection:)` wants an optional. Deselecting is not a state
    /// Settings has, so nil keeps what was there.
    private var listSelection: Binding<DesktopSettingsSection?> {
        Binding(
            get: { selection },
            set: { if let section = $0 { selection = section } }
        )
    }

    var body: some View {
        List(selection: listSelection) {
            // Grouped with the system's own section gap, no headers: the
            // rhythm says which sections belong together without a label
            // to read.
            ForEach(Array(visibleGroups.enumerated()), id: \.offset) { _, group in
                Section {
                    ForEach(group) { section in
                        row(section)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .junoSidebarSelectionTint()
        .searchable(text: $query, placement: .sidebar, prompt: "Search settings")
        .overlay {
            if visible.isEmpty {
                // Mac-only copy (register #177), on the shared empty state.
                JunoEmptyState(title: "No settings match \u{201C}\(query)\u{201D}", icon: .search, size: .panel)
                    .padding(JunoSpace.regular)
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
        // `.sidebar` list resolves its icon slot against the system accent.
        let selected = selection == section
        let ink = selected ? Color.junoForeground : Color.junoSidebarForeground

        return Label {
            Text(section.label)
        } icon: {
            DesktopSettingsSectionTile(icon: section.icon, selected: selected)
        }
        .foregroundStyle(ink)
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint),
            value: selected
        )
        .junoSidebarRowSelection(selected)
        .tag(section)
        .accessibilityIdentifier("juno.desktop.settings.section.\(section.rawValue)")
    }
}

/// A section's mark in its tile: the web's glyph at 13pt on a small rounded
/// square, monochrome at rest. The selected section's glyph is the one
/// accent-coloured thing in the rail (brief rule 1), on the card tone so it
/// reads against the selection fill.
struct DesktopSettingsSectionTile: View {
    let icon: JunoIcon
    let selected: Bool

    static let size: CGFloat = 22
    static let radius: CGFloat = 6

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        JunoIconView(icon, size: 13)
            .foregroundStyle(selected ? Color.junoAccentInk : Color.junoSidebarForeground)
            .frame(width: Self.size, height: Self.size)
            .background(selected ? Color.junoCard : Color.junoSecondary, in: shape)
            .overlay(shape.strokeBorder(Color.junoBorder.opacity(selected ? 0.9 : 0.6), lineWidth: 0.5))
            .accessibilityHidden(true)
    }
}

/// The Code section of Settings: a way into Juno Code's own settings window.
/// This Mac's Work switch moved to Devices (§C2).
struct DesktopCodeSettingsScreen: View {
    let workbench: WorkbenchModel?
    let availableModels: [ModelOption]
    let codeHostModel: DesktopCodeHostModel?

    @Environment(\.openWindow) private var openWindow

    var body: some View {
        DesktopSettingsForm {
            Section {
                DesktopSettingRow(
                    title: "Alevr Code has its own settings",
                    description: "Permissions and rules, environment, instructions, the agent, Git, tools and MCP, appearance and notifications."
                ) {
                    DesktopOutlineButton(title: "Open Code Settings") {
                        openWindow(id: JunoDesktopWindow.codeSettingsID)
                    }
                }
            }
        }
    }
}

/// Juno Code's settings window: the package's page, with this app's remote
/// hosting switch handed in for the Permissions section.
struct DesktopCodeSettingsWindow: View {
    let configuration: JunoDesktopConfiguration?

    var body: some View {
        StudioSettingsView(
            workbench: DesktopWorkbenchRegistry.shared.workbench,
            remoteHosting: AnyView(DesktopCodeRemoteHostTile(host: configuration?.codeHostModel))
        )
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
            JunoSettingsTile("Alevr Code Remote") {
                Toggle(
                    isOn: Binding(
                        get: { host.servesQueuedTasks },
                        set: { host.servesQueuedTasks = $0 }
                    )
                ) {
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text("Allow remote Alevr Code on this Mac")
                            .junoRowLabel()
                        Text(
                            "Lets your phone and the web start Alevr Code sessions that run here, "
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

                    // What leaves this Mac while the switch is on, said where
                    // the switch is — the upload is the other half of the
                    // consent, not a detail of it.
                    Text(
                        "Your phone also sees this Mac's recent sessions in those workspaces: "
                            + "titles, status and transcripts, never file contents. A session "
                            + "running above your remote limit can be followed and stopped there, "
                            + "and its requests declined, but not continued or allowed. Turning "
                            + "this off takes them off your phone."
                    )
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)

                    if let problem = host.remoteSyncProblem {
                        Text("Your phone is not getting updates: \(problem)")
                            .junoCaption()
                            .foregroundStyle(Color.junoDanger)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("juno.desktop.settings.remote-host-sync-problem")
                    }

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
                    + "Pair it again to run Alevr Code sessions from your phone."
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
