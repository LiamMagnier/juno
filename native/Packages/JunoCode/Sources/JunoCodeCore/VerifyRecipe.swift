import Foundation

// The project's verify recipe: the checks Juno runs to know a change works,
// recorded once per project in `.juno/verify.json` and reused by every run
// (CODE_AGENT_SPEC §1.8).
//
// The file is repository-authored data. It can never grant a permission:
// running a check is a command like any other and goes through the reader's
// rules and the approval ladder. What the reader accepts once from the recipe
// card is the file's exact bytes (so a later edit asks again) and, when they
// tick "Run these without asking in this repository", the exact `Bash(...)`
// rules `permissionRules` lists, written to the personal settings file.

/// How a check's command is written: an argument vector (preferred, nothing
/// for a shell to reinterpret) or one shell string.
public enum VerifyCommand: Hashable, Sendable, Codable {
    case argv([String])
    case shell(String)

    /// The command line Juno runs and shows: the vector shell-quoted, or the
    /// string as written.
    public var commandLine: String {
        switch self {
        case let .argv(arguments):
            arguments.map(ShellQuoting.quote).joined(separator: " ")
        case let .shell(line):
            line.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    public var isEmpty: Bool {
        switch self {
        case let .argv(arguments):
            arguments.allSatisfy { $0.trimmingCharacters(in: .whitespaces).isEmpty }
        case let .shell(line):
            line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let arguments = try? container.decode([String].self) {
            self = .argv(arguments)
        } else {
            self = .shell(try container.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .argv(arguments): try container.encode(arguments)
        case let .shell(line): try container.encode(line)
        }
    }
}

/// One check: what it is for, how to run it, and which files it covers.
public struct VerifyCheck: Hashable, Codable, Sendable, Identifiable {
    /// Stable within the recipe: `web-test`, `swift-build`.
    public var id: String
    public var kind: CheckKind
    public var run: VerifyCommand
    /// A narrower command for the files a run changed. `{files}` expands to
    /// the changed files under `paths`, `{tests}` to the test files the
    /// runtime maps from them (same-name `*.test.*`, `*Tests.swift`, …).
    public var targeted: String?
    /// Workspace-relative globs. A check covers a change when one of its
    /// patterns matches a changed file; no patterns cover everything.
    public var paths: [String]
    /// The workspace-relative folder the command runs in; nil for the root.
    public var cwd: String?
    public var timeoutSeconds: Int?

    public init(
        id: String,
        kind: CheckKind,
        run: VerifyCommand,
        targeted: String? = nil,
        paths: [String] = [],
        cwd: String? = nil,
        timeoutSeconds: Int? = nil
    ) {
        self.id = id
        self.kind = kind
        self.run = run
        self.targeted = targeted
        self.paths = paths
        self.cwd = cwd
        self.timeoutSeconds = timeoutSeconds
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, run, targeted, paths, cwd, timeoutSeconds
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(CheckKind.self, forKey: .kind)
        run = try container.decode(VerifyCommand.self, forKey: .run)
        targeted = try container.decodeIfPresent(String.self, forKey: .targeted)
        paths = try container.decodeIfPresent([String].self, forKey: .paths) ?? []
        cwd = try container.decodeIfPresent(String.self, forKey: .cwd)
        timeoutSeconds = try container.decodeIfPresent(Int.self, forKey: .timeoutSeconds)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encode(run, forKey: .run)
        try container.encodeIfPresent(targeted, forKey: .targeted)
        if !paths.isEmpty { try container.encode(paths, forKey: .paths) }
        try container.encodeIfPresent(cwd, forKey: .cwd)
        try container.encodeIfPresent(timeoutSeconds, forKey: .timeoutSeconds)
    }

    /// The full command line.
    public var commandLine: String { run.commandLine }

    /// The default timeout for one check: generous, since a full build or test
    /// suite is the point.
    public static let defaultTimeoutSeconds = 600

    public var effectiveTimeoutSeconds: Int {
        min(max(timeoutSeconds ?? Self.defaultTimeoutSeconds, 1), 3_600)
    }

    // MARK: - Coverage

    /// The changed files this check covers, in the order given.
    public func coveredFiles(_ changedFiles: [String]) -> [String] {
        guard !paths.isEmpty else { return changedFiles }
        let patterns = paths.compactMap { try? GlobPattern($0) }
        return changedFiles.filter { file in patterns.contains { $0.matches(file) } }
    }

    /// How specific this check's coverage of `file` is: the length of the
    /// literal folder its best matching pattern names (`apps/web/**` is more
    /// specific than `**`), or nil when it does not cover the file.
    public func specificity(for file: String) -> Int? {
        guard !paths.isEmpty else { return 0 }
        var best: Int?
        for pattern in paths {
            guard let glob = try? GlobPattern(pattern), glob.matches(file) else { continue }
            let literal = pattern.prefix { $0 != "*" && $0 != "?" && $0 != "[" && $0 != "{" }
            best = max(best ?? 0, literal.count)
        }
        return best
    }

    /// The targeted command for `changedFiles`, or nil when the check has no
    /// template or the template expands to nothing (then the full command
    /// runs).
    ///
    /// - Parameter fileExists: whether a workspace-relative file exists, for
    ///   mapping sources to their tests.
    public func targetedCommandLine(
        changedFiles: [String],
        fileExists: (String) -> Bool
    ) -> String? {
        guard let template = targeted?.trimmingCharacters(in: .whitespacesAndNewlines),
              !template.isEmpty
        else { return nil }
        let covered = coveredFiles(changedFiles).filter(fileExists)
        guard !covered.isEmpty else { return nil }
        var line = template
        if line.contains("{files}") {
            let files = covered.map(relativeToCwd)
            guard !files.isEmpty else { return nil }
            line = line.replacingOccurrences(of: "{files}", with: files.map(ShellQuoting.quote).joined(separator: " "))
        }
        if line.contains("{tests}") {
            let tests = TestFileMapping.tests(for: covered, fileExists: fileExists).map(relativeToCwd)
            guard !tests.isEmpty else { return nil }
            line = line.replacingOccurrences(of: "{tests}", with: tests.map(ShellQuoting.quote).joined(separator: " "))
        }
        return line == template ? nil : line
    }

    /// `path` relative to the check's folder, as a command run there sees it.
    func relativeToCwd(_ path: String) -> String {
        guard let cwd = normalizedCwd else { return path }
        let prefix = cwd + "/"
        return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
    }

    /// The folder, without `./` or trailing slashes; nil for the root.
    public var normalizedCwd: String? {
        guard var cwd = cwd?.trimmingCharacters(in: .whitespaces), !cwd.isEmpty else { return nil }
        while cwd.hasPrefix("./") { cwd.removeFirst(2) }
        while cwd.hasSuffix("/") { cwd.removeLast() }
        return cwd.isEmpty || cwd == "." ? nil : cwd
    }

    /// The literal part of the targeted template before its first
    /// placeholder: `npx vitest run` for `npx vitest run {tests}`.
    public var targetedPrefix: String? {
        guard let template = targeted else { return nil }
        guard let open = template.firstIndex(of: "{") else { return nil }
        let prefix = template[..<open].trimmingCharacters(in: .whitespaces)
        return prefix.isEmpty ? nil : prefix
    }
}

/// Where a recipe says the running result can be looked at.
public struct VerifyUITarget: Hashable, Codable, Sendable {
    public var kind: UIVerificationSurface
    /// A `.juno/launch.json` configuration, for web.
    public var launch: String?
    /// The check that builds the app, for Mac and iOS.
    public var build: String?
    /// The built app's path, for Mac and iOS.
    public var app: String?
    public var routes: [String]?

    public init(
        kind: UIVerificationSurface,
        launch: String? = nil,
        build: String? = nil,
        app: String? = nil,
        routes: [String]? = nil
    ) {
        self.kind = kind
        self.launch = launch
        self.build = build
        self.app = app
        self.routes = routes
    }
}

public enum VerifyRecipeError: Error, Equatable, Sendable, CustomStringConvertible {
    case unreadable(String)
    case unsupportedVersion(Int)
    case duplicateCheck(String)
    case invalidCheck(String)

    public var description: String {
        switch self {
        case let .unreadable(reason):
            ".juno/verify.json could not be read: \(reason)"
        case let .unsupportedVersion(version):
            ".juno/verify.json is version \(version); this Juno reads version \(VerifyRecipe.currentVersion)."
        case let .duplicateCheck(id):
            ".juno/verify.json names the check \"\(id)\" twice."
        case let .invalidCheck(id):
            ".juno/verify.json has a check \"\(id)\" with no command."
        }
    }
}

/// The checks recorded for one project.
public struct VerifyRecipe: Hashable, Codable, Sendable {
    public static let currentVersion = 1
    /// Where the recipe lives, relative to the project root.
    public static let relativePath = ".juno/verify.json"

    public var version: Int
    public var checks: [VerifyCheck]
    public var ui: [VerifyUITarget]

    public init(version: Int = VerifyRecipe.currentVersion, checks: [VerifyCheck], ui: [VerifyUITarget] = []) {
        self.version = version
        self.checks = checks
        self.ui = ui
    }

    enum CodingKeys: String, CodingKey { case version, checks, ui }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? Self.currentVersion
        checks = try container.decodeIfPresent([VerifyCheck].self, forKey: .checks) ?? []
        ui = try container.decodeIfPresent([VerifyUITarget].self, forKey: .ui) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(checks, forKey: .checks)
        if !ui.isEmpty { try container.encode(ui, forKey: .ui) }
    }

    public var isEmpty: Bool { checks.isEmpty }

    /// Parses and validates the file's bytes.
    public static func decode(_ data: Data) throws -> VerifyRecipe {
        let recipe: VerifyRecipe
        do {
            recipe = try JSONDecoder().decode(VerifyRecipe.self, from: data)
        } catch let error as DecodingError {
            throw VerifyRecipeError.unreadable(Self.describe(error))
        }
        guard recipe.version == currentVersion else {
            throw VerifyRecipeError.unsupportedVersion(recipe.version)
        }
        var seen = Set<String>()
        for check in recipe.checks {
            guard seen.insert(check.id).inserted else { throw VerifyRecipeError.duplicateCheck(check.id) }
            guard !check.run.isEmpty, !check.id.trimmingCharacters(in: .whitespaces).isEmpty else {
                throw VerifyRecipeError.invalidCheck(check.id)
            }
        }
        return recipe
    }

    /// The bytes Juno writes: pretty, keys sorted, so a diff of the file in
    /// Changes reads well and the same recipe is always the same bytes.
    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(self)
        data.append(0x0A)
        return data
    }

    public func check(id: String) -> VerifyCheck? {
        checks.first { $0.id == id }
    }

    // MARK: - Choosing checks

    /// The checks a targeted run picks for `changedFiles`: for each file and
    /// kind, the checks that cover it most specifically, so a monorepo runs
    /// the affected package's checks rather than every package's. In recipe
    /// order.
    public func targetedChecks(for changedFiles: [String], kinds: Set<CheckKind>? = nil) -> [VerifyCheck] {
        let candidates = checks.filter { kinds?.contains($0.kind) ?? true }
        var chosen = Set<String>()
        for file in changedFiles {
            var bestByKind: [CheckKind: (Int, [String])] = [:]
            for check in candidates {
                guard let score = check.specificity(for: file) else { continue }
                if let (best, ids) = bestByKind[check.kind] {
                    if score > best {
                        bestByKind[check.kind] = (score, [check.id])
                    } else if score == best {
                        bestByKind[check.kind] = (best, ids + [check.id])
                    }
                } else {
                    bestByKind[check.kind] = (score, [check.id])
                }
            }
            for (_, ids) in bestByKind.values { chosen.formUnion(ids) }
        }
        return candidates.filter { chosen.contains($0.id) }
    }

    // MARK: - Recognising a check

    /// The check a command line is, when it is exactly one of this recipe's
    /// commands (or its targeted template filled in), run in that check's
    /// folder. `cd <folder> && <command>` counts as running it there.
    public func match(commandLine: String, workingDirectory: String? = nil) -> VerifyCheck? {
        var line = Self.normalize(commandLine)
        var directory = Self.normalizeFolder(workingDirectory)
        // `cd apps/web && npm test`
        if let (folder, rest) = Self.leadingDirectoryChange(line) {
            directory = Self.normalizeFolder(Self.join(directory, folder))
            line = rest
        }
        for check in checks where Self.normalizeFolder(check.cwd) == directory {
            if Self.normalize(check.commandLine) == line { return check }
            if let prefix = check.targetedPrefix.map(Self.normalize),
               line.hasPrefix(prefix + " "),
               Self.isPlainArgumentList(String(line.dropFirst(prefix.count + 1)))
            {
                return check
            }
        }
        return nil
    }

    /// Whether `command` is exactly a check of this recipe, wherever it runs.
    /// What lets `run_tests` follow the reader's rules for an accepted check.
    public func containsCommand(_ command: String) -> Bool {
        let line = Self.normalize(command)
        return checks.contains { Self.normalize($0.commandLine) == line }
    }

    // MARK: - Rules for "Run these without asking"

    /// The exact rules "Run these without asking in this repository" writes:
    /// one `Bash(<command>)` per command segment of each check, and one
    /// `Bash(<template prefix> *)` for a check with a targeted template. Never
    /// a rule for a line a pattern cannot vouch for (one that runs commands
    /// from inside itself), and never a bare `Bash`.
    public var permissionRules: [PermissionRule] {
        var rules: [PermissionRule] = []
        var seen = Set<PermissionRule>()
        func add(_ specifier: String) {
            let trimmed = specifier.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty,
                  PermissionRuleSet.patternsCanVouch(for: .command(trimmed))
            else { return }
            let rule = PermissionRule(tool: "Bash", specifier: trimmed)
            if seen.insert(rule).inserted { rules.append(rule) }
        }
        for check in checks {
            let line = check.commandLine
            guard PermissionRuleSet.patternsCanVouch(for: .command(line)) else { continue }
            for segment in ShellSegments.split(line) {
                add(segment)
            }
            if let prefix = check.targetedPrefix, PermissionRuleSet.patternsCanVouch(for: .command(prefix)) {
                let segments = ShellSegments.split(prefix)
                for segment in segments.dropLast() { add(segment) }
                if let last = segments.last { add(last + " *") }
            }
        }
        return rules
    }

    // MARK: - Helpers

    static func normalize(_ line: String) -> String {
        line.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0 == " " || $0 == "\t" })
            .joined(separator: " ")
    }

    static func normalizeFolder(_ folder: String?) -> String? {
        guard var folder = folder?.trimmingCharacters(in: .whitespaces), !folder.isEmpty else { return nil }
        while folder.hasPrefix("./") { folder.removeFirst(2) }
        while folder.hasSuffix("/") { folder.removeLast() }
        return folder.isEmpty || folder == "." ? nil : folder
    }

    private static func join(_ base: String?, _ folder: String) -> String {
        guard let base, !folder.hasPrefix("/") else { return folder }
        return base + "/" + folder
    }

    /// `cd <folder> && <rest>` split in two, for a plain folder name.
    static func leadingDirectoryChange(_ line: String) -> (String, String)? {
        guard line.hasPrefix("cd "), let range = line.range(of: " && ") else { return nil }
        let folder = line[line.index(line.startIndex, offsetBy: 3)..<range.lowerBound]
            .trimmingCharacters(in: .whitespaces)
        let rest = String(line[range.upperBound...])
        guard !folder.isEmpty, !folder.contains(" "), !folder.contains(".."), !folder.hasPrefix("/"),
              !folder.hasPrefix("~")
        else { return nil }
        return (folder, rest)
    }

    /// Arguments only: no operator, redirection or substitution that would
    /// make the line something more than the template's command.
    static func isPlainArgumentList(_ text: String) -> Bool {
        let forbidden = CharacterSet(charactersIn: ";&|<>`$()\n")
        return !text.isEmpty && text.unicodeScalars.allSatisfy { !forbidden.contains($0) }
    }

    private static func describe(_ error: DecodingError) -> String {
        switch error {
        case let .dataCorrupted(context):
            return context.debugDescription
        case let .keyNotFound(key, _):
            return "missing \"\(key.stringValue)\""
        case let .typeMismatch(_, context), let .valueNotFound(_, context):
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return path.isEmpty ? context.debugDescription : "\(path): \(context.debugDescription)"
        @unknown default:
            return "invalid JSON"
        }
    }
}

// MARK: - Shell quoting

/// POSIX single-quote quoting for one word, leaving plain words as they are.
public enum ShellQuoting {
    public static func quote(_ word: String) -> String {
        guard !word.isEmpty else { return "''" }
        let plain = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@%+=:,./-")
        if word.unicodeScalars.allSatisfy({ plain.contains($0) }) { return word }
        return "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

// MARK: - Mapping sources to tests

/// Finds the test files that go with changed source files, by the naming
/// conventions the common runners use. A changed test file maps to itself.
public enum TestFileMapping {
    public static func isTestFile(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        let lower = name.lowercased()
        if lower.contains(".test.") || lower.contains(".spec.") { return true }
        if lower.hasSuffix("_test.go") || lower.hasSuffix("_test.py") || lower.hasPrefix("test_") && lower.hasSuffix(".py") {
            return true
        }
        if name.hasSuffix("Tests.swift") || name.hasSuffix("Test.swift") { return true }
        if lower.hasSuffix("_spec.rb") || lower.hasSuffix("_test.rb") { return true }
        return path.split(separator: "/").contains("__tests__")
    }

    /// The tests for `files`, each once, in order.
    public static func tests(for files: [String], fileExists: (String) -> Bool) -> [String] {
        var result: [String] = []
        var seen = Set<String>()
        for file in files {
            let candidates = isTestFile(file) ? [file] : candidatesFor(file)
            for candidate in candidates where fileExists(candidate) && seen.insert(candidate).inserted {
                result.append(candidate)
            }
        }
        return result
    }

    static func candidatesFor(_ file: String) -> [String] {
        let ns = file as NSString
        let directory = ns.deletingLastPathComponent
        let fileName = ns.lastPathComponent
        let ext = (fileName as NSString).pathExtension
        let stem = (fileName as NSString).deletingPathExtension
        func path(_ name: String, in folder: String? = nil) -> String {
            let base = folder ?? directory
            return base.isEmpty ? name : base + "/" + name
        }
        var candidates: [String] = []
        switch ext {
        case "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte":
            let testExtensions = ext == "vue" || ext == "svelte" ? ["ts", "js"] : [ext]
            for testExt in testExtensions {
                for infix in ["test", "spec"] {
                    candidates.append(path("\(stem).\(infix).\(testExt)"))
                    candidates.append(path("\(stem).\(infix).\(testExt)", in: path("__tests__")))
                }
            }
        case "go":
            candidates.append(path("\(stem)_test.go"))
        case "py":
            candidates.append(path("test_\(stem).py"))
            candidates.append(path("\(stem)_test.py"))
            candidates.append(path("test_\(stem).py", in: path("tests")))
            candidates.append("tests/test_\(stem).py")
        case "rb":
            candidates.append(path("\(stem)_spec.rb"))
            candidates.append("spec/\(stem)_spec.rb")
            candidates.append("test/\(stem)_test.rb")
        case "swift":
            // Sources/Module/Thing.swift → Tests/ModuleTests/ThingTests.swift
            let parts = file.split(separator: "/").map(String.init)
            if let sources = parts.firstIndex(of: "Sources"), sources + 1 < parts.count {
                let root = parts[..<sources].joined(separator: "/")
                let module = parts[sources + 1]
                let tests = (root.isEmpty ? "" : root + "/") + "Tests/\(module)Tests/\(stem)Tests.swift"
                candidates.append(tests)
            }
        default:
            break
        }
        return candidates
    }
}

// MARK: - Where a session's recipe comes from

/// The project's recipe as the runtime may use it.
public enum VerifyRecipeStatus: Hashable, Sendable {
    /// `.juno/verify.json` exists and the reader accepted these exact bytes.
    case accepted(VerifyRecipe)
    /// There is no `.juno/verify.json`; these are the checks Juno's own
    /// discovery found (possibly none). Usable, each command still asking
    /// as any command does, and offered to the reader to keep.
    case discovered(VerifyRecipe)
    /// `.juno/verify.json` exists but these bytes were never accepted, or
    /// changed since: its commands are not offered to the model until the
    /// reader accepts them.
    case awaitingAcceptance(VerifyRecipe)
    /// `.juno/verify.json` exists and cannot be read.
    case invalid(String)

    /// The checks the runtime may offer and run now.
    public var usableRecipe: VerifyRecipe? {
        switch self {
        case let .accepted(recipe), let .discovered(recipe): recipe
        case .awaitingAcceptance, .invalid: nil
        }
    }

    public var isAccepted: Bool {
        if case .accepted = self { return true }
        return false
    }
}

/// Reads a project's recipe for the runtime. Implemented over the file, the
/// reader's acceptances and discovery in JunoCodeLocal (`VerifyRecipeStore`).
public protocol VerifyRecipeProviding: Sendable {
    /// The recipe and whether it may be used, running discovery when there is
    /// no file.
    func status() async -> VerifyRecipeStatus
    /// The accepted recipe only, read without discovery: cheap enough for a
    /// permission decision.
    func acceptedRecipe() -> VerifyRecipe?
}
