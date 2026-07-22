import JunoChatKit
import JunoCodeBridge
import JunoCodeRuntime
import JunoCodeUI
import JunoCore
import SwiftUI

/// Hosts the Juno Code workbench inside the main app, wired to the real
/// authenticated backend model transport for the signed-in account.
struct JunoMacCodeView: View {
    let transport: any NativeChatRequestSending
    let accountID: AccountID

    @State private var model: WorkbenchModel?

    var body: some View {
        Group {
            if let model {
                WorkbenchView(model: model)
            } else {
                ProgressView("Preparing Juno Code…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: accountID) {
            if model == nil {
                model = Self.makeModel(transport: transport, accountID: accountID)
            }
            await refreshModelCatalog()
        }
    }

    private static func makeModel(
        transport: any NativeChatRequestSending,
        accountID: AccountID
    ) -> WorkbenchModel {
        let client = BackendCodeModelClient(streamer: transport, accountID: accountID)
        return WorkbenchModel(
            dependencies: .standard(
                modelClient: client,
                availableModels: fallbackModels
            )
        )
    }

    /// Loads the real model manifest and keeps only the Claude models Juno
    /// Code can currently run. Falls back silently to the static list on error
    /// so the section stays usable offline.
    private func refreshModelCatalog() async {
        guard let model else { return }
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

    private static let fallbackModels: [ModelOption] = [
        ModelOption(modelID: "claude-sonnet-5", displayName: "Claude Sonnet 5"),
        ModelOption(modelID: "claude-opus-4-8", displayName: "Claude Opus 4.8"),
    ]
}
