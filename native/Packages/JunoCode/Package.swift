// swift-tools-version: 6.0

import PackageDescription

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
        // Juno Simulator: Xcode/simctl discovery, the build-and-run state machine,
        // frame capture and the capability advertisement. No SwiftUI — the pane
        // lives in JunoCodeUI, so this stays testable headlessly.
        .library(name: "JunoSimulator", targets: ["JunoSimulator"]),
    ],
    dependencies: [
        .package(path: "../JunoNativeKit")
    ],
    targets: [
        .target(name: "JunoCodeCore"),
        .target(name: "JunoCodeLocal", dependencies: ["JunoCodeCore"]),
        // Depends on Core only, for SecretRedactor — build logs routinely carry
        // tokens, and they are redacted before reaching the UI or the model.
        .target(name: "JunoSimulator", dependencies: ["JunoCodeCore"]),
        .target(name: "JunoCodeRuntime", dependencies: ["JunoCodeCore"]),
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
            ]
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
            ]
        ),
        .testTarget(name: "JunoCodeCoreTests", dependencies: ["JunoCodeCore"]),
        .testTarget(
            name: "JunoSimulatorTests",
            dependencies: ["JunoSimulator"],
            resources: [.copy("Fixtures")]
        ),
        .testTarget(name: "JunoCodeLocalTests", dependencies: ["JunoCodeCore", "JunoCodeLocal"]),
        .testTarget(
            name: "JunoCodeRuntimeTests",
            dependencies: ["JunoCodeCore", "JunoCodeRuntime", "JunoCodeLocal"]
        ),
        .testTarget(
            name: "JunoCodeUITests",
            dependencies: ["JunoCodeCore", "JunoCodeLocal", "JunoCodeRuntime", "JunoCodeUI"]
        ),
        .testTarget(
            name: "JunoCodeBridgeTests",
            dependencies: [
                "JunoCodeCore",
                "JunoCodeLocal",
                "JunoCodeRuntime",
                "JunoCodeBridge",
            ]
        ),
    ],
    swiftLanguageModes: [.v6]
)
