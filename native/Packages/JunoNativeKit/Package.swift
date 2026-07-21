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
        .library(name: "JunoVoiceKit", targets: ["JunoVoiceKit"]),
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
        .target(
            name: "JunoVoiceKit",
            dependencies: ["JunoCore", "JunoAPI", "JunoAuth", "JunoDesignSystem"]
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
            ]
        ),
        .testTarget(
            name: "JunoCodeKitTests",
            dependencies: ["JunoCore", "JunoCodeKit"]
        ),
        .testTarget(
            name: "JunoVoiceKitTests",
            dependencies: ["JunoVoiceKit"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
