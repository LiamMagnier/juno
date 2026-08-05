// swift-tools-version: 6.0

import PackageDescription

// Two layers, and the split is the security boundary rather than a filing
// preference. Core is pure value logic that decides *what* is allowed; Local is
// the only place that touches a real filesystem, so every containment rule has
// exactly one implementation to audit and exactly one place it can be bypassed.
let package = Package(
    name: "JunoWork",
    platforms: [
        // Work runs on the Mac and is *watched* from the phone: the approval
        // sheet, the batch preview and the host list are all iOS surfaces that
        // decode these exact types, so Core has to build for both.
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "JunoWorkCore", targets: ["JunoWorkCore"]),
        .library(name: "JunoWorkLocal", targets: ["JunoWorkLocal"]),
    ],
    targets: [
        // No dependencies, deliberately. Everything here is pure value logic so
        // that the containment rules, the batch planner and the undo journal can
        // be tested without a filesystem, a network or a signed-in account.
        .target(name: "JunoWorkCore"),
        // Depends on Core and nothing else. The moment this target needs a
        // network client or a UI framework, the folder-touching code has become
        // reachable from places that cannot be reviewed as a boundary.
        .target(name: "JunoWorkLocal", dependencies: ["JunoWorkCore"]),
        .testTarget(name: "JunoWorkCoreTests", dependencies: ["JunoWorkCore"]),
        .testTarget(
            name: "JunoWorkLocalTests",
            dependencies: ["JunoWorkCore", "JunoWorkLocal"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
