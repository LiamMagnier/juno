import AppKit
import JunoAuth
import JunoChatKit
import JunoCodeUI
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// The sections of the ⌘, window.
///
/// The account's pages — Usage, Connections — used to be rows in the *Code*
/// navigation column, so opening Usage replaced the coding surface with a
/// ledger. They are account pages, and a Mac keeps account pages in the
/// Settings window: one rail on the left, one page on the right, reachable
/// from every product with ⌘, and from the account menu in each column's
/// footer.
enum DesktopSettingsSection: String, CaseIterable, Identifiable {
    case general
    case code
    case usage
    case connections

    var id: String { rawValue }

    static let storageKey = "juno.desktop.settings.section"

    var label: String {
        switch self {
        case .general: "General"
        case .code: "Code"
        case .usage: "Usage"
        case .connections: "Connections"
        }
    }

    var icon: JunoIcon {
        switch self {
        case .general: .settings
        case .code: .code
        case .usage: .usage
        case .connections: .connections
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

/// The ⌘, window: a rail and a page.
struct DesktopSettingsWindow: View {
    let configuration: JunoDesktopConfiguration?

    @AppStorage(DesktopSettingsSection.storageKey) private var storedSection =
        DesktopSettingsSection.general.rawValue
    @State private var registry = DesktopWorkbenchRegistry.shared

    private var section: Binding<DesktopSettingsSection> {
        Binding(
            get: { DesktopSettingsSection(rawValue: storedSection) ?? .general },
            set: { storedSection = $0.rawValue }
        )
    }

    var body: some View {
        HStack(spacing: 0) {
            rail
            Divider().overlay(Color.junoSeparator)
            page
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 760, idealWidth: 920, minHeight: 560, idealHeight: 680)
        .accessibilityIdentifier("juno.desktop.settings.window")
    }

    private var rail: some View {
        List(DesktopSettingsSection.allCases, selection: section) { item in
            Label {
                Text(item.label).junoRowLabel()
            } icon: {
                JunoIconView(item.icon, size: 15)
                    .junoSidebarMarkInk(selected: section.wrappedValue == item)
            }
            .junoSidebarRowInk()
            .tag(item)
            .accessibilityIdentifier("juno.desktop.settings.section.\(item.rawValue)")
        }
        .listStyle(.sidebar)
        .junoSidebarSelectionTint()
        .frame(width: 176)
    }

    @ViewBuilder
    private var page: some View {
        if let configuration,
           let settingsModel = configuration.memorySettingsModel,
           case .signedIn(let session) = configuration.authModel.phase
        {
            switch section.wrappedValue {
            case .general:
                DesktopSettingsScreen(
                    model: settingsModel,
                    authModel: configuration.authModel,
                    session: session,
                    accountDataClient: configuration.accountDataClient,
                    shareClient: configuration.shareClient,
                    modelCatalog: configuration.conversationModel?.selectableModels ?? [],
                    avatarData: configuration.avatarModel?.imageData,
                    syncModel: configuration.syncModel,
                    outbox: configuration.outbox,
                    openUsage: { section.wrappedValue = .usage },
                    // Hosting moved to the Code section, where the rest of
                    // Code's standing preferences live.
                    codeHostModel: nil,
                    workHostModel: configuration.workHostModel,
                    learningModel: configuration.memoryLearningModel
                )
            case .code:
                DesktopCodeSettingsScreen(
                    workbench: registry.workbench,
                    availableModels: registry.workbench?.availableModels ?? [],
                    codeHostModel: configuration.codeHostModel
                )
            case .usage:
                DesktopUsageScreen(
                    session: session,
                    requestSender: configuration.requestSender,
                    modelCatalog: configuration.conversationModel?.selectableModels ?? []
                )
            case .connections:
                if let model = configuration.connectorModel {
                    DesktopConnectionsScreen(model: model)
                } else {
                    JunoEmptyState(
                        title: "Connections",
                        message: "The connector service is unavailable.",
                        icon: .error
                    )
                }
            }
        } else {
            ContentUnavailableView(
                "Sign in to change settings",
                systemImage: "person.crop.circle",
                description: Text(
                    "Juno's settings belong to your account and sync across your devices."
                )
            )
        }
    }
}

/// The Code section: the package's page, with this app's remote-hosting tile
/// handed in.
struct DesktopCodeSettingsScreen: View {
    let workbench: WorkbenchModel?
    let availableModels: [ModelOption]
    let codeHostModel: DesktopCodeHostModel?

    var body: some View {
        CodeSettingsView(
            workbench: workbench,
            availableModels: availableModels
        ) {
            DesktopCodeRemoteHostTile(host: codeHostModel)
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
