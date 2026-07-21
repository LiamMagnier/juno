import JunoAPI
import JunoAuth
import JunoCore
import JunoDesignSystem
import SwiftUI
import UIKit

@main
struct JunoMobileApp: App {
    @State private var authModel: NativeAuthModel

    init() {
        _authModel = State(initialValue: Self.makeAuthModel())
    }

    var body: some Scene {
        WindowGroup {
            JunoMobileRootView(authModel: authModel)
        }
    }

    @MainActor
    private static func makeAuthModel() -> NativeAuthModel {
        do {
            guard let backendURL = URL(string: "https://chat.liams.dev") else {
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
            return NativeAuthModel(
                runtime: try NativeAuthRuntime.live(
                    origin: APIOrigin(backendURL),
                    device: device
                ),
                browser: JunoMobileWebAuthenticationClient()
            )
        } catch {
            return NativeAuthModel(
                configurationErrorDescription: error.localizedDescription
            )
        }
    }
}

private enum JunoMobileAppConfigurationError: Error, LocalizedError {
    case invalidBackendURL

    var errorDescription: String? {
        String(localized: "auth.error.configuration")
    }
}
