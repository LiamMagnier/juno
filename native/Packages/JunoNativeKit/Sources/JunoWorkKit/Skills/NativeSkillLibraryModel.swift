import Foundation
import JunoCore
import Observation

// MARK: - Pure rules

/// The skills library as the pages reason about it (`skill-library-model.ts`,
/// `library-contract.ts`, the slug rules in `lib/work/skills.ts`): pure
/// functions, so the list, the composer and the tests read one answer.
public enum NativeSkillRules {
    /// Repositories offered as one-press starting points.
    public static let popularSources: [(owner: String, repo: String)] = [
        ("anthropics", "skills"),
        ("openai", "skills"),
        ("vercel-labs", "agent-skills"),
    ]

    public static let maximumSlugLength = 64

    /// A commit as people read one.
    public static func shortCommit(_ sha: String?) -> String {
        String((sha ?? "").prefix(7))
    }

    /// Lowercase words joined by single hyphens, or nil (`normalizeSkillSlug`).
    public static func normalizeSlug(_ raw: String) -> String? {
        let slug = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !slug.isEmpty, slug.count <= maximumSlugLength, isSlug(slug) else { return nil }
        return slug
    }

    /// The slash name a display name makes (`skillSlugFromName`): everything
    /// outside `[a-z0-9]` becomes a separator, runs collapse, and a cut name
    /// does not end in a hyphen. Nil when nothing usable survives.
    public static func slug(fromName name: String) -> String? {
        var out = ""
        var pendingHyphen = false
        for scalar in name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().unicodeScalars {
            if (97...122).contains(scalar.value) || (48...57).contains(scalar.value) {
                if pendingHyphen, !out.isEmpty { out.append("-") }
                pendingHyphen = false
                out.unicodeScalars.append(scalar)
            } else {
                pendingHyphen = true
            }
        }
        guard !out.isEmpty else { return nil }
        var truncated = String(out.prefix(maximumSlugLength))
        while truncated.hasSuffix("-") { truncated.removeLast() }
        return truncated.isEmpty ? nil : truncated
    }

    static func isSlug(_ value: String) -> Bool {
        guard let first = value.first, let last = value.last, first != "-", last != "-" else { return false }
        var previousHyphen = false
        for character in value {
            if character == "-" {
                if previousHyphen { return false }
                previousHyphen = true
            } else if character.isASCII, character.isLowercase || character.isNumber {
                previousHyphen = false
            } else {
                return false
            }
        }
        return true
    }

    /// Only a trusted skill can be chosen automatically.
    public static func trustPermitsAutoSelection(_ trust: String) -> Bool {
        trust == "user_authored" || trust == "verified"
    }

    /// Whether chat and tasks may use a skill: its own switch and its
    /// source's.
    public static func isAvailable(_ skill: NativeSkill, source: NativeSkillSource?) -> Bool {
        skill.enabled && (skill.sourceID == nil || source == nil || source?.enabled == true)
    }

    /// The composer's list (`chatSkillsFromLibrary`): yours first, then each
    /// source in the library's order, keeping only what chat can use — a
    /// skill switched off, one whose source is off, one blocked, or one whose
    /// new version waits for approval would arm a pill and then be refused.
    /// Trust is not filtered on: this is the reader naming a skill.
    public static func chooseable(_ library: NativeSkillLibrary) -> [NativeSkillChoice] {
        let usable: (NativeSkill, NativeSkillSource?) -> Bool = { skill, source in
            isAvailable(skill, source: source) && !skill.requiresConsent && !skill.isBlocked
        }
        let yours = library.yours
            .filter { usable($0, nil) }
            .map { NativeSkillChoice(slug: $0.slug, name: $0.name, description: $0.description) }
        let installed = library.sources.flatMap { source in
            source.skills
                .filter { usable($0, source) }
                .map {
                    NativeSkillChoice(
                        slug: $0.slug, name: $0.name, description: $0.description,
                        sourceLabel: source.label, sourceOwner: source.owner
                    )
                }
        }
        return yours + installed
    }

    /// A leading `/slug …` typed into the composer, when the slug names one
    /// of `choices` (`readSkillInvocation`): `/Users/liam` and `/usr/local`
    /// stay the sentences they are.
    public static func invocation(
        in draft: String,
        choices: [NativeSkillChoice]
    ) -> (choice: NativeSkillChoice, remainder: String)? {
        let trimmed = draft.drop { $0.isWhitespace }
        guard trimmed.first == "/" else { return nil }
        let body = trimmed.dropFirst()
        let slugEnd = body.firstIndex(where: \.isWhitespace) ?? body.endIndex
        let slug = String(body[..<slugEnd])
        guard isSlug(slug), slug.count <= maximumSlugLength,
            let choice = choices.first(where: { $0.slug == slug })
        else { return nil }
        return (choice, String(body[slugEnd...]).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The library after a search. A skill matches on its name, slash name or
    /// description; a source matches on `owner/repo` and keeps every child.
    public static func filter(_ library: NativeSkillLibrary, query raw: String) -> FilteredLibrary {
        let query = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else {
            return FilteredLibrary(
                yours: library.yours,
                sources: library.sources.map { ($0, $0.skills) },
                searching: false
            )
        }
        func matches(_ skill: NativeSkill) -> Bool {
            skill.name.lowercased().contains(query) || skill.slug.contains(query)
                || skill.description.lowercased().contains(query)
        }
        let yours = library.yours.filter(matches)
        let sources: [(NativeSkillSource, [NativeSkill])] = library.sources.compactMap { source in
            if source.label.lowercased().contains(query) { return (source, source.skills) }
            let skills = source.skills.filter(matches)
            return skills.isEmpty ? nil : (source, skills)
        }
        return FilteredLibrary(yours: yours, sources: sources, searching: true)
    }

    public struct FilteredLibrary {
        public let yours: [NativeSkill]
        public let sources: [(source: NativeSkillSource, skills: [NativeSkill])]
        public let searching: Bool
        public var isEmpty: Bool { yours.isEmpty && sources.isEmpty }
    }

    public enum RenameProblem: Sendable, Equatable {
        case invalid, taken, duplicate

        public var sentence: String {
            switch self {
            case .invalid: "Use lowercase letters, numbers and dashes."
            case .taken: "That name is taken. Choose another."
            case .duplicate: "Another skill in this list is using that name."
            }
        }
    }

    /// What is wrong with the slash names an import is about to send, per
    /// path (`renameProblems`).
    public static func renameProblems(
        _ skills: [NativeSkillImportCandidate],
        chosen: Set<String>,
        renames: [String: String]
    ) -> [String: RenameProblem] {
        let picked = skills.filter { chosen.contains($0.path) && !$0.installed }
        func finalSlug(_ skill: NativeSkillImportCandidate) -> String? {
            skill.slugTaken ? normalizeSlug(renames[skill.path] ?? "") : normalizeSlug(skill.slug)
        }
        var claims: [String: Int] = [:]
        for skill in picked {
            if let slug = finalSlug(skill) { claims[slug, default: 0] += 1 }
        }
        var problems: [String: RenameProblem] = [:]
        for skill in picked where skill.slugTaken {
            guard let slug = finalSlug(skill) else {
                problems[skill.path] = .invalid
                continue
            }
            if slug == normalizeSlug(skill.slug) {
                problems[skill.path] = .taken
            } else if (claims[slug] ?? 0) > 1 {
                problems[skill.path] = .duplicate
            }
        }
        return problems
    }

    /// The write behind the Usage choice (`skillUsagePatch`): "Automatically"
    /// trusts the skill in the same write; going back to "Only when I call it"
    /// returns an installed skill to untrusted.
    public static func usagePatch(automatic: Bool, skill: NativeSkill, isInstalled: Bool) -> NativeSkillPatch {
        if automatic { return NativeSkillPatch(autoSelect: true, trust: "user_authored") }
        if skill.trust == "user_authored", isInstalled {
            return NativeSkillPatch(autoSelect: false, trust: "untrusted")
        }
        return NativeSkillPatch(autoSelect: false)
    }

    /// Which Usage the stored pair describes.
    public static func isAutomatic(_ skill: NativeSkill) -> Bool {
        skill.autoSelect && trustPermitsAutoSelection(skill.trust)
    }

    /// The toast an update ends with (`updateOutcomeMessage`).
    public static func updateOutcome(
        _ result: NativeSkillSourceUpdateResult,
        from source: String
    ) -> (ok: Bool, title: String, detail: String?) {
        let plural: (Int) -> String = { $0 == 1 ? "skill" : "skills" }
        var counts: [(reason: String, count: Int)] = []
        for reason in result.skipped {
            if let index = counts.firstIndex(where: { $0.reason == reason }) {
                counts[index].count += 1
            } else {
                counts.append((reason, 1))
            }
        }
        let detail = counts.map { reason, count in
            "\(count) skipped because \(skipReason(reason, many: count > 1))."
        }
        .joined(separator: " ")
        let title: String
        if result.updated > 0, result.installed > 0 {
            title = "Updated \(result.updated) and installed \(result.installed) from \(source)"
        } else if result.updated > 0 {
            title = "Updated \(result.updated) \(plural(result.updated)) from \(source)"
        } else if result.installed > 0 {
            title = "Installed \(result.installed) \(plural(result.installed)) from \(source)"
        } else {
            title = "Nothing was updated."
        }
        return (result.updated + result.installed > 0, title, detail.isEmpty ? nil : detail)
    }

    static func skipReason(_ code: String, many: Bool) -> String {
        switch code {
        case "up_to_date": many ? "they were already up to date" : "it was already up to date"
        case "removed_upstream": many ? "they’re no longer in the repository" : "it’s no longer in the repository"
        case "unreadable": many ? "their SKILL.md files couldn’t be read" : "its SKILL.md couldn’t be read"
        case "not_installed": many ? "they aren’t installed from this repository" : "it isn’t installed from this repository"
        case "installed": many ? "they were already installed" : "it was already installed"
        case "invalid_slug":
            many ? "Juno couldn’t turn their names into slash names" : "Juno couldn’t turn its name into a slash name"
        case "slug_taken": many ? "their slash names were taken" : "its slash name was taken"
        case "version_conflict":
            many ? "they were being saved somewhere else at the same moment"
                : "it was being saved somewhere else at the same moment"
        default: many ? "Juno couldn’t apply them" : "Juno couldn’t apply it"
        }
    }
}

// MARK: - The model

/// The skills library, read once and kept in step with what the reader
/// switches (`useSkillLibrary`), and the one place the composer asks which
/// skills a message can run under (``chooseable``).
///
/// **Switches answer at once.** A toggle writes the new state before the
/// request and puts the old one back if the server refuses, with the server's
/// sentence; each row keeps a ticket so a slow answer to an earlier press can
/// never overwrite a later one.
///
/// **A failed read is said.** `failure` carries a sentence and `library`
/// stays nil, so the page draws a retry instead of an empty library.
///
/// Shared (``JunoDesktopConfiguration/skillLibraryModel`` on the Mac) and
/// platform-neutral, so iOS compiles it too.
@MainActor
@Observable
public final class NativeSkillLibraryModel {
    /// Nil until the first read lands.
    public private(set) var library: NativeSkillLibrary?
    /// The sentence for a failed read, or nil.
    public private(set) var failure: String?
    public private(set) var isLoading = false

    private let client: NativeSkillsClient
    private var accountID: AccountID?
    private var tickets: [String: Int] = [:]

    public init(client: NativeSkillsClient) {
        self.client = client
    }

    /// What the composer may offer — its "Use a Skill" menu and a typed
    /// `/slug`, both sent as `skillSlug` on `/api/chat`. Empty until the
    /// library is read (``refresh()``).
    public var chooseable: [NativeSkillChoice] {
        library.map(NativeSkillRules.chooseable) ?? []
    }

    /// The choice a typed `/slug …` names, and the words after it.
    public func invocation(in draft: String) -> (choice: NativeSkillChoice, remainder: String)? {
        NativeSkillRules.invocation(in: draft, choices: chooseable)
    }

    public func start(for accountID: AccountID) async {
        guard self.accountID != accountID else { return }
        stop()
        self.accountID = accountID
        await refresh()
    }

    public func stop() {
        accountID = nil
        library = nil
        failure = nil
        isLoading = false
        tickets = [:]
    }

    /// Reads the library. A failure with a library already on screen keeps
    /// it, and says so in the returned sentence.
    @discardableResult
    public func refresh() async -> String? {
        guard let accountID else { return nil }
        isLoading = true
        defer { isLoading = false }
        let result = await client.library(for: accountID)
        guard self.accountID == accountID else { return nil }
        if let value = result.value {
            library = value
            failure = nil
            return nil
        }
        if library == nil {
            failure = result.message(
                fallback: "Couldn’t load your skills. The request failed, so this is not an empty library."
            )
            return nil
        }
        return result.message(fallback: "Couldn’t refresh your skills. The list may be out of date.")
    }

    /// A skill's own switch. Returns the sentence when the server refused.
    @discardableResult
    public func setSkillEnabled(_ skill: NativeSkill, _ enabled: Bool) async -> String? {
        guard let accountID else { return nil }
        let key = "skill:\(skill.id)"
        let ticket = nextTicket(key)
        update(skill: skill.id) { $0.enabled = enabled }
        let result = await client.patch(id: skill.id, NativeSkillPatch(enabled: enabled), for: accountID)
        guard tickets[key] == ticket else { return nil }
        if let saved = result.value {
            update(skill: skill.id) { $0.enabled = saved.enabled }
            return nil
        }
        update(skill: skill.id) { $0.enabled = skill.enabled }
        return result.message(fallback: "Couldn’t change that. The skill is as it was.")
    }

    /// A source's switch; its skills keep their own.
    @discardableResult
    public func setSourceEnabled(_ source: NativeSkillSource, _ enabled: Bool) async -> String? {
        guard let accountID else { return nil }
        let key = "source:\(source.id)"
        let ticket = nextTicket(key)
        update(source: source.id) { $0.enabled = enabled }
        let result = await client.setSourceEnabled(id: source.id, enabled, for: accountID)
        guard tickets[key] == ticket else { return nil }
        if case .ok(let saved) = result {
            update(source: source.id) { $0.enabled = saved?.enabled ?? enabled }
            return nil
        }
        update(source: source.id) { $0.enabled = source.enabled }
        return result.message(fallback: "Couldn’t change that. The repository is as it was.")
    }

    /// Removes a source and its skills. Returns nil when it went, or the
    /// sentence.
    public func removeSource(_ source: NativeSkillSource) async -> String? {
        guard let accountID else { return nil }
        let result = await client.removeSource(id: source.id, for: accountID)
        if result.value != nil {
            library?.sources.removeAll { $0.id == source.id }
            return nil
        }
        return result.message(fallback: "Couldn’t remove that repository. Its skills are still installed.")
    }

    /// The client, for the pages that talk to one skill, the importer and
    /// the update sheet.
    public var skillsClient: NativeSkillsClient { client }
    public var currentAccountID: AccountID? { accountID }

    /// Puts the model in a known state for the preview harness and snapshots.
    public func preview(_ library: NativeSkillLibrary?, failure: String? = nil) {
        self.library = library
        self.failure = failure
    }

    // MARK: Helpers

    private func nextTicket(_ key: String) -> Int {
        let ticket = (tickets[key] ?? 0) + 1
        tickets[key] = ticket
        return ticket
    }

    private func update(skill id: String, _ change: (inout NativeSkill) -> Void) {
        guard var library else { return }
        for index in library.yours.indices where library.yours[index].id == id {
            change(&library.yours[index])
        }
        for sourceIndex in library.sources.indices {
            for index in library.sources[sourceIndex].skills.indices
            where library.sources[sourceIndex].skills[index].id == id {
                change(&library.sources[sourceIndex].skills[index])
            }
        }
        self.library = library
    }

    private func update(source id: String, _ change: (inout NativeSkillSource) -> Void) {
        guard var library else { return }
        for index in library.sources.indices where library.sources[index].id == id {
            change(&library.sources[index])
        }
        self.library = library
    }
}
