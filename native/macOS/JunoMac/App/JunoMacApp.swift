import AppKit
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCodeUI
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
#if DEBUG
import JunoPreviewSupport
#endif

@main
struct JunoMacApp: App {
    // Restores the last-viewed section across relaunches (per scene).
    @SceneStorage("juno.mac.selectedSection") private var selectedSection = JunoMacSection.chat
    /// The last product mode, restored per scene. Stored as a raw string so an
    /// unrecognized value (an older or newer build wrote it) degrades to Chat
    /// instead of failing to decode.
    @SceneStorage("juno.mac.productMode") private var productModeRawValue = JunoMacProductMode.chat.rawValue
    @State private var authModel: NativeAuthModel
    @State private var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    @State private var conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    @State private var projectModel: NativeProjectModel<SQLiteAccountRepository>?
    @State private var artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    @State private var memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    @State private var searchModel: NativeSearchModel<SQLiteAccountRepository>?
    private let localStore: SQLiteAccountRepository?
    private let outbox: (any MutationOutboxRepository)?
    private let chatTransport: (any NativeChatRequestSending)?
    /// Owned here, not by `JunoMacCodeView`, so switching modes does not
    /// rebuild the Code workspace list and session selection every time.
    /// Built once on the first entry into Code, so a reader who never opens
    /// Code never pays for it.
    @State private var codeWorkbenchModel: WorkbenchModel?
    #if DEBUG
    /// Preview runs seed the mode from `--juno-preview-mode` and keep it in
    /// plain `@State`, so a QA launch lands where it was asked to and the
    /// control still works when clicked.
    @State private var previewProductMode = JunoMacProductMode.previewLaunchMode
    #endif

    init() {
        let configuration = Self.resolvedConfiguration()
        _authModel = State(initialValue: configuration.authModel)
        _syncModel = State(initialValue: configuration.syncModel)
        _conversationModel = State(initialValue: configuration.conversationModel)
        _projectModel = State(initialValue: configuration.projectModel)
        _artifactModel = State(initialValue: configuration.artifactModel)
        _memorySettingsModel = State(initialValue: configuration.memorySettingsModel)
        _searchModel = State(initialValue: configuration.searchModel)
        localStore = configuration.localStore
        outbox = configuration.outbox
        chatTransport = configuration.chatTransport
    }

    // The window's minimum is Code's, not Chat's. Juno Code is a three-column
    // workbench — sidebar 220 + detail + inspector 260 — and a window narrower
    // than that has no satisfiable constraint solve, which AppKit reports by
    // throwing from `_postWindowNeedsUpdateConstraints` rather than by clipping.
    // Chat fits comfortably inside the same minimum.
    var body: some Scene {
        WindowGroup("Juno") {
            #if DEBUG
            if CommandLine.arguments.contains(CodePreviewScenario.launchFlag) {
                // Juno Code workbench over local synthetic fixtures only: no
                // account, Keychain, network, shell, or Git access.
                WorkbenchView(
                    model: .preview(
                        scenario: CodePreviewScenario.fromArguments(CommandLine.arguments)
                    )
                )
                    .frame(minWidth: 900, minHeight: 560)
                    .junoPreviewWindowSize()
                    .preferredColorScheme(
                        CommandLine.arguments.contains("--juno-preview-dark") ? .dark : nil
                    )
                    .onAppear {
                        if CommandLine.arguments.contains("--juno-preview-dark") {
                            NSApp.appearance = NSAppearance(named: .darkAqua)
                        }
                    }
            } else if JunoPreviewEnvironment.isActive {
                JunoPreviewContainer(
                    initialScenario: JunoPreviewEnvironment.initialScenario
                ) { world in
                    JunoMacRootView(
                        selection: $selectedSection,
                        productMode: $previewProductMode,
                        codeWorkbenchModel: $codeWorkbenchModel,
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
                .frame(minWidth: 900, minHeight: 560)
                // `--juno-preview-dark` previously only affected the Juno Code
                // preview, so a dark-mode QA pass of the main shell silently
                // rendered light.
                //
                // Both of these are needed. `preferredColorScheme` drives
                // SwiftUI's environment, but AppKit-resolved tints — notably the
                // accent applied to sidebar `Label` icons — come from the
                // window's `NSAppearance`, which it does not touch. Setting only
                // the color scheme produced a dark sidebar whose icons resolved
                // against the *light* accent and disappeared entirely.
                .preferredColorScheme(
                    CommandLine.arguments.contains("--juno-preview-dark") ? .dark : nil
                )
                .onAppear {
                    if CommandLine.arguments.contains("--juno-preview-dark") {
                        NSApp.appearance = NSAppearance(named: .darkAqua)
                    }
                }
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
            JunoMacNavigationCommands(
                selection: $selectedSection,
                productMode: productMode
            )
        }
    }

    private var productMode: Binding<JunoMacProductMode> {
        Binding(
            get: { JunoMacProductMode.restored(from: productModeRawValue) },
            set: { productModeRawValue = $0.rawValue }
        )
    }

    private var rootView: some View {
        JunoMacRootView(
            selection: $selectedSection,
            productMode: productMode,
            codeWorkbenchModel: $codeWorkbenchModel,
            authModel: authModel,
            syncModel: syncModel,
            outbox: outbox,
            conversationModel: conversationModel,
            projectModel: projectModel,
            artifactModel: artifactModel,
            memorySettingsModel: memorySettingsModel,
            searchModel: searchModel,
            chatTransport: chatTransport
        )
        .frame(minWidth: 900, minHeight: 560)
    }

    #if DEBUG
    @MainActor
    private static let previewAuthModel = NativeAuthModel(
        configurationErrorDescription: "UI Preview"
    )
    #endif

    /// The configuration the app actually starts with.
    ///
    /// A preview launch gets the inert one. `init()` previously called
    /// ``makeConfiguration()`` unconditionally, so a run started with
    /// `--juno-code-ui-preview` — the mode whose whole claim is "no account,
    /// Keychain, network, shell, or Git access" — had already opened
    /// `accounts.sqlite3`, built the live `NativeAuthRuntime` against
    /// `chat.liams.dev`, and constructed the sync coordinator, mutation drainer
    /// and chat transport before the scene body chose the preview branch. The
    /// preview view then discarded all of it, which made the claim false and,
    /// in practice, meant two preview instances contended for the same SQLite
    /// file and the second never reached a window.
    @MainActor
    private static func resolvedConfiguration() -> JunoMacConfiguration {
        #if DEBUG
        if isPreviewLaunch { return .inert }
        #endif
        return makeConfiguration()
    }

    #if DEBUG
    /// True for every development-only preview entry point.
    static var isPreviewLaunch: Bool {
        CommandLine.arguments.contains(CodePreviewScenario.launchFlag)
            || JunoPreviewEnvironment.isActive
    }
    #endif

    @MainActor
    private static func makeConfiguration() -> JunoMacConfiguration {
        do {
            guard let backendURL = URL(string: JunoBackend.productionURLString) else {
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
                outbox: outbox,
                chatTransport: runtime
            )
        } catch {
            return .inert(describing: error.localizedDescription)
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
    let outbox: (any MutationOutboxRepository)?
    let chatTransport: (any NativeChatRequestSending)?

    /// No repository, no transport, no auth runtime — used both when
    /// configuration fails and for every preview launch, so a preview cannot
    /// reach the account database or the network even by accident.
    @MainActor
    static func inert(describing reason: String) -> JunoMacConfiguration {
        JunoMacConfiguration(
            authModel: NativeAuthModel(configurationErrorDescription: reason),
            localStore: nil,
            syncModel: nil,
            conversationModel: nil,
            projectModel: nil,
            artifactModel: nil,
            memorySettingsModel: nil,
            searchModel: nil,
            outbox: nil,
            chatTransport: nil
        )
    }

    #if DEBUG
    @MainActor
    static var inert: JunoMacConfiguration { inert(describing: "UI Preview") }
    #endif
}

private struct JunoMacNavigationCommands: Commands {
    @Binding var selection: JunoMacSection
    @Binding var productMode: JunoMacProductMode

    var body: some Commands {
        CommandMenu("menu.navigate") {
            // The product switch first, on plain ⌘1/⌘2, mirroring the sidebar
            // control. Selecting Chat from here also returns to the Chat
            // section, so the menu never leaves the app on a mode whose
            // destination is stale.
            Section {
                ForEach(JunoMacProductMode.allCases) { mode in
                    Button {
                        productMode = mode
                        if mode == .chat, selection == .settings { selection = .chat }
                    } label: {
                        Label(mode.title, systemImage: mode.systemImage)
                    }
                    .keyboardShortcut(mode.keyboardShortcut, modifiers: .command)
                }
            }

            ForEach(JunoMacSection.Group.allCases) { group in
                Section {
                    ForEach(group.sections) { section in
                        Button {
                            // A Chat destination implies Chat mode; picking one
                            // from the menu while in Code must switch back
                            // rather than silently do nothing.
                            productMode = .chat
                            selection = section
                        } label: {
                            Label(section.title, systemImage: section.systemImage)
                        }
                        .keyboardShortcut(
                            section.keyboardShortcut,
                            modifiers: section.keyboardModifiers
                        )
                    }
                }
            }
        }
    }
}
