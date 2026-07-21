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
    ],
    targets: [
        .target(name: "JunoCodeCore"),
        .target(name: "JunoCodeLocal", dependencies: ["JunoCodeCore"]),
        .target(name: "JunoCodeRuntime", dependencies: ["JunoCodeCore"]),
        .testTarget(name: "JunoCodeCoreTests", dependencies: ["JunoCodeCore"]),
        .testTarget(name: "JunoCodeLocalTests", dependencies: ["JunoCodeCore", "JunoCodeLocal"]),
        .testTarget(
            name: "JunoCodeRuntimeTests",
            dependencies: ["JunoCodeCore", "JunoCodeRuntime", "JunoCodeLocal"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
