import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UIKit
#if DEBUG
import JunoPreviewSupport
#endif

@main
struct JunoMobileApp: App {
    @State private var authModel: NativeAuthModel
    @State private var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    @State private var conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    @State private var privateChatModel: NativePrivateChatModel?
    @State private var projectModel: NativeProjectModel<SQLiteAccountRepository>?
    @State private var artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    @State private var memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    @State private var searchModel: NativeSearchModel<SQLiteAccountRepository>?
    @State private var connectorModel: NativeConnectorModel?
    @State private var scheduledTaskModel: NativeScheduledTaskModel?
    @State private var codeModel: NativeCodeModel?
    @State private var libraryModel: NativeLibraryModel?
    private let localStore: SQLiteAccountRepository?
    private let outbox: (any MutationOutboxRepository)?
    private let attachmentModel: NativeComposerAttachmentModel?
    private let avatarModel: NativeAvatarModel?
    /// The authenticated transport, kept so a voice session can be authorized
    /// on demand. Voice is the one feature whose credential is minted per
    /// session against an account that is only known once signed in, so it
    /// cannot be a model built at launch like every other one here.
    private let requestSender: (any NativeAuthenticatedRequestSending)?
    private let accountDataClient: NativeAccountDataClient?
    private let voiceTranscriptClient: NativeVoiceTranscriptClient?
    private let messageActionsClient: NativeMessageActionsClient?

    init() {
        let configuration = Self.makeConfiguration()
        _authModel = State(initialValue: configuration.authModel)
        _syncModel = State(initialValue: configuration.syncModel)
        _conversationModel = State(initialValue: configuration.conversationModel)
        _privateChatModel = State(initialValue: configuration.privateChatModel)
        _projectModel = State(initialValue: configuration.projectModel)
        _artifactModel = State(initialValue: configuration.artifactModel)
        _memorySettingsModel = State(initialValue: configuration.memorySettingsModel)
        _searchModel = State(initialValue: configuration.searchModel)
        _connectorModel = State(initialValue: configuration.connectorModel)
        _scheduledTaskModel = State(initialValue: configuration.scheduledTaskModel)
        _codeModel = State(initialValue: configuration.codeModel)
        _libraryModel = State(initialValue: configuration.libraryModel)
        requestSender = configuration.requestSender
        accountDataClient = configuration.accountDataClient
        voiceTranscriptClient = configuration.voiceTranscriptClient
        messageActionsClient = configuration.messageActionsClient
        localStore = configuration.localStore
        outbox = configuration.outbox
        attachmentModel = configuration.attachmentModel
        avatarModel = configuration.avatarModel
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if JunoPreviewEnvironment.isActive {
                JunoPreviewContainer(
                    initialScenario: JunoPreviewEnvironment.initialScenario
                ) { world in
                    JunoMobileRootView(
                        authModel: Self.previewAuthModel,
                        syncModel: world.syncModel,
                        attachmentModel: world.attachmentModel,
                        conversationModel: world.conversationModel,
                        projectModel: world.projectModel,
                        artifactModel: world.artifactModel,
                        memorySettingsModel: world.memorySettingsModel,
                        searchModel: world.searchModel,
                        privateChatModel: world.privateChatModel,
                        libraryModel: world.libraryModel,
                        accountDataClient: world.accountDataClient,
                        previewSession: world.session
                    )
                }
            } else {
                rootView
            }
            #else
            rootView
            #endif
        }
    }

    private var rootView: some View {
        JunoMobileRootView(
            authModel: authModel,
            syncModel: syncModel,
            outbox: outbox,
            attachmentModel: attachmentModel,
            avatarModel: avatarModel,
            conversationModel: conversationModel,
            projectModel: projectModel,
            artifactModel: artifactModel,
            memorySettingsModel: memorySettingsModel,
            searchModel: searchModel,
            privateChatModel: privateChatModel,
            connectorModel: connectorModel,
            scheduledTaskModel: scheduledTaskModel,
            codeModel: codeModel,
            libraryModel: libraryModel,
            requestSender: requestSender,
            accountDataClient: accountDataClient,
            voiceTranscriptClient: voiceTranscriptClient,
            messageActionsClient: messageActionsClient
        )
    }

    #if DEBUG
    @MainActor
    private static let previewAuthModel = NativeAuthModel(
        configurationErrorDescription: "UI Preview"
    )
    #endif

    @MainActor
    private static func makeConfiguration() -> JunoMobileConfiguration {
        do {
            guard let backendURL = URL(string: JunoBackend.productionURLString) else {
                throw JunoMobileAppConfigurationError.invalidBackendURL
            }
            let version = Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String ?? "0.1.0"
            let platform = UIDevice.current.userInterfaceIdiom == .pad
                ? "iPadOS" : "iOS"
            let device = try NativeDeviceMetadata(
                name: UIDevice.current.name,
                platform: platform,
                appVersion: version
            )
            guard let applicationSupport = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first else {
                throw JunoMobileAppConfigurationError.applicationSupportUnavailable
            }
            let localStore = try NativeLocalAccountStoreFactory(
                databaseURL: applicationSupport
                    .appendingPathComponent("Juno", isDirectory: true)
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
            let authModel = NativeAuthModel(
                runtime: runtime,
                browser: JunoMobileWebAuthenticationClient()
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
            return JunoMobileConfiguration(
                authModel: authModel,
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
                // Its own client instance, and its own model: an incognito chat
                // shares no state with the persisted one by construction.
                privateChatModel: NativePrivateChatModel(
                    client: NativeChatAPIClient(transport: runtime)
                ),
                connectorModel: NativeConnectorModel(
                    client: NativeConnectorClient(sender: runtime)
                ),
                scheduledTaskModel: NativeScheduledTaskModel(
                    client: NativeScheduledTaskClient(sender: runtime)
                ),
                codeModel: NativeCodeModel(
                    client: NativeCodeTaskClient(sender: runtime, streamer: runtime)
                ),
                libraryModel: NativeLibraryModel(
                    client: NativeLibraryClient(sender: runtime)
                ),
                requestSender: runtime,
                accountDataClient: NativeAccountDataClient(sender: runtime),
                voiceTranscriptClient: NativeVoiceTranscriptClient(sender: runtime),
                messageActionsClient: NativeMessageActionsClient(sender: runtime)
            )
        } catch {
            return JunoMobileConfiguration(
                authModel: NativeAuthModel(
                    configurationErrorDescription: error.localizedDescription
                ),
                localStore: nil,
                syncModel: nil,
                outbox: nil,
                attachmentModel: nil,
                avatarModel: nil,
                conversationModel: nil,
                projectModel: nil,
                artifactModel: nil,
                memorySettingsModel: nil,
                searchModel: nil,
                privateChatModel: nil,
                connectorModel: nil,
                scheduledTaskModel: nil,
                codeModel: nil,
                libraryModel: nil,
                requestSender: nil,
                accountDataClient: nil,
                voiceTranscriptClient: nil,
                messageActionsClient: nil
            )
        }
    }
}

private enum JunoMobileAppConfigurationError: Error, LocalizedError {
    case invalidBackendURL
    case applicationSupportUnavailable

    var errorDescription: String? {
        String(localized: "auth.error.configuration")
    }
}

private struct JunoMobileConfiguration {
    let authModel: NativeAuthModel
    let localStore: SQLiteAccountRepository?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let outbox: (any MutationOutboxRepository)?
    let attachmentModel: NativeComposerAttachmentModel?
    let avatarModel: NativeAvatarModel?
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    let memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    let searchModel: NativeSearchModel<SQLiteAccountRepository>?
    let privateChatModel: NativePrivateChatModel?
    let connectorModel: NativeConnectorModel?
    let scheduledTaskModel: NativeScheduledTaskModel?
    let codeModel: NativeCodeModel?
    let libraryModel: NativeLibraryModel?
    let requestSender: (any NativeAuthenticatedRequestSending)?
    let accountDataClient: NativeAccountDataClient?
    let voiceTranscriptClient: NativeVoiceTranscriptClient?
    let messageActionsClient: NativeMessageActionsClient?
}
