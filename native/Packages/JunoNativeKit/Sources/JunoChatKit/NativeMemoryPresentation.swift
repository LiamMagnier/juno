import Foundation

// MARK: - Vocabulary

/// The memory page's words for the values the server sends
/// (`src/lib/memory-categories.ts`, `memory-sensitive.ts`).
public enum NativeMemoryVocabulary {
    /// Statuses that mean "Juno used to believe this".
    public static let retiredStatuses: Set<String> = ["superseded", "contradicted", "suppressed", "expired"]

    /// `MEMORY_CATEGORIES`, the order the topics read in.
    public static let categoryOrder = [
        "identity", "preferences", "goals", "studies", "workflows",
        "projects", "relationships", "temporary", "suppression",
    ]

    /// A topic's name; nil for a category this build does not know (it files
    /// under Uncategorised rather than as a raw enum value).
    public static func categoryLabel(_ id: String?) -> String? {
        switch id {
        case "identity": "Identity"
        case "preferences": "Preferences"
        case "goals": "Goals"
        case "studies": "Studies"
        case "workflows": "Workflows"
        case "projects": "Projects"
        case "relationships": "People"
        case "temporary": "Temporary"
        case "suppression": "Never remember"
        default: nil
        }
    }

    /// `memoryCategoryLabel`: unknown and missing both read "Uncategorised".
    public static func topicLabel(_ id: String?) -> String {
        categoryLabel(id) ?? "Uncategorised"
    }

    /// `MEMORY_STATUS_META`'s label, for a retired row.
    public static func statusLabel(_ status: String) -> String? {
        switch status {
        case "superseded": "Replaced"
        case "contradicted": "Conflicting"
        case "suppressed": "Forgotten"
        case "expired": "Expired"
        default: nil
        }
    }

    public static func statusDescription(_ status: String) -> String? {
        switch status {
        case "superseded": "Something newer took its place. Kept so you can see the change."
        case "contradicted": "It clashes with a fact you saved yourself, so Juno does not use it."
        case "suppressed": "You asked Juno to forget this. It will not be relearned."
        case "expired": "It was only true for a while, and that while has passed."
        default: nil
        }
    }

    /// `sensitiveTopicLabel`: an unknown subject is "Sensitive".
    public static func sensitiveLabel(_ id: String) -> String {
        switch id {
        case "health": "Health"
        case "ethnicity": "Race and ethnicity"
        case "religion": "Religion and beliefs"
        case "politics": "Political views"
        case "sexuality": "Sexuality and gender"
        case "finances": "Money"
        default: "Sensitive"
        }
    }
}

// MARK: - Scope

/// A slice of memory the page can narrow to. `id` nil is everything.
public struct NativeMemoryScope: Identifiable, Equatable, Sendable {
    public let id: String?
    public let label: String
    /// Facts Juno currently believes in this scope; retired ones do not count.
    public let count: Int

    public init(id: String?, label: String, count: Int) {
        self.id = id
        self.label = label
        self.count = count
    }
}

/// How the list is grouped (`MemorySort`).
public enum NativeMemoryGrouping: String, CaseIterable, Sendable {
    case topic
    case newest
}

/// One heading's worth of rows.
public struct NativeMemorySection: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    /// The category id for a topic section, for its glyph; nil by date.
    public let topic: String?
    public let rows: [NativeMemoryFact]
}

/// The pure half of the memory page: every question the page, the tests and
/// the snapshots all ask, answered once (`memory-model.ts`, `memory-list.tsx`,
/// `memory-time.ts`, `summary-panel.tsx`).
public enum NativeMemoryPresentation {
    /// Everything, then every project Juno has memory for, most remembered
    /// first. A project earns an entry with a summary or any fact at all,
    /// retired ones included.
    public static func scopes(
        facts: [NativeMemoryFact],
        projectSummaries: [NativeProjectMemorySummary]
    ) -> [NativeMemoryScope] {
        var byProject: [String: (label: String, count: Int)] = [:]
        var order: [String] = []
        var total = 0
        for fact in facts where fact.isFact {
            let active = !fact.isRetired
            if active { total += 1 }
            guard let projectID = fact.projectID else { continue }
            if byProject[projectID] == nil {
                order.append(projectID)
                byProject[projectID] = (fact.projectName ?? "Untitled project", 0)
            }
            if active { byProject[projectID]?.count += 1 }
        }
        for summary in projectSummaries where byProject[summary.projectID] == nil {
            order.append(summary.projectID)
            byProject[summary.projectID] = (summary.projectName, 0)
        }
        var projects: [NativeMemoryScope] = []
        for id in order {
            guard let entry = byProject[id] else { continue }
            projects.append(NativeMemoryScope(id: id, label: entry.label, count: entry.count))
        }
        projects.sort { lhs, rhs in
            if lhs.count != rhs.count { return lhs.count > rhs.count }
            return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
        }
        return [NativeMemoryScope(id: nil, label: "Everything", count: total)] + projects
    }

    /// The rows a scope shows: everything, or a project's own facts plus the
    /// never-remember list, which holds account-wide.
    public static func facts(_ facts: [NativeMemoryFact], inScope scope: String?) -> [NativeMemoryFact] {
        guard let scope else { return facts }
        return facts.filter { $0.isSuppression || $0.projectID == scope }
    }

    /// Everything a search finds a fact by: its words, its topic, its project
    /// and why it changed.
    public static func matches(_ fact: NativeMemoryFact, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return true }
        let haystack = [
            fact.content,
            fact.projectName ?? "",
            NativeMemoryVocabulary.categoryLabel(fact.category) ?? "",
            fact.reason ?? "",
        ]
        .joined(separator: " ")
        .lowercased()
        return haystack.contains(needle)
    }

    /// Active facts as the list draws them: by topic in the category order
    /// (unknown last), or by date bucket; newest first inside each.
    public static func sections(
        _ active: [NativeMemoryFact],
        grouping: NativeMemoryGrouping,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [NativeMemorySection] {
        let newestFirst = active.sorted { $0.createdAt > $1.createdAt }
        switch grouping {
        case .newest:
            var buckets: [DateBucket: [NativeMemoryFact]] = [:]
            for fact in newestFirst {
                buckets[dateBucket(fact.createdAt, now: now, calendar: calendar), default: []].append(fact)
            }
            return DateBucket.allCases.compactMap { bucket in
                guard let rows = buckets[bucket] else { return nil }
                return NativeMemorySection(id: bucket.rawValue, label: bucket.label, topic: nil, rows: rows)
            }
        case .topic:
            var byTopic: [String: [NativeMemoryFact]] = [:]
            for fact in newestFirst where fact.isFact {
                let id = NativeMemoryVocabulary.categoryLabel(fact.category) == nil
                    ? "uncategorised" : (fact.category ?? "uncategorised")
                byTopic[id, default: []].append(fact)
            }
            let rank = Dictionary(
                uniqueKeysWithValues: NativeMemoryVocabulary.categoryOrder.enumerated().map { ($1, $0) }
            )
            return byTopic
                .map { id, rows in
                    NativeMemorySection(
                        id: id,
                        label: id == "uncategorised" ? "Uncategorised" : NativeMemoryVocabulary.topicLabel(id),
                        topic: id,
                        rows: rows
                    )
                }
                .sorted { lhs, rhs in
                    let left = rank[lhs.id] ?? Int.max
                    let right = rank[rhs.id] ?? Int.max
                    if left != right { return left < right }
                    if lhs.rows.count != rhs.rows.count { return lhs.rows.count > rhs.rows.count }
                    return lhs.label < rhs.label
                }
        }
    }

    // MARK: Dates

    public enum DateBucket: String, CaseIterable, Sendable {
        case today, yesterday, week, month, earlier

        public var label: String {
            switch self {
            case .today: "Today"
            case .yesterday: "Yesterday"
            case .week: "Last 7 days"
            case .month: "Last 30 days"
            case .earlier: "Older"
            }
        }
    }

    /// Counted from midnight, as a reader counts.
    public static func dateBucket(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> DateBucket {
        let startOfToday = calendar.startOfDay(for: now)
        let day: TimeInterval = 86_400
        if date >= startOfToday { return .today }
        if date >= startOfToday.addingTimeInterval(-day) { return .yesterday }
        if date >= startOfToday.addingTimeInterval(-6 * day) { return .week }
        if date >= startOfToday.addingTimeInterval(-29 * day) { return .month }
        return .earlier
    }

    /// "just now", "5 minutes ago", "yesterday", "3 weeks ago" (`relativeTime`).
    public static func relativeTime(_ date: Date, now: Date = Date(), locale: Locale = .current) -> String {
        let elapsed = max(0, now.timeIntervalSince(date))
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.dateTimeStyle = .named
        formatter.unitsStyle = .full
        let minute: TimeInterval = 60
        let hour = 60 * minute
        let day = 24 * hour
        if elapsed < minute { return formatter.localizedString(fromTimeInterval: 0) }
        if elapsed < hour { return formatter.localizedString(from: DateComponents(minute: -Int((elapsed / minute).rounded()))) }
        if elapsed < day { return formatter.localizedString(from: DateComponents(hour: -Int((elapsed / hour).rounded()))) }
        let days = Int((elapsed / day).rounded())
        if days < 7 { return formatter.localizedString(from: DateComponents(day: -days)) }
        if days < 30 { return formatter.localizedString(from: DateComponents(weekOfMonth: -Int((Double(days) / 7).rounded()))) }
        if days < 365 { return formatter.localizedString(from: DateComponents(month: -Int((Double(days) / 30).rounded()))) }
        return formatter.localizedString(from: DateComponents(year: -Int((Double(days) / 365).rounded())))
    }

    // MARK: Summary

    public struct SummarySection: Equatable, Sendable {
        public let title: String
        public let body: String
    }

    /// The consolidated summary is Markdown with `## ` sections; text before
    /// the first heading takes `preambleTitle` ("About you", or "About this
    /// project").
    public static func summarySections(_ markdown: String, preambleTitle: String = "About you") -> [SummarySection] {
        var sections: [(title: String, body: [String])] = []
        var preamble: [String] = []
        for line in markdown.components(separatedBy: "\n") {
            if let title = heading(line) {
                sections.append((title, []))
            } else if !sections.isEmpty {
                sections[sections.count - 1].body.append(line)
            } else {
                preamble.append(line)
            }
        }
        var out: [SummarySection] = []
        let pre = preamble.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !pre.isEmpty { out.append(SummarySection(title: preambleTitle, body: pre)) }
        for section in sections {
            let body = section.body.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty { out.append(SummarySection(title: section.title, body: body)) }
        }
        return out
    }

    private static func heading(_ line: String) -> String? {
        var rest = Substring(line)
        var hashes = 0
        while rest.first == "#", hashes < 4 {
            rest = rest.dropFirst()
            hashes += 1
        }
        guard (1...3).contains(hashes), rest.first == " " || rest.first == "\t" else { return nil }
        let title = rest
            .trimmingCharacters(in: .whitespaces)
            .filter { !"*_`#".contains($0) }
            .trimmingCharacters(in: .whitespaces)
        return title.isEmpty ? nil : title
    }

    /// How many whole sections show before "Read the whole summary": the
    /// first always, then more while they fit about six lines of the column;
    /// a short remainder is not worth the fold.
    public static func summaryPreviewCount(_ sections: [SummarySection], budget: Int = 520) -> Int {
        var used = 0
        var count = 0
        for section in sections {
            if count > 0, used + section.body.count > budget { break }
            used += section.body.count
            count += 1
        }
        let rest = sections.dropFirst(count).reduce(0) { $0 + $1.body.count }
        return rest < 160 ? sections.count : count
    }
}

// MARK: - Recap

/// What changed in what Juno knows over a period (`src/lib/memory-recap.ts`),
/// dated by the data's own meaning, never by `updatedAt`.
public struct NativeMemoryRecap: Equatable, Sendable {
    public struct Replacement: Equatable, Sendable {
        public let before: NativeMemoryFact
        public let after: NativeMemoryFact
    }

    public let days: Int
    public let learned: [NativeMemoryFact]
    public let replaced: [Replacement]
    public let conflicting: [NativeMemoryFact]
    public let forgotten: [NativeMemoryFact]
    public let expired: [NativeMemoryFact]
    public let leanedOn: [NativeMemoryFact]

    public static let periods = [7, 30, 90]

    public var changedCount: Int { replaced.count + conflicting.count }
    public var letGoCount: Int { forgotten.count + expired.count }

    public func isEmpty(themes: [String]) -> Bool {
        learned.isEmpty && replaced.isEmpty && conflicting.isEmpty && forgotten.isEmpty
            && expired.isEmpty && leanedOn.isEmpty && themes.isEmpty
    }

    public static func build(_ rows: [NativeMemoryFact], days: Int, now: Date = Date()) -> NativeMemoryRecap {
        let since = now.addingTimeInterval(-Double(days) * 86_400)
        func inWindow(_ date: Date?) -> Bool {
            guard let date else { return false }
            return date >= since && date <= now
        }
        let byID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let facts = rows.filter(\.isFact)
        let learned = facts.filter { inWindow($0.createdAt) }.sorted { $0.createdAt > $1.createdAt }
        let replaced = facts
            .filter { $0.status == "superseded" }
            .compactMap { before -> Replacement? in
                guard let afterID = before.supersededByID, let after = byID[afterID], inWindow(after.createdAt)
                else { return nil }
                return Replacement(before: before, after: after)
            }
            .sorted { $0.after.createdAt > $1.after.createdAt }
        let conflicting = facts
            .filter { $0.status == "contradicted" && inWindow($0.createdAt) }
            .sorted { $0.createdAt > $1.createdAt }
        let forgotten = rows
            .filter { $0.isSuppression && inWindow($0.createdAt) }
            .sorted { $0.createdAt > $1.createdAt }
        let expired = facts
            .filter { $0.status == "expired" && inWindow($0.expiresAt) }
            .sorted { ($0.expiresAt ?? .distantPast) > ($1.expiresAt ?? .distantPast) }
        let leanedOn = Array(
            facts
                .filter { $0.status == "active" && inWindow($0.lastUsedAt) }
                .sorted { ($0.lastUsedAt ?? .distantPast) > ($1.lastUsedAt ?? .distantPast) }
                .prefix(6)
        )
        return NativeMemoryRecap(
            days: days, learned: learned, replaced: replaced, conflicting: conflicting,
            forgotten: forgotten, expired: expired, leanedOn: leanedOn
        )
    }
}
