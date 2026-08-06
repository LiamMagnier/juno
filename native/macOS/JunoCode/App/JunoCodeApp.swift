import AppKit
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCodeBridge
import JunoCodeKit
import JunoCodeRuntime
import JunoCodeUI
import JunoCore
import JunoStorage
import JunoSync
import SwiftUI

/// Juno Code composition root.
///
/// This target is a standalone Code client as well as a UI fixture host. It
/// owns the same authenticated runtime as the integrated JunoMac shell, so
/// opening `JunoCode.app` no longer produces a workbench that can only render
/// previews and then fails every real turn with an unconfigured transport.
@MainActor
@main
struct JunoCodeApp: App {
    @State private var authModel: NativeAuthModel
    @State private var workbenchModel: WorkbenchModel?
    @State private var workbenchAccountID: AccountID?
    private let chatTransport: (any NativeChatRequestSending)?
    private let previewLaunch: Bool

    init() {
        #if DEBUG
        let preview = CommandLine.arguments.contains(CodePreviewScenario.launchFlag)
        #else
        let preview = false
        #endif
        previewLaunch = preview

        if preview {
            _authModel = State(
                initialValue: NativeAuthModel(configurationErrorDescription: "UI Preview")
            )
            _workbenchModel = State(initialValue: Self.makePreviewModel())
            _workbenchAccountID = State(initialValue: nil)
            chatTransport = nil
        } else {
            let configuration = Self.makeConfiguration()
            _authModel = State(initialValue: configuration.authModel)
            _workbenchModel = State(initialValue: nil)
            _workbenchAccountID = State(initialValue: nil)
            chatTransport = configuration.chatTransport
        }
    }

    var body: some Scene {
        WindowGroup("Juno Code") {
            if previewLaunch, let workbenchModel {
                WorkbenchView(model: workbenchModel)
                    .frame(minWidth: 980, minHeight: 620)
                    #if DEBUG
                    .preferredColorScheme(
                        CommandLine.arguments.contains("--juno-preview-dark") ? .dark : nil
                    )
                    #endif
            } else {
                rootView
                    .task {
                        guard !previewLaunch else { return }
                        await authModel.restore()
                    }
                    .onChange(of: authModel.phase) { _, phase in
                        guard !previewLaunch else { return }
                        if case .signedIn(let session) = phase {
                            if workbenchAccountID != session.profile.id {
                                let previous = workbenchModel
                                workbenchModel = nil
                                workbenchAccountID = nil
                                if let previous {
                                    Task { await previous.shutdown() }
                                }
                            }
                        } else if let previous = workbenchModel {
                            workbenchModel = nil
                            workbenchAccountID = nil
                            Task { await previous.shutdown() }
                        }
                    }
            }
        }
        .windowToolbarStyle(.unified)
        .defaultSize(width: 1_280, height: 800)

        // The docked preview is the primary workflow. This scene is the
        // optional escape hatch for a larger, independently resizable page.
        CodePreviewScene()
    }

    @ViewBuilder
    private var rootView: some View {
        switch authModel.phase {
        case .signedIn(let session):
            if let workbenchModel,
                workbenchAccountID == session.profile.id
            {
                WorkbenchView(model: workbenchModel)
                    .task(id: session.profile.id) {
                        await refreshModelCatalog(
                            transport: chatTransport,
                            accountID: session.profile.id,
                            model: workbenchModel
                        )
                    }
            } else {
                ProgressView("Preparing Code…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task(id: session.profile.id) {
                        prepareWorkbench(for: session)
                    }
            }
        case .restoring:
            ProgressView("Restoring Juno…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .signedOut, .signingIn, .unavailable:
            JunoCodeSignInView(authModel: authModel)
        }
    }

    private func prepareWorkbench(for session: NativeAuthenticatedSession) {
        guard let chatTransport else { return }
        guard workbenchAccountID != session.profile.id else { return }
        if let previous = workbenchModel {
            Task { await previous.shutdown() }
        }
        workbenchModel = Self.makeModel(
            transport: chatTransport,
            accountID: session.profile.id
        )
        workbenchAccountID = session.profile.id
    }

    private func refreshModelCatalog(
        transport: (any NativeChatRequestSending)?,
        accountID: AccountID,
        model: WorkbenchModel
    ) async {
        guard let transport else { return }
        do {
            let catalog = try await NativeChatAPIClient(transport: transport)
                .modelCatalog(for: accountID)
            let options = catalog.models
                .filter {
                    $0.isAvailable
                        && $0.isChatCapable
                        && CodeModelProviderResolver.supports($0.id)
                }
                .map { ModelOption(catalog: $0.junoDescriptor) }
            if !options.isEmpty {
                await model.setAvailableModels(options)
            }
        } catch {
            // The signed-in fallback catalog remains usable when the manifest
            // endpoint is temporarily unavailable.
        }
    }

    private static func makeModel(
        transport: any NativeChatRequestSending,
        accountID: AccountID
    ) -> WorkbenchModel {
        let client = BackendCodeModelClient(
            streamer: transport,
            accountID: accountID
        )
        return WorkbenchModel(
            dependencies: .standard(
                accountID: accountID.rawValue,
                modelClient: client,
                availableModels: JunoCodeFallback.models,
                remoteSessionProvider: NativeCodeTaskRemoteSessionProvider(
                    client: NativeCodeTaskClient(
                        sender: transport,
                        streamer: transport
                    ),
                    accountID: accountID
                )
            )
        )
    }

    private static func makePreviewModel() -> WorkbenchModel {
        #if DEBUG
        .preview(
            scenario: .fromArguments(CommandLine.arguments)
        )
        #else
        fatalError("The preview model is only available in debug builds.")
        #endif
    }

    @MainActor
    private static func makeConfiguration() -> JunoCodeConfiguration {
        do {
            guard let backendURL = URL(string: JunoBackend.productionURLString) else {
                throw JunoCodeAppConfigurationError.invalidBackendURL
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
                throw JunoCodeAppConfigurationError.applicationSupportUnavailable
            }
            let localStore = try NativeLocalAccountStoreFactory(
                databaseURL: applicationSupport
                    .appendingPathComponent("Juno", isDirectory: true)
                    .appendingPathComponent("accounts.sqlite3")
            ).openRepository()
            let runtime = try NativeAuthRuntime.live(
                origin: try APIOrigin(backendURL),
                device: device,
                accountDataPurger: RepositoryAccountDataPurger(
                    repository: localStore
                )
            )
            return JunoCodeConfiguration(
                authModel: NativeAuthModel(
                    runtime: runtime,
                    browser: JunoCodeWebAuthenticationClient()
                ),
                chatTransport: runtime
            )
        } catch {
            return .inert(describing: error.localizedDescription)
        }
    }
}

private enum JunoCodeAppConfigurationError: Error, LocalizedError {
    case invalidBackendURL
    case applicationSupportUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidBackendURL:
            "Juno Code has an invalid backend URL."
        case .applicationSupportUnavailable:
            "Juno Code cannot access Application Support."
        }
    }
}

private struct JunoCodeConfiguration {
    let authModel: NativeAuthModel
    let chatTransport: (any NativeChatRequestSending)?

    @MainActor
    static func inert(describing reason: String) -> JunoCodeConfiguration {
        JunoCodeConfiguration(
            authModel: NativeAuthModel(configurationErrorDescription: reason),
            chatTransport: nil
        )
    }
}

private enum JunoCodeFallback {
    static let models: [ModelOption] = [
        ModelOption(modelID: "claude-sonnet-5", displayName: "Claude Sonnet 5"),
        ModelOption(modelID: "claude-opus-4-8", displayName: "Claude Opus 4.8"),
        ModelOption(modelID: "gpt-5.2", displayName: "GPT-5.2"),
    ]
}

private struct JunoCodeSignInView: View {
    let authModel: NativeAuthModel

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 38, weight: .semibold))
                .foregroundStyle(.tint)
            Text("Sign in to Juno Code")
                .font(.title.bold())
            Text("Connect your Juno account to run agents, use Computer Use, and access Cloud/Remote work.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 440)
            if let error = authModel.lastErrorDescription {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 480)
            }
            if authModel.phase != .unavailable {
                Button {
                    Task { await authModel.signIn() }
                } label: {
                    if authModel.phase == .signingIn {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Continue in browser")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(authModel.phase == .signingIn)
            }
        }
        .padding(48)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
