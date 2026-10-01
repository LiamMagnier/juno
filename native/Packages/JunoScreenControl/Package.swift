// swift-tools-version: 6.0

import PackageDescription

// Screen control for every Juno surface that drives another app: Juno Code's
// computer use and Juno Work's visual and accessibility tiers.
//
// One package, because there is one screen. The lock, the stop, the per-app
// grants and the always-confirm floor have to be the same object for Code and
// Work, or two of them can drive the same mouse at once and a stop pressed in
// one leaves the other running (CODE_AGENT_SPEC §3.2, audit CU-09).
//
// It depends on nothing else in the repository. Juno Code and Juno Work both
// depend on it; it depends on neither, so the policy here cannot reach into a
// session, a task or a model — it decides about a screen action, and nothing
// else.
let package = Package(
    name: "JunoScreenControl",
    platforms: [
        // Work's packages build for iOS too (the phone watches a Work run), so
        // this one must at least compile there. Everything that touches the
        // real screen is behind `#if os(macOS)`; the policy is plain values.
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "JunoScreenControl", targets: ["JunoScreenControl"]),
    ],
    targets: [
        .target(name: "JunoScreenControl"),
        .testTarget(
            name: "JunoScreenControlTests",
            dependencies: ["JunoScreenControl"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
