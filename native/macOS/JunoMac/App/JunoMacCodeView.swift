import JunoChatKit
import JunoCodeBridge
import JunoCodeKit
import JunoCodeRuntime
import JunoCodeUI
import JunoCore
import SwiftUI

/// Hosts the Juno Code workbench inside the main app, wired to the real
/// authenticated backend model transport for the signed-in account.
///
/// The `WorkbenchModel` is **owned by the app**, not by this view. Switching to
/// Chat and back unmounts this view; if the model lived here as `@State` the
/// workspace list, the session selection and the store observer would all be
/// rebuilt on every switch. Held above, the selected session survives and
/// `bootstrap()` is a cheap idempotent refresh.
struct JunoMacCodeView<SidebarHeader: View>: View {
    let transport: any NativeChatRequestSending
    let accountID: AccountID
    let model: WorkbenchModel
    let remoteTaskModel: NativeCodeModel?
    @ViewBuilder let sidebarHeader: () -> SidebarHeader

    var body: some View {
        WorkbenchView(
            model: model,
            remoteTaskModel: remoteTaskModel,
            sidebarHeader: sidebarHeader
        )
            .task(id: accountID) {
                await refreshModelCatalog()
            }
    }

    static func makeModel(
        transport: any NativeChatRequestSending,
        accountID: AccountID
    ) -> WorkbenchModel {
        let client = BackendCodeModelClient(streamer: transport, accountID: accountID)
        return WorkbenchModel(
            dependencies: .standard(
                accountID: accountID.rawValue,
                modelClient: client,
                availableModels: JunoMacCodeFallback.models,
                remoteSessionProvider: NativeCodeTaskRemoteSessionProvider(
                    client: NativeCodeTaskClient(sender: transport, streamer: transport),
                    accountID: accountID
                )
            )
        )
    }

    static func makeRemoteTaskModel(
        transport: any NativeChatRequestSending
    ) -> NativeCodeModel {
        NativeCodeModel(
            client: NativeCodeTaskClient(sender: transport, streamer: transport)
        )
    }

    /// Loads the real model manifest and keeps every chat-capable provider that
    /// Juno Code can route. Falls back silently to the static list on error so
    /// the section stays usable offline.
    private func refreshModelCatalog() async {
        do {
            let catalog = try await NativeChatAPIClient(transport: transport)
                .modelCatalog(for: accountID)
            let options = catalog.models
                .filter { $0.isAvailable && $0.isChatCapable && CodeModelProviderResolver.supports($0.id) }
                .map { ModelOption(catalog: $0.junoDescriptor) }
            if !options.isEmpty {
                await model.setAvailableModels(options)
            }
        } catch {
            // Keep the fallback list; runs still surface their own errors.
        }
    }
}

/// Outside the view because a generic type cannot hold static stored
/// properties, and the list is per-app rather than per-instantiation.
private enum JunoMacCodeFallback {
    static let models: [ModelOption] = [
        ModelOption(modelID: "claude-sonnet-5", displayName: "Claude Sonnet 5"),
        ModelOption(modelID: "claude-opus-4-8", displayName: "Claude Opus 4.8"),
    ]
}
