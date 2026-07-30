import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoStorage
import JunoSync

@MainActor
struct JunoDesktopConfiguration {
    let authModel: NativeAuthModel
    let runtime: NativeAuthRuntime?
    let localStore: SQLiteAccountRepository?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let outbox: (any MutationOutboxRepository)?
    let attachmentModel: NativeComposerAttachmentModel?
    let avatarModel: NativeAvatarModel?
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let privateChatModel: NativePrivateChatModel?
    /// Compare's transport. Its own client instance for the same reason
    /// incognito has one: a comparison is a set of ephemeral private turns and
    /// shares no state with the persisted conversation.
    let compareModel: NativeCompareModel?
    /// `/api/generate`, for editing an image the account already has. The same
    /// endpoint a fresh generation uses; the `edit` payload is what makes it an
    /// edit, so there is nothing separate to construct.
    let generateClient: NativeChatAPIClient?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    let memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    let searchModel: NativeSearchModel<SQLiteAccountRepository>?
    let connectorModel: NativeConnectorModel?
    let scheduledTaskModel: NativeScheduledTaskModel?
    let codeModel: NativeCodeModel?
    let remoteCodeModel: CodeRemoteBrowserModel?
    let libraryModel: NativeLibraryModel?
    let requestSender: (any NativeAuthenticatedRequestSending)?
    let accountDataClient: NativeAccountDataClient?
    let voiceTranscriptClient: NativeVoiceTranscriptClient?
    let messageActionsClient: NativeMessageActionsClient?
    /// Suggests what to ask next, under a finished reply.
    let followUpClient: NativeFollowUpClient?
    /// The pull requests Juno Code opened.
    let pullsClient: NativeGitHubPullsClient?
    /// Publishes a conversation behind an unguessable link.
    let shareClient: NativeShareClient?

    static func live() -> Self {
        do {
            guard let backendURL = URL(string: JunoBackend.productionURLString) else {
                throw JunoDesktopConfigurationError.invalidBackendURL
            }
            guard let applicationSupport = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first else {
                throw JunoDesktopConfigurationError.applicationSupportUnavailable
            }

            let version = Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String ?? "0.1.0"
            let device = try NativeDeviceMetadata(
                name: Host.current().localizedName ?? "Mac",
                platform: "macOS",
                appVersion: version
            )
            let localStore = try NativeLocalAccountStoreFactory(
                databaseURL: applicationSupport
                    .appendingPathComponent("Juno", isDirectory: true)
                    .appendingPathComponent("Desktop", isDirectory: true)
                    .appendingPathComponent("accounts.sqlite3")
            ).openRepository()
            let runtime = try NativeAuthRuntime.live(
                origin: APIOrigin(backendURL),
                device: device,
                accountDataPurger: RepositoryAccountDataPurger(
                    repository: localStore
                )
            )
            let coordinator = NativeSyncCoordinator(
                repository: localStore,
                sender: runtime
            )
            let syncModel = NativeSyncModel(
                coordinator: coordinator,
                monitor: NativeSyncMonitor(
                    coordinator: coordinator,
                    streamer: runtime
                )
            )
            let outbox = PersistentMutationOutbox(repository: localStore)
            let drainer = NativeMutationDrainer(
                repository: localStore,
                outbox: outbox,
                sender: runtime
            )

            return Self(
                authModel: NativeAuthModel(
                    runtime: runtime,
                    browser: JunoDesktopWebAuthenticationClient()
                ),
                runtime: runtime,
                localStore: localStore,
                syncModel: syncModel,
                outbox: outbox,
                attachmentModel: NativeComposerAttachmentModel(
                    client: NativeAttachmentAPIClient(sender: runtime)
                ),
                avatarModel: NativeAvatarModel(sender: runtime),
                conversationModel: NativeConversationModel(
                    repository: localStore,
                    outbox: outbox,
                    drainer: drainer,
                    syncModel: syncModel,
                    chatClient: NativeChatAPIClient(transport: runtime),
                    titleClient: NativeConversationTitleClient(sender: runtime)
                ),
                privateChatModel: NativePrivateChatModel(
                    client: NativeChatAPIClient(transport: runtime)
                ),
                compareModel: NativeCompareModel(
                    client: NativeChatAPIClient(transport: runtime)
                ),
                generateClient: NativeChatAPIClient(transport: runtime),
                projectModel: NativeProjectModel(
                    repository: localStore,
                    outbox: outbox,
                    drainer: drainer,
                    syncModel: syncModel,
                    sender: runtime
                ),
                artifactModel: NativeArtifactModel(
                    repository: localStore,
                    syncModel: syncModel,
                    sender: runtime
                ),
                memorySettingsModel: NativeMemorySettingsModel(
                    repository: localStore,
                    outbox: outbox,
                    drainer: drainer,
                    syncModel: syncModel,
                    sender: runtime
                ),
                searchModel: NativeSearchModel(repository: localStore),
                connectorModel: NativeConnectorModel(
                    client: NativeConnectorClient(sender: runtime)
                ),
                scheduledTaskModel: NativeScheduledTaskModel(
                    client: NativeScheduledTaskClient(sender: runtime)
                ),
                codeModel: NativeCodeModel(
                    client: NativeCodeTaskClient(sender: runtime, streamer: runtime)
                ),
                remoteCodeModel: CodeRemoteBrowserModel(
                    client: NativeCodeRemoteClient(sender: runtime)
                ),
                libraryModel: NativeLibraryModel(
                    client: NativeLibraryClient(sender: runtime),
                    // The picker draws the file, which means resolving its
                    // bytes — the same route the Library screen already takes.
                    previewSource: NativeProjectAPIClient(sender: runtime)
                ),
                requestSender: runtime,
                accountDataClient: NativeAccountDataClient(sender: runtime),
                voiceTranscriptClient: NativeVoiceTranscriptClient(sender: runtime),
                messageActionsClient: NativeMessageActionsClient(sender: runtime),
                followUpClient: NativeFollowUpClient(sender: runtime),
                pullsClient: NativeGitHubPullsClient(sender: runtime),
                shareClient: NativeShareClient(sender: runtime)
            )
        } catch {
            return unavailable(error.localizedDescription)
        }
    }

    private static func unavailable(_ message: String) -> Self {
        Self(
            authModel: NativeAuthModel(configurationErrorDescription: message),
            runtime: nil,
            localStore: nil,
            syncModel: nil,
            outbox: nil,
            attachmentModel: nil,
            avatarModel: nil,
            conversationModel: nil,
            privateChatModel: nil,
            compareModel: nil,
            generateClient: nil,
            projectModel: nil,
            artifactModel: nil,
            memorySettingsModel: nil,
            searchModel: nil,
            connectorModel: nil,
            scheduledTaskModel: nil,
            codeModel: nil,
            remoteCodeModel: nil,
            libraryModel: nil,
            requestSender: nil,
            accountDataClient: nil,
            voiceTranscriptClient: nil,
            messageActionsClient: nil,
            followUpClient: nil,
            pullsClient: nil,
            shareClient: nil
        )
    }
}

private enum JunoDesktopConfigurationError: Error, LocalizedError {
    case invalidBackendURL
    case applicationSupportUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidBackendURL:
            "The production Juno address is invalid."
        case .applicationSupportUnavailable:
            "Juno cannot access Application Support on this Mac."
        }
    }
}
