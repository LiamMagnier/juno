import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// The pop-up Settings modal dialog on macOS.
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

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Settings")
                    .font(.headline)
                    .foregroundStyle(Color.junoForeground)
                Spacer()
                Button(action: onDismiss) {
                    JunoIconView(systemImage: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.junoForeground)
                        .frame(width: 24, height: 24)
                        .background(Color.junoMuted.opacity(0.5), in: Circle())
                }
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Circle())
                .keyboardShortcut(.cancelAction)
                .help("Close settings (Esc)")
                .accessibilityLabel("Close settings")
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.snug)
            .background(Color.junoRaised.opacity(0.5))

            Divider()
                .overlay(Color.junoSeparator)

            DesktopSettingsScreen(
                model: model,
                authModel: authModel,
                session: session,
                accountDataClient: accountDataClient,
                shareClient: shareClient,
                modelCatalog: modelCatalog,
                avatarData: avatarData,
                syncModel: syncModel,
                outbox: outbox,
                openUsage: {
                    onDismiss()
                    openUsage?()
                },
                codeHostModel: codeHostModel,
                workHostModel: workHostModel,
                learningModel: learningModel
            )
            .background(Color.junoCanvas)
        }
        .frame(minWidth: 780, idealWidth: 840, maxWidth: 960, minHeight: 560, idealHeight: 640, maxHeight: 780)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
    }
}
