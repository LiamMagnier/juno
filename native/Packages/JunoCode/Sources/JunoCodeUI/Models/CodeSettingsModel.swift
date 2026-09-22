import Foundation
import Observation
import JunoCodeCore
import JunoCodeLocal

/// Which settings file an edit goes to.
public enum CodeSettingsScope: String, CaseIterable, Identifiable, Sendable {
    /// `~/.juno/settings.json` — every project on this Mac.
    case user
    /// `<project>/.juno/settings.json` — shared with the team through Git.
    case project
    /// `<project>/.juno/settings.local.json` — this project, this Mac only.
    case local

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .user: "All projects"
        case .project: "Project (shared)"
        case .local: "Project (only me)"
        }
    }

    public var detail: String {
        switch self {
        case .user: "~/.juno/settings.json"
        case .project: ".juno/settings.json · checked in"
        case .local: ".juno/settings.local.json · kept out of Git"
        }
    }

    var storeScope: CodeSettingsStore.Scope {
        switch self {
        case .user: .user
        case .project: .project
        case .local: .local
        }
    }
}

/// The settings files, as the Settings window edits them.
///
/// The files are the source of truth — a reader may edit them in their own
/// editor, and a team checks one in — so this model holds a copy, writes
/// through on every change, and reloads when the window comes forward.
@MainActor
@Observable
public final class CodeSettingsModel {
    public static let shared = CodeSettingsModel()

    private let store: CodeSettingsStore

    public private(set) var user = CodeSettingsFile()
    public private(set) var project = CodeSettingsFile()
    public private(set) var local = CodeSettingsFile()
    /// The project whose files the project scopes edit, or nil for none.
    public private(set) var projectRoot: URL?
    public private(set) var resolved = ResolvedCodeSettings.defaults
    /// Files that exist but could not be read, or writes that failed.
    public private(set) var problems: [String] = []
    /// `~/.juno/JUNO.md`, the reader's instructions for every project.
    public private(set) var personalInstructions = ""
    /// Project files that ask for more than the reader has approved, and so
    /// apply only where they narrow the agent.
    public private(set) var awaitingApproval: Set<CodeSettingsScope> = []

    public init(store: CodeSettingsStore = CodeSettingsStore()) {
        self.store = store
        reload()
    }

    public func selectProject(_ root: URL?) {
        guard root != projectRoot else { return }
        projectRoot = root
        reload()
    }

    public func reload() {
        user = store.load(.user, projectRoot: nil)
        project = projectRoot.map { store.load(.project, projectRoot: $0) } ?? CodeSettingsFile()
        local = projectRoot.map { store.load(.local, projectRoot: $0) } ?? CodeSettingsFile()
        resolved = store.resolved(projectRoot: projectRoot)
        personalInstructions = (try? String(contentsOf: store.userInstructionsURL(), encoding: .utf8)) ?? ""
        problems = CodeSettingsStore.Scope.allCases.compactMap {
            store.loadError($0, projectRoot: projectRoot)
        }
        awaitingApproval = Set(
            store.awaitingApproval(projectRoot: projectRoot).map { scope -> CodeSettingsScope in
                switch scope {
                case .user: .user
                case .project: .project
                case .local: .local
                }
            }
        )
    }

    /// Puts a project file in force as it now reads: its allow rules,
    /// environment, folders and network access. Any later change to the file
    /// withdraws this.
    public func approve(_ scope: CodeSettingsScope) {
        guard let projectRoot, scope != .user else { return }
        do {
            try store.approve(scope.storeScope, projectRoot: projectRoot)
        } catch {
            problems.append("Could not approve \(scope.detail): \(error.localizedDescription)")
            return
        }
        reload()
    }

    public func file(_ scope: CodeSettingsScope) -> CodeSettingsFile {
        switch scope {
        case .user: user
        case .project: project
        case .local: local
        }
    }

    public func url(_ scope: CodeSettingsScope) -> URL? {
        store.url(for: scope.storeScope, projectRoot: projectRoot)
    }

    public var personalInstructionsURL: URL { store.userInstructionsURL() }

    /// The scope's file, created empty through the store if there is none, so
    /// a new personal file is kept out of Git before the reader fills it in.
    public func fileForEditing(_ scope: CodeSettingsScope) -> URL? {
        guard isAvailable(scope) else { return nil }
        do {
            let url = try store.createIfMissing(scope.storeScope, projectRoot: projectRoot)
            reload()
            return url
        } catch {
            problems.append("Could not create \(scope.detail): \(error.localizedDescription)")
            return nil
        }
    }

    /// Whether a scope can be edited right now: the project ones need a project.
    public func isAvailable(_ scope: CodeSettingsScope) -> Bool {
        scope == .user || projectRoot != nil
    }

    /// Whether the window may write to a scope's file: it needs a project,
    /// and a file that exists but cannot be read is left for the reader to
    /// fix, because writing the window's empty copy of it would replace it.
    public func canEdit(_ scope: CodeSettingsScope) -> Bool {
        isAvailable(scope) && store.loadError(scope.storeScope, projectRoot: projectRoot) == nil
    }

    public func update(_ scope: CodeSettingsScope, _ change: (inout CodeSettingsFile) -> Void) {
        guard isAvailable(scope) else { return }
        var failure: String?
        do {
            try store.update(scope.storeScope, projectRoot: projectRoot, change)
        } catch {
            failure = "Could not save \(scope.detail): \(error.localizedDescription)"
        }
        // Reloaded first: reloading rebuilds `problems`, which used to wipe the
        // failure a moment after it was reported.
        reload()
        if let failure { problems.append(failure) }
    }

    public func savePersonalInstructions(_ text: String) {
        let url = store.userInstructionsURL()
        var failure: String?
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            failure = "Could not save JUNO.md: \(error.localizedDescription)"
        }
        reload()
        if let failure { problems.append(failure) }
    }

    // MARK: - Permission rules

    public enum RuleList: String, CaseIterable, Identifiable, Sendable {
        case allow, ask, deny
        public var id: String { rawValue }
    }

    public func rules(_ list: RuleList, in scope: CodeSettingsScope) -> [PermissionRule] {
        let permissions = file(scope).permissions
        switch list {
        case .allow: return permissions?.allow ?? []
        case .ask: return permissions?.ask ?? []
        case .deny: return permissions?.deny ?? []
        }
    }

    /// Adds a rule from its text; answers false for text that is not a rule.
    @discardableResult
    public func addRule(_ text: String, to list: RuleList, in scope: CodeSettingsScope) -> Bool {
        guard let rule = PermissionRule(parsing: text) else { return false }
        update(scope) { file in
            var permissions = file.permissions ?? CodeSettingsFile.Permissions()
            switch list {
            case .allow: permissions.allow = Self.appending(rule, to: permissions.allow)
            case .ask: permissions.ask = Self.appending(rule, to: permissions.ask)
            case .deny: permissions.deny = Self.appending(rule, to: permissions.deny)
            }
            file.permissions = permissions
        }
        return true
    }

    public func removeRule(_ rule: PermissionRule, from list: RuleList, in scope: CodeSettingsScope) {
        update(scope) { file in
            guard var permissions = file.permissions else { return }
            switch list {
            case .allow: permissions.allow?.removeAll { $0 == rule }
            case .ask: permissions.ask?.removeAll { $0 == rule }
            case .deny: permissions.deny?.removeAll { $0 == rule }
            }
            file.permissions = permissions
        }
    }

    private static func appending(_ rule: PermissionRule, to rules: [PermissionRule]?) -> [PermissionRule] {
        var rules = rules ?? []
        if !rules.contains(rule) { rules.append(rule) }
        return rules
    }

    // MARK: - Reads other surfaces need

    /// The most a task started from another device may do in the project at
    /// `path` — the settings' ceiling for that project, or the default.
    public nonisolated static func remoteCeiling(forProjectAt path: String?) -> PermissionMode {
        let root = path.map { URL(fileURLWithPath: $0, isDirectory: true) }
        return CodeSettingsStore().resolved(projectRoot: root).remoteCeiling
    }

    /// Saves an "Always allow" answer where the store says it belongs: this
    /// project's personal file, or the reader's own for screen input.
    public nonisolated static func rememberAllowRule(_ rule: PermissionRule, projectRoot: URL?) throws {
        try CodeSettingsStore().rememberAllowRule(rule, projectRoot: projectRoot)
    }
}
