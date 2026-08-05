// swift-tools-version: 6.0

import PackageDescription

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
        .library(name: "JunoChatKit", targets: ["JunoChatKit"]),
        .library(name: "JunoCodeKit", targets: ["JunoCodeKit"]),
        .library(name: "JunoWorkKit", targets: ["JunoWorkKit"]),
        .library(name: "JunoVoiceKit", targets: ["JunoVoiceKit"]),
        // Development-only: every source file is wrapped in `#if DEBUG`, so this
        // target contributes nothing to Release builds.
        .library(name: "JunoPreviewSupport", targets: ["JunoPreviewSupport"]),
    ],
    targets: [
        .target(name: "JunoCore"),
        .target(name: "JunoAPI", dependencies: ["JunoCore"]),
        .target(name: "JunoAuth", dependencies: ["JunoCore", "JunoAPI"]),
        .target(name: "JunoStorage"),
        .target(
            name: "JunoSync",
            dependencies: ["JunoCore", "JunoAPI", "JunoAuth", "JunoStorage"]
        ),
        .target(name: "JunoSearch", dependencies: ["JunoCore", "JunoStorage"]),
        .target(name: "JunoDesignSystem", dependencies: ["JunoCore"]),
        .target(
            name: "JunoChatKit",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoSearch", "JunoDesignSystem",
            ]
        ),
        .target(
            name: "JunoCodeKit",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoDesignSystem",
            ]
        ),
        // Juno Work's client half: the value types a phone or a Mac exchanges
        // with the relay, the policy lattice a host enforces, and the claim
        // loop. Deliberately does NOT depend on JunoCodeKit — the two products
        // solve the same relay problem and share its shape, and coupling them
        // to share six lines of backoff arithmetic would mean a change to one
        // rebuilds and re-tests the other.
        .target(
            name: "JunoWorkKit",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoDesignSystem",
            ]
        ),
        .target(
            name: "JunoVoiceKit",
            dependencies: ["JunoCore", "JunoAPI", "JunoAuth", "JunoDesignSystem"]
        ),
        .target(
            name: "JunoPreviewSupport",
            dependencies: [
                "JunoCore", "JunoAPI", "JunoAuth", "JunoStorage", "JunoSync",
                "JunoSearch", "JunoChatKit", "JunoCodeKit", "JunoDesignSystem",
            ]
        ),
        .testTarget(name: "JunoCoreTests", dependencies: ["JunoCore"]),
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
            dependencies: ["JunoDesignSystem"]
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
            ]
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
