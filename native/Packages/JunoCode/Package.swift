// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "JunoCode",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .library(name: "JunoCodeCore", targets: ["JunoCodeCore"]),
        .library(name: "JunoCodeLocal", targets: ["JunoCodeLocal"]),
        .library(name: "JunoCodeRuntime", targets: ["JunoCodeRuntime"]),
        .library(name: "JunoCodeUI", targets: ["JunoCodeUI"]),
        .library(name: "JunoCodeBridge", targets: ["JunoCodeBridge"]),
    ],
    dependencies: [
        .package(path: "../JunoNativeKit")
    ],
    targets: [
        .target(name: "JunoCodeCore"),
        .target(name: "JunoCodeLocal", dependencies: ["JunoCodeCore"]),
        .target(name: "JunoCodeRuntime", dependencies: ["JunoCodeCore"]),
        .target(
            name: "JunoCodeUI",
            dependencies: [
                "JunoCodeCore", "JunoCodeLocal", "JunoCodeRuntime",
                // Shared design tokens, so Code and Chat cannot drift apart on
                // spacing, radii, surfaces or type.
                .product(name: "JunoDesignSystem", package: "JunoNativeKit"),
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
