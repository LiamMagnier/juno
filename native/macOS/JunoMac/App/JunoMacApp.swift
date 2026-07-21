import JunoAPI
import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

@main
struct JunoMacApp: App {
    @State private var selectedSection = JunoMacSection.chat
    @State private var authModel: NativeAuthModel
    @State private var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    private let localStore: SQLiteAccountRepository?

    init() {
        let configuration = Self.makeConfiguration()
        _authModel = State(initialValue: configuration.authModel)
        _syncModel = State(initialValue: configuration.syncModel)
        localStore = configuration.localStore
    }

    var body: some Scene {
        WindowGroup("Juno") {
            JunoMacRootView(
                selection: $selectedSection,
                authModel: authModel,
                syncModel: syncModel
            )
                .frame(minWidth: 760, minHeight: 520)
        }
        .defaultSize(width: 1_180, height: 760)
        .commands {
            SidebarCommands()
            JunoMacNavigationCommands(selection: $selectedSection)
        }
    }

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
            return JunoMacConfiguration(
                authModel: authModel,
                localStore: localStore,
                syncModel: NativeSyncModel(
                    coordinator: coordinator,
                    monitor: NativeSyncMonitor(
                        coordinator: coordinator,
                        streamer: runtime
                    )
                )
            )
        } catch {
            return JunoMacConfiguration(
                authModel: NativeAuthModel(
                    configurationErrorDescription: error.localizedDescription
                ),
                localStore: nil,
                syncModel: nil
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
}

private struct JunoMacNavigationCommands: Commands {
    @Binding var selection: JunoMacSection

    var body: some Commands {
        CommandMenu("menu.navigate") {
            ForEach(JunoMacSection.allCases) { section in
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
