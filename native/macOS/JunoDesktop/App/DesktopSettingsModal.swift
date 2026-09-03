import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// Settings presented inside a product window — as a sheet from the sidebar's
/// account menu, or as the Chat column's Settings destination.
///
/// The same rail and pane the ⌘, window draws (``DesktopSettingsShell``), so
/// there is one Settings and not two. The modal's only additions are its own
/// close control in the rail's header and a fixed frame: a presented surface
/// that negotiates its own size re-lays out the window underneath it, which
/// this shell has fallen into a constraint loop over before.
///
/// The init keeps the individual models its callers already hand over; the
/// shell reads the rest from the configuration.
struct DesktopSettingsModal: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    let authModel: NativeAuthModel
    let session: NativeAuthenticatedSession
    let configuration: JunoDesktopConfiguration?
    let accountDataClient: NativeAccountDataClient?
    let shareClient: NativeShareClient?
    var modelCatalog: [NativeChatModelOption] = []
    var avatarData: Data?
    var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    var outbox: (any MutationOutboxRepository)?
    var openUsage: (() -> Void)?
    var codeHostModel: DesktopCodeHostModel?
    var workHostModel: DesktopWorkHostModel?
    var learningModel: MemoryLearningModel<SQLiteAccountRepository>?
    let onDismiss: () -> Void

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
        Group {
            if let configuration {
                DesktopSettingsShell(
                    configuration: configuration,
                    settingsModel: model,
                    session: session,
                    section: section,
                    onDismiss: onDismiss
                )
            } else {
                HStack(spacing: 0) {
                    DesktopSettingsRail(selection: section, onDismiss: onDismiss)
                        .frame(width: DesktopSettingsMetrics.railWidth)
                    Divider().overlay(Color.junoSeparator)
                    DesktopSettingsScreen(
                        section: section.wrappedValue,
                        model: model,
                        authModel: authModel,
                        session: session,
                        accountDataClient: accountDataClient,
                        shareClient: shareClient,
                        modelCatalog: modelCatalog,
                        avatarData: avatarData,
                        syncModel: syncModel,
                        outbox: outbox,
                        connectorModel: nil,
                        requestSender: nil,
                        codeWorkbench: registry.workbench,
                        codeModels: registry.workbench?.availableModels ?? [],
                        codeHostModel: codeHostModel,
                        workHostModel: workHostModel,
                        learningModel: learningModel
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .junoReadingCanvas()
            }
        }
        .frame(minWidth: 860, idealWidth: 960, maxWidth: 1040, minHeight: 600, idealHeight: 700, maxHeight: 820)
        .clipShape(
            RoundedRectangle(cornerRadius: JunoSettingsMetrics.tileRadius, style: .continuous)
        )
        .accessibilityIdentifier("juno.desktop.settings.modal")
    }
}
