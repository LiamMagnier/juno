import Foundation

/// Finds the Apple project in a Juno workspace, and what it can build.
///
/// Scoped to the workspace root the user granted, and never above it: a project
/// search that wandered into a sibling directory would be reading folders Juno
/// was never given. Depth is bounded and the usual build/dependency directories
/// are skipped, because a `node_modules` full of vendored `.xcodeproj`s is a
/// real thing and scanning it finds only noise.
public struct XcodeProjectDiscoveryService: Sendable {
    /// Directories that never contain the project the user means.
    static let skipped: Set<String> = [
        "node_modules", ".git", ".build", "DerivedData", "Pods", "Carthage",
        ".swiftpm", "build", "dist", ".next", "vendor", "Frameworks",
    ]
    static let maxDepth = 5

    private let runner: SimulatorProcessRunner

    public init(runner: SimulatorProcessRunner) {
        self.runner = runner
    }

    public enum ToolchainStatus: Equatable, Sendable {
        case ready(developerDirectory: String, xcodeVersion: String, xcodeBuild: String)
        case missing(String)
    }

    /// Is there a usable Xcode at all?
    ///
    /// `xcode-select -p` pointing at the Command Line Tools is the single most
    /// common cause of "it works in Terminal but not in Juno", so it is checked
    /// first and reported with the fix rather than as a build failure ten
    /// seconds later.
    public func toolchain() async -> ToolchainStatus {
        guard let selected = try? await runner.run(SimulatorCommands.xcodeSelectPath(), timeout: 20), selected.succeeded else {
            return .missing("Xcode is not installed, or no developer directory is selected.")
        }
        let developerDirectory = selected.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        if developerDirectory.contains("CommandLineTools") {
            return .missing(
                """
                Only the Command Line Tools are selected, which cannot build for the iOS Simulator. \
                Install Xcode, then run: sudo xcode-select -s /Applications/Xcode.app
                """
            )
        }
        guard let version = try? await runner.run(SimulatorCommands.xcodebuildVersion(), timeout: 30), version.succeeded,
              let parsed = SimulatorParsing.parseXcodeVersion(version.standardOutput)
        else {
            return .missing("Xcode is installed but `xcodebuild -version` did not answer. Open Xcode once to finish setup.")
        }
        return .ready(developerDirectory: developerDirectory, xcodeVersion: parsed.version, xcodeBuild: parsed.build)
    }

    /// Every buildable container under `root`, workspaces first.
    ///
    /// An `.xcworkspace` beside an `.xcodeproj` almost always means the
    /// workspace is the right container (CocoaPods, or a multi-project app), so
    /// ordering here is the default the picker offers — while still listing the
    /// project, because sometimes it genuinely is the one you want.
    public func findProjects(root: URL) async -> [XcodeProject] {
        let containers = Self.scan(root: root)
        var out: [XcodeProject] = []
        for container in containers {
            let schemes = await schemes(for: container)
            out.append(
                XcodeProject(
                    kind: container.kind,
                    path: container.path,
                    name: container.name,
                    schemes: schemes
                )
            )
        }
        return out.sorted { lhs, rhs in
            if lhs.kind != rhs.kind { return rank(lhs.kind) < rank(rhs.kind) }
            return lhs.path.count < rhs.path.count // shallower is more likely the root project
        }
    }

    private func rank(_ kind: XcodeProjectKind) -> Int {
        switch kind {
        case .workspace: 0
        case .project: 1
        case .swiftPackage: 2
        }
    }

    struct Container: Equatable {
        let kind: XcodeProjectKind
        let path: String
        let name: String
    }

    /// Pure directory walk, extracted so it can be tested against a temporary
    /// tree without Xcode installed.
    static func scan(root: URL) -> [Container] {
        var out: [Container] = []
        var stack: [(URL, Int)] = [(root, 0)]
        let fileManager = FileManager.default

        while let (directory, depth) = stack.popLast() {
            guard depth <= maxDepth else { continue }
            guard let entries = try? fileManager.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            var sawPackageManifest = false
            for entry in entries {
                let name = entry.lastPathComponent
                if name == "Package.swift" { sawPackageManifest = true }

                let isDirectory = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
                guard isDirectory else { continue }

                if name.hasSuffix(".xcworkspace") {
                    // Every `.xcodeproj` contains a `project.xcworkspace`; that
                    // is an implementation detail, not a workspace to build.
                    if directory.lastPathComponent.hasSuffix(".xcodeproj") { continue }
                    out.append(.init(kind: .workspace, path: entry.path, name: String(name.dropLast(".xcworkspace".count))))
                    continue
                }
                if name.hasSuffix(".xcodeproj") {
                    out.append(.init(kind: .project, path: entry.path, name: String(name.dropLast(".xcodeproj".count))))
                    continue // never descend into a project bundle
                }
                if skipped.contains(name) { continue }
                stack.append((entry, depth + 1))
            }

            // A package is only interesting when there is no project beside it —
            // otherwise the project is the app and the package is a dependency.
            if sawPackageManifest, !out.contains(where: { $0.path.hasPrefix(directory.path) }) {
                out.append(.init(kind: .swiftPackage, path: directory.path, name: directory.lastPathComponent))
            }
        }
        return out.sorted { $0.path < $1.path }
    }

    private func schemes(for container: Container) async -> [String] {
        let project = XcodeProject(kind: container.kind, path: container.path, name: container.name, schemes: [])
        guard let result = try? await runner.run(SimulatorCommands.listSchemes(project: project), timeout: 120),
              result.succeeded,
              let parsed = try? SimulatorParsing.parseSchemeList(Data(result.standardOutput.utf8))
        else {
            // A container with no *shared* scheme lists nothing. That is a real,
            // common state (schemes default to not-shared), and it is reported
            // as "no schemes" so the pane can say so rather than showing an
            // empty picker with no explanation.
            return []
        }
        return parsed.schemes
    }

    /// Settings for one scheme, and whether it can actually target the simulator.
    public func settings(
        project: XcodeProject,
        scheme: String,
        configuration: String,
        derivedDataPath: String
    ) async throws -> XcodeTargetSettings {
        let invocation = SimulatorCommands.showBuildSettings(
            project: project, scheme: scheme, configuration: configuration, derivedDataPath: derivedDataPath
        )
        let result = try await runner.run(invocation, timeout: 300)
        guard result.succeeded else {
            let diagnostics = SimulatorParsing.parseDiagnostics(result.combined)
            throw SimulatorFailure(
                stage: .discovery,
                message: diagnostics.first?.message ?? "Xcode could not read this scheme's build settings.",
                detail: String(result.combined.suffix(4_000))
            )
        }
        let settings = try SimulatorParsing.parseBuildSettings(Data(result.standardOutput.utf8))
        guard settings.targetsIOSSimulator else {
            throw SimulatorFailure(
                stage: .discovery,
                message: "“\(scheme)” does not build for the iOS Simulator (it supports \(settings.supportedPlatforms.joined(separator: ", "))).",
                detail: nil
            )
        }
        return settings
    }
}

extension SimulatorFailure: Error {}
