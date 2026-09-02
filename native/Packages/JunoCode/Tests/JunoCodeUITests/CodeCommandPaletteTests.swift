import Foundation
import Testing
@testable import JunoCodeUI

/// The ⌘K ranking: prefix beats word-start beats substring beats subsequence,
/// and an empty query lists actions first.
struct CodeCommandPaletteTests {
    private let items = [
        CodePaletteItem(id: "session.1", kind: .session, title: "Refactor the sync coordinator", subtitle: "juno · feat/sync", icon: .conversation, keywords: ["feat/sync"]),
        CodePaletteItem(id: "action.new", kind: .action, title: "New task", icon: .new, shortcut: "⌘N"),
        CodePaletteItem(id: "project.juno", kind: .project, title: "juno", subtitle: "~/Developer/juno", icon: .projects),
        CodePaletteItem(id: "model.sonnet", kind: .model, title: "Claude Sonnet 5", icon: .models),
        CodePaletteItem(id: "slash.review", kind: .slashCommand, title: "/review", subtitle: "Review the working changes", icon: .terminal),
    ]

    @Test
    func anEmptyQueryListsActionsFirst() {
        let ranked = CodePaletteSearch.rank(items, query: "")
        #expect(ranked.first?.id == "action.new")
        #expect(ranked.map(\.id) == ["action.new", "session.1", "project.juno", "slash.review", "model.sonnet"])
    }

    @Test
    func prefixOutranksSubstringOutranksSubsequence() {
        #expect(CodePaletteSearch.rank(items, query: "new").first?.id == "action.new")
        #expect(CodePaletteSearch.rank(items, query: "sync").first?.id == "session.1")
        // `nwtsk` is a subsequence of "New task" and of nothing else.
        let scattered = CodePaletteSearch.rank(items, query: "nwtsk")
        #expect(scattered.map(\.id) == ["action.new"])
    }

    @Test
    func keywordsAndSubtitlesMatchButRankBelowTitles() {
        let ranked = CodePaletteSearch.rank(items, query: "feat")
        #expect(ranked.map(\.id) == ["session.1"])
        #expect(CodePaletteSearch.rank(items, query: "developer").map(\.id) == ["project.juno"])
    }

    @Test
    func nothingMatchesNothing() {
        #expect(CodePaletteSearch.rank(items, query: "zzzz").isEmpty)
    }

    @Test
    func sectionsFollowFirstAppearance() {
        let sections = CodePaletteSearch.sections(items, query: "")
        #expect(sections.map(\.kind) == [.action, .session, .project, .slashCommand, .model])
        #expect(sections.flatMap(\.items).count == items.count)
    }
}
