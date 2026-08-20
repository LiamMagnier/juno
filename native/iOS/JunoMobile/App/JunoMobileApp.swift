import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoWorkKit
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
    @State private var generateClient: NativeChatAPIClient?
    @State private var projectModel: NativeProjectModel<SQLiteAccountRepository>?
    @State private var artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    @State private var memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    @State private var memoryLearningModel: MemoryLearningModel<SQLiteAccountRepository>?
    @State private var searchModel: NativeSearchModel<SQLiteAccountRepository>?
    @State private var connectorModel: NativeConnectorModel?
    @State private var scheduledTaskModel: NativeScheduledTaskModel?
    @State private var codeModel: NativeCodeModel?
    @State private var workModel: NativeWorkModel?
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
    /// Suggests what to ask next, under a finished reply.
    private let followUpClient: NativeFollowUpClient?
    private let pullsClient: NativeGitHubPullsClient?
    private let shareClient: NativeShareClient?

    init() {
        let configuration = Self.makeConfiguration()
        _authModel = State(initialValue: configuration.authModel)
        _syncModel = State(initialValue: configuration.syncModel)
        _conversationModel = State(initialValue: configuration.conversationModel)
        _privateChatModel = State(initialValue: configuration.privateChatModel)
        _generateClient = State(initialValue: configuration.generateClient)
        _projectModel = State(initialValue: configuration.projectModel)
        _artifactModel = State(initialValue: configuration.artifactModel)
        _memorySettingsModel = State(initialValue: configuration.memorySettingsModel)
        _memoryLearningModel = State(initialValue: configuration.memoryLearningModel)
        _searchModel = State(initialValue: configuration.searchModel)
        _connectorModel = State(initialValue: configuration.connectorModel)
        _scheduledTaskModel = State(initialValue: configuration.scheduledTaskModel)
        _codeModel = State(initialValue: configuration.codeModel)
        _workModel = State(initialValue: configuration.workModel)
        _libraryModel = State(initialValue: configuration.libraryModel)
        requestSender = configuration.requestSender
        accountDataClient = configuration.accountDataClient
        voiceTranscriptClient = configuration.voiceTranscriptClient
        messageActionsClient = configuration.messageActionsClient
        followUpClient = configuration.followUpClient
        pullsClient = configuration.pullsClient
        shareClient = configuration.shareClient
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
                        connectorModel: world.connectorModel,
                        scheduledTaskModel: world.scheduledTaskModel,
                        // Code and Work are both relay-backed, and both were
                        // omitted here. The shell renders "Something went wrong"
                        // for a section whose model is nil, so
                        // `--juno-preview-tab work` and `--juno-preview-tab code`
                        // spent their whole lives on that placeholder: the two
                        // screens on this device that supervise a Mac were the
                        // two that could not be looked at without an account, a
                        // relay and a real task in the right state. Work was
                        // fixed; Code was left, and this is the same fix.
                        codeModel: world.codeModel,
                        workModel: world.workModel,
                        libraryModel: world.libraryModel,
                        accountDataClient: world.accountDataClient,
                        previewSession: world.session
                    )
                }
                // Keep appearance as part of the preview contract. The flag is
                // intentionally applied outside the preview world so every
                // native surface — sheets, menus and the drawer included — is
                // rendered in the requested scheme rather than inheriting the
                // fixture account's stored preference.
                .junoPreviewAppearance()
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
            memoryLearningModel: memoryLearningModel,
            searchModel: searchModel,
            privateChatModel: privateChatModel,
            generateClient: generateClient,
            connectorModel: connectorModel,
            scheduledTaskModel: scheduledTaskModel,
            codeModel: codeModel,
            workModel: workModel,
            libraryModel: libraryModel,
            requestSender: requestSender,
            accountDataClient: accountDataClient,
            voiceTranscriptClient: voiceTranscriptClient,
            messageActionsClient: messageActionsClient,
            followUpClient: followUpClient,
            pullsClient: pullsClient,
            shareClient: shareClient
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
            // Hoisted out of the initializer below because the learning model is
            // built over it. A second `NativeMemorySettingsModel` would be a
            // second opinion about whether memory is switched on, and that flag is
            // the consent gate the extractor reads before it may run at all.
            let memorySettingsModel = NativeMemorySettingsModel(
                repository: localStore,
                outbox: outbox,
                drainer: drainer,
                syncModel: syncModel,
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
                    titleClient: NativeConversationTitleClient(sender: runtime),
                    // The phone opens on its home screen — the greeting and an
                    // empty composer — exactly as the website does. Without this
                    // the first load selected the most recent conversation and
                    // the app launched straight into the last thing you said.
                    opensMostRecentConversationOnLoad: false
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
                memorySettingsModel: memorySettingsModel,
                memoryLearningModel: MemoryLearningModel(settings: memorySettingsModel),
                searchModel: NativeSearchModel(repository: localStore),
                // Its own client instance, and its own model: an incognito chat
                // shares no state with the persisted one by construction.
                privateChatModel: NativePrivateChatModel(
                    client: NativeChatAPIClient(transport: runtime)
                ),
                generateClient: NativeChatAPIClient(transport: runtime),
                connectorModel: NativeConnectorModel(
                    client: NativeConnectorClient(sender: runtime)
                ),
                scheduledTaskModel: NativeScheduledTaskModel(
                    client: NativeScheduledTaskClient(sender: runtime)
                ),
                codeModel: NativeCodeModel(
                    client: NativeCodeTaskClient(sender: runtime, streamer: runtime)
                ),
                // Both halves come from the one runtime: Work sends unary
                // requests and follows a task's log over SSE, and giving it two
                // transports would be two places for the bearer token to be
                // refreshed.
                workModel: NativeWorkModel(
                    client: NativeWorkClient(transport: runtime)
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
                generateClient: nil,
                connectorModel: nil,
                scheduledTaskModel: nil,
                codeModel: nil,
                workModel: nil,
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
    /// Runs ``MemoryExtractionEngine`` after a finished turn and holds what it
    /// proposed until the reader answers.
    ///
    /// Built over `memorySettingsModel` rather than beside it, because an accepted
    /// proposal is written by that model's `createMemory` and by nothing else —
    /// one write path, one place to delete from.
    ///
    /// Defaulted, and therefore a `var` among lets, so the failed-launch
    /// configuration below does not have to name a model it cannot build.
    var memoryLearningModel: MemoryLearningModel<SQLiteAccountRepository>? = nil
    let searchModel: NativeSearchModel<SQLiteAccountRepository>?
    let privateChatModel: NativePrivateChatModel?
    /// `/api/generate`, for editing an image the account already has. The same
    /// endpoint a fresh generation uses; the `edit` payload is what makes it an
    /// edit, so there is nothing separate to construct.
    let generateClient: NativeChatAPIClient?
    let connectorModel: NativeConnectorModel?
    let scheduledTaskModel: NativeScheduledTaskModel?
    let codeModel: NativeCodeModel?
    let workModel: NativeWorkModel?
    let libraryModel: NativeLibraryModel?
    let requestSender: (any NativeAuthenticatedRequestSending)?
    let accountDataClient: NativeAccountDataClient?
    let voiceTranscriptClient: NativeVoiceTranscriptClient?
    let messageActionsClient: NativeMessageActionsClient?
    let followUpClient: NativeFollowUpClient?
    let pullsClient: NativeGitHubPullsClient?
    let shareClient: NativeShareClient?
}
