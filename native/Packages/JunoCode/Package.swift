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
    ],
    targets: [
        .target(name: "JunoCodeCore"),
        .target(name: "JunoCodeLocal", dependencies: ["JunoCodeCore"]),
        .target(name: "JunoCodeRuntime", dependencies: ["JunoCodeCore"]),
        .target(
            name: "JunoCodeUI",
            dependencies: ["JunoCodeCore", "JunoCodeLocal", "JunoCodeRuntime"]
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
    ],
    swiftLanguageModes: [.v6]
)
