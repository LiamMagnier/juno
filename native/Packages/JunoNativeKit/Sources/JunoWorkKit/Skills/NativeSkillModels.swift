import Foundation
import JunoCore

// MARK: - The library

/// One skill as the library lists it (`LibrarySkill`: the wire skill plus
/// where it lives and whether it waits for approval).
public struct NativeSkill: Identifiable, Equatable, Sendable {
    public let id: String
    public var projectID: String?
    /// The slash name, lowercase words joined by hyphens.
    public let slug: String
    public var name: String
    public var description: String
    public var currentVersion: Int
    /// The skill's own switch.
    public var enabled: Bool
    /// `untrusted`, `user_authored` or `verified`; unknown reads as untrusted.
    public var trust: String
    public var autoSelect: Bool
    /// `clear`, `warning`, `blocked`, `pending`, …
    public var securityStatus: String
    public let createdAt: Date?
    public var updatedAt: Date?
    /// The source it was installed from; nil for a skill you wrote.
    public var sourceID: String?
    /// Its `SKILL.md` path inside that source.
    public var sourcePath: String?
    /// The current version asks for more than the last and waits for approval.
    public var requiresConsent: Bool

    public init(
        id: String,
        projectID: String? = nil,
        slug: String,
        name: String,
        description: String = "",
        currentVersion: Int = 1,
        enabled: Bool = true,
        trust: String = "user_authored",
        autoSelect: Bool = false,
        securityStatus: String = "clear",
        createdAt: Date? = nil,
        updatedAt: Date? = nil,
        sourceID: String? = nil,
        sourcePath: String? = nil,
        requiresConsent: Bool = false
    ) {
        self.id = id
        self.projectID = projectID
        self.slug = slug
        self.name = name
        self.description = description
        self.currentVersion = currentVersion
        self.enabled = enabled
        self.trust = trust
        self.autoSelect = autoSelect
        self.securityStatus = securityStatus
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.sourceID = sourceID
        self.sourcePath = sourcePath
        self.requiresConsent = requiresConsent
    }

    public var isBlocked: Bool { securityStatus == "blocked" }

    /// The one fact about a skill worth a mark on its row: blocked outranks
    /// consent, because approving a blocked version would not make it run.
    public var attention: NativeSkillAttention? {
        if isBlocked { return .blocked }
        if requiresConsent { return .consent }
        return nil
    }
}

public enum NativeSkillAttention: Sendable, Equatable {
    case blocked
    case consent

    /// The row's words (`ATTENTION_COPY`).
    public var sentence: String {
        switch self {
        case .blocked: "Blocked by Juno’s safety check"
        case .consent: "Needs your approval before it can run"
        }
    }
}

/// A repository a group of skills was installed from.
public struct NativeSkillSource: Identifiable, Equatable, Sendable {
    public let id: String
    public let owner: String
    public let repo: String
    /// `github:owner/repo`, lower-cased.
    public let key: String
    public let ref: String
    /// The folder the import was scoped to; empty is the whole repository.
    public let path: String
    public var commit: String
    public var latestCommit: String?
    /// The source's own switch; off hides every skill in it without touching
    /// theirs.
    public var enabled: Bool
    public let url: String
    public var skills: [NativeSkill]

    public init(
        id: String,
        owner: String,
        repo: String,
        key: String? = nil,
        ref: String = "main",
        path: String = "",
        commit: String = "",
        latestCommit: String? = nil,
        enabled: Bool = true,
        url: String? = nil,
        skills: [NativeSkill] = []
    ) {
        self.id = id
        self.owner = owner
        self.repo = repo
        self.key = key ?? "github:\(owner.lowercased())/\(repo.lowercased())"
        self.ref = ref
        self.path = path
        self.commit = commit
        self.latestCommit = latestCommit
        self.enabled = enabled
        self.url = url ?? "https://github.com/\(owner)/\(repo)"
        self.skills = skills
    }

    /// "anthropics/skills", or with the scoped folder.
    public var label: String {
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return trimmed.isEmpty ? "\(owner)/\(repo)" : "\(owner)/\(repo)/\(trimmed)"
    }

    /// The last check saw a different, newer commit.
    public var hasUpdate: Bool {
        guard let latestCommit, !latestCommit.isEmpty else { return false }
        return latestCommit != commit
    }

    /// Any skill in it is blocked or waits for approval.
    public var needsAttention: Bool { skills.contains { $0.attention != nil } }

    /// How many it brought, and how many are on by their own switch.
    public var counts: (total: Int, on: Int) { (skills.count, skills.filter(\.enabled).count) }
}

/// `GET /api/skills`.
public struct NativeSkillLibrary: Equatable, Sendable {
    /// Skills you wrote, captured from a run, or made before sources existed.
    public var yours: [NativeSkill]
    public var sources: [NativeSkillSource]
    /// Every skill counted, so a capped response can say so.
    public var total: Int
    public var truncated: Bool

    public init(yours: [NativeSkill], sources: [NativeSkillSource], total: Int? = nil, truncated: Bool = false) {
        self.yours = yours
        self.sources = sources
        self.total = total ?? (yours.count + sources.reduce(0) { $0 + $1.skills.count })
        self.truncated = truncated
    }

    public static let empty = NativeSkillLibrary(yours: [], sources: [])

    /// How many the response actually listed, for "Showing n of m".
    public var listedCount: Int { yours.count + sources.reduce(0) { $0 + $1.skills.count } }

    public var isEmpty: Bool { yours.isEmpty && sources.isEmpty }
}

/// A skill the composer can offer — its "Use a Skill" menu and a typed
/// `/slug` (Track A wires both to `skillSlug` on `/api/chat`).
public struct NativeSkillChoice: Identifiable, Equatable, Sendable {
    public let slug: String
    public let name: String
    public let description: String
    /// Always true for a choice ``NativeSkillLibraryModel/chooseable`` hands
    /// out; carried so a caller holding an older list can tell.
    public let enabled: Bool
    /// "owner/repo" for an installed skill; nil for one of yours.
    public let sourceLabel: String?
    /// The repository's owner, for its avatar.
    public let sourceOwner: String?

    public var id: String { slug }
    /// A skill written here rather than installed.
    public var isYours: Bool { sourceLabel == nil }

    public init(
        slug: String,
        name: String,
        description: String,
        enabled: Bool = true,
        sourceLabel: String? = nil,
        sourceOwner: String? = nil
    ) {
        self.slug = slug
        self.name = name
        self.description = description
        self.enabled = enabled
        self.sourceLabel = sourceLabel
        self.sourceOwner = sourceOwner
    }
}

// MARK: - One skill

public struct NativeSkillResource: Identifiable, Equatable, Sendable {
    public let attachmentID: String
    public let fileName: String
    public var id: String { attachmentID }

    public init(attachmentID: String, fileName: String) {
        self.attachmentID = attachmentID
        self.fileName = fileName
    }
}

/// One immutable version of a skill's instructions.
public struct NativeSkillVersion: Identifiable, Equatable, Sendable {
    public let id: String
    public let version: Int
    public let instructions: String
    /// The declaration as sent: a new version has to send it back whole, or
    /// the route fills what is missing with nothing.
    public let contract: JunoJSONValue
    public let requestedTools: [String]
    public let securityStatus: String
    /// The scanner's findings, in its words.
    public let findings: [String]
    public let requiresConsent: Bool
    public let createdAt: Date?

    public init(
        id: String,
        version: Int,
        instructions: String,
        contract: JunoJSONValue = .object([:]),
        requestedTools: [String] = [],
        securityStatus: String = "clear",
        findings: [String] = [],
        requiresConsent: Bool = false,
        createdAt: Date? = nil
    ) {
        self.id = id
        self.version = version
        self.instructions = instructions
        self.contract = contract
        self.requestedTools = requestedTools
        self.securityStatus = securityStatus
        self.findings = findings
        self.requiresConsent = requiresConsent
        self.createdAt = createdAt
    }

    /// Files the version names (`contract.resourceAttachmentIds`).
    public var declaredResourceIDs: [String] {
        guard case .object(let object) = contract, case .array(let ids)? = object["resourceAttachmentIds"] else {
            return []
        }
        return ids.compactMap(\.stringValue)
    }

    /// Where it came from (`contract.provenance`), for an installed skill.
    public var provenance: NativeSkillProvenance? {
        guard case .object(let object) = contract, case .object(let record)? = object["provenance"] else {
            return nil
        }
        func read(_ key: String) -> String? {
            guard let value = record[key]?.stringValue, !value.isEmpty else { return nil }
            return value
        }
        guard read("source.kind") == "github", let owner = read("source.owner"), let repo = read("source.repo")
        else { return nil }
        let url = read("source.url").flatMap { $0.hasPrefix("https://github.com/") ? $0 : nil }
        return NativeSkillProvenance(
            owner: owner, repo: repo, ref: read("source.ref"), commit: read("source.commit"),
            path: read("source.path"), url: url
        )
    }
}

public struct NativeSkillProvenance: Equatable, Sendable {
    public let owner: String
    public let repo: String
    public let ref: String?
    public let commit: String?
    public let path: String?
    /// The `SKILL.md` at the commit it was read at, on GitHub only.
    public let url: String?
}

/// `GET /api/work/skills/{id}`.
public struct NativeSkillDetail: Equatable, Sendable {
    public var skill: NativeSkill
    public var version: NativeSkillVersion?
    public var resources: [NativeSkillResource]
    public var projectName: String?
    public var source: NativeSkillSource?

    public init(
        skill: NativeSkill,
        version: NativeSkillVersion?,
        resources: [NativeSkillResource] = [],
        projectName: String? = nil,
        source: NativeSkillSource? = nil
    ) {
        self.skill = skill
        self.version = version
        self.resources = resources
        self.projectName = projectName
        self.source = source
    }

    /// Files the version names that are no longer in the library.
    public var missingResourceCount: Int {
        max(0, Set(version?.declaredResourceIDs ?? []).count - resources.count)
    }
}

// MARK: - Importing and updating

public struct NativeSkillImportCandidate: Identifiable, Equatable, Sendable {
    public let path: String
    public let slug: String
    public let name: String
    public let description: String
    public let license: String?
    public let compatibility: String?
    public let requestedTools: [String]
    public let droppedTools: [String]
    public let companionFiles: [String]
    public let url: String
    public let installed: Bool
    public let slugTaken: Bool
    public let suggestedSlug: String?
    public let securityStatus: String?

    public var id: String { path }

    public init(
        path: String,
        slug: String,
        name: String,
        description: String = "",
        license: String? = nil,
        compatibility: String? = nil,
        requestedTools: [String] = [],
        droppedTools: [String] = [],
        companionFiles: [String] = [],
        url: String = "",
        installed: Bool = false,
        slugTaken: Bool = false,
        suggestedSlug: String? = nil,
        securityStatus: String? = nil
    ) {
        self.path = path
        self.slug = slug
        self.name = name
        self.description = description
        self.license = license
        self.compatibility = compatibility
        self.requestedTools = requestedTools
        self.droppedTools = droppedTools
        self.companionFiles = companionFiles
        self.url = url
        self.installed = installed
        self.slugTaken = slugTaken
        self.suggestedSlug = suggestedSlug
        self.securityStatus = securityStatus
    }
}

public struct NativeSkillImportProblem: Equatable, Sendable {
    public let path: String
    public let message: String

    public init(path: String, message: String) {
        self.path = path
        self.message = message
    }
}

public struct NativeSkillImportPreview: Equatable, Sendable {
    public struct Repository: Equatable, Sendable {
        public let owner: String
        public let repo: String
        public let ref: String
        public let commit: String
        public let url: String

        public init(owner: String, repo: String, ref: String, commit: String, url: String) {
            self.owner = owner
            self.repo = repo
            self.ref = ref
            self.commit = commit
            self.url = url
        }
    }

    public let repository: Repository
    public let skills: [NativeSkillImportCandidate]
    public let problems: [NativeSkillImportProblem]
    /// The walk stopped before the end of the repository.
    public let more: Bool
    /// Every `SKILL.md` in scope, read or not; nil from an older server.
    public let total: Int?

    public init(
        repository: Repository,
        skills: [NativeSkillImportCandidate],
        problems: [NativeSkillImportProblem] = [],
        more: Bool = false,
        total: Int? = nil
    ) {
        self.repository = repository
        self.skills = skills
        self.problems = problems
        self.more = more
        self.total = total
    }

    /// What starts ticked: everything installable except what the scan
    /// blocked.
    public var defaultChoice: Set<String> {
        Set(skills.filter { !$0.installed && $0.securityStatus != "blocked" }.map(\.path))
    }

    /// A new slash name for each row whose own is taken, prefilled with the
    /// server's suggestion.
    public var defaultRenames: [String: String] {
        Dictionary(uniqueKeysWithValues: skills
            .filter { $0.slugTaken && !$0.installed }
            .map { ($0.path, $0.suggestedSlug ?? "\(repository.repo)-\($0.slug)".lowercased()) })
    }
}

public struct NativeSkillImportOutcome: Equatable, Sendable {
    public struct Skipped: Equatable, Sendable {
        public let path: String
        public let message: String

        public init(path: String, message: String) {
            self.path = path
            self.message = message
        }
    }

    public let importedCount: Int
    public let skipped: [Skipped]
    /// How many landed switched off because the scanner refused them.
    public let blocked: Int
    public let source: NativeSkillSource?

    public init(importedCount: Int, skipped: [Skipped] = [], blocked: Int = 0, source: NativeSkillSource? = nil) {
        self.importedCount = importedCount
        self.skipped = skipped
        self.blocked = blocked
        self.source = source
    }
}

public struct NativeSkillSourceChange: Identifiable, Equatable, Sendable {
    public let path: String
    public let name: String
    public let description: String
    public let skillID: String?
    public let widensPermissions: Bool

    public var id: String { path }

    public init(path: String, name: String, description: String = "", skillID: String? = nil, widensPermissions: Bool = false) {
        self.path = path
        self.name = name
        self.description = description
        self.skillID = skillID
        self.widensPermissions = widensPermissions
    }
}

/// `POST /api/skills/sources/{id}/check`.
public struct NativeSkillSourceCheck: Equatable, Sendable {
    public let latestCommit: String
    public let upToDate: Bool
    public let changed: [NativeSkillSourceChange]
    public let added: [NativeSkillSourceChange]
    public let removed: [NativeSkillSourceChange]
    public let more: Bool

    public init(
        latestCommit: String,
        upToDate: Bool,
        changed: [NativeSkillSourceChange] = [],
        added: [NativeSkillSourceChange] = [],
        removed: [NativeSkillSourceChange] = [],
        more: Bool = false
    ) {
        self.latestCommit = latestCommit
        self.upToDate = upToDate
        self.changed = changed
        self.added = added
        self.removed = removed
        self.more = more
    }

    /// Not the server's `upToDate`, which ignores skills new upstream.
    public var hasChoices: Bool { !changed.isEmpty || !added.isEmpty }
}

public struct NativeSkillSourceUpdateResult: Equatable, Sendable {
    public let updated: Int
    public let installed: Int
    /// Skip reasons as the route's codes (`up_to_date`, …).
    public let skipped: [String]
    public let source: NativeSkillSource?

    public init(updated: Int, installed: Int, skipped: [String] = [], source: NativeSkillSource? = nil) {
        self.updated = updated
        self.installed = installed
        self.skipped = skipped
        self.source = source
    }
}

// MARK: - Results

/// A skills request's answer, in the web's `WorkResult` split: a refusal the
/// server explained (409/429, with its sentence) against a failure the reader
/// can only retry.
public enum NativeSkillResult<Value: Sendable>: Sendable {
    case ok(Value)
    case blocked(reason: String, explanation: String)
    case failed(NativeSkillFailure, message: String?)

    public var value: Value? {
        if case .ok(let value) = self { return value }
        return nil
    }

    /// The sentence for a result that did not succeed (`skillsFailureMessage`):
    /// the server's words when it wrote some, one sentence per cause
    /// otherwise, and `fallback` for a plain server failure.
    public func message(fallback: String) -> String {
        switch self {
        case .ok:
            return fallback
        case .blocked(_, let explanation):
            return explanation
        case .failed(let cause, let message):
            if let message, !message.isEmpty { return message }
            switch cause {
            case .offline: return "Couldn’t reach Juno. Check your connection and try again."
            case .unauthorized: return "Your session has ended. Sign in again to continue."
            case .notFound, .rejected, .server: return fallback
            }
        }
    }
}

public enum NativeSkillFailure: Sendable, Equatable {
    case offline
    case unauthorized
    case notFound
    case rejected
    case server
}
