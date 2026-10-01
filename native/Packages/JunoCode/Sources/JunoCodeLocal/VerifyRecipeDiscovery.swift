import Foundation
import JunoCodeCore

// Verify recipe discovery: the checks a project already has, read from its
// manifests rather than invented (CODE_AGENT_SPEC §1.8).
//
// One check per signal, for fourteen ecosystems: Node (npm, pnpm, yarn, bun),
// make, Cargo, SwiftPM, Xcode, Go, Python, Gradle, Maven, Deno, Bun's own
// runner, Ruby, Elixir and .NET. The root and nested manifests are scanned
// to depth 3, the dev-server discovery's bound, and every check gets `paths`
// from its manifest's folder so a monorepo runs the affected package first.
//
// What it proposes is shown to the reader, command by command, before it is
// kept. Nothing here runs a project's own code: the only process it starts is
// `xcodebuild -list -json`, which reads the project file, and lookups of
// whether an optional tool (clippy, golangci-lint, swiftlint) is installed.

/// What discovery may ask of the machine. Injected so tests read fixtures.
public protocol VerifyDiscoveryEnvironment: Sendable {
    /// Whether `program` is on the toolchain PATH.
    func isInstalled(_ program: String) async -> Bool
    /// Runs a read-only listing (`xcodebuild -list -json`) in `directory` and
    /// returns what it printed, or nil when it failed or took too long.
    func run(_ arguments: [String], in directory: URL) async -> String?
}

/// The real machine: the toolchain PATH Juno's commands use, and a short
/// timeout for the one listing it runs.
public struct SystemVerifyDiscoveryEnvironment: VerifyDiscoveryEnvironment {
    private let path: String

    public init(path: String = ToolchainEnvironment.resolvedPATH()) {
        self.path = path
    }

    public func isInstalled(_ program: String) async -> Bool {
        path.split(separator: ":").contains { folder in
            FileManager.default.isExecutableFile(atPath: String(folder) + "/" + program)
        }
    }

    public func run(_ arguments: [String], in directory: URL) async -> String? {
        guard let program = arguments.first else { return nil }
        let candidates = path.split(separator: ":").map { String($0) + "/" + program }
        guard let executable = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return nil
        }
        return await Task.detached(priority: .utility) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = Array(arguments.dropFirst())
            process.currentDirectoryURL = directory
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do { try process.run() } catch { return nil }
            // A listing that hangs (a project waiting on package resolution)
            // is stopped, and discovery goes on without it.
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 20, execute: timeout)
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            timeout.cancel()
            guard process.terminationReason == .exit, process.terminationStatus == 0 else { return nil }
            return String(data: data, encoding: .utf8)
        }.value
    }
}

public struct VerifyRecipeDiscovery: Sendable {
    public let workspaceRoot: URL
    private let environment: any VerifyDiscoveryEnvironment
    private let maximumDepth: Int

    /// More than this many checks is a recipe nobody reads; the root's and
    /// the shallowest packages' come first.
    public static let maximumChecks = 24

    public init(
        workspaceRoot: URL,
        environment: any VerifyDiscoveryEnvironment = SystemVerifyDiscoveryEnvironment(),
        maximumDepth: Int = 3
    ) {
        self.workspaceRoot = workspaceRoot
        self.environment = environment
        self.maximumDepth = maximumDepth
    }

    /// Folders that hold dependencies, build output or tool state, never a
    /// project's own manifest worth a check.
    static let skippedFolders: Set<String> = [
        "node_modules", ".git", ".build", "build", "dist", "out", "target", "Pods", "DerivedData",
        "vendor", ".venv", "venv", "env", "__pycache__", ".next", ".nuxt", ".svelte-kit", "coverage",
        ".juno", ".claude", ".gradle", ".idea", ".vscode", "bin", "obj", "_build", "deps", ".turbo",
        "Carthage", ".swiftpm", "tmp", ".cache",
    ]

    /// Every check discovered under the workspace, root first.
    public func discover() async -> VerifyRecipe {
        var checks: [VerifyCheck] = []
        var ui: [VerifyUITarget] = []
        for folder in folders() {
            let found = await discover(in: folder)
            checks += found.checks
            ui += found.ui
        }
        var seen = Set<String>()
        checks = checks.filter { seen.insert($0.id).inserted }
        return VerifyRecipe(checks: Array(checks.prefix(Self.maximumChecks)), ui: ui)
    }

    // MARK: - Walking

    /// Workspace-relative folders to depth `maximumDepth`, breadth first, the
    /// root as "".
    func folders() -> [String] {
        var result: [String] = [""]
        var frontier: [String] = [""]
        let manager = FileManager.default
        for _ in 0..<maximumDepth {
            var next: [String] = []
            for folder in frontier {
                let url = folder.isEmpty ? workspaceRoot : workspaceRoot.appendingPathComponent(folder)
                guard let names = try? manager.contentsOfDirectory(atPath: url.path) else { continue }
                for name in names.sorted() {
                    guard !name.hasPrefix("."), !Self.skippedFolders.contains(name),
                          !name.hasSuffix(".xcodeproj"), !name.hasSuffix(".xcworkspace"),
                          !name.hasSuffix(".app"), !name.hasSuffix(".framework")
                    else { continue }
                    var isDirectory: ObjCBool = false
                    let child = url.appendingPathComponent(name)
                    guard manager.fileExists(atPath: child.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                        continue
                    }
                    // A link could lead out of the workspace or round in a loop.
                    if (try? child.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true { continue }
                    next.append(folder.isEmpty ? name : folder + "/" + name)
                }
            }
            result += next
            frontier = next
        }
        return result
    }

    // MARK: - One folder

    private struct Found {
        var checks: [VerifyCheck] = []
        var ui: [VerifyUITarget] = []
    }

    private func url(_ folder: String, _ name: String = "") -> URL {
        let base = folder.isEmpty ? workspaceRoot : workspaceRoot.appendingPathComponent(folder)
        return name.isEmpty ? base : base.appendingPathComponent(name)
    }

    private func exists(_ folder: String, _ name: String) -> Bool {
        FileManager.default.fileExists(atPath: url(folder, name).path)
    }

    private func read(_ folder: String, _ name: String) -> String? {
        try? String(contentsOf: url(folder, name), encoding: .utf8)
    }

    private func names(in folder: String) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: url(folder).path))?.sorted() ?? []
    }

    /// The globs a check in `folder` covers.
    private func paths(_ folder: String) -> [String] {
        folder.isEmpty ? ["**"] : [folder + "/**"]
    }

    /// `apps/web` → `apps-web`, the root → nil.
    private func slug(_ folder: String) -> String? {
        guard !folder.isEmpty else { return nil }
        let mapped = folder.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }
        return String(mapped).split(separator: "-").joined(separator: "-")
    }

    private func check(
        _ folder: String,
        _ ecosystem: String,
        _ kind: CheckKind,
        _ run: VerifyCommand,
        targeted: String? = nil,
        runsInFolder: Bool = true,
        timeout: Int? = nil
    ) -> VerifyCheck {
        let id = ([slug(folder), ecosystem, kind.rawValue].compactMap { $0 }).joined(separator: "-")
        return VerifyCheck(
            id: id,
            kind: kind,
            run: run,
            targeted: targeted,
            paths: paths(folder),
            cwd: runsInFolder && !folder.isEmpty ? folder : nil,
            timeoutSeconds: timeout
        )
    }

    private func discover(in folder: String) async -> Found {
        var found = Found()
        let entries = names(in: folder)
        if entries.contains("package.json") { node(folder, into: &found) }
        if entries.contains("deno.json") || entries.contains("deno.jsonc") { deno(folder, into: &found) }
        if let makefile = ["Makefile", "makefile", "GNUmakefile"].first(where: entries.contains) {
            make(folder, file: makefile, into: &found)
        }
        if entries.contains("Cargo.toml") { await cargo(folder, into: &found) }
        if entries.contains("Package.swift") { await swiftPackage(folder, into: &found) }
        let xcodeContainers = entries.filter { $0.hasSuffix(".xcworkspace") || $0.hasSuffix(".xcodeproj") }
        if !xcodeContainers.isEmpty { await xcode(folder, containers: xcodeContainers, into: &found) }
        if entries.contains("go.mod") { await go(folder, into: &found) }
        if entries.contains("pyproject.toml") || entries.contains("pytest.ini") || entries.contains("tox.ini")
            || entries.contains("setup.cfg") && (read(folder, "setup.cfg")?.contains("[tool:pytest]") ?? false)
        {
            python(folder, entries: entries, into: &found)
        }
        if entries.contains("gradlew") || entries.contains("build.gradle") || entries.contains("build.gradle.kts")
            || entries.contains("settings.gradle") || entries.contains("settings.gradle.kts")
        {
            await gradle(folder, entries: entries, into: &found)
        }
        if entries.contains("pom.xml") { maven(folder, into: &found) }
        if entries.contains("Gemfile") { ruby(folder, entries: entries, into: &found) }
        if entries.contains("mix.exs") { elixir(folder, into: &found) }
        if entries.contains(where: { $0.hasSuffix(".sln") }) || entries.contains(where: { $0.hasSuffix(".csproj") || $0.hasSuffix(".fsproj") }) {
            dotnet(folder, entries: entries, into: &found)
        }
        return found
    }

    // MARK: - Node

    /// The package manager for `folder`: the `packageManager` field, else the
    /// nearest lockfile in it or a folder above it, else npm.
    func packageManager(for folder: String, manifest: [String: Any]) -> String {
        if let field = manifest["packageManager"] as? String {
            let name = String(field.prefix { $0 != "@" })
            if ["npm", "pnpm", "yarn", "bun"].contains(name) { return name }
        }
        var current: String? = folder
        while let here = current {
            if exists(here, "pnpm-lock.yaml") { return "pnpm" }
            if exists(here, "yarn.lock") { return "yarn" }
            if exists(here, "bun.lockb") || exists(here, "bun.lock") { return "bun" }
            if exists(here, "package-lock.json") || exists(here, "npm-shrinkwrap.json") { return "npm" }
            current = here.isEmpty ? nil : (here as NSString).deletingLastPathComponent
        }
        return "npm"
    }

    /// `npm test`'s placeholder, which fails by design.
    static func isPlaceholderTestScript(_ script: String) -> Bool {
        let lower = script.lowercased()
        return lower.contains("no test specified") && lower.contains("exit 1")
    }

    private func node(_ folder: String, into found: inout Found) {
        guard let data = try? Data(contentsOf: url(folder, "package.json")),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        let scripts = manifest["scripts"] as? [String: String] ?? [:]
        let dependencies = (manifest["dependencies"] as? [String: Any] ?? [:])
            .merging(manifest["devDependencies"] as? [String: Any] ?? [:]) { first, _ in first }
        let manager = packageManager(for: folder, manifest: manifest)
        let ecosystem = manager

        func runScript(_ name: String) -> String {
            switch (manager, name) {
            case ("npm", "test"): "npm test"
            case ("pnpm", "test"): "pnpm test"
            case ("yarn", _): "yarn \(name)"
            case ("bun", _): "bun run \(name)"
            default: "\(manager) run \(name)"
            }
        }
        func exec(_ binary: String) -> String {
            switch manager {
            case "pnpm": "pnpm exec \(binary)"
            case "yarn": "yarn \(binary)"
            case "bun": "bunx \(binary)"
            default: "npx \(binary)"
            }
        }

        if scripts["build"] != nil {
            found.checks.append(check(folder, ecosystem, .build, .shell(runScript("build"))))
        }
        let typecheckScript = ["typecheck", "type-check", "check-types", "tsc"].first { scripts[$0] != nil }
        if let typecheckScript {
            found.checks.append(check(folder, ecosystem, .typecheck, .shell(runScript(typecheckScript))))
        } else if exists(folder, "tsconfig.json"),
                  dependencies["typescript"] != nil || exists(folder, "node_modules/typescript")
        {
            found.checks.append(check(folder, ecosystem, .typecheck, .shell(exec("tsc --noEmit -p ."))))
        }
        if scripts["lint"] != nil {
            found.checks.append(check(folder, ecosystem, .lint, .shell(runScript("lint"))))
        }
        var targeted: String?
        if dependencies["vitest"] != nil {
            targeted = exec("vitest run {tests}")
        } else if dependencies["jest"] != nil {
            targeted = exec("jest {tests}")
        }
        if let test = scripts["test"], !Self.isPlaceholderTestScript(test) {
            found.checks.append(check(folder, ecosystem, .test, .shell(runScript("test")), targeted: targeted))
        } else if manager == "bun" {
            // Bun's own runner needs no script.
            found.checks.append(check(folder, "bun", .test, .argv(["bun", "test"])))
        }
        if scripts["dev"] != nil || scripts["start"] != nil,
           ["next", "vite", "astro", "nuxt", "@sveltejs/kit", "react-scripts", "@remix-run/dev", "parcel", "webpack-dev-server"]
            .contains(where: { dependencies[$0] != nil })
        {
            found.ui.append(VerifyUITarget(kind: .web, routes: ["/"]))
        }
    }

    // MARK: - Deno

    private func deno(_ folder: String, into found: inout Found) {
        found.checks.append(check(folder, "deno", .test, .argv(["deno", "test"])))
        found.checks.append(check(folder, "deno", .typecheck, .argv(["deno", "check", "."])))
    }

    // MARK: - make

    /// The targets a Makefile defines.
    static func makeTargets(_ text: String) -> Set<String> {
        var targets = Set<String>()
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let first = line.first, first != "\t", first != " ", first != "#" else { continue }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let after = line.index(after: colon)
            // `VAR := value` and `VAR ::= value` are assignments.
            if after < line.endIndex, line[after] == "=" || line[after] == ":" { continue }
            for name in line[..<colon].split(separator: " ") {
                let target = String(name)
                if !target.hasPrefix("."), !target.contains("$"), !target.contains("%"), !target.contains("=") {
                    targets.insert(target)
                }
            }
        }
        return targets
    }

    private func make(_ folder: String, file: String, into found: inout Found) {
        guard let text = read(folder, file) else { return }
        let targets = Self.makeTargets(text)
        if targets.contains("build") {
            found.checks.append(check(folder, "make", .build, .argv(["make", "build"])))
        }
        if targets.contains("test") {
            found.checks.append(check(folder, "make", .test, .argv(["make", "test"])))
        } else if targets.contains("check") {
            found.checks.append(check(folder, "make", .test, .argv(["make", "check"])))
        }
        if targets.contains("lint") {
            found.checks.append(check(folder, "make", .lint, .argv(["make", "lint"])))
        }
    }

    // MARK: - Cargo

    private func cargo(_ folder: String, into found: inout Found) async {
        found.checks.append(check(folder, "cargo", .build, .argv(["cargo", "build"])))
        found.checks.append(check(folder, "cargo", .test, .argv(["cargo", "test"])))
        if await environment.isInstalled("cargo-clippy") {
            found.checks.append(check(folder, "cargo", .lint, .argv(["cargo", "clippy", "--", "-D", "warnings"])))
        }
        found.checks.append(check(folder, "cargo", .typecheck, .argv(["cargo", "check"])))
    }

    // MARK: - SwiftPM

    private func swiftPackage(_ folder: String, into found: inout Found) async {
        // From the root with --package-path, so the command reads the same
        // wherever the package sits.
        let packagePath = folder.isEmpty ? [] : ["--package-path", folder]
        found.checks.append(check(folder, "swift", .build, .argv(["swift", "build"] + packagePath), runsInFolder: false, timeout: 1_200))
        if exists(folder, "Tests") {
            found.checks.append(check(
                folder, "swift", .test, .argv(["swift", "test"] + packagePath),
                targeted: nil, runsInFolder: false, timeout: 1_200
            ))
        }
        if exists(folder, ".swiftlint.yml") || exists("", ".swiftlint.yml"),
           await environment.isInstalled("swiftlint")
        {
            found.checks.append(check(folder, "swiftlint", .lint, .argv(["swiftlint", "lint", "--quiet"])))
        }
    }

    // MARK: - Xcode

    /// What `xcodebuild -list -json` says: the schemes.
    static func schemes(fromListJSON text: String) -> [String] {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [] }
        let container = (object["workspace"] ?? object["project"]) as? [String: Any]
        return container?["schemes"] as? [String] ?? []
    }

    private func xcode(_ folder: String, containers: [String], into found: inout Found) async {
        // A workspace holds the project, and Swift packages make a
        // project.xcworkspace of their own inside it: prefer a real workspace.
        let workspace = containers.first { $0.hasSuffix(".xcworkspace") }
        guard let container = workspace ?? containers.first(where: { $0.hasSuffix(".xcodeproj") }) else { return }
        let flag = container.hasSuffix(".xcworkspace") ? "-workspace" : "-project"
        guard let listing = await environment.run(["xcodebuild", "-list", "-json", flag, container], in: url(folder)) else {
            return
        }
        let schemes = Self.schemes(fromListJSON: listing)
        guard !schemes.isEmpty else { return }
        let name = (container as NSString).deletingPathExtension
        let scheme = schemes.first { $0 == name }
            ?? schemes.first { !$0.lowercased().contains("test") }
            ?? schemes[0]
        let project = containers.first { $0.hasSuffix(".xcodeproj") }
        let iOS = project.map { read(folder, $0 + "/project.pbxproj")?.contains("SDKROOT = iphoneos") ?? false } ?? false
        let destination = iOS ? "generic/platform=iOS Simulator" : "platform=macOS"
        let base = ["xcodebuild", flag, container, "-scheme", scheme, "-destination", destination,
                    "-derivedDataPath", "build"]
        found.checks.append(check(folder, "xcode", .build, .argv(base + ["build"]), timeout: 1_800))
        // A test action needs a concrete device on iOS, which is the
        // reader's choice; on the Mac the scheme's own tests run.
        if !iOS, let project, schemeHasTests(folder, project: project, scheme: scheme) {
            found.checks.append(check(folder, "xcode", .test, .argv(base + ["test"]), timeout: 1_800))
        }
        found.ui.append(VerifyUITarget(
            kind: iOS ? .ios : .mac,
            build: ([slug(folder), "xcode", CheckKind.build.rawValue].compactMap { $0 }).joined(separator: "-")
        ))
    }

    /// Whether a shared scheme lists test targets.
    private func schemeHasTests(_ folder: String, project: String, scheme: String) -> Bool {
        let path = "\(project)/xcshareddata/xcschemes/\(scheme).xcscheme"
        return read(folder, path)?.contains("<TestableReference") ?? false
    }

    // MARK: - Go

    private func go(_ folder: String, into found: inout Found) async {
        found.checks.append(check(folder, "go", .build, .argv(["go", "build", "./..."])))
        found.checks.append(check(folder, "go", .test, .argv(["go", "test", "./..."])))
        if await environment.isInstalled("golangci-lint") {
            found.checks.append(check(folder, "go", .lint, .argv(["golangci-lint", "run"])))
        } else {
            found.checks.append(check(folder, "go", .lint, .argv(["go", "vet", "./..."])))
        }
    }

    // MARK: - Python

    private func python(_ folder: String, entries: [String], into found: inout Found) {
        let pyproject = read(folder, "pyproject.toml") ?? ""
        var prefix: [String] = []
        if entries.contains("uv.lock") || exists("", "uv.lock") {
            prefix = ["uv", "run"]
        } else if entries.contains("poetry.lock") || pyproject.contains("[tool.poetry]") {
            prefix = ["poetry", "run"]
        }
        let usesPytest = entries.contains("pytest.ini") || entries.contains("tox.ini")
            || pyproject.contains("[tool.pytest") || pyproject.contains("pytest")
            || entries.contains("conftest.py") || entries.contains("tests")
            || (read(folder, "setup.cfg")?.contains("[tool:pytest]") ?? false)
        if usesPytest {
            found.checks.append(check(folder, "python", .test, .argv(prefix + ["pytest", "-q"]), targeted: (prefix + ["pytest", "-q"]).joined(separator: " ") + " {tests}"))
        }
        if pyproject.contains("[tool.ruff") || entries.contains("ruff.toml") || entries.contains(".ruff.toml") {
            found.checks.append(check(folder, "python", .lint, .argv(prefix + ["ruff", "check", "."])))
        }
        if pyproject.contains("[tool.mypy") || entries.contains("mypy.ini") || entries.contains(".mypy.ini") {
            found.checks.append(check(folder, "python", .typecheck, .argv(prefix + ["mypy", "."])))
        } else if pyproject.contains("[tool.pyright") || entries.contains("pyrightconfig.json") {
            found.checks.append(check(folder, "python", .typecheck, .argv(prefix + ["pyright"])))
        }
    }

    // MARK: - Gradle and Maven

    private func gradle(_ folder: String, entries: [String], into found: inout Found) async {
        let gradle: String
        if entries.contains("gradlew") {
            gradle = "./gradlew"
        } else if await environment.isInstalled("gradle") {
            gradle = "gradle"
        } else {
            return
        }
        found.checks.append(check(folder, "gradle", .build, .argv([gradle, "build"]), timeout: 1_800))
        found.checks.append(check(folder, "gradle", .test, .argv([gradle, "test"]), timeout: 1_800))
    }

    private func maven(_ folder: String, into found: inout Found) {
        let mvn = exists(folder, "mvnw") ? "./mvnw" : "mvn"
        found.checks.append(check(folder, "maven", .build, .argv([mvn, "-q", "-DskipTests", "package"]), timeout: 1_800))
        found.checks.append(check(folder, "maven", .test, .argv([mvn, "-q", "test"]), timeout: 1_800))
    }

    // MARK: - Ruby, Elixir, .NET

    private func ruby(_ folder: String, entries: [String], into found: inout Found) {
        let gemfile = read(folder, "Gemfile") ?? ""
        if entries.contains("spec") || entries.contains(".rspec") || gemfile.contains("rspec") {
            found.checks.append(check(folder, "ruby", .test, .argv(["bundle", "exec", "rspec"])))
        } else if entries.contains("Rakefile") {
            found.checks.append(check(folder, "ruby", .test, .argv(["bundle", "exec", "rake", "test"])))
        }
    }

    private func elixir(_ folder: String, into found: inout Found) {
        found.checks.append(check(folder, "mix", .build, .argv(["mix", "compile"])))
        found.checks.append(check(folder, "mix", .test, .argv(["mix", "test"])))
    }

    private func dotnet(_ folder: String, entries: [String], into found: inout Found) {
        // A project under a solution is built by the solution's checks.
        if !entries.contains(where: { $0.hasSuffix(".sln") }), hasSolutionAbove(folder) { return }
        found.checks.append(check(folder, "dotnet", .build, .argv(["dotnet", "build"]), timeout: 1_800))
        found.checks.append(check(folder, "dotnet", .test, .argv(["dotnet", "test"]), timeout: 1_800))
    }

    private func hasSolutionAbove(_ folder: String) -> Bool {
        var current = folder
        while !current.isEmpty {
            current = (current as NSString).deletingLastPathComponent
            if names(in: current).contains(where: { $0.hasSuffix(".sln") }) { return true }
        }
        return false
    }
}
