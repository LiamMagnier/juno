import Foundation
import JunoCodeCore

// The project's verify recipe on disk and the reader's acceptance of it
// (CODE_AGENT_SPEC §1.8, D-019).
//
// `.juno/verify.json` is checked in and reviewable. The reader accepts its
// exact bytes once, from the recipe card; the digest is kept outside the
// project, so a later edit by anyone (a teammate, a pull, the agent itself)
// asks again before the new commands reach the model. Accepting never grants
// a permission by itself. Only the card's second, separately ticked option,
// "Run these without asking in this repository", writes rules, and only the
// exact `Bash(...)` rules the recipe lists, to the personal
// `.juno/settings.local.json`, where `/permissions` shows them.

/// The reader's acceptances, one small file per project, kept outside every
/// project (the pattern `CodeSettingsApprovalStore` uses).
public struct VerifyRecipeApprovalStore: Sendable {
    private struct Payload: Codable, Sendable {
        var sha256: String
        var acceptedAt: Date
    }

    public let directory: URL

    public init(directory: URL = VerifyRecipeApprovalStore.defaultDirectory) {
        self.directory = directory
    }

    public static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("JunoCode", isDirectory: true)
            .appendingPathComponent("verify-approvals", isDirectory: true)
    }

    /// The digest of the recipe bytes the reader accepted for this project.
    public func acceptedDigest(projectRoot: URL) -> String? {
        guard let data = try? Data(contentsOf: fileURL(projectRoot)) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(Payload.self, from: data))?.sha256
    }

    public func setAcceptedDigest(_ digest: String?, projectRoot: URL, at date: Date = Date()) throws {
        let url = fileURL(projectRoot)
        guard let digest else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(Payload(sha256: digest, acceptedAt: date)).write(to: url, options: .atomic)
    }

    private func fileURL(_ projectRoot: URL) -> URL {
        let canonical = projectRoot.resolvingSymlinksInPath().standardizedFileURL.path
        return directory.appendingPathComponent(Digests.sha256Hex(canonical) + ".json")
    }
}

/// What `.juno/verify.json` holds, as one read found it.
public enum VerifyRecipeFile: Equatable, Sendable {
    case missing
    case present(VerifyRecipe, digest: String, accepted: Bool)
    case invalid(String, digest: String)
}

/// What accepting the card did.
public struct VerifyRecipeAcceptance: Equatable, Sendable {
    /// Whether `.juno/verify.json` was written (it is a change in the
    /// workspace, shown in Changes).
    public var wroteRecipe: Bool
    /// The rules added to `.juno/settings.local.json`; empty unless the reader
    /// ticked "Run these without asking".
    public var rulesAdded: [PermissionRule]
}

public struct VerifyRecipeStore: VerifyRecipeProviding {
    public let workspaceRoot: URL
    public let approvals: VerifyRecipeApprovalStore
    public let settings: CodeSettingsStore
    private let discovery: VerifyRecipeDiscovery

    public init(
        workspaceRoot: URL,
        approvals: VerifyRecipeApprovalStore = VerifyRecipeApprovalStore(),
        settings: CodeSettingsStore = CodeSettingsStore(),
        discovery: VerifyRecipeDiscovery? = nil
    ) {
        self.workspaceRoot = workspaceRoot
        self.approvals = approvals
        self.settings = settings
        self.discovery = discovery ?? VerifyRecipeDiscovery(workspaceRoot: workspaceRoot)
    }

    public var recipeURL: URL {
        workspaceRoot.appendingPathComponent(VerifyRecipe.relativePath)
    }

    /// One read of the file and its acceptance.
    public func file() -> VerifyRecipeFile {
        guard let data = try? Data(contentsOf: recipeURL) else { return .missing }
        let digest = Digests.sha256Hex(data)
        do {
            let recipe = try VerifyRecipe.decode(data)
            return .present(recipe, digest: digest, accepted: approvals.acceptedDigest(projectRoot: workspaceRoot) == digest)
        } catch {
            return .invalid(String(describing: error), digest: digest)
        }
    }

    // MARK: - VerifyRecipeProviding

    public func status() async -> VerifyRecipeStatus {
        switch file() {
        case .missing:
            return .discovered(await discovery.discover())
        case let .present(recipe, _, accepted):
            return accepted ? .accepted(recipe) : .awaitingAcceptance(recipe)
        case let .invalid(message, _):
            return .invalid(message)
        }
    }

    public func acceptedRecipe() -> VerifyRecipe? {
        if case let .present(recipe, _, true) = file() { return recipe }
        return nil
    }

    /// What discovery finds now, whatever the file says.
    public func discover() async -> VerifyRecipe {
        await discovery.discover()
    }

    // MARK: - Accepting

    /// "Use these checks": writes `recipe` as `.juno/verify.json` (unless the
    /// file already holds exactly these bytes), records the bytes as
    /// accepted, and, only when `runWithoutAsking`, adds the recipe's exact
    /// rules to the personal settings file. Nothing is written to a shared
    /// project file but the recipe itself.
    @discardableResult
    public func accept(_ recipe: VerifyRecipe, runWithoutAsking: Bool) throws -> VerifyRecipeAcceptance {
        let data = try recipe.encoded()
        var wrote = false
        if (try? Data(contentsOf: recipeURL)) != data {
            try FileManager.default.createDirectory(
                at: recipeURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: recipeURL, options: .atomic)
            wrote = true
        }
        try approvals.setAcceptedDigest(Digests.sha256Hex(data), projectRoot: workspaceRoot)
        let rules = runWithoutAsking ? try addRules(recipe.permissionRules) : []
        return VerifyRecipeAcceptance(wroteRecipe: wrote, rulesAdded: rules)
    }

    /// Accepts the file as it is, when it still has the bytes the reader was
    /// shown. Answers nil, accepting nothing, when it changed in between.
    @discardableResult
    public func acceptExisting(expectedDigest: String, runWithoutAsking: Bool) throws -> VerifyRecipeAcceptance? {
        guard case let .present(recipe, digest, _) = file(), digest == expectedDigest else { return nil }
        try approvals.setAcceptedDigest(digest, projectRoot: workspaceRoot)
        let rules = runWithoutAsking ? try addRules(recipe.permissionRules) : []
        return VerifyRecipeAcceptance(wroteRecipe: false, rulesAdded: rules)
    }

    /// Adds `rules` to `.juno/settings.local.json` in one edit, keeping
    /// everything else in the file; answers the ones that were new.
    private func addRules(_ rules: [PermissionRule]) throws -> [PermissionRule] {
        guard !rules.isEmpty else { return [] }
        var added: [PermissionRule] = []
        try settings.update(.local, projectRoot: workspaceRoot) { file in
            var permissions = file.permissions ?? CodeSettingsFile.Permissions()
            var allow = permissions.allow ?? []
            for rule in rules where !allow.contains(rule) {
                allow.append(rule)
                added.append(rule)
            }
            permissions.allow = allow
            file.permissions = permissions
        }
        return added
    }
}
