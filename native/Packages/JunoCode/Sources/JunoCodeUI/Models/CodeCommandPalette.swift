import Foundation
import JunoCodeCore
import JunoDesignSystem

/// One thing the ⌘K palette can do.
///
/// A value, so the palette's contents — which sessions, which projects, which
/// toggles — are assembled by the window that knows them and the palette itself
/// only searches and dispatches. That keeps the ranking testable without a
/// window and keeps the palette from depending on any one model.
public struct CodePaletteItem: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable, CaseIterable {
        case session
        case project
        case action
        case permission
        case model
        case slashCommand

        /// The section header the palette groups this under.
        public var sectionTitle: String {
            switch self {
            case .session: "Sessions"
            case .project: "Projects"
            case .action: "Actions"
            case .permission: "Permissions"
            case .model: "Models"
            case .slashCommand: "Commands"
            }
        }

        /// Section order when the query is empty: what the reader most often
        /// reaches ⌘K for first.
        public var order: Int {
            switch self {
            case .action: 0
            case .session: 1
            case .project: 2
            case .slashCommand: 3
            case .permission: 4
            case .model: 5
            }
        }
    }

    public let id: String
    public let kind: Kind
    public let title: String
    public let subtitle: String?
    public let icon: JunoIcon
    /// A keyboard shortcut, as the menu bar would print it — "⌘N".
    public let shortcut: String?
    /// Extra words the search should match — a session's branch, a project's
    /// path — that are not worth printing on the row.
    public let keywords: [String]

    public init(
        id: String,
        kind: Kind,
        title: String,
        subtitle: String? = nil,
        icon: JunoIcon,
        shortcut: String? = nil,
        keywords: [String] = []
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
        self.shortcut = shortcut
        self.keywords = keywords
    }
}

/// The palette's search: subsequence matching with a rank that prefers a
/// prefix, then a word start, then a scattered match.
///
/// Subsequence rather than substring because that is what every launcher a
/// Mac user has learned — Spotlight, Raycast, Xcode's Open Quickly — and typing
/// `nwtsk` should still find "New task". Ties are broken by section order so
/// the empty query lists actions first and models last.
public enum CodePaletteSearch {
    public static func rank(_ items: [CodePaletteItem], query: String) -> [CodePaletteItem] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        if needle.isEmpty {
            return items.sorted { left, right in
                if left.kind.order != right.kind.order { return left.kind.order < right.kind.order }
                return false
            }
        }
        let scored: [(item: CodePaletteItem, score: Int)] = items.compactMap { item in
            guard let score = score(item, needle: needle) else { return nil }
            return (item, score)
        }
        return scored
            .sorted { left, right in
                if left.score != right.score { return left.score > right.score }
                if left.item.kind.order != right.item.kind.order {
                    return left.item.kind.order < right.item.kind.order
                }
                return left.item.title < right.item.title
            }
            .map(\.item)
    }

    /// Higher is better; nil is no match.
    static func score(_ item: CodePaletteItem, needle: String) -> Int? {
        let haystacks = [item.title] + (item.subtitle.map { [$0] } ?? []) + item.keywords
        var best: Int?
        for (position, haystack) in haystacks.enumerated() {
            guard let base = score(haystack.lowercased(), needle: needle) else { continue }
            // A title match outranks a subtitle or keyword match of the same shape.
            let weighted = base - position * 10
            best = max(best ?? Int.min, weighted)
        }
        return best
    }

    static func score(_ haystack: String, needle: String) -> Int? {
        if haystack == needle { return 1_000 }
        if haystack.hasPrefix(needle) { return 800 }
        if haystack.split(separator: " ").contains(where: { $0.hasPrefix(needle) }) { return 600 }
        if haystack.contains(needle) { return 400 }
        // Subsequence: every character of the needle appears in order.
        var index = haystack.startIndex
        var matched = 0
        for character in needle {
            guard let found = haystack[index...].firstIndex(of: character) else { return nil }
            matched += 1
            index = haystack.index(after: found)
        }
        return matched == needle.count ? 100 : nil
    }

    /// The ranked items, grouped by section in first-appearance order.
    public static func sections(
        _ items: [CodePaletteItem],
        query: String
    ) -> [(kind: CodePaletteItem.Kind, items: [CodePaletteItem])] {
        let ranked = rank(items, query: query)
        var order: [CodePaletteItem.Kind] = []
        var grouped: [CodePaletteItem.Kind: [CodePaletteItem]] = [:]
        for item in ranked {
            if grouped[item.kind] == nil { order.append(item.kind) }
            grouped[item.kind, default: []].append(item)
        }
        return order.map { ($0, grouped[$0] ?? []) }
    }
}
