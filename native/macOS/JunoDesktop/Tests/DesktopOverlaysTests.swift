import Foundation
import JunoAuth
import JunoChatKit
import JunoCodeCore
import JunoDesignSystem
import SwiftUI
import Testing
@testable import JunoDesktop

/// Phase 3 Stage B's pure rules: the Command menu's matcher and rows, the
/// Search panel's merge, guard, filters, notices and routing, the Share
/// state machine, the Outputs index, the account popover's usage block, and
/// Archived Chats.
@MainActor
struct DesktopOverlaysTests {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    // MARK: - The matcher

    /// The web's `atWordStart`: a query begins on a word boundary, never
    /// inside a word.
    @Test
    func aQueryMatchesOnlyAtAWordStart() {
        #expect(DesktopCommandCatalog.atWordStart("documents generated made", "doc"))
        #expect(DesktopCommandCatalog.atWordStart("open pull requests", "pull req"))
        #expect(!DesktopCommandCatalog.atWordStart("documents generated made", "rate"))
        #expect(!DesktopCommandCatalog.atWordStart("documents generated made", "ent"))
        #expect(DesktopCommandCatalog.atWordStart("new-chat", "chat"))
        #expect(DesktopCommandCatalog.atWordStart("anything", ""))
    }

    /// Keywords count as much as the label.
    @Test
    func keywordsFindTheirRow() {
        #expect(DesktopCommandCatalog.matches(label: "Open Memory", keywords: "remember facts", query: "facts"))
        #expect(!DesktopCommandCatalog.matches(label: "Open Memory", keywords: "remember facts", query: "act"))
    }

    /// "canvas" keys exactly one place: Open Designs.
    @Test
    func canvasFindsOneRow() {
        let rows = DesktopCommandCatalog.rows(query: "canvas", context: .init(now: now))
        #expect(rows.map(\.id) == ["design"])
    }

    // MARK: - The Command menu's rows

    @Test
    func theEmptyQueryListsTheWebsGroupsInOrder() {
        let rows = DesktopCommandCatalog.rows(
            query: "",
            context: .init(
                conversations: [conversation("c1", minutesAgo: 3), conversation("code", kind: "code", minutesAgo: 1)],
                projects: [project("p1", starred: true)],
                now: now
            )
        )
        let groups = rows.reduce(into: [String]()) { if $0.last != $1.group { $0.append($1.group) } }
        #expect(groups == ["Actions", "Chats", "Projects", "Settings"])
        // The Chats group never lists Code's conversations.
        #expect(rows.filter { $0.group == "Chats" }.map(\.id) == ["recent-c1"])
        // "Pinned" is a pinned project's meta; "All projects" closes the group.
        #expect(rows.first { $0.id == "project-p1" }?.meta == "Pinned")
        #expect(rows.last { $0.group == "Projects" }?.label == "All projects")
    }

    /// Decision 10: a row whose page is not routed on this base is absent
    /// until its hook is wired; Pull requests and Compare are left out.
    @Test
    func hookRowsAreAbsentWhileTheirHookIsNil() {
        let bare = DesktopCommandCatalog.rows(query: "", context: .init(now: now)).map(\.id)
        for absent in ["new-automation", "new-assistant", "notifications", "assistants", "skills", "automations",
                       "permissions", "upgrade", "code-pulls", "compare"] {
            #expect(!bare.contains(absent))
        }
        for present in ["new-chat", "new-private-chat", "new-code", "new-design", "new-agent", "search-everything",
                        "toggle-sidebar", "agents", "code-runs", "design", "artifacts", "library", "connections",
                        "memory", "roadmap", "settings", "theme", "shortcuts"] {
            #expect(bare.contains(present))
        }
        var hooks = DesktopCommandCatalog.Hooks()
        hooks.openPage = { _ in }
        hooks.openUpgrade = {}
        hooks.openNotifications = {}
        let wired = DesktopCommandCatalog.rows(query: "", context: .init(hooks: hooks, now: now)).map(\.id)
        for now in ["new-automation", "new-assistant", "notifications", "assistants", "skills", "automations",
                    "permissions", "upgrade"] {
            #expect(wired.contains(now))
        }
    }

    /// The theme row names the theme it switches to.
    @Test
    func theThemeRowSaysWhereItGoes() {
        let light = DesktopCommandCatalog.rows(query: "theme", context: .init(isDark: false, now: now))
        #expect(light.first { $0.id == "theme" }?.label == "Switch to dark mode")
        let dark = DesktopCommandCatalog.rows(query: "theme", context: .init(isDark: true, now: now))
        #expect(dark.first { $0.id == "theme" }?.label == "Switch to light mode")
    }

    @Test
    func relativeTimeIsTheWebsCompactForm() {
        #expect(DesktopCommandCatalog.relativeTime(now.addingTimeInterval(-20), now: now) == "Just now")
        #expect(DesktopCommandCatalog.relativeTime(now.addingTimeInterval(-5 * 60), now: now) == "5m")
        #expect(DesktopCommandCatalog.relativeTime(now.addingTimeInterval(-2 * 3600), now: now) == "2h")
        #expect(DesktopCommandCatalog.relativeTime(now.addingTimeInterval(-26 * 3600), now: now) == "Yesterday")
        #expect(DesktopCommandCatalog.relativeTime(now.addingTimeInterval(-3 * 86_400), now: now) == "3d")
        #expect(DesktopCommandCatalog.relativeTime(now.addingTimeInterval(-15 * 86_400), now: now) == "2w")
        #expect(DesktopCommandCatalog.relativeTime(now.addingTimeInterval(-130 * 86_400), now: now) == "4mo")
        #expect(DesktopCommandCatalog.relativeTime(now.addingTimeInterval(-400 * 86_400), now: now) == "1y")
    }

    // MARK: - Search: merge, guard, filters

    /// Local groups and the server's interleave in the web's order, each at
    /// most six rows, and memory from the local store is never listed.
    @Test
    func resultsMergeInTheWebsGroupOrder() {
        let local = [
            result(.artifact, "a1", "Plan artifact"),
            result(.conversation, "c1", "Quarterly plan"),
            result(.memory, "m-local", "Plan memory"),
            result(.file, "f1", "plan.pdf"),
        ]
        let server = serverResult(
            query: "plan",
            groups: [
                (.work, [hit("work:s1", .work, "Plan task", href: "/chat/c9")]),
                (.knowledge, [hit("knowledge:k1", .knowledge, "Plan doc", href: "/projects/p1?doc=d&block=b")]),
                (.memory, [hit("memory:m1", .memory, "Plans in tables", href: "/memory?entry=m1")]),
            ]
        )
        let rows = DesktopSearchPanelModel.resultRows(
            query: "plan", local: local, server: server, typeFilter: nil, window: .any, projectFilter: nil,
            projectOfConversation: { _ in nil }, hooks: .none, now: now
        )
        #expect(rows.map(\.group) == ["Chats", "Files", "Knowledge", "Artifacts", "Memory", "Tasks"])
        #expect(!rows.contains { $0.id == "local-memory-m-local" })
        // The words that matched are marked, as offsets into the title.
        let chat = rows.first { $0.id == "local-conversation-c1" }
        #expect(chat?.labelMarks == [NativeSearchMark(start: 10, end: 14)])
    }

    /// The echo guard, end to end: an answer to an earlier query is dropped.
    @Test
    func aLateServerAnswerIsDropped() async {
        let model = DesktopSearchPanelModel()
        model.debounce = .zero
        var services = DesktopSearchPanelModel.Services()
        services.localSearch = { _ in [] }
        services.serverSearch = { _, _, _, _ in self.serverResult(query: "pla", groups: []) }
        model.services = services
        model.present(.search)
        model.setQuery("plan")
        await model.runSearch(generation: model.currentGeneration)
        #expect(model.server == .searching)
        services.serverSearch = { _, _, _, _ in self.serverResult(query: "plan", groups: []) }
        model.services = services
        await model.runSearch(generation: model.currentGeneration)
        #expect(model.serverResult?.query == "plan")
    }

    /// Changing a filter puts the cursor back on the first row.
    @Test
    func aFilterResetsTheCursor() {
        let model = DesktopSearchPanelModel()
        model.present(.search)
        model.setQuery("plan")
        let rows = [row("a"), row("b"), row("c")]
        model.moveCursor(by: 2, in: rows)
        #expect(model.activeIndex(in: rows) == 2)
        model.setTypeFilter(.message)
        #expect(model.activeIndex(in: rows) == 0)
        model.moveCursor(by: 1, in: rows)
        model.setWindow(.week)
        #expect(model.activeIndex(in: rows) == 0)
    }

    /// Server groups slotting in above the cursor do not move it off its row.
    @Test
    func theCursorFollowsItsRowNotItsIndex() {
        let model = DesktopSearchPanelModel()
        model.present(.search)
        let before = [row("a"), row("b")]
        model.moveCursor(by: 1, in: before)
        let after = [row("a"), row("k"), row("b")]
        #expect(model.activeIndex(in: after) == 2)
    }

    /// Filters: a local-only type asks nothing of the server, a server type
    /// nothing of this Mac; the window and project narrow local results.
    @Test
    func filtersNarrowBothHalves() {
        #expect(DesktopSearchPanelModel.serverTypes(for: nil) == [.knowledge, .memory, .work])
        #expect(DesktopSearchPanelModel.serverTypes(for: .conversation).isEmpty)
        #expect(DesktopSearchPanelModel.serverTypes(for: .memory) == [.memory])
        #expect(DesktopSearchPanelModel.searchesLocally(.work) == false)
        let old = NativeSearchResult(
            kind: .conversation, entityID: "old", conversationID: "old", title: "Old plan", snippet: "",
            score: 1, updatedAt: now.addingTimeInterval(-40 * 86_400)
        )
        let rows = DesktopSearchPanelModel.resultRows(
            query: "plan", local: [old, result(.conversation, "c1", "New plan")], server: nil, typeFilter: nil,
            window: .month, projectFilter: "p1", projectOfConversation: { $0 == "c1" ? "p1" : nil }, hooks: .none,
            now: now
        )
        #expect(rows.map(\.id) == ["local-conversation-c1"])
    }

    /// Offline, one notice naming every server type in scope; otherwise the server's
    /// shortfalls, two and then the count of the rest.
    @Test
    func noticesSayWhatWasSearchedOnlyInPart() {
        #expect(
            DesktopSearchPanelModel.notices(server: .failed(offline: true), types: [.knowledge, .memory, .work])
                == ["Knowledge, memory and tasks: not searched while offline."]
        )
        let coverage: [NativeSearchCoverage] = [
            .init(type: .knowledge, state: .partial, detail: "Still indexing."),
            .init(type: .memory, state: .unavailable, detail: "Could not be read."),
            .init(type: .work, state: .partial, detail: "Only the last year."),
        ]
        let partial = NativeUnifiedSearchResult(query: "x", groups: [], total: 0, coverage: coverage, partial: true)
        #expect(
            DesktopSearchPanelModel.notices(server: .ready(partial), types: [.knowledge, .memory, .work])
                == [
                    "Knowledge: Still indexing.",
                    "Memory: Could not be read.",
                    "1 more part of your account was searched only in part.",
                ]
        )
    }

    // MARK: - Routing

    @Test
    func hitsRouteByTypeThenHref() {
        let hooks = DesktopCommandCatalog.Hooks.none
        #expect(DesktopSearchRoute.hit(hit("c", .conversation, "x", href: "/chat/c-1"), hooks: hooks) == .conversation(id: "c-1"))
        #expect(
            DesktopSearchRoute.hit(hit("m", .message, "x", href: "/chat/c-1?m=msg-9"), hooks: hooks)
                == .conversation(id: "c-1", messageID: "msg-9")
        )
        #expect(DesktopSearchRoute.hit(hit("p", .project, "x", href: "/projects/p-1"), hooks: hooks) == .project("p-1"))
        #expect(DesktopSearchRoute.hit(hit("f", .file, "x", href: "/chat/c-1?m=m"), hooks: hooks) == .destination(.library))
        #expect(DesktopSearchRoute.hit(hit("k", .knowledge, "x", href: "/projects/p"), hooks: hooks) == .destination(.library))
        #expect(
            DesktopSearchRoute.hit(hit("a", .artifact, "x", href: "/a/art-1?v=3"), hooks: hooks)
                == .artifact(id: "art-1", conversationID: nil)
        )
        #expect(DesktopSearchRoute.hit(hit("m", .memory, "x", href: "/memory?entry=1"), hooks: hooks) == .destination(.memory))
        #expect(DesktopSearchRoute.hit(hit("work:s1", .work, "x", href: "/chat/c-7"), hooks: hooks) == .conversation(id: "c-7"))
        // A task with no conversation is absent until seam 6 is wired.
        #expect(DesktopSearchRoute.hit(hit("work:s2", .work, "x", href: "/chat"), hooks: hooks) == nil)
        var wired = DesktopCommandCatalog.Hooks()
        wired.openTaskRecord = { _ in }
        #expect(DesktopSearchRoute.hit(hit("work:s2", .work, "x", href: "/chat"), hooks: wired) == .taskRecord(sessionID: "s2"))
        // Anything else opens the web.
        #expect(DesktopSearchRoute.path("/roadmap") == .web(path: "/roadmap"))
    }

    @Test
    func recentsRouteByKind() {
        #expect(DesktopSearchRoute.recent(kind: "chat", href: "/chat/c-1") == .conversation(id: "c-1"))
        #expect(DesktopSearchRoute.recent(kind: "project", href: "/projects/p-1") == .project("p-1"))
        #expect(DesktopSearchRoute.recent(kind: "code", href: "/chat/c-2") == .openCode)
        #expect(
            DesktopSearchRoute.recent(kind: "code", href: DesktopSearchRoute.localCodeSessionPrefix + "s-1")
                == .codeSession(CodeSessionID(value: "s-1"))
        )
    }

    /// Offline, Recent is this Mac's own chats and projects by recency, with
    /// archived chats and Code's conversations left out.
    @Test
    func localRecentsAreChatsAndProjectsByRecency() {
        let items = DesktopSearchPanelModel.localRecents(
            conversations: [
                conversation("c1", minutesAgo: 30),
                conversation("c2", minutesAgo: 5),
                conversation("gone", minutesAgo: 1, archived: true),
                conversation("code", kind: "code", minutesAgo: 2),
            ],
            projects: [project("p1", starred: false, minutesAgo: 10)],
            codeSessions: []
        )
        #expect(items.map(\.id) == ["c2", "p1", "c1"])
    }

    // MARK: - Share

    @Test
    func shareMakesTheLinkAndCopies() async {
        let service = StubShareService(outcomes: [.success(share())])
        let state = DesktopShareState()
        state.copiedDuration = .milliseconds(20)
        state.start(.chat("c-1"), service: service)
        #expect(state.isPresented)
        await state.createTask?.value
        #expect(state.phase == .ready(share()))
        var pasted: String?
        state.copy { pasted = $0 }
        #expect(pasted == "https://juno.example/s/tok")
        #expect(state.copied)
        try? await Task.sleep(for: .milliseconds(80))
        #expect(!state.copied)
    }

    @Test
    func shareBlockedErrorRetryRevokeAndRecreate() async {
        let service = StubShareService(outcomes: [
            .failure(NativeShareError.blocked("Reported chats can’t be shared.")),
            .failure(NativeShareError.blocked(nil)),
            .failure(NativeShareError.failed),
            .success(share()),
            .success(share(id: "s-2")),
        ])
        let state = DesktopShareState()
        state.start(.chat("c-1"), service: service)
        await state.createTask?.value
        #expect(state.phase == .blocked("Reported chats can’t be shared."))
        await state.create()
        #expect(state.phase == .blocked("This can’t be shared."))
        await state.create()
        #expect(state.phase == .error)
        await state.create()
        #expect(state.phase == .ready(share()))
        var toasts: [String] = []
        await state.revoke { toasts.append($0.title) }
        #expect(state.phase == .revoked)
        #expect(toasts == ["Link revoked. It no longer works."])
        await state.create()
        #expect(state.phase == .ready(share(id: "s-2")))
        service.revokeFails = true
        await state.revoke { toasts.append($0.title) }
        #expect(state.phase == .ready(share(id: "s-2")))
        #expect(toasts.last == "Couldn’t revoke the link.")
    }

    @Test
    func theShareCaptionIsTheWebs() {
        let caption = DesktopSharePopover.caption(for: share(views: 14), locale: Locale(identifier: "en_US"))
        #expect(caption == "Snapshot · Sep 22, 2026 · 14 views")
        #expect(DesktopSharePopover.caption(for: share(views: 1), locale: Locale(identifier: "en_US")).hasSuffix("1 view"))
        #expect(!DesktopShareState.selectionClosesPopover(sharing: "c-1", selected: "c-1"))
        #expect(DesktopShareState.selectionClosesPopover(sharing: "c-1", selected: "c-2"))
    }

    // MARK: - Outputs

    /// The web's `readSession()` cases: labels, generated pictures, newest
    /// first, and each used row's detail.
    @Test
    func sessionOutputsReadTheTranscript() {
        let artifacts = [
            artifact("a1", kind: .markdown, minutesAgo: 30),
            artifact("a2", kind: .code, language: "python", minutesAgo: 5),
            artifact("a3", kind: .design, minutesAgo: 20),
        ]
        let upload = attachment("u1", "brief.pdf", kind: "DOCUMENT", mime: "application/pdf")
        let picture = attachment("i1", "poster.png", kind: "IMAGE", mime: "image/png")
        let messages = [
            message("q1", .user, attachments: [upload, upload]),
            message(
                "r1", .assistant, model: "anthropic:claude-sonnet-4-6", minutesAgo: 1, attachments: [picture],
                activity: [
                    NativeChatActivity(id: "v", kind: .visit, title: "", detail: nil, url: "https://a.example"),
                    NativeChatActivity(
                        id: "m", kind: .context, title: "", detail: nil, url: nil,
                        memory: [NativeMemoryReceipt(id: "f1", content: "x", category: "Work")]
                    ),
                    NativeChatActivity(
                        id: "t", kind: .tool, title: "", detail: nil, url: nil,
                        tool: NativeToolDetail(server: "GitHub", name: "list")
                    ),
                ]
            ),
            message("r2", .assistant, model: "openai:gpt-5", sources: [source("https://b.example")]),
            message("r3", .assistant, model: "google:gemini-3-pro"),
        ]
        let outputs = ChatSessionOutputs.read(artifacts: artifacts, messages: messages)
        #expect(outputs.outputs.map(\.label) == ["Image", "python", "Design", "Doc"])
        #expect(outputs.outputs.first { $0.id == "a3" }?.poster?.artifactID == "a3")
        #expect(outputs.outputs.first { $0.id == "a3" }?.preview == nil)
        let used = Dictionary(uniqueKeysWithValues: outputs.used.map { ($0.id, $0) })
        #expect(used["models"]?.label == "Models")
        #expect(used["models"]?.detail == "Claude Sonnet 4.6 +2")
        #expect(used["uploads"]?.detail == "brief.pdf")
        #expect(used["uploads"]?.files.count == 1)
        #expect(used["search"]?.detail == "2 sources")
        #expect(used["memory"]?.detail == "Read · Work")
        #expect(used["connectors"]?.label == "Connector")
        #expect(used["connectors"]?.detail == "GitHub")
        #expect(outputs.used.map(\.id) == ["models", "uploads", "search", "memory", "connectors"])
    }

    @Test
    func anEmptySessionHasNothingToShow() {
        let outputs = ChatSessionOutputs.read(artifacts: [], messages: [message("q", .user)])
        #expect(outputs.isEmpty)
    }

    @Test
    func extensionLabelsAreTheWebs() {
        #expect(ChatSessionOutputs.extensionLabel(of: attachment("a", "report.final.docx", kind: "DOCUMENT", mime: "x/y")) == "DOCX")
        #expect(ChatSessionOutputs.extensionLabel(of: attachment("b", "README", kind: "DOCUMENT", mime: "text/markdown")) == "MARKD")
        #expect(ChatSessionOutputs.extensionLabel(of: attachment("c", "notes.backup", kind: "DOCUMENT", mime: "application/vnd.ms-excel")) == "VND")
    }

    /// The popover's height is a function of its rows, capped at 400.
    @Test
    func theOutputsPopoverHeightIsDeterministic() {
        let one = ChatSessionOutputs(outputs: [tile("a")], used: [])
        let many = ChatSessionOutputs(outputs: (0..<6).map { tile("t\($0)") }, used: [])
        #expect(DesktopOutputsPopover.height(for: one) < DesktopOutputsPopover.height(for: many))
        #expect(DesktopOutputsPopover.height(for: many) == 400)
    }

    // MARK: - Account popover

    @Test
    func theUsageBlockReadsThePlan() {
        let none = DesktopAccountUsage(plan: nil)
        #expect(none.readout == "Unavailable")
        #expect(DesktopAccountUsage.uncappedSentence(isOwner: true) == "Everything unlocked, with no usage cap.")
        #expect(DesktopAccountUsage.uncappedSentence(isOwner: false) == "All models, with a monthly token limit.")
        #expect(DesktopAccountPopoverRows.canUpgrade(planID: "free"))
        #expect(DesktopAccountPopoverRows.canUpgrade(planID: "lite"))
        #expect(DesktopAccountPopoverRows.canUpgrade(planID: "MAX"))
        #expect(DesktopAccountPopoverRows.canUpgrade(planID: "MAX20"), "Ultra is above Max ×10")
        #expect(!DesktopAccountPopoverRows.canUpgrade(planID: "ULTRA"), "the top plan for sale")
        #expect(!DesktopAccountPopoverRows.canUpgrade(planID: "OWNER"))
        #expect(!DesktopAccountPopoverRows.canUpgrade(planID: "TEAM"), "a plan this build does not know")
        let base = DesktopAccountPopoverRows(showsUpgrade: false, showsAdmin: false).height
        #expect(DesktopAccountPopoverRows(showsUpgrade: true, showsAdmin: true).height == base + 56)
    }

    // MARK: - Archived Chats and dialogs

    @Test
    func archivedChatsAreChatsWithArchivedAtNewestFirst() {
        var early = conversation("early", minutesAgo: 60, archived: true)
        early.archivedAt = now.addingTimeInterval(-3600)
        var late = conversation("late", minutesAgo: 90, archived: true)
        late.archivedAt = now.addingTimeInterval(-60)
        let rows = DesktopArchivedChats.rows(from: [
            early, late, conversation("live", minutesAgo: 1),
            conversation("code", kind: "code", minutesAgo: 1, archived: true),
        ])
        #expect(rows.map(\.id) == ["late", "early"])
        #expect(DesktopArchivedChats.load(phase: .loading, conversations: []) == .loading)
        #expect(DesktopArchivedChats.load(phase: .failed, conversations: []) == .failed)
        #expect(DesktopArchivedChats.load(phase: .ready, conversations: []) == .ready([]))
    }

    /// Rename… reveals a hidden sidebar before the row's field starts.
    @Test
    func renameRevealsTheSidebar() {
        #expect(DesktopChatRename.columns(forRenameFrom: .detailOnly) == .all)
        #expect(DesktopChatRename.columns(forRenameFrom: .all) == .all)
    }

    @Test
    func deleteAsksInTheWebsWords() {
        let confirmation = DesktopChatDeletion.confirmation {}
        #expect(confirmation.title == "Delete this conversation?")
        #expect(confirmation.message == "This permanently removes the conversation and its messages. This can't be undone.")
        #expect(confirmation.confirmTitle == "Delete Chat")
        #expect(DesktopChatDeletion.succeeded(id: "x", in: [conversation("y", minutesAgo: 1)]))
        #expect(!DesktopChatDeletion.succeeded(id: "y", in: [conversation("y", minutesAgo: 1)]))
    }

    // MARK: - Fixtures

    private func conversation(
        _ id: String,
        kind: String = "chat",
        minutesAgo: Double,
        archived: Bool = false,
        projectID: String? = nil
    ) -> NativeConversation {
        let date = now.addingTimeInterval(-minutesAgo * 60)
        return NativeConversation(
            id: id, title: id.capitalized, model: "auto", kind: kind, pinned: false,
            archivedAt: archived ? date : nil, createdAt: date, updatedAt: date, lastMessageAt: date,
            revision: 1, projectId: projectID
        )
    }

    private func project(_ id: String, starred: Bool, minutesAgo: Double = 60) -> NativeProject {
        let date = now.addingTimeInterval(-minutesAgo * 60)
        return NativeProject(
            id: id, name: id.uppercased(), instructions: "", starred: starred, createdAt: date, updatedAt: date,
            revision: 1
        )
    }

    private func result(_ kind: NativeSearchResultKind, _ id: String, _ title: String) -> NativeSearchResult {
        NativeSearchResult(
            kind: kind, entityID: id, conversationID: kind == .project ? nil : "c1", title: title, snippet: "",
            score: 1, updatedAt: now.addingTimeInterval(-3600)
        )
    }

    private func hit(_ id: String, _ type: NativeUnifiedSearchType, _ title: String, href: String) -> NativeSearchHit {
        NativeSearchHit(id: id, type: type, title: title, href: href, updatedAt: now)
    }

    private func serverResult(
        query: String,
        groups: [(NativeUnifiedSearchType, [NativeSearchHit])]
    ) -> NativeUnifiedSearchResult {
        NativeUnifiedSearchResult(
            query: query,
            groups: groups.map { NativeSearchGroup(type: $0.0, label: $0.0.label, hits: $0.1) },
            total: groups.reduce(0) { $0 + $1.1.count },
            coverage: [],
            partial: false
        )
    }

    private func row(_ id: String) -> DesktopPanelRow {
        DesktopPanelRow(id: id, group: "G", label: id, icon: .search, action: .newChat)
    }

    private func share(id: String = "s-1", views: Int = 3) -> NativeShare {
        NativeShare(
            id: id, kind: "CHAT", token: "tok", url: URL(string: "https://juno.example/s/tok")!, title: nil,
            snapshotAt: Date(timeIntervalSince1970: 1_790_071_200), views: views, createdAt: nil
        )
    }

    private func artifact(
        _ id: String,
        kind: NativeArtifactKind,
        language: String? = nil,
        minutesAgo: Double
    ) -> NativeArtifact {
        let date = now.addingTimeInterval(-minutesAgo * 60)
        return NativeArtifact(
            id: id, conversationID: "c1", conversationTitle: "C1", messageID: nil, identifier: id, title: id.uppercased(),
            kind: kind, language: language, currentVersion: 1,
            versions: [NativeArtifactVersion(id: "\(id)-v1", version: 1, content: "# \(id)", origin: nil, createdAt: date)],
            createdAt: date, updatedAt: date, revision: 1
        )
    }

    private func attachment(_ id: String, _ name: String, kind: String, mime: String) -> NativeChatAttachment {
        NativeChatAttachment(id: id, fileName: name, mimeType: mime, kind: kind, size: 1024, width: nil, height: nil)
    }

    private func source(_ url: String) -> NativeChatSource {
        NativeChatSource(title: "Source", url: URL(string: url)!, snippet: "", cited: false)
    }

    private func message(
        _ id: String,
        _ role: NativeChatRole,
        model: String? = nil,
        minutesAgo: Double = 10,
        attachments: [NativeChatAttachment] = [],
        sources: [NativeChatSource] = [],
        activity: [NativeChatActivity] = []
    ) -> NativeChatMessage {
        NativeChatMessage(
            id: id, conversationID: "c1", clientID: nil, role: role, content: "text", reasoning: nil, model: model,
            createdAt: now.addingTimeInterval(-minutesAgo * 60), revision: 1, sources: sources,
            attachments: attachments, activity: activity
        )
    }

    private func tile(_ id: String) -> ChatSessionOutputs.Tile {
        ChatSessionOutputs.Tile(
            id: id, identifier: id, title: id, label: "Doc", kind: .markdown, language: nil, preview: "text",
            poster: nil, attachment: nil, sortKey: now
        )
    }
}

/// A share service answering from a script, one outcome per create.
@MainActor
private final class StubShareService: DesktopShareService {
    var outcomes: [Result<NativeShare, Error>]
    var revokeFails = false

    init(outcomes: [Result<NativeShare, Error>]) {
        self.outcomes = outcomes
    }

    func create(_ target: DesktopShareTarget) async throws -> NativeShare {
        guard !outcomes.isEmpty else { throw NativeShareError.failed }
        return try outcomes.removeFirst().get()
    }

    func revoke(shareID: String) async throws {
        if revokeFails { throw NativeShareError.failed }
    }
}
