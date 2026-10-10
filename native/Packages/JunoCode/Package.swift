// swift-tools-version: 6.0

import PackageDescription

// This manifest excludes nothing on purpose.
//
// It used to carry `exclude:` entries behind a helper that probed the
// filesystem, so SwiftPM would not warn on a checkout where the excluded paths
// were absent — every one of them named a file that no longer existed. A
// manifest that tolerates missing files cannot tell you when a real source
// file goes missing. If a file needs to leave a target, delete it; every
// source under `Sources/` is compiled, and nothing is compiled that is not.

let package = Package(
    name: "JunoCode",
    platforms: [
        .macOS("26.0"),
        .iOS("26.0"),
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
        // The iPhone's remote for Mac Alevr Code over the v2 device link
        // (docs/code-v2/REMOTE-CONTROL.md). No AppKit or UIKit: it builds and
        // tests on the Mac and ships in the iPhone app.
        .library(name: "JunoCodeRemote", targets: ["JunoCodeRemote"]),
    ],
    dependencies: [
        .package(path: "../JunoNativeKit"),
        // Screen control, shared with Juno Work: one lock, one stop, the
        // grants and the always-confirm floor (CODE_AGENT_SPEC §3.2).
        .package(path: "../JunoScreenControl"),
    ],
    targets: [
        .target(name: "JunoCodeCore"),
        .target(
            name: "JunoCodeLocal",
            dependencies: [
                "JunoCodeCore",
                .product(name: "JunoScreenControl", package: "JunoScreenControl"),
            ]
        ),
        // Depends on Core only, for SecretRedactor — build logs routinely carry
        // tokens, and they are redacted before they reach the UI or the model.
        .target(name: "JunoSimulator", dependencies: ["JunoCodeCore"]),
        .target(
            name: "JunoCodeRuntime",
            dependencies: [
                "JunoCodeCore",
                // The computer tools speak the screen-control vocabulary and
                // scale Simulator frames with its scaler. The service itself
                // is reached only through the protocol a session hands in.
                .product(name: "JunoScreenControl", package: "JunoScreenControl"),
            ]
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
                .product(name: "JunoScreenControl", package: "JunoScreenControl"),
            ]
        ),
        .target(
            name: "JunoCodeBridge",
            dependencies: [
                "JunoCodeCore",
                "JunoCodeRuntime",
                // The canonical agent protocol: the one projection of a Mac
                // session every wire (relay, device task) is spelled from.
                .product(name: "JunoAgentProtocol", package: "JunoNativeKit"),
                .product(name: "JunoCodeKit", package: "JunoNativeKit"),
                .product(name: "JunoCore", package: "JunoNativeKit"),
                .product(name: "JunoAPI", package: "JunoNativeKit"),
                .product(name: "JunoAuth", package: "JunoNativeKit"),
                .product(name: "JunoSync", package: "JunoNativeKit"),
                .product(name: "JunoChatKit", package: "JunoNativeKit"),
            ]
        ),
        .target(
            name: "JunoCodeRemote",
            dependencies: [
                "JunoCodeCore",
                .product(name: "JunoCore", package: "JunoNativeKit"),
                .product(name: "JunoAPI", package: "JunoNativeKit"),
                .product(name: "JunoAuth", package: "JunoNativeKit"),
                .product(name: "JunoSync", package: "JunoNativeKit"),
                .product(name: "JunoCodeKit", package: "JunoNativeKit"),
            ]
        ),
        .testTarget(
            name: "JunoCodeRemoteTests",
            dependencies: [
                "JunoCodeCore", "JunoCodeRemote",
                .product(name: "JunoCore", package: "JunoNativeKit"),
                .product(name: "JunoAPI", package: "JunoNativeKit"),
                .product(name: "JunoAuth", package: "JunoNativeKit"),
                .product(name: "JunoSync", package: "JunoNativeKit"),
                .product(name: "JunoCodeKit", package: "JunoNativeKit"),
            ]
        ),
        .testTarget(
            name: "JunoCodeCoreTests",
            dependencies: ["JunoCodeCore"]
        ),
        .testTarget(
            name: "JunoSimulatorTests",
            dependencies: ["JunoSimulator"],
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "JunoCodeLocalTests",
            dependencies: [
                "JunoCodeCore", "JunoCodeLocal",
                .product(name: "JunoScreenControl", package: "JunoScreenControl"),
            ]
        ),
        .testTarget(
            name: "JunoCodeRuntimeTests",
            dependencies: [
                "JunoCodeCore", "JunoCodeRuntime", "JunoCodeLocal",
                .product(name: "JunoCore", package: "JunoNativeKit"),
                .product(name: "JunoScreenControl", package: "JunoScreenControl"),
            ]
        ),
        .testTarget(
            name: "JunoCodeUITests",
            dependencies: [
                "JunoCodeCore", "JunoCodeLocal", "JunoCodeRuntime", "JunoCodeUI",
                .product(name: "JunoScreenControl", package: "JunoScreenControl"),
            ]
        ),
        .testTarget(
            name: "JunoCodeBridgeTests",
            dependencies: [
                "JunoCodeCore",
                "JunoCodeLocal",
                "JunoCodeRuntime",
                "JunoCodeBridge",
                .product(name: "JunoAgentProtocol", package: "JunoNativeKit"),
            ]
        ),
    ],
    swiftLanguageModes: [.v6]
)
