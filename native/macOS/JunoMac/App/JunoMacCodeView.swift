import JunoChatKit
import JunoCodeBridge
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
    @ViewBuilder let sidebarHeader: () -> SidebarHeader

    var body: some View {
        WorkbenchView(model: model, sidebarHeader: sidebarHeader)
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
                modelClient: client,
                availableModels: JunoMacCodeFallback.models
            )
        )
    }

    /// Loads the real model manifest and keeps only the Claude models Juno
    /// Code can currently run. Falls back silently to the static list on error
    /// so the section stays usable offline.
    private func refreshModelCatalog() async {
        do {
            let catalog = try await NativeChatAPIClient(transport: transport)
                .modelCatalog(for: accountID)
            let resolver = CodeModelProviderResolver.default
            let options = catalog.models
                .filter { $0.isAvailable && resolver.provider(for: $0.id) == .anthropic }
                .map { ModelOption(modelID: $0.id, displayName: $0.displayName) }
            if !options.isEmpty {
                model.availableModels = options
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
