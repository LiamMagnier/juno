import Foundation
import JunoChatKit
import JunoDesignSystem
import Testing

@testable import JunoDesktop

/// ⌘F over the transcript (spec §6.14, brief §6.8), and the Activity panel's
/// Cited / Also read split. Neither can be driven offscreen, so their rules are
/// pinned here.
@MainActor
struct TranscriptFindTests {
    private func message(_ id: String, _ role: NativeChatRole, _ content: String, sources: [NativeChatSource] = [])
        -> NativeChatMessage
    {
        NativeChatMessage(
            id: id, conversationID: "c", clientID: nil, role: role, content: content, reasoning: nil,
            model: nil, createdAt: Date(timeIntervalSince1970: 0), revision: 1, sources: sources
        )
    }

    @Test
    func matchesAreCountedAsDrawnAndSteppedInOrder() {
        let find = TranscriptFindModel()
        find.open()
        find.query = "readme"
        find.update(messages: [
            message("q", .user, "What makes a good README?"),
            message("a", .assistant, "A **readme** answers questions.\n\n```swift\nlet readme = 1\n```"),
        ])
        #expect(find.matches.map(\.messageID) == ["q", "a", "a"])
        #expect(find.matches.map(\.ordinal) == [0, 0, 1])
        #expect(find.current == 0)
        #expect(find.highlight(for: "q")?.current == 0)
        #expect(find.highlight(for: "a")?.current == nil)

        find.next()
        find.next()
        #expect(find.currentMatch == .init(messageID: "a", ordinal: 1))
        find.next()
        #expect(find.current == 0, "it wraps")
        find.previous()
        #expect(find.current == 2)

        find.close()
        #expect(find.matches.isEmpty)
        #expect(find.highlight(for: "a") == nil)
    }

    /// A trailing "Sources" list the pill replaces is not searched: it is not
    /// drawn.
    @Test
    func theReplacedSourcesSectionIsNotSearched() {
        let source = NativeChatSource(title: "Swift", url: URL(string: "https://swift.org")!, snippet: "")
        let reply = message(
            "a",
            .assistant,
            "Swift is fast.\n\n## Sources\n[1] https://swift.org/swift",
            sources: [source]
        )
        #expect(TranscriptFindModel.count(of: "swift", in: reply) == 1)
    }

    @Test
    func citedSourcesComeFirstInCitationOrder() {
        let sources = (1...4).map {
            NativeChatSource(title: "Source \($0)", url: URL(string: "https://s\($0).dev")!, snippet: "", cited: true)
        }
        let split = DesktopSourceSplit(message: message("a", .assistant, "Up [3], then [1] and again [3].", sources: sources))
        #expect(split.cited.map(\.number) == [3, 1])
        #expect(split.read.map(\.number) == [2, 4])

        let uncited = DesktopSourceSplit(message: message(
            "b",
            .assistant,
            "Up [3].",
            sources: sources.map { NativeChatSource(title: $0.title, url: $0.url, snippet: "") }
        ))
        #expect(uncited.cited.isEmpty, "a bracket means nothing without a numbered corpus")
        #expect(uncited.read.count == 4)

        // A search result nothing opened or cited was only found (SPEC §8.3.2).
        let searched = DesktopSourceSplit(message: message(
            "c",
            .assistant,
            "Up [1].",
            sources: [
                NativeChatSource(title: "Cited", url: URL(string: "https://a.dev")!, snippet: "", cited: true, origin: "juno_search"),
                NativeChatSource(title: "Found", url: URL(string: "https://b.dev")!, snippet: "", cited: true, origin: "juno_search"),
                NativeChatSource(title: "Read", url: URL(string: "https://c.dev")!, snippet: "", cited: false, origin: "juno_fetch"),
            ]
        ))
        #expect(searched.cited.map(\.number) == [1])
        #expect(searched.read.map(\.number) == [3])
        #expect(searched.found.map(\.number) == [2])
    }

    @Test
    func theFinishNotesAreTheWebsWords() {
        #expect(DesktopFinishCopy.sentence(for: .length) == "The model stopped at its token limit.")
        #expect(DesktopFinishCopy.sentence(for: .networkError) == "The stream was interrupted. The partial answer was preserved.")
        #expect(DesktopFinishCopy.sentence(for: .userStopped) == "Stopped by user.")
        #expect(DesktopFinishCopy.sentence(for: .toolCalls) == "The model requested tools, but no tool flow is enabled for this request.")
        #expect(DesktopFinishCopy.sentence(for: .sensitive) == "The provider stopped the response for safety reasons.")
        #expect(DesktopFinishCopy.sentence(for: .stop) == nil)
    }
}
