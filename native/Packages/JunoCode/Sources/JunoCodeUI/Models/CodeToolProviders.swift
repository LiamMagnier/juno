import Foundation
import JunoCodeLocal
import JunoCodeRuntime

/// Every lane's tool provider, in the order their tools are offered to a Code
/// turn (CODE_AGENT_SPEC §6.0). Each provider lives in its lane's own file and
/// starts empty; a lane registers tools there without touching this list or
/// the session's tool assembly.
enum CodeToolProviders {
    static let all: [any CodeToolProvider] = [
        // Lane A: JunoCodeRuntime/Tools/GoalTools.swift
        GoalToolProvider(),
        // Lane B: JunoCodeRuntime/Tools/RunChecksTool.swift
        VerificationToolProvider(
            recipes: { VerifyRecipeStore(workspaceRoot: $0) },
            changes: { WorkspaceChangeDetector(rootURL: $0) }
        ),
        // Lane C: JunoCodeRuntime/Tools/SimulatorTools.swift
        ScreenToolProvider(),
        // Lane D: JunoCodeUI/Views/Preview/CodePreviewInspectionTool.swift
        PreviewToolProvider(),
        // Lane E: JunoCodeRuntime/Tools/GitTools.swift
        ShipToolProvider(),
        // Lane F: JunoCodeRuntime/Tools/ExtensionTools.swift
        ExtensionToolProvider(),
    ]
}
