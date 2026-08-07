// swift-tools-version: 6.0

import Foundation
import PackageDescription

// Keep local compatibility copies out of the target when they exist, but do
// not emit SwiftPM warnings on a clean CI checkout where those copies are
// intentionally absent.
let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
func existingExcludes(_ paths: [String], relativeTo targetDirectory: String) -> [String] {
    let directory = packageDirectory.appendingPathComponent(targetDirectory)
    return paths.filter { directory.appendingPathComponent($0).pathExists }
}

private extension URL {
    var pathExists: Bool {
        FileManager.default.fileExists(atPath: path)
    }
}

let package = Package(
    name: "JunoCode",
    platforms: [
        .macOS("26.0")
    ],
    products: [
        .library(name: "JunoCodeCore", targets: ["JunoCodeCore"]),
        .library(name: "JunoCodeLocal", targets: ["JunoCodeLocal"]),
        .library(name: "JunoCodeRuntime", targets: ["JunoCodeRuntime"]),
        .library(name: "JunoCodeUI", targets: ["JunoCodeUI"]),
        .library(name: "JunoCodeBridge", targets: ["JunoCodeBridge"]),
        // Juno Simulator: Xcode/simctl discovery, the build-and-run state
        // machine, frame capture and the capability advertisement. No SwiftUI —
        // the pane lives in JunoCodeUI, so this stays testable headlessly.
        .library(name: "JunoSimulator", targets: ["JunoSimulator"]),
    ],
    dependencies: [
        .package(path: "../JunoNativeKit")
    ],
    targets: [
        .target(name: "JunoCodeCore"),
        .target(
            name: "JunoCodeLocal",
            dependencies: ["JunoCodeCore"],
            exclude: existingExcludes([
                "DevServerCommandDiscovery 2.swift",
                "DevServerService 2.swift",
                "DevServerURLDetector 2.swift",
                "WorktreeManager 2.swift",
            ], relativeTo: "Sources/JunoCodeLocal")
        ),
        // Depends on Core only, for SecretRedactor — build logs routinely carry
        // tokens, and they are redacted before they reach the UI or the model.
        .target(name: "JunoSimulator", dependencies: ["JunoCodeCore"]),
        .target(
            name: "JunoCodeRuntime",
            dependencies: ["JunoCodeCore"],
            exclude: existingExcludes([
                "Tools/ComputerUseTools 2.swift",
                "Tools/DelegateTaskTool 2.swift",
                "Tools/UpdateGoalTool 2.swift",
            ], relativeTo: "Sources/JunoCodeRuntime")
        ),
        .target(
            name: "JunoCodeUI",
            dependencies: [
                "JunoCodeCore", "JunoCodeLocal", "JunoCodeRuntime",
                // The remote-command protocols. UI depends on the bridge, never
                // the reverse — the bridge must stay usable without a window.
                "JunoCodeBridge",
                "JunoSimulator",
                // Shared design tokens, so Code and Chat cannot drift apart on
                // spacing, radii, surfaces or type.
                .product(name: "JunoDesignSystem", package: "JunoNativeKit"),
                .product(name: "JunoCodeKit", package: "JunoNativeKit"),
                .product(name: "JunoAuth", package: "JunoNativeKit"),
            ],
            // Keep the retired canvas out of the target. The shared workbench
            // below now uses the same `CodeSessionCanvas` as the desktop shell;
            // `AgentCanvasView` is an older, self-contained surface that also
            // declares copies of shared status/approval views.
            exclude: existingExcludes([
                "Models/CodeAttachment 2.swift",
                "Models/CodeDraftModel 2.swift",
                "Models/CodeModelCatalog 2.swift",
                "Models/CodeSessionDigests 2.swift",
                "Models/FileContextToken 2.swift",
                "Models/ReviewModel 2.swift",
                "Models/SlashCommands 2.swift",
                "Views/CodeSessionSurface 2.swift",
                "Views/Composer 2.swift",
                "Views/Console/CodeConsoleDrawer 2.swift",
                "Views/FileContextMenu 2.swift",
                "Views/GoalBar 2.swift",
                "Views/Inspector/ActivityTab 2.swift",
                "Views/Inspector/ComputerUsePane 2.swift",
                "Views/Inspector/RepositoryTab 2.swift",
                "Views/Inspector/SubagentInspector 2.swift",
                "Views/SlashCommandMenu 2.swift",
                "Views/StatusChip 2.swift",
                "Views/AgentCanvasView.swift",
            ], relativeTo: "Sources/JunoCodeUI")
        ),
        .target(
            name: "JunoCodeBridge",
            dependencies: [
                "JunoCodeCore",
                "JunoCodeRuntime",
                .product(name: "JunoCodeKit", package: "JunoNativeKit"),
                .product(name: "JunoCore", package: "JunoNativeKit"),
                .product(name: "JunoAPI", package: "JunoNativeKit"),
                .product(name: "JunoAuth", package: "JunoNativeKit"),
                .product(name: "JunoSync", package: "JunoNativeKit"),
                .product(name: "JunoChatKit", package: "JunoNativeKit"),
            ],
            exclude: existingExcludes(["CodeThinkingWire 2.swift"], relativeTo: "Sources/JunoCodeBridge")
        ),
        .testTarget(
            name: "JunoCodeCoreTests",
            dependencies: ["JunoCodeCore"],
            exclude: existingExcludes(["GoalModelsTests 2.swift"], relativeTo: "Tests/JunoCodeCoreTests")
        ),
        .testTarget(
            name: "JunoSimulatorTests",
            dependencies: ["JunoSimulator"],
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "JunoCodeLocalTests",
            dependencies: ["JunoCodeCore", "JunoCodeLocal"],
            exclude: existingExcludes([
                "ComputerUseKeyChordTests 2.swift",
                "WorktreeManagerTests 2.swift",
                "WorkspaceBookmarkTests 2.swift",
            ], relativeTo: "Tests/JunoCodeLocalTests")
        ),
        .testTarget(
            name: "JunoCodeRuntimeTests",
            dependencies: ["JunoCodeCore", "JunoCodeRuntime", "JunoCodeLocal"],
            exclude: existingExcludes([
                "CodeSessionStoreTests 2.swift",
                "DelegateTaskToolTests 2.swift",
                "GoalModeRuntimeTests 2.swift",
            ], relativeTo: "Tests/JunoCodeRuntimeTests")
        ),
        .testTarget(
            name: "JunoCodeUITests",
            dependencies: ["JunoCodeCore", "JunoCodeLocal", "JunoCodeRuntime", "JunoCodeUI"],
            exclude: existingExcludes([
                "CodeModelCatalogTests 2.swift",
                "FileContextTokenTests 2.swift",
                "SlashCommandTests 2.swift",
                "SubagentDigestTests 2.swift",
                "SubagentSessionVisibilityTests 2.swift",
            ], relativeTo: "Tests/JunoCodeUITests")
        ),
        .testTarget(
            name: "JunoCodeBridgeTests",
            dependencies: [
                "JunoCodeCore",
                "JunoCodeLocal",
                "JunoCodeRuntime",
                "JunoCodeBridge",
            ],
            exclude: existingExcludes([
                "CodeThinkingWireTests 2.swift",
                "UserAttachmentWireTests 2.swift",
            ], relativeTo: "Tests/JunoCodeBridgeTests")
        ),
    ],
    swiftLanguageModes: [.v6]
)
