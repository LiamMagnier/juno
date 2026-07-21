import JunoAPI
import JunoAuth
import JunoCore
import JunoDesignSystem
import SwiftUI

@main
struct JunoMacApp: App {
    @State private var selectedSection = JunoMacSection.chat
    @State private var authModel: NativeAuthModel

    init() {
        _authModel = State(initialValue: Self.makeAuthModel())
    }

    var body: some Scene {
        WindowGroup("Juno") {
            JunoMacRootView(selection: $selectedSection, authModel: authModel)
                .frame(minWidth: 760, minHeight: 520)
        }
        .defaultSize(width: 1_180, height: 760)
        .commands {
            SidebarCommands()
            JunoMacNavigationCommands(selection: $selectedSection)
        }
    }

    @MainActor
    private static func makeAuthModel() -> NativeAuthModel {
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
            return NativeAuthModel(
                runtime: try NativeAuthRuntime.live(
                    origin: APIOrigin(backendURL),
                    device: device
                ),
                browser: JunoMacWebAuthenticationClient()
            )
        } catch {
            return NativeAuthModel(
                configurationErrorDescription: error.localizedDescription
            )
        }
    }
}

private enum JunoMacAppConfigurationError: Error, LocalizedError {
    case invalidBackendURL

    var errorDescription: String? {
        String(localized: "auth.error.configuration")
    }
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
