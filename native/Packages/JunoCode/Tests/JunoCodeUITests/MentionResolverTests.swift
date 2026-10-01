import Foundation
import Testing
import JunoCodeCore
@testable import JunoCodeUI

/// `@folder`, `@diff`, `@preview:/route` and `@shell:<id>` (CODE_AGENT_SPEC
/// §5.12), resolved into fenced context when a message is sent.
struct MentionResolverTests {
    private static func path(_ value: String) -> WorkspacePath { try! WorkspacePath(value) }

    /// A fake workspace: `big/` holds 150 folders of 3 files each, `src/` a
    /// little tree with an AGENTS.md.
    private func resolver(preview: (any PreviewMentionProviding)? = nil, diff: String? = "diff --git a/x b/x") -> MentionResolver {
        MentionResolver(
            listDirectory: { folder in
                switch folder?.value {
                case "big":
                    return (0..<150).map { FileEntry(path: Self.path("big/d\($0)"), isDirectory: true, byteCount: nil) }
                case let value? where value.hasPrefix("big/d"):
                    return (0..<3).map { FileEntry(path: Self.path("\(value)/f\($0).txt"), isDirectory: false, byteCount: 1) }
                case "src":
                    return [
                        FileEntry(path: Self.path("src/AGENTS.md"), isDirectory: false, byteCount: 10),
                        FileEntry(path: Self.path("src/components"), isDirectory: true, byteCount: nil),
                        FileEntry(path: Self.path("src/main.ts"), isDirectory: false, byteCount: 10),
                    ]
                case "src/components":
                    return [
                        FileEntry(path: Self.path("src/components/deep"), isDirectory: true, byteCount: nil),
                        FileEntry(path: Self.path("src/components/Menu.tsx"), isDirectory: false, byteCount: 10),
                    ]
                case "src/components/deep":
                    return [FileEntry(path: Self.path("src/components/deep/too-far.ts"), isDirectory: false, byteCount: 1)]
                default:
                    return []
                }
            },
            readText: { path, _ in path.value == "src/AGENTS.md" ? "Use pnpm." : nil },
            isDirectory: { ["big", "src", "src/components"].contains($0.value) },
            diff: { diff },
            preview: preview,
            shellTail: { $0 == "sh-1" ? "listening on :3000" : nil }
        )
    }

    @Test
    func aFolderIsListedTwoLevelsDeepWithItsAgentsFile() async throws {
        let text = "Tidy @src please"
        let context = try #require(await resolver().context(for: text, references: [Self.path("src")]))
        #expect(context.contains("FOLDER @src/"))
        #expect(context.contains("components/\n  deep/"), "the second level is listed")
        #expect(!context.contains("too-far.ts"), "the third level is not")
        #expect(context.contains("AGENTS.md in this folder:\nUse pnpm."))
        #expect(context.hasPrefix("BEGIN MENTIONED CONTEXT"))
        #expect(context.contains("untrusted project data"))
    }

    @Test
    func aFolderListingStopsAtTwoHundredEntries() async {
        let section = await resolver().folder(Self.path("big"))
        let entries = section.split(separator: "\n").filter { $0.hasPrefix(" ") || $0.hasPrefix("d") }
        #expect(entries.count == MentionResolver.folderEntryLimit)
        #expect(section.contains("only the first 200 entries are listed"))
    }

    @Test
    func diffPreviewAndShellMentions() async throws {
        let preview = FakePreview()
        let text = "Compare @diff with @preview:/settings and @shell:sh-1"
        let context = try #require(await resolver(preview: preview).context(for: text, references: []))
        #expect(context.contains("DIFF @diff\ndiff --git a/x b/x"))
        #expect(context.contains("PREVIEW @preview:/settings\nSettings — menu open"))
        #expect(context.contains("SHELL @shell:sh-1\nlistening on :3000"))
        #expect(await preview.asked == ["/settings"])

        let noPreview = try #require(await resolver(diff: "").context(for: "@preview:/ and @diff", references: []))
        #expect(noPreview.contains("The Preview is not open"))
        #expect(noPreview.contains("There are no uncommitted changes."))
    }

    @Test
    func unknownMentionsStayText() async {
        let text = "email me@example.com about @nothing or @shell:sh-9 or @src"
        // `@src` was never chosen from the picker, `@shell:sh-9` does not
        // exist, `@nothing` is not a mention: nothing resolves.
        #expect(await resolver().context(for: text, references: []) == nil)
        #expect(resolver().mentions(in: "a @diffs b", references: []).isEmpty)
        // A folder the reader chose but then deleted from the text is gone.
        #expect(await resolver().context(for: "never mind", references: [Self.path("src")]) == nil)
    }

    @Test
    func thePickerOffersDiffAndRunningShells() {
        #expect(ComposerMentionSuggestions.special(for: "", shellIDs: ["sh-1"]) == [.diff, .shell(id: "sh-1")])
        #expect(ComposerMentionSuggestions.special(for: "di", shellIDs: ["sh-1"]) == [.diff])
        #expect(ComposerMentionSuggestions.special(for: "sh", shellIDs: ["sh-1"]) == [.shell(id: "sh-1")])
        #expect(ComposerMentionSuggestions.special(for: "menu", shellIDs: []) == [])
        #expect(ComposerMention.preview(route: "/a").token == "@preview:/a")
    }
}

private actor FakePreview: PreviewMentionProviding {
    private(set) var asked: [String] = []

    func snapshot(route: String) async -> String? {
        asked.append(route)
        return "Settings — menu open"
    }
}
