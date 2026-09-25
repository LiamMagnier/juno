import Foundation
import JunoChatKit
import Testing

@testable import JunoDesktop

/// Phase 4 Stage A's page rules, ported from the web and pinned here.
@MainActor
struct DesktopArtifactsFilterTests {
    private func artifact(
        _ id: String,
        _ kind: NativeArtifactKind,
        title: String = "",
        conversation: String = "Chat",
        language: String? = nil,
        identifier: String = "thing"
    ) -> NativeArtifact {
        NativeArtifact(
            id: id, conversationID: "conv", conversationTitle: conversation, messageID: nil,
            identifier: identifier, title: title, kind: kind, language: language, currentVersion: 1,
            versions: [NativeArtifactVersion(id: "\(id)-v1", version: 1, content: "x", origin: nil, createdAt: Date())],
            createdAt: Date(), updatedAt: Date(), revision: 1
        )
    }

    /// `homeTypeChips`: Designs always, first; the rest in `HOME_TYPE_ORDER`
    /// when they have items.
    @Test
    func designsAlwaysShowAndLead() {
        #expect(DesktopArtifactsFilter.chips(present: []) == [.design])
        #expect(DesktopArtifactsFilter.chips(present: [.mermaid, .html, .code]) == [.design, .html, .code, .mermaid])
        #expect(DesktopArtifactsFilter.chips(present: [.design, .design]) == [.design])
    }

    /// `effectiveHomeFilter`: a filter with no chip reads as All.
    @Test
    func aFilterWithNoChipReadsAsAll() {
        let chips = DesktopArtifactsFilter.chips(present: [.html])
        #expect(DesktopArtifactsFilter.effective("REACT", chips: chips) == "ALL")
        #expect(DesktopArtifactsFilter.effective("HTML", chips: chips) == "HTML")
        #expect(DesktopArtifactsFilter.effective("DESIGN", chips: chips) == "DESIGN")
        #expect(DesktopArtifactsFilter.effective("ALL", chips: chips) == "ALL")
    }

    /// `homeTypeFromParam`: case-insensitive; an unknown value is All.
    @Test
    func theTypeParameterIsReadLikeTheWebs() {
        #expect(DesktopArtifactsFilter.type(fromParam: "design") == "DESIGN")
        #expect(DesktopArtifactsFilter.type(fromParam: " Design ") == "DESIGN")
        #expect(DesktopArtifactsFilter.type(fromParam: "moodboard") == "ALL")
        #expect(DesktopArtifactsFilter.type(fromParam: nil) == "ALL")
    }

    /// The search matches the title, the conversation title and the runtime
    /// label, as the page's `filtered` does.
    @Test
    func searchMatchesTitleConversationAndRuntime() {
        let items = [
            artifact("a", .html, title: "Pricing card", conversation: "Launch"),
            artifact("b", .code, title: "Parser", conversation: "Pricing research", language: "python"),
            artifact("c", .mermaid, title: "Flow", conversation: "Ops"),
        ]
        #expect(DesktopArtifactsFilter.filter(items, type: "ALL", query: "pricing").map(\.id) == ["a", "b"])
        #expect(DesktopArtifactsFilter.filter(items, type: "ALL", query: "mermaid").map(\.id) == ["c"])
        #expect(DesktopArtifactsFilter.filter(items, type: "CODE", query: "").map(\.id) == ["b"])
        #expect(DesktopArtifactsFilter.filter(items, type: "HTML", query: "parser").isEmpty)
    }

    /// `{identifier}.{ext}`: the language's extension, else the type's.
    @Test
    func theDownloadNameIsTheWebs() {
        #expect(DesktopArtifactKinds.downloadName(artifact("a", .code, language: "python", identifier: "fib")) == "fib.py")
        #expect(DesktopArtifactKinds.downloadName(artifact("a", .code, language: "ts", identifier: "api")) == "api.ts")
        #expect(DesktopArtifactKinds.downloadName(artifact("a", .code, language: "brainfuck", identifier: "x")) == "x.txt")
        #expect(DesktopArtifactKinds.downloadName(artifact("a", .html, identifier: "card")) == "card.html")
        #expect(DesktopArtifactKinds.downloadName(artifact("a", .design, identifier: "signin")) == "signin.juno.design.json")
        #expect(DesktopArtifactKinds.downloadName(artifact("a", .markdown, identifier: "")) == "artifact.md")
    }

    /// The chips' words are the web's `TYPE_LABELS`.
    @Test
    func theChipLabelsAreTheWebs() {
        #expect(NativeArtifactKind.allCases.map(DesktopArtifactKinds.chipLabel) ==
            ["Sites", "Components", "Code", "Documents", "Graphics", "Diagrams", "Designs"])
    }

    /// Open in Conversation asks for the row by its id (A1).
    @Test
    func openInConversationCarriesTheRowID() {
        let router = DesktopPageRouter()
        let row = artifact("art-9", .html, identifier: "card~abc123")
        router.openArtifactInConversation(row)
        #expect(router.pendingCanvas?.artifactID == "art-9")
        #expect(router.pendingCanvas?.conversationID == "conv")
        if let request = router.pendingCanvas { router.consumeCanvas(request) }
        #expect(router.pendingCanvas == nil)
    }

    /// A router request for a project page goes to Projects with the route.
    @Test
    func aProjectRequestPushesOnProjects() {
        let router = DesktopPageRouter()
        router.open(.projects, route: .project("proj-1"))
        #expect(router.pending?.destination == .projects)
        #expect(router.pending?.route == .project("proj-1"))
    }
}

@MainActor
struct DesktopProjectListingTests {
    private func project(_ id: String, _ name: String, starred: Bool = false, updated: TimeInterval, instructions: String = "") -> NativeProject {
        NativeProject(
            id: id, name: name, instructions: instructions, starred: starred,
            createdAt: Date(timeIntervalSince1970: 0),
            updatedAt: Date(timeIntervalSince1970: updated),
            revision: 1
        )
    }

    private func file(_ id: String, _ name: String) -> NativeProjectFile {
        NativeProjectFile(
            id: id, projectID: "p", conversationID: nil, messageID: nil, fileName: name, kind: "FILE",
            mimeType: "application/pdf", size: 10, width: nil, height: nil, createdAt: Date(), revision: 1,
            libraryRemovedAt: nil
        )
    }

    private var summaries: [DesktopProjectSummary] {
        [
            DesktopProjectSummary(project: project("a", "Zeta", updated: 10), chatCount: 1, files: []),
            DesktopProjectSummary(project: project("b", "alpha", starred: true, updated: 30, instructions: "Quasar notes"), chatCount: 5, files: []),
            DesktopProjectSummary(project: project("c", "Beta", updated: 20), chatCount: 5, files: []),
        ]
    }

    @Test
    func sortsByLastUpdatedNameAndMostChats() {
        #expect(DesktopProjectListing.visible(summaries, query: "", pinnedOnly: false, sort: .updated).map(\.id) == ["b", "c", "a"])
        #expect(DesktopProjectListing.visible(summaries, query: "", pinnedOnly: false, sort: .name).map(\.id) == ["b", "c", "a"])
        // A tie on chats falls through to the id.
        #expect(DesktopProjectListing.visible(summaries, query: "", pinnedOnly: false, sort: .chats).map(\.id) == ["b", "c", "a"])
    }

    @Test
    func filtersByPinAndSearchesNameAndInstructions() {
        #expect(DesktopProjectListing.visible(summaries, query: "", pinnedOnly: true, sort: .updated).map(\.id) == ["b"])
        #expect(DesktopProjectListing.visible(summaries, query: "quasar", pinnedOnly: false, sort: .updated).map(\.id) == ["b"])
        #expect(DesktopProjectListing.visible(summaries, query: "zet", pinnedOnly: false, sort: .updated).map(\.id) == ["a"])
        // "{n} of {m}": what is shown over what exists.
        let shown = DesktopProjectListing.visible(summaries, query: "eta", pinnedOnly: false, sort: .name)
        #expect(shown.count == 2)
    }

    /// The cover is the file named `__cover__`: never a source, never counted.
    @Test
    func theCoverIsNotASource() {
        let summary = DesktopProjectSummary(
            project: project("p", "P", updated: 0),
            chatCount: 0,
            files: [file("f1", "notes.pdf"), file("f2", "__cover__"), file("f3", "data.csv")]
        )
        #expect(summary.sources.map(\.id) == ["f1", "f3"])
        #expect(summary.cover?.id == "f2")
    }

    /// Tasks only when there are any; Code is not offered yet.
    @Test
    func tabsFollowWhatTheProjectHas() {
        #expect(DesktopProjectTab.visible(taskCount: 0) == [.overview, .sources, .settings])
        #expect(DesktopProjectTab.visible(taskCount: 2) == [.overview, .tasks, .sources, .settings])
    }

    @Test
    func relativeTimeIsTheWebsShortForm() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(DesktopRelativeTime.short(now.addingTimeInterval(-30), now: now) == "just now")
        #expect(DesktopRelativeTime.short(now.addingTimeInterval(-7_200), now: now) == "2h ago")
        #expect(DesktopRelativeTime.short(now.addingTimeInterval(-3 * 86_400), now: now) == "3d ago")
    }
}

@MainActor
struct DesktopLibraryPageRulesTests {
    @Test
    func sizesAreTheWebsFormatBytes() {
        #expect(DesktopLibraryScreen.sizeLabel(0) == "0 B")
        #expect(DesktopLibraryScreen.sizeLabel(512) == "512 B")
        #expect(DesktopLibraryScreen.sizeLabel(2_048) == "2 KB")
        #expect(DesktopLibraryScreen.sizeLabel(2_480_000) == "2.4 MB")
    }

    @Test
    func kindAndTypeLabelsAreTheWebs() {
        func item(_ name: String, image: Bool = false) -> NativeLibraryItem {
            NativeLibraryItem(id: name, fileName: name, mimeType: "", size: 1, kind: image ? "IMAGE" : "FILE", createdAt: Date())
        }
        #expect(DesktopLibraryScreen.kindLabel(item("a.xlsx")) == "Spreadsheet")
        #expect(DesktopLibraryScreen.kindLabel(item("a.ts")) == "Code")
        #expect(DesktopLibraryScreen.kindLabel(item("a.png", image: true)) == "Image")
        #expect(DesktopLibraryScreen.kindLabel(item("README")) == "File")
        #expect(DesktopLibraryScreen.typeLabel(item("report.final.pdf")) == "PDF")
        #expect(DesktopLibraryScreen.typeLabel(item("noextension")) == "File")
    }

    @Test
    func indexNotesAreTheWebsWords() {
        #expect(DesktopLibraryScreen.indexNote(NativeLibraryKnowledge(state: "processing")) == "Indexing for search…")
        #expect(DesktopLibraryScreen.indexNote(NativeLibraryKnowledge(state: "failed")) == "This file could not be indexed.")
        #expect(DesktopLibraryScreen.indexNote(NativeLibraryKnowledge(state: "partial")) == "Only part of this file could be indexed.")
        #expect(DesktopLibraryScreen.indexNote(NativeLibraryKnowledge(state: "ready")) == nil)
        #expect(DesktopLibraryScreen.indexNote(nil) == nil)
    }
}
