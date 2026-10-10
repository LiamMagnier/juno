import Foundation
import Observation
import SwiftUI
import JunoCodeCore
import JunoCodeLocal

// Skills in Alevr Code's composer (skills lane): the reader's Alevr skills,
// the ones installed on this Mac and the project's own, chosen from the
// Skills chip (the thread keeps them) or with `/name` (the next message only).

/// A skill from the reader's Alevr library, as the app hands it to Code.
public struct CodeAccountSkill: Identifiable, Hashable, Sendable {
    /// The library's id, to read the instructions with.
    public let id: String
    public let slug: String
    public let name: String
    public let description: String
    /// "owner/repo" for an installed one; nil for one the reader wrote.
    public let sourceLabel: String?

    public init(id: String, slug: String, name: String, description: String, sourceLabel: String? = nil) {
        self.id = id
        self.slug = slug
        self.name = name
        self.description = description
        self.sourceLabel = sourceLabel
    }
}

/// How Code reaches the reader's Alevr skills: the app injects it, since the
/// account client lives outside this package.
public struct CodeAccountSkills: Sendable {
    public var list: @Sendable () async -> [CodeAccountSkill]?
    public var instructions: @Sendable (_ id: String) async -> String?
    /// Opens the skills library (Manage skills…).
    public var manage: (@MainActor @Sendable () -> Void)?

    public init(
        list: @escaping @Sendable () async -> [CodeAccountSkill]?,
        instructions: @escaping @Sendable (String) async -> String?,
        manage: (@MainActor @Sendable () -> Void)? = nil
    ) {
        self.list = list
        self.instructions = instructions
        self.manage = manage
    }
}

private struct CodeAccountSkillsKey: EnvironmentKey {
    static let defaultValue: CodeAccountSkills? = nil
}

extension EnvironmentValues {
    /// The reader's Alevr skills, set once by the app on the Code workspace.
    public var codeAccountSkills: CodeAccountSkills? {
        get { self[CodeAccountSkillsKey.self] }
        set { self[CodeAccountSkillsKey.self] = newValue }
    }
}

/// One row of the Skills selector and the `/` menu.
public struct CodeSkillChoice: Identifiable, Hashable, Sendable {
    public enum Group: Int, CaseIterable, Sendable {
        case yours, mac, project

        public var title: String {
            switch self {
            case .yours: "Yours"
            case .mac: "Installed on this Mac"
            case .project: "Project"
            }
        }
    }

    public let name: String
    public let title: String
    public let description: String
    public let source: CodeV2.SkillSource
    public let origin: CodeV2.SkillOrigin?
    public let plugin: String?
    public let path: String?
    public let accountID: String?
    /// For an account skill installed from a repository: "owner/repo".
    public let sourceLabel: String?

    public var id: String { "\(source.rawValue):\(name)" }

    public var group: Group {
        switch source {
        case .account: .yours
        case .project: .project
        case .user, .plugin: .mac
        }
    }

    /// Where it came from, in the reader's words: "Claude Code", "Codex",
    /// "impeccable plugin", "owner/repo".
    public var originLabel: String? {
        switch source {
        case .account: return sourceLabel
        case .plugin: return plugin.map { "\($0) plugin" } ?? "Plugin"
        case .user, .project:
            switch origin {
            case .claude: return "Claude Code"
            case .codex: return "Codex"
            case .alevr: return "Alevr"
            case .juno: return "Alevr"
            case nil: return nil
            }
        }
    }

    public init(local: CodeV2.LocalSkillSummary) {
        name = local.name
        title = local.name
        description = local.description
        source = local.source
        origin = local.origin
        plugin = local.plugin
        path = local.path
        accountID = nil
        sourceLabel = nil
    }

    public init(account: CodeAccountSkill) {
        name = account.slug
        title = account.name
        description = account.description
        source = .account
        origin = nil
        plugin = nil
        path = nil
        accountID = account.id
        sourceLabel = account.sourceLabel
    }

    /// For tests and fixtures.
    public init(name: String, title: String? = nil, description: String, source: CodeV2.SkillSource,
                origin: CodeV2.SkillOrigin? = nil, plugin: String? = nil, path: String? = nil, accountID: String? = nil) {
        self.name = name
        self.title = title ?? name
        self.description = description
        self.source = source
        self.origin = origin
        self.plugin = plugin
        self.path = path
        self.accountID = accountID
        self.sourceLabel = nil
    }

    /// The activation sent with a turn; an account skill's text is added at send.
    func activation(once: Bool, instructions: String? = nil) -> CodeV2.SkillActivation {
        CodeV2.SkillActivation(
            name: name, source: source, path: path, instructions: instructions,
            title: title == name ? nil : title, once: once ? true : nil
        )
    }
}

/// The composer's skills for one thread: what can be chosen, what the thread
/// runs under (kept per thread), and a `/name` armed for the next message.
@MainActor
@Observable
public final class CodeSkillsModel {
    public private(set) var choices: [CodeSkillChoice] = []
    public private(set) var isLoading = false
    public private(set) var failed = false
    /// The thread's selection, by ``CodeSkillChoice/id``, in the order chosen.
    public private(set) var selectedIDs: [String] = []
    /// A `/name` skill for the next message only.
    public var once: CodeSkillChoice?

    /// Live selection (env server threads): called with the thread's whole
    /// selection whenever it changes here, to send it to the env server now
    /// (`skills.select`) so every device following the thread applies it.
    @ObservationIgnored public var onSelectionChange: (@MainActor ([CodeV2.SkillActivation]) async -> Void)?
    /// The env server's last record of the selection (ids), nil until seen.
    @ObservationIgnored private var remoteIDs: [String]?
    @ObservationIgnored private var remoteActivations: [String: CodeV2.SkillActivation] = [:]
    @ObservationIgnored nonisolated(unsafe) private var catalogListener: UUID?
    @ObservationIgnored private var listLocal: (@Sendable () async -> [CodeV2.LocalSkillSummary]?)?
    @ObservationIgnored public private(set) var account: CodeAccountSkills?
    @ObservationIgnored private var threadKey: String?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var loaded = false

    public init(
        threadKey: String? = nil,
        defaults: UserDefaults = .standard,
        choices: [CodeSkillChoice] = [],
        selectedIDs: [String]? = nil
    ) {
        self.defaults = defaults
        self.choices = choices
        // A list handed in (a fixture) is the list; nothing to read.
        self.loaded = !choices.isEmpty
        bind(threadKey: threadKey)
        if let selectedIDs { self.selectedIDs = selectedIDs }
    }

    deinit {
        if let catalogListener { Self.macCatalog.removeListener(catalogListener) }
    }

    nonisolated static func storageKey(_ thread: String) -> String { "alevr.code.skills.thread.\(thread)" }

    /// The Mac's skills, watched; shared by every composer on this Mac.
    nonisolated static let macCatalog = LocalSkillCatalog()

    /// The skills on this Mac plus a project's, read off the main thread.
    nonisolated public static func macSkills(projectRoot: URL?) async -> [CodeV2.LocalSkillSummary]? {
        await Task.detached(priority: .userInitiated) { macCatalog.list(projectRoot: projectRoot) }.value
    }

    /// Records a selection for a thread this composer did not make (a
    /// hand-off to the env server, a new session from the landing).
    nonisolated public static func remember(_ activations: [CodeV2.SkillActivation], thread: String, defaults: UserDefaults = .standard) {
        let ids = activations.filter { $0.once != true }.map { "\($0.source.rawValue):\($0.name)" }
        if ids.isEmpty { defaults.removeObject(forKey: storageKey(thread)) } else { defaults.set(ids, forKey: storageKey(thread)) }
    }

    /// Points the model at a thread (nil: a new session), restoring its selection.
    public func bind(threadKey: String?, snapshot: [CodeV2.SkillActivation]? = nil) {
        guard threadKey != self.threadKey || threadKey == nil else { return }
        self.threadKey = threadKey
        remoteIDs = nil
        remoteActivations = [:]
        if let threadKey, let stored = defaults.stringArray(forKey: Self.storageKey(threadKey)) {
            selectedIDs = stored
        } else if let snapshot {
            // Another device chose them: the env server keeps the thread's selection.
            selectedIDs = snapshot.filter { $0.once != true }.map { "\($0.source.rawValue):\($0.name)" }
        } else if threadKey != nil {
            selectedIDs = []
        }
    }

    /// Hands a new session's selection to the thread it became.
    public func adopt(threadKey: String) {
        self.threadKey = threadKey
        persist()
    }

    /// Where the lists come from. Loads once; `refresh()` reads again.
    public func configure(
        listLocal: (@Sendable () async -> [CodeV2.LocalSkillSummary]?)?,
        account: CodeAccountSkills?
    ) {
        self.listLocal = listLocal
        self.account = account
    }

    /// Re-reads an opened list whenever the Mac's skills change on disk (the
    /// in-process engine's composers, which list `macCatalog` directly).
    public func followMacCatalog() {
        guard catalogListener == nil else { return }
        catalogListener = Self.macCatalog.onChange { [weak self] in
            Task { @MainActor in await self?.refreshIfLoaded() }
        }
    }

    /// Reads the list again if it was ever read (a picker that is not open
    /// stays lazy).
    public func refreshIfLoaded() async {
        guard loaded else { return }
        await refresh()
    }

    // MARK: Live selection

    /// The env server's record of the thread's selection (its snapshot, then
    /// each `session.skills`). The first time a thread is seen with nothing
    /// selected there while this Mac has a selection for it, this Mac's is
    /// sent; after that, the env server's record is the selection.
    public func applyRemote(_ activations: [CodeV2.SkillActivation]?) {
        let list = (activations ?? []).filter { $0.once != true }
        let ids = list.map { "\($0.source.rawValue):\($0.name)" }
        remoteActivations = Dictionary(list.map { ("\($0.source.rawValue):\($0.name)", $0) }, uniquingKeysWith: { a, _ in a })
        let first = remoteIDs == nil
        guard first || ids != remoteIDs else { return }
        remoteIDs = ids
        if first, ids.isEmpty, !selectedIDs.isEmpty {
            pushSelection()
            return
        }
        guard ids != selectedIDs else { return }
        selectedIDs = ids
        persist()
    }

    private func pushSelection() {
        guard let onSelectionChange else { return }
        // The selection as it is now, not as it is when the task runs.
        let ids = selectedIDs
        Task { @MainActor in
            await onSelectionChange(await persistentActivations(ids))
        }
    }

    /// The thread's selection as activations (account text read now); an id
    /// this Mac cannot rebuild keeps the env server's activation for it.
    private func persistentActivations(_ ids: [String]? = nil) async -> [CodeV2.SkillActivation] {
        var out: [CodeV2.SkillActivation] = []
        for id in ids ?? selectedIDs {
            if let choice = choices.first(where: { $0.id == id }) ?? Self.placeholder(id) {
                let built = await activation(choice, once: false)
                if built.source != .account || !(built.instructions ?? "").isEmpty { out.append(built); continue }
            }
            if let known = remoteActivations[id] { out.append(known) }
        }
        return out
    }

    public func loadIfNeeded() async {
        guard !loaded else { return }
        await refresh()
    }

    public func refresh() async {
        loaded = true
        isLoading = true
        defer { isLoading = false }
        async let local = listLocal?()
        async let mine = account?.list()
        let (localSkills, accountSkills) = await (local, mine)
        failed = localSkills == nil && listLocal != nil && accountSkills == nil
        var next = (accountSkills ?? []).map(CodeSkillChoice.init(account:))
        next += (localSkills ?? []).map(CodeSkillChoice.init(local:))
        choices = Self.ordered(next)
    }

    /// Yours, then this Mac's, then the project's; a name once (the nearest wins
    /// for local skills, the env server's own rule; an account skill of the
    /// same name stays listed under Yours).
    static func ordered(_ choices: [CodeSkillChoice]) -> [CodeSkillChoice] {
        var seen = Set<String>()
        let unique = choices.filter { seen.insert($0.id).inserted }
        return unique.enumerated().sorted { a, b in
            a.element.group.rawValue != b.element.group.rawValue
                ? a.element.group.rawValue < b.element.group.rawValue
                : a.offset < b.offset
        }.map(\.element)
    }

    // MARK: Selection

    public var selected: [CodeSkillChoice] {
        selectedIDs.compactMap { id in choices.first { $0.id == id } ?? Self.placeholder(id) }
    }

    /// A chosen skill the list has not loaded (yet): still sent, by name.
    static func placeholder(_ id: String) -> CodeSkillChoice? {
        let parts = id.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, let source = CodeV2.SkillSource(rawValue: parts[0]), source != .account else { return nil }
        return CodeSkillChoice(name: parts[1], description: "", source: source)
    }

    public func isSelected(_ choice: CodeSkillChoice) -> Bool { selectedIDs.contains(choice.id) }

    public func toggle(_ choice: CodeSkillChoice) {
        if let index = selectedIDs.firstIndex(of: choice.id) { selectedIDs.remove(at: index) } else { selectedIDs.append(choice.id) }
        persist()
        pushSelection()
    }

    public func clear() {
        selectedIDs = []
        once = nil
        persist()
        pushSelection()
    }

    /// Another device chose these skills for the thread (remote control's
    /// sync, by name): each becomes the listed choice of that name, a choice
    /// already selected under that name, or, when nothing is loaded yet, this
    /// Mac's own skill of that name.
    public func adoptRemote(names: [String]) {
        var next: [String] = []
        for name in names {
            let id = choices.first { $0.name == name }?.id
                ?? selectedIDs.first { $0.split(separator: ":", maxSplits: 1).last.map(String.init) == name }
                ?? "\(CodeV2.SkillSource.user.rawValue):\(name)"
            if !next.contains(id) { next.append(id) }
        }
        guard next != selectedIDs else { return }
        selectedIDs = next
        persist()
    }

    /// The chip's words: "Skills", one skill's name, or "2 skills".
    public var chipTitle: String {
        let names = selected.map(\.title) + (once.map { ["/" + $0.name] } ?? [])
        switch names.count {
        case 0: return "Skills"
        case 1: return names[0]
        default: return "\(names.count) skills"
        }
    }

    public var hasActive: Bool { !selectedIDs.isEmpty || once != nil }

    private func persist() {
        guard let threadKey else { return }
        if selectedIDs.isEmpty { defaults.removeObject(forKey: Self.storageKey(threadKey)) } else {
            defaults.set(selectedIDs, forKey: Self.storageKey(threadKey))
        }
    }

    // MARK: Search and slash

    /// Matches for a search or a typed `/query`: names that start with it
    /// first, then names, titles and descriptions that contain it.
    public func matches(_ query: String) -> [CodeSkillChoice] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return choices }
        let prefix = choices.filter { $0.name.hasPrefix(needle) || $0.title.lowercased().hasPrefix(needle) }
        let rest = choices.filter { choice in
            !prefix.contains(choice)
                && (choice.name.contains(needle) || choice.title.lowercased().contains(needle)
                    || choice.description.lowercased().contains(needle)
                    || (choice.originLabel?.lowercased().contains(needle) ?? false))
        }
        return prefix + rest
    }

    /// A leading `/name …` that names a real skill, and the words after it.
    /// `/Users/me` is a path, not a skill, so it arms nothing.
    public func invocation(in draft: String) -> (choice: CodeSkillChoice, remainder: String)? {
        let trimmed = draft.drop { $0 == " " || $0 == "\n" }
        guard trimmed.first == "/" else { return nil }
        let rest = trimmed.dropFirst()
        let name = rest.prefix { !$0.isWhitespace }.lowercased()
        guard !name.isEmpty, let choice = choices.first(where: { $0.name == name }) else { return nil }
        let remainder = rest.dropFirst(name.count).trimmingCharacters(in: .whitespacesAndNewlines)
        return (choice, remainder)
    }

    /// Arms a skill for the next message (a `/name` chosen in the menu).
    public func arm(_ choice: CodeSkillChoice) { once = choice }

    // MARK: Sending

    /// The skills a message runs under: the thread's, then the armed `/name`
    /// one. An account skill's instructions are read from the library now.
    /// Clears the armed one.
    public func takeActivations() async -> [CodeV2.SkillActivation] {
        let armed = once
        once = nil
        var out = await persistentActivations()
        if let armed, !selected.contains(armed) {
            let one = await activation(armed, once: true)
            if one.source != .account || !(one.instructions ?? "").isEmpty { out.append(one) }
        }
        return out
    }

    private func activation(_ choice: CodeSkillChoice, once: Bool) async -> CodeV2.SkillActivation {
        guard choice.source == .account, let id = choice.accountID else { return choice.activation(once: once) }
        let text = await account?.instructions(id)
        return choice.activation(once: once, instructions: text)
    }
}
