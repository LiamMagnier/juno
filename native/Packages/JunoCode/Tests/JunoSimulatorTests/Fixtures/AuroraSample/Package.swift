// swift-tools-version: 5.9
import PackageDescription

// A minimal iOS application used by JunoSimulator's integration test.
//
// Deliberately tiny and dependency-free: the test is about Juno's discovery →
// build → boot → install → launch loop, not about the app. It is a Swift package
// rather than an .xcodeproj so it can live in the repository as readable text
// instead of a generated project file nobody can review.
let package = Package(
    name: "Aurora",
    platforms: [.iOS(.v17)],
    products: [.library(name: "Aurora", targets: ["Aurora"])],
    targets: [.target(name: "Aurora", path: "Aurora")]
)
