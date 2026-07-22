import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
#if DEBUG
import JunoCodeUI
import JunoPreviewSupport
#endif

@main
struct JunoMacApp: App {
    // Restores the last-viewed section across relaunches (per scene).
    @SceneStorage("juno.mac.selectedSection") private var selectedSection = JunoMacSection.chat
    @State private var authModel: NativeAuthModel
    @State private var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    @State private var conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    @State private var projectModel: NativeProjectModel<SQLiteAccountRepository>?
    @State private var artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    @State private var memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    @State private var searchModel: NativeSearchModel<SQLiteAccountRepository>?
    private let localStore: SQLiteAccountRepository?
    private let chatTransport: (any NativeChatRequestSending)?

    init() {
        let configuration = Self.makeConfiguration()
        _authModel = State(initialValue: configuration.authModel)
        _syncModel = State(initialValue: configuration.syncModel)
        _conversationModel = State(initialValue: configuration.conversationModel)
        _projectModel = State(initialValue: configuration.projectModel)
        _artifactModel = State(initialValue: configuration.artifactModel)
        _memorySettingsModel = State(initialValue: configuration.memorySettingsModel)
        _searchModel = State(initialValue: configuration.searchModel)
        localStore = configuration.localStore
        chatTransport = configuration.chatTransport
    }

    var body: some Scene {
        WindowGroup("Juno") {
            #if DEBUG
            if CommandLine.arguments.contains("--juno-code-ui-preview") {
                // Juno Code workbench over local synthetic fixtures only: no
                // account, Keychain, network, shell, or Git access.
                WorkbenchView(model: .preview())
                    .frame(minWidth: 900, minHeight: 560)
                    .preferredColorScheme(
                        CommandLine.arguments.contains("--juno-preview-dark") ? .dark : nil
                    )
            } else if JunoPreviewEnvironment.isActive {
                JunoPreviewContainer(
                    initialScenario: JunoPreviewEnvironment.initialScenario
                ) { world in
                    JunoMacRootView(
                        selection: $selectedSection,
                        authModel: Self.previewAuthModel,
                        syncModel: world.syncModel,
                        conversationModel: world.conversationModel,
                        projectModel: world.projectModel,
                        artifactModel: world.artifactModel,
                        memorySettingsModel: world.memorySettingsModel,
                        searchModel: world.searchModel,
                        chatTransport: world.chatTransport,
                        previewSession: world.session
                    )
                }
                .frame(minWidth: 760, minHeight: 520)
            } else {
                rootView
            }
            #else
            rootView
            #endif
        }
        .defaultSize(width: 1_180, height: 760)
        .commands {
            SidebarCommands()
            JunoMacNavigationCommands(selection: $selectedSection)
        }
    }

    private var rootView: some View {
        JunoMacRootView(
            selection: $selectedSection,
            authModel: authModel,
            syncModel: syncModel,
            conversationModel: conversationModel,
            projectModel: projectModel,
            artifactModel: artifactModel,
            memorySettingsModel: memorySettingsModel,
            searchModel: searchModel,
            chatTransport: chatTransport
        )
        .frame(minWidth: 760, minHeight: 520)
    }

    #if DEBUG
    @MainActor
    private static let previewAuthModel = NativeAuthModel(
        configurationErrorDescription: "UI Preview"
    )
    #endif

    @MainActor
    private static func makeConfiguration() -> JunoMacConfiguration {
        do {
            guard let backendURL = URL(string: "https://chat.liams.dev") else {
                throw JunoMacAppConfigurationError.invalidBackendURL
            }
            let version = Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String ?? "0.1.0"
            let device = try NativeDeviceMetadata(
                name: Host.current().localizedName ?? "Mac",
                platform: "macOS",
                appVersion: version
            )
            guard let applicationSupport = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first else {
                throw JunoMacAppConfigurationError.applicationSupportUnavailable
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
                browser: JunoMacWebAuthenticationClient()
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
            return JunoMacConfiguration(
                authModel: authModel,
                localStore: localStore,
                syncModel: syncModel,
                conversationModel: NativeConversationModel(
                    repository: localStore,
                    outbox: outbox,
                    drainer: drainer,
                    syncModel: syncModel,
                    chatClient: NativeChatAPIClient(transport: runtime)
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
                chatTransport: runtime
            )
        } catch {
            return JunoMacConfiguration(
                authModel: NativeAuthModel(
                    configurationErrorDescription: error.localizedDescription
                ),
                localStore: nil,
                syncModel: nil,
                conversationModel: nil,
                projectModel: nil,
                artifactModel: nil,
                memorySettingsModel: nil,
                searchModel: nil,
                chatTransport: nil
            )
        }
    }
}

private enum JunoMacAppConfigurationError: Error, LocalizedError {
    case invalidBackendURL
    case applicationSupportUnavailable

    var errorDescription: String? {
        String(localized: "auth.error.configuration")
    }
}

private struct JunoMacConfiguration {
    let authModel: NativeAuthModel
    let localStore: SQLiteAccountRepository?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    let memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    let searchModel: NativeSearchModel<SQLiteAccountRepository>?
    let chatTransport: (any NativeChatRequestSending)?
}

private struct JunoMacNavigationCommands: Commands {
    @Binding var selection: JunoMacSection

    var body: some Commands {
        CommandMenu("menu.navigate") {
            ForEach(JunoMacSection.Group.allCases) { group in
                Section {
                    ForEach(group.sections) { section in
                        Button {
                            selection = section
                        } label: {
                            Label(section.title, systemImage: section.systemImage)
                        }
                        .keyboardShortcut(section.keyboardShortcut, modifiers: .command)
                    }
                }
            }
        }
    }
}
