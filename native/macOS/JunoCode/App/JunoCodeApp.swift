import SwiftUI
import JunoCodeRuntime
import JunoCodeUI

/// Juno Code composition root.
///
/// The model transport is intentionally unconfigured here: production model
/// turns go through the authenticated Juno backend transport composed by the
/// account integration (see docs/native/JUNO_CODE_HANDOFF.md). Until that
/// client is injected, sessions surface an honest "sign in to Juno" failure
/// instead of any mock behavior.
@main
struct JunoCodeApp: App {
    @State private var model = WorkbenchModel(
        dependencies: .standard(
            modelClient: UnconfiguredModelClient(),
            availableModels: [
                ModelOption(modelID: "claude-sonnet-5", displayName: "Claude Sonnet 5"),
                ModelOption(modelID: "claude-opus-4-8", displayName: "Claude Opus 4.8"),
                ModelOption(modelID: "gpt-5.2", displayName: "GPT-5.2"),
            ]
        )
    )

    var body: some Scene {
        WindowGroup {
            WorkbenchView(model: model)
                .frame(minWidth: 980, minHeight: 620)
        }
        .windowToolbarStyle(.unified)
        .defaultSize(width: 1_280, height: 800)
    }
}
