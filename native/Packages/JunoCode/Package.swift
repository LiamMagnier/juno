// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "JunoCode",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .library(name: "JunoCodeCore", targets: ["JunoCodeCore"])
    ],
    targets: [
        .target(name: "JunoCodeCore"),
        .testTarget(name: "JunoCodeCoreTests", dependencies: ["JunoCodeCore"]),
    ],
    swiftLanguageModes: [.v6]
)
