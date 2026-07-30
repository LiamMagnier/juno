import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoCodeKit
import SwiftUI
import UniformTypeIdentifiers

struct DesktopDestinationView: View {
    @Binding var destination: DesktopDestination
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Bindable var conversationModel: NativeConversationModel<SQLiteAccountRepository>
    @Binding var draftProjectID: String?
    @Binding var draftPrompt: String?

    var body: some View {
        switch destination {
        case .chat:
            DesktopConversationView(
                model: conversationModel,
                attachmentModel: configuration.attachmentModel,
                profileName: session.profile.name,
                configuration: configuration,
                session: session,
                draftProjectID: $draftProjectID,
                draftPrompt: $draftPrompt
            )
        case .search:
            if let model = configuration.searchModel {
                DesktopSearchScreen(
                    model: model,
                    openConversation: openConversation
                )
            } else {
                unavailable("Search", "The encrypted search index is unavailable.")
            }
        case .projects:
            if let model = configuration.projectModel {
                DesktopProjectsScreen(
                    model: model,
                    conversationModel: conversationModel,
                    configuration: configuration,
                    session: session,
                    openConversation: openConversation,
                    startConversation: startConversation
                )
            } else {
                unavailable("Projects", "The synchronized project store is unavailable.")
            }
        case .library:
            if let model = configuration.libraryModel {
                DesktopLibraryScreen(model: model)
            } else {
                unavailable("Library", "The authenticated file library is unavailable.")
            }
        case .artifacts:
            if let model = configuration.artifactModel {
                DesktopArtifactsScreen(model: model)
            } else {
                unavailable("Artifacts", "The synchronized artifact store is unavailable.")
            }
        case .pulls:
            NativePullsView(
                client: configuration.pullsClient,
                accountID: session.profile.id,
                openConnections: { destination = .connections }
            )
        case .connections:
            if let model = configuration.connectorModel {
                DesktopConnectionsScreen(model: model)
            } else {
                unavailable("Connections", "The connector service is unavailable.")
            }
        case .tasks:
            if let model = configuration.scheduledTaskModel {
                DesktopTasksScreen(
                    model: model,
                    modelOptions: conversationModel.selectableModels,
                    openConversation: openConversation
                )
            } else {
                unavailable("Tasks", "The scheduled-task service is unavailable.")
            }
        case .usage:
            DesktopUsageScreen(
                session: session,
                requestSender: configuration.requestSender,
                modelCatalog: conversationModel.selectableModels
            )
        case .settings:
            if let model = configuration.memorySettingsModel {
                DesktopSettingsScreen(
                    model: model,
                    authModel: configuration.authModel,
                    session: session,
                    accountDataClient: configuration.accountDataClient,
                    modelCatalog: conversationModel.selectableModels,
                    avatarData: configuration.avatarModel?.imageData,
                    syncModel: configuration.syncModel,
                    outbox: configuration.outbox,
                    requestSender: configuration.requestSender
                )
            } else {
                unavailable("Settings", "Account settings could not be loaded.")
            }
        }
    }

    private func openConversation(_ id: String) {
        draftProjectID = nil
        conversationModel.isDraftingNewConversation = false
        conversationModel.selectedConversationID = id
        destination = .chat
    }

    private func startConversation(in projectID: String, prompt: String?) {
        draftProjectID = projectID
        draftPrompt = prompt
        conversationModel.isDraftingNewConversation = true
        conversationModel.selectedConversationID = nil
        destination = .chat
    }

    private func unavailable(_ title: String, _ description: String) -> some View {
        ContentUnavailableView(
            title,
            systemImage: "exclamationmark.triangle",
            description: Text(description)
        )
    }
}

struct DesktopScreenHeader<Trailing: View>: View {
    let title: String
    let subtitle: String
    let trailing: Trailing

    init(
        _ title: String,
        subtitle: String,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.title2.weight(.semibold))
                Text(subtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            trailing
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
        .background(Color.junoRaised)
        .overlay(alignment: .bottom) { Divider() }
    }
}
