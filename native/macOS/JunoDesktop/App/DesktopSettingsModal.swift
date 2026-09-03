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
/// The same source list and page the ⌘, window draws (``DesktopSettingsShell``),
/// so there is one Settings and not two. The modal's only additions are the
/// toolbar's Done button and a fixed frame: a presented surface that
/// negotiates its own size re-lays out the window underneath it, which this
/// shell has fallen into a constraint loop over before.
///
/// The init keeps the individual models its callers already hand over; with a
/// configuration the page reads the rest from it, and without one it works
/// from what it was given.
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
        DesktopSettingsShell(section: section, onDismiss: onDismiss) { section in
            if let configuration {
                DesktopSettingsScreen(
                    section: section,
                    configuration: configuration,
                    settingsModel: model,
                    session: session
                )
            } else {
                DesktopSettingsScreen(
                    section: section,
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
            }
        }
        .frame(
            width: DesktopSettingsMetrics.modalSize.width,
            height: DesktopSettingsMetrics.modalSize.height
        )
        .accessibilityIdentifier("juno.desktop.settings.modal")
    }
}
