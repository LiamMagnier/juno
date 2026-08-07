// swift-tools-version: 6.0

import Foundation
import PackageDescription

// Some contributors keep compatibility copies named `… 2.swift` in their
// local checkout while migrating native targets. SwiftPM warns when an
// `exclude` names a file that is not present, which made CI noisy and hid real
// manifest warnings. Keep the local copies excluded when they exist, without
// making the manifest claim that they are part of the repository.
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
    name: "JunoNativeKit",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "JunoCore", targets: ["JunoCore"]),
        .library(name: "JunoAPI", targets: ["JunoAPI"]),
        .library(name: "JunoAuth", targets: ["JunoAuth"]),
        .library(name: "JunoStorage", targets: ["JunoStorage"]),
        .library(name: "JunoSync", targets: ["JunoSync"]),
        .library(name: "JunoSearch", targets: ["JunoSearch"]),
        .library(name: "JunoDesignSystem", targets: ["JunoDesignSystem"]),
        // The Juno Design scene contract: the same document the website edits,
        // decoded natively, plus the validated Swift<->JavaScript bridge the
        // hosted editor speaks. No editor engine lives here — that is shared.
        .library(name: "JunoDesignKit", targets: ["JunoDesignKit"]),
        .library(name: "JunoChatKit", targets: ["JunoChatKit"]),
        .library(name: "JunoCodeKit", targets: ["JunoCodeKit"]),
        .library(name: "JunoWorkKit", targets: ["JunoWorkKit"]),
        .library(name: "JunoVoiceKit", targets: ["JunoVoiceKit"]),
        // Development-only: every source file is wrapped in `#if DEBUG`, so this
        // target contributes nothing to Release builds.
        .library(name: "JunoPreviewSupport", targets: ["JunoPreviewSupport"]),
    ],
    targets: [
        .target(
            name: "JunoCore",
            // The repository currently contains compatibility copies created
            // during the native-package migration. They intentionally stay on
            // disk, but SwiftPM must not compile both declarations.
            exclude: existingExcludes(["JunoUpdateFeed 2.swift"], relativeTo: "Sources/JunoCore")
        ),
        .target(name: "JunoAPI", dependencies: ["JunoCore"]),
        .target(name: "JunoAuth", dependencies: ["JunoCore", "JunoAPI"]),
        .target(name: "JunoStorage"),
        .target(
            name: "JunoSync",
            dependencies: ["JunoCore", "JunoAPI", "JunoAuth", "JunoStorage"]
        ),
        .target(name: "JunoSearch", dependencies: ["JunoCore", "JunoStorage"]),
        .target(
            name: "JunoDesignSystem",
            dependencies: ["JunoCore"],
            exclude: existingExcludes([
                "JunoAIcssCode 2.swift",
                "JunoAIcssGeneration 2.swift",
                "JunoAIcssReasoning 2.swift",
                "JunoAIcssSearch 2.swift",
                "JunoAIcssShine 2.swift",
                "JunoAIcssTodo 2.swift",
                "JunoComposerAura 2.swift",
                "JunoConnectorMarks 2.swift",
                "JunoDesktopChrome 2.swift",
                "JunoLearningBlockViews 2.swift",
                "JunoLearningBlocks 2.swift",
                "JunoLessonText 2.swift",
                "JunoModelCatalog 2.swift",
                "JunoModelMarks 2.swift",
                "JunoModelSelector 2.swift",
                "JunoProviderGlow 2.swift",
                "JunoSettingsPrimitives 2.swift",
                "JunoStepLab 2.swift",
                "JunoStepLabData 2.swift",
                "JunoStepLabView 2.swift",
                "JunoThinkingControl 2.swift",
                "JunoVoiceAura 2.swift",
                "JunoYAMLSubset 2.swift",
                "NativePromptLimits 2.swift",
            ], relativeTo: "Sources/JunoDesignSystem")
        ),
        // Deliberately dependency-free: the design contract must be decodable
        // without dragging in auth, storage or sync, so a test can round-trip a
        // document with nothing else running.
        .target(name: "JunoDesignKit"),
        .target(
            name: "JunoChatKit",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoSearch", "JunoDesignSystem",
            ],
            exclude: existingExcludes([
                "NativeFilePreview 2.swift",
                "NativeFollowUpClient 2.swift",
                "NativeFollowUpStrip 2.swift",
                "NativeImageEditSession 2.swift",
                "NativeImageEditView 2.swift",
                "NativeMediaGenerationView 2.swift",
                "NativeSearchActivity 2.swift",
                "NativeShareClient 2.swift",
                "NativeSharedLinksView 2.swift",
                "NativeUsageBreakdown 2.swift",
            ], relativeTo: "Sources/JunoChatKit")
        ),
        .target(
            name: "JunoCodeKit",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoDesignSystem",
            ],
            exclude: existingExcludes([
                "NativeGitHubPullsClient 2.swift",
                "NativePullsView 2.swift",
            ], relativeTo: "Sources/JunoCodeKit")
        ),
        .target(
            name: "JunoWorkKit",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoDesignSystem",
            ]
        ),
        .target(
            name: "JunoVoiceKit",
            dependencies: ["JunoCore", "JunoAPI", "JunoAuth", "JunoDesignSystem"],
            exclude: existingExcludes([
                "JunoVoiceTranscriptRecord 2.swift",
                "VoiceSessionState 2.swift",
            ], relativeTo: "Sources/JunoVoiceKit")
        ),
        .target(
            name: "JunoPreviewSupport",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoSearch", "JunoChatKit", "JunoCodeKit", "JunoWorkKit",
                "JunoDesignSystem",
            ]
        ),
        .testTarget(
            name: "JunoCoreTests",
            dependencies: ["JunoCore"],
            exclude: existingExcludes(["JunoUpdateFeedTests 2.swift"], relativeTo: "Tests/JunoCoreTests")
        ),
        .testTarget(name: "JunoAPITests", dependencies: ["JunoAPI"]),
        .testTarget(name: "JunoAuthTests", dependencies: ["JunoAuth"]),
        .testTarget(name: "JunoStorageTests", dependencies: ["JunoStorage"]),
        .testTarget(
            name: "JunoSyncTests",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
            ]
        ),
        .testTarget(
            name: "JunoSearchTests",
            dependencies: ["JunoCore", "JunoStorage", "JunoSearch"]
        ),
        .testTarget(
            name: "JunoDesignSystemTests",
            dependencies: ["JunoDesignSystem"],
            exclude: existingExcludes([
                "JunoAIcssReasoningLinesTests 2.swift",
                "JunoLearningBlocksTests 2.swift",
            ], relativeTo: "Tests/JunoDesignSystemTests")
        ),
        .testTarget(
            name: "JunoDesignKitTests",
            dependencies: ["JunoDesignKit"],
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "JunoChatKitTests",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoChatKit",
                // `NativePromptLimits` moved down into the design system so Juno
                // Code's composer can obey the same thresholds as Chat's; its
                // tests still live here.
                "JunoDesignSystem",
            ],
            exclude: existingExcludes([
                "NativeFilePreviewTests 2.swift",
                "NativeImageMaskTests 2.swift",
                "NativeModelCapabilityTests 2.swift",
                "NativePromptLimitsTests 2.swift",
                "NativeVoiceTranscriptClientTests 2.swift",
            ], relativeTo: "Tests/JunoChatKitTests")
        ),
        .testTarget(
            name: "JunoCodeKitTests",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoCodeKit",
            ]
        ),
        .testTarget(
            name: "JunoWorkKitTests",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoWorkKit",
            ]
        ),
        .testTarget(
            name: "JunoVoiceKitTests",
            dependencies: ["JunoVoiceKit"]
        ),
        .testTarget(
            name: "JunoPreviewSupportTests",
            dependencies: [
                "JunoPreviewSupport", "JunoCore", "JunoAPI", "JunoAuth",
                "JunoStorage", "JunoSync",
            ]
        ),
    ],
    swiftLanguageModes: [.v6]
)
