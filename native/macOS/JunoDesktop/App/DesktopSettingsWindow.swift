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

/// The ⌘, window: the rail and the page.
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
                DesktopSettingsShell(
                    configuration: configuration,
                    settingsModel: settingsModel,
                    session: session,
                    section: section
                )
            } else {
                JunoEmptyState(
                    title: "Sign in to change settings",
                    message: "Juno's settings belong to your account and sync across your devices.",
                    icon: .user
                )
            }
        }
        .frame(minWidth: 840, idealWidth: 960, minHeight: 600, idealHeight: 700)
        .accessibilityIdentifier("juno.desktop.settings.window")
    }
}

/// The rail and the pane, shared by the ⌘, window and the in-window modal so
/// the two cannot come to disagree about what Settings contains.
struct DesktopSettingsShell: View {
    let configuration: JunoDesktopConfiguration
    @Bindable var settingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>
    let session: NativeAuthenticatedSession
    @Binding var section: DesktopSettingsSection
    /// Present in the modal, where the shell has to offer its own way out.
    var onDismiss: (() -> Void)? = nil

    @State private var registry = DesktopWorkbenchRegistry.shared

    var body: some View {
        HStack(spacing: 0) {
            DesktopSettingsRail(selection: $section, onDismiss: onDismiss)
                .frame(width: DesktopSettingsMetrics.railWidth)
            Divider().overlay(Color.junoSeparator)
            DesktopSettingsScreen(
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
                codeWorkbench: registry.workbench,
                codeModels: registry.workbench?.availableModels ?? [],
                codeHostModel: configuration.codeHostModel,
                workHostModel: configuration.workHostModel,
                learningModel: configuration.memoryLearningModel
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .junoReadingCanvas()
    }
}

/// The left rail: the website's `SettingsRail` — an inset well holding one row
/// per section, the active one filled.
///
/// A column of buttons rather than a `List(selection:)`. The list would draw
/// the platform's full-bleed source-list selection in the app accent, which is
/// exactly the coral slab the sidebar work spent a release removing; the web's
/// rail is a well with a quietly raised active row, and that is a shape this
/// can draw directly.
struct DesktopSettingsRail: View {
    @Binding var selection: DesktopSettingsSection
    var onDismiss: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text("Settings")
                    .junoTitle()
                    .junoInk()
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if let onDismiss {
                    Button(action: onDismiss) {
                        JunoIconView(.close, size: 13)
                            .junoSecondaryInk()
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                    .help("Close settings (Esc)")
                    .accessibilityLabel("Close settings")
                } else {
                    Text("⌘,")
                        .junoCodeSmall()
                        .junoSecondaryInk()
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, JunoSpace.tight)

            VStack(spacing: 2) {
                ForEach(DesktopSettingsSection.allCases) { item in
                    DesktopSettingsRailRow(
                        section: item,
                        isSelected: selection == item,
                        select: { selection = item }
                    )
                }
            }
            .padding(JunoSpace.tight)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(Color.junoMuted.opacity(0.55))
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoHairline, lineWidth: 0.5)
            )
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Settings sections")

            Spacer(minLength: 0)
        }
        .padding(JunoSpace.regular)
        .accessibilityIdentifier("juno.desktop.settings.rail")
    }
}

/// One row in the rail: a Lucide mark and a word, filled when selected.
private struct DesktopSettingsRailRow: View {
    let section: DesktopSettingsSection
    let isSelected: Bool
    let select: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var fill: Color {
        if isSelected { return Color.junoSurface }
        if isHovering { return Color.junoRowHover }
        return .clear
    }

    var body: some View {
        Button(action: select) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(section.icon, size: 15)
                    .foregroundStyle(isSelected ? Color.junoAccent : Color.junoMutedForeground)
                Text(section.label)
                    .junoRowLabel()
                    .fontWeight(isSelected ? .medium : .regular)
                    .foregroundStyle(isSelected ? Color.junoForeground : Color.junoMutedForeground)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(fill)
                    .shadow(
                        color: isSelected ? Color.junoCardShadow : .clear,
                        radius: JunoElevation.cardBlur,
                        y: JunoElevation.cardOffsetY
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(isSelected ? Color.junoHairline : .clear, lineWidth: 0.5)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous))
        }
        .buttonStyle(.junoPress)
        .onHover { isHovering = $0 }
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
            value: isHovering
        )
        .help(section.summary)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("juno.desktop.settings.section.\(section.rawValue)")
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
