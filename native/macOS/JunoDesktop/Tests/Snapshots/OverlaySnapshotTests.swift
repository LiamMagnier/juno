import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI
import Testing

@testable import JunoDesktop

/// Phase 3 Stage B's overlays, drawn offscreen in both appearances:
/// `$JUNO_SNAPSHOT_DIR/<name>-<light|dark>.png`, and the window composition
/// under `$JUNO_FINAL_SNAPSHOT_DIR` (or `<snapshot dir>/final`).
///
/// The panel's glass is drawn with its Reduce Transparency recipe
/// (``SwiftUI/EnvironmentValues/junoSnapshotOpaqueGlass``). Popovers are drawn
/// as views at their popover frame on a stand-in popover fill, and the sheet
/// on a stand-in sheet ground: both are system glass on screen, which an
/// offscreen window cannot composite.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Phase 3 Stage B overlays."
    ),
    .serialized
)
struct OverlaySnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
    }

    private var finalDirectory: URL {
        if let final = ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"] {
            return URL(fileURLWithPath: final)
        }
        return directory.appendingPathComponent("final", isDirectory: true)
    }

    @Test(arguments: OverlayFixtures.names)
    func drawsInBothAppearances(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.shared()
        let fixture = try #require(OverlayFixtures.fixture(named: name, world: world))
        if let prepare = fixture.prepare {
            try await prepare()
        }
        let isFinal = name.hasPrefix("window-")
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                fixture.view(),
                name: fixture.name,
                width: fixture.width,
                appearance: appearance,
                into: isFinal ? finalDirectory : directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

// MARK: - Fixtures

@MainActor
enum OverlayFixtures {
    nonisolated static let names = [
        "panel-commands-empty",
        "panel-commands-query",
        "panel-search-recent",
        "panel-search-results",
        "panel-search-offline-notice",
        "panel-search-empty",
        "panel-search-error",
        "panel-search-loading",
        "share-loading",
        "share-ready",
        "share-copied",
        "share-revoked",
        "share-blocked",
        "share-error",
        "outputs-one",
        "outputs-many",
        "outputs-used-only",
        "account-popover-free",
        "account-popover-owner",
        "archived-list",
        "archived-empty",
        "archived-error",
        "archived-loading",
        "window-panel-over-chat",
        "share-artifact-sheet",
        "quick-entry-chat",
        "quick-entry-code",
        "quick-entry-no-accessibility",
    ]

    static let now = Date()

    static func fixture(named name: String, world: SnapshotPreviewWorld) -> FinalFixture? {
        switch name {
        // MARK: Panel
        case "panel-commands-empty":
            let model = DesktopSearchPanelModel()
            return panelFixture(name, model: model) {
                model.present(.commands)
            }
        case "panel-commands-query":
            let model = DesktopSearchPanelModel()
            return panelFixture(name, model: model) {
                model.present(.commands)
                model.setQuery("pro")
            }
        case "panel-search-recent":
            let model = DesktopSearchPanelModel()
            return panelFixture(name, model: model) {
                model.services = services()
                model.present(.search)
                await model.refreshRecents()
            }
        case "panel-search-results":
            let model = DesktopSearchPanelModel()
            return panelFixture(name, model: model) {
                model.services = services()
                model.debounce = .seconds(60)
                model.present(.search)
                model.setQuery("launch plan")
                await model.runSearch(generation: model.currentGeneration)
            }
        case "panel-search-offline-notice":
            let model = DesktopSearchPanelModel()
            return panelFixture(name, model: model) {
                var offline = services()
                offline.isOffline = { true }
                model.services = offline
                model.debounce = .seconds(60)
                model.present(.search)
                model.setQuery("launch plan")
                await model.runSearch(generation: model.currentGeneration)
            }
        case "panel-search-empty":
            let model = DesktopSearchPanelModel()
            return panelFixture(name, model: model) {
                var empty = services()
                empty.localSearch = { _ in [] }
                empty.serverSearch = { query, _, _, _ in
                    NativeUnifiedSearchResult(query: query, groups: [], total: 0, coverage: [], partial: false)
                }
                model.services = empty
                model.debounce = .seconds(60)
                model.present(.search)
                model.setQuery("zebra crossing")
                await model.runSearch(generation: model.currentGeneration)
            }
        case "panel-search-error":
            let model = DesktopSearchPanelModel()
            return panelFixture(name, model: model) {
                var failing = services()
                failing.localSearch = { _ in throw CocoaError(.fileReadCorruptFile) }
                failing.serverSearch = { _, _, _, _ in throw NativeUnifiedSearchError.failed(status: 503) }
                model.services = failing
                model.debounce = .seconds(60)
                model.present(.search)
                model.setQuery("launch plan")
                await model.runSearch(generation: model.currentGeneration)
            }
        case "panel-search-loading":
            let model = DesktopSearchPanelModel()
            return panelFixture(name, model: model) {
                model.services = services()
                model.debounce = .seconds(60)
                model.present(.search)
                model.setQuery("launch plan")
            }

        // MARK: Share
        case "share-loading":
            return shareFixture(name) { state in
                state.start(.chat("c-1"), service: SnapshotShareService(outcome: .pending))
            }
        case "share-ready":
            return shareFixture(name) { state in
                state.start(.chat("c-1"), service: SnapshotShareService(outcome: .share))
                await state.createTask?.value
            }
        case "share-copied":
            return shareFixture(name) { state in
                state.copiedDuration = .seconds(60)
                state.start(.chat("c-1"), service: SnapshotShareService(outcome: .share))
                await state.createTask?.value
                state.copy { _ in }
            }
        case "share-revoked":
            return shareFixture(name) { state in
                state.start(.chat("c-1"), service: SnapshotShareService(outcome: .share))
                await state.createTask?.value
                await state.revoke { _ in }
            }
        case "share-blocked":
            return shareFixture(name) { state in
                state.start(.chat("c-1"), service: SnapshotShareService(outcome: .blocked))
                await state.createTask?.value
            }
        case "share-error":
            return shareFixture(name) { state in
                state.start(.chat("c-1"), service: SnapshotShareService(outcome: .failed))
                await state.createTask?.value
            }

        case "share-artifact-sheet":
            // An artifact's Share… in its sheet: the popover's content with
            // the sheet's Done, at the ready state's explicit frame.
            let state = DesktopShareState()
            return FinalFixture(
                name: name,
                width: DesktopSharePopover.size.width + 48,
                view: { AnyView(popoverStandIn(DesktopShareSheet(state: state))) },
                prepare: {
                    state.start(.artifact("a-1"), service: SnapshotShareService(outcome: .share))
                    await state.createTask?.value
                }
            )

        // MARK: Quick Entry
        case "quick-entry-chat", "quick-entry-code", "quick-entry-no-accessibility":
            let product: DesktopProductMode = name == "quick-entry-code" ? .code : .chat
            let trusted = name != "quick-entry-no-accessibility"
            return FinalFixture(name: name, width: 656 + 48, view: {
                AnyView(
                    DesktopQuickEntryView(readTrust: { trusted }, dismiss: {}, startingProduct: product)
                        .padding(24)
                        .background(Color.junoCanvas)
                        .environment(\.junoSnapshotOpaqueGlass, true)
                )
            })

        // MARK: Outputs
        case "outputs-one":
            return outputsFixture(name, outputs: ChatSessionOutputs.read(
                artifacts: [artifact("a-plan", "Launch checklist", kind: .code, language: "python", content: launchScript)],
                messages: [message("r1", .assistant, model: "anthropic:claude-sonnet-4-6")]
            ))
        case "outputs-many":
            return outputsFixture(name, outputs: ChatSessionOutputs.read(
                artifacts: [
                    artifact("a-doc", "Launch brief", kind: .markdown, content: launchBrief, minutesAgo: 40),
                    artifact("a-code", "Readiness check", kind: .code, language: "python", content: launchScript, minutesAgo: 30),
                    artifact("a-svg", "Timeline", kind: .svg, content: timelineSVG, minutesAgo: 20),
                    artifact("a-design", "Sign-in screen", kind: .design, content: "{}", minutesAgo: 10),
                ],
                messages: [
                    message(
                        "q1", .user,
                        attachments: [
                            attachment("u1", "Q4 roadmap.pdf", mime: "application/pdf"),
                            attachment("u2", "pricing-notes.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                        ]
                    ),
                    message(
                        "r1", .assistant, model: "anthropic:claude-sonnet-4-6",
                        attachments: [
                            NativeChatAttachment(
                                id: PreviewImageFixtures.generatedID, fileName: "Launch poster.png", mimeType: "image/png",
                                kind: "IMAGE", size: 920_000, width: 1_024, height: 1_024
                            ),
                        ],
                        sources: [source("https://www.apple.com/newsroom/"), source("https://stripe.com/docs/billing")],
                        activity: [
                            NativeChatActivity(
                                id: "m", kind: .context, title: "", detail: nil, url: nil,
                                memory: [NativeMemoryReceipt(id: "f1", content: "Prefers tables", category: "Work style")]
                            ),
                            NativeChatActivity(
                                id: "t", kind: .tool, title: "", detail: nil, url: nil,
                                tool: NativeToolDetail(server: "GitHub", name: "list_issues")
                            ),
                        ]
                    ),
                    message("r2", .assistant, model: "openai:gpt-5"),
                ]
            ))
        case "outputs-used-only":
            return outputsFixture(name, outputs: ChatSessionOutputs.read(
                artifacts: [],
                messages: [
                    message("q1", .user, attachments: [attachment("u1", "board-minutes.pdf", mime: "application/pdf")]),
                    message(
                        "r1", .assistant, model: "anthropic:claude-sonnet-4-6",
                        sources: [source("https://www.bbc.co.uk/news"), source("https://www.ft.com/"), source("https://apnews.com/")]
                    ),
                ]
            ))

        // MARK: Account
        case "account-popover-free":
            return popoverFixture(name, width: DesktopAccountPopover.width) {
                AnyView(
                    DesktopAccountPopover(
                        name: "Liam Magnier", email: "crtn.tjb@gmail.com", avatarData: nil, imageURL: nil,
                        planName: "Free",
                        usage: DesktopAccountUsage(caption: "This week", readout: "37% used", fraction: 0.37, sentence: nil, tone: .quiet),
                        isOwner: false,
                        openSettings: {}, openUpgrade: {}, openAdmin: {}, openShortcuts: {}, signOut: {}
                    )
                )
            }
        case "account-popover-owner":
            return popoverFixture(name, width: DesktopAccountPopover.width) {
                AnyView(
                    DesktopAccountPopover(
                        name: "Liam Magnier", email: "crtn.tjb@gmail.com", avatarData: nil, imageURL: nil,
                        planName: "Owner",
                        usage: DesktopAccountUsage(
                            caption: "Messages", readout: "No cap", fraction: nil,
                            sentence: DesktopAccountUsage.uncappedSentence(isOwner: true), tone: .quiet
                        ),
                        isOwner: true,
                        openSettings: {}, openUpgrade: nil, openAdmin: {}, openShortcuts: {}, signOut: {}
                    )
                )
            }

        // MARK: Archived Chats
        case "archived-list":
            return archivedFixture(name, load: .ready(DesktopArchivedChats.rows(from: archived)))
        case "archived-empty":
            return archivedFixture(name, load: .ready([]))
        case "archived-error":
            return archivedFixture(name, load: .failed)
        case "archived-loading":
            return archivedFixture(name, load: .loading)

        // MARK: Window
        case "window-panel-over-chat":
            let model = DesktopSearchPanelModel()
            return FinalFixture(
                name: name,
                width: FinalSnapshotFixtures.windowWidth,
                view: {
                    world.showConversation()
                    let rows = DesktopCommandCatalog.rows(query: model.query, context: commandContext)
                    let width = DesktopSearchPanelMetrics.width(detailWidth: FinalSnapshotFixtures.detailWidth)
                    let height = DesktopSearchPanelMetrics.height(
                        listContent: DesktopSearchPanelMetrics.listContentHeight(rows),
                        showsFilters: false,
                        noticeCount: 0,
                        windowHeight: FinalSnapshotFixtures.windowHeight
                    )
                    return AnyView(
                        FinalSnapshotFixtures.window(world: world, fixedHeight: FinalSnapshotFixtures.windowHeight) {
                            VStack(spacing: 0) {
                                TranscriptSnapshotFixtures.column {
                                    TranscriptSnapshotFixtures.row(FinalSnapshotFixtures.comparisonQuestion)
                                    TranscriptSnapshotFixtures.row(FinalSnapshotFixtures.comparisonReply, newest: true)
                                }
                                .frame(maxHeight: .infinity, alignment: .top)
                                .clipped()
                                FinalSnapshotFixtures.composer(world: world)
                            }
                        }
                        .overlay(alignment: .topLeading) {
                            DesktopSearchPanel(model: model, rows: rows, projects: [], height: height, run: { _ in })
                                .frame(width: width, height: height)
                                .offset(
                                    x: FinalSnapshotFixtures.sidebarWidth + (FinalSnapshotFixtures.detailWidth - width) / 2,
                                    y: FinalSnapshotFixtures.toolbarHeight + DesktopSearchPanelMetrics.topOffset
                                )
                                .environment(\.junoSnapshotOpaqueGlass, true)
                        }
                    )
                },
                prepare: {
                    model.present(.commands)
                    model.setQuery("")
                }
            )
        default:
            return nil
        }
    }

    // MARK: Builders

    /// The panel at its own size on the canvas, with room for its throw.
    private static func panelFixture(
        _ name: String,
        model: DesktopSearchPanelModel,
        prepare: @escaping @MainActor () async -> Void
    ) -> FinalFixture {
        FinalFixture(
            name: name,
            width: DesktopSearchPanelMetrics.maxWidth + 64,
            view: {
                let rows: [DesktopPanelRow] = model.mode == .commands
                    ? DesktopCommandCatalog.rows(query: model.query, context: commandContext)
                    : model.searchRows(hooks: .none, now: now)
                let height = DesktopSearchPanelMetrics.height(
                    listContent: DesktopSearchPanelMetrics.listContentHeight(rows),
                    showsFilters: model.showsFilters,
                    noticeCount: model.notices.count,
                    windowHeight: 800
                )
                return AnyView(
                    DesktopSearchPanel(model: model, rows: rows, projects: projects, height: height, run: { _ in })
                        .frame(width: DesktopSearchPanelMetrics.maxWidth, height: height)
                        .padding(32)
                        .environment(\.junoSnapshotOpaqueGlass, true)
                )
            },
            prepare: prepare
        )
    }

    private static func shareFixture(
        _ name: String,
        prepare: @escaping @MainActor (DesktopShareState) async -> Void
    ) -> FinalFixture {
        let state = DesktopShareState()
        return FinalFixture(
            name: name,
            width: DesktopSharePopover.size.width + 48,
            view: { AnyView(popoverStandIn(DesktopSharePopover(state: state))) },
            prepare: { await prepare(state) }
        )
    }

    private static func outputsFixture(_ name: String, outputs: ChatSessionOutputs) -> FinalFixture {
        FinalFixture(
            name: name,
            width: DesktopOutputsPopover.width + 48,
            view: {
                AnyView(
                    popoverStandIn(
                        DesktopOutputsPopover(outputs: outputs, openArtifact: { _ in }, quickLook: { _ in })
                            .environment(\.junoTranscriptMedia, SnapshotMediaProvider())
                            .environment(\.junoDesignPreviews, SnapshotDesignProvider())
                    )
                )
            }
        )
    }

    private static func popoverFixture(_ name: String, width: CGFloat, view: @escaping @MainActor () -> AnyView) -> FinalFixture {
        FinalFixture(name: name, width: width + 48, view: { AnyView(popoverStandIn(view())) })
    }

    private static func archivedFixture(_ name: String, load: DesktopArchivedChats.Load) -> FinalFixture {
        FinalFixture(
            name: name,
            width: DesktopArchivedChatsSheet.size.width + 48,
            view: {
                AnyView(
                    DesktopArchivedChatsSheet(
                        load: load,
                        restore: { _ in true },
                        delete: { _ in true },
                        open: { _ in },
                        done: {}
                    )
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                            .fill(Color(nsColor: .windowBackgroundColor))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                            .strokeBorder(Color.junoBorder, lineWidth: 1)
                    )
                    .padding(24)
                    .junoAccentTint()
                )
            }
        )
    }

    /// A popover's own view at its frame, on a stand-in for the system's
    /// popover glass: the popover fill under a hairline, at the menu radius.
    private static func popoverStandIn<V: View>(_ content: V) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous)
                    .fill(Color.junoPopover)
                    .shadow(color: Color.junoCardShadow, radius: 12, y: 4)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .padding(24)
            .junoAccentTint()
    }

    // MARK: Data

    private static let chatTitles: [(String, Double)] = [
        ("Pricing for the Pro plan", 7),
        ("Q4 launch plan review", 52),
        ("Draft reply to the landlord", 190),
        ("Why the build is slow on CI", 1_460),
        ("Recipes for a small kitchen", 4_300),
        ("Notes from the product offsite", 11_000),
    ]

    static var commandContext: DesktopCommandCatalog.Context {
        DesktopCommandCatalog.Context(
            conversations: chatTitles.enumerated().map { index, entry in
                conversation("chat-\(index)", entry.0, minutesAgo: entry.1)
            },
            projects: projects,
            isDark: false,
            now: now
        )
    }

    static var projects: [NativeProject] {
        [
            project("p-launch", "Product launch", starred: true, minutesAgo: 90),
            project("p-home", "Home renovation", starred: false, minutesAgo: 2_900),
            project("p-thesis", "Thesis chapter 3", starred: false, minutesAgo: 9_000),
        ]
    }

    private static var archived: [NativeConversation] {
        [
            ("Flight options to Lisbon", 3.0),
            ("Old onboarding copy", 11.0),
            ("", 16.0),
            ("Tax documents checklist", 38.0),
            ("Interview questions for the design role", 64.0),
        ].enumerated().map { index, entry in
            var row = conversation("arch-\(index)", entry.0, minutesAgo: entry.1 * 1_440 + 400)
            row.archivedAt = now.addingTimeInterval(-entry.1 * 86_400)
            return row
        }
    }

    /// Search services over fixed data: the local store's chats, messages,
    /// files and artifacts, the server's knowledge, memory and tasks.
    private static func services() -> DesktopSearchPanelModel.Services {
        var services = DesktopSearchPanelModel.Services()
        services.localSearch = { _ in
            [
                localResult(.conversation, "chat-1", "Q4 launch plan review", minutesAgo: 52),
                localResult(
                    .message, "msg-7", "Q4 launch plan review",
                    snippet: "…so the launch plan slips a week unless the pricing page is signed off by Friday…",
                    conversation: "chat-1", minutesAgo: 60
                ),
                localResult(
                    .message, "msg-9", "Pricing for the Pro plan",
                    snippet: "…align the Pro tiers with the launch plan before the press embargo lifts…",
                    conversation: "chat-0", minutesAgo: 9
                ),
                localResult(.file, "file-2", "Launch plan v3.pdf", conversation: "chat-1", minutesAgo: 70),
                localResult(.artifact, "a-plan", "Launch plan timeline", conversation: "chat-1", minutesAgo: 55),
            ]
        }
        services.serverSearch = { query, _, _, _ in
            NativeUnifiedSearchResult(
                query: query,
                groups: [
                    NativeSearchGroup(type: .knowledge, label: "Knowledge", hits: [
                        NativeSearchHit(
                            id: "knowledge:k1", type: .knowledge, title: "Go-to-market playbook.pdf",
                            snippet: NativeSearchSnippet(
                                text: "…the launch plan owns the date; marketing owns the message…",
                                marks: [NativeSearchMark(start: 5, end: 11), NativeSearchMark(start: 12, end: 16)]
                            ),
                            href: "/projects/p-launch?doc=d1&block=b4", locator: "Page 4", updatedAt: now.addingTimeInterval(-86_400 * 3)
                        ),
                    ]),
                    NativeSearchGroup(type: .memory, label: "Memory", hits: [
                        NativeSearchHit(
                            id: "memory:m1", type: .memory, title: "Wants every launch plan as a dated table",
                            titleMarks: [NativeSearchMark(start: 16, end: 22), NativeSearchMark(start: 23, end: 27)],
                            href: "/memory?entry=m1", updatedAt: now.addingTimeInterval(-86_400 * 12)
                        ),
                    ]),
                    NativeSearchGroup(type: .work, label: "Tasks", hits: [
                        NativeSearchHit(
                            id: "work:s1", type: .work, title: "Compile the launch plan from Linear",
                            titleMarks: [NativeSearchMark(start: 16, end: 22), NativeSearchMark(start: 23, end: 27)],
                            href: "/chat/chat-1", locator: "done", updatedAt: now.addingTimeInterval(-86_400 * 2)
                        ),
                    ]),
                ],
                total: 3,
                coverage: [],
                partial: false
            )
        }
        services.recents = {
            [
                NativeRecentItem(id: "chat-0", kind: "chat", title: "Pricing for the Pro plan", updatedAt: now.addingTimeInterval(-420), href: "/chat/chat-0"),
                NativeRecentItem(id: "s-4", kind: "work", title: "Compile the launch plan from Linear", updatedAt: now.addingTimeInterval(-2_400), href: "/chat/chat-1"),
                NativeRecentItem(id: "chat-1", kind: "chat", title: "Q4 launch plan review", updatedAt: now.addingTimeInterval(-3_120), href: "/chat/chat-1"),
                NativeRecentItem(id: "p-launch", kind: "project", title: "Product launch", updatedAt: now.addingTimeInterval(-5_400), href: "/projects/p-launch"),
                NativeRecentItem(id: "c-code", kind: "code", title: "Fix the flaky upload test", updatedAt: now.addingTimeInterval(-9_600), href: "/chat/c-code"),
                NativeRecentItem(id: "chat-2", kind: "chat", title: "Draft reply to the landlord", updatedAt: now.addingTimeInterval(-11_400), href: "/chat/chat-2"),
                NativeRecentItem(id: "chat-3", kind: "chat", title: "Why the build is slow on CI", updatedAt: now.addingTimeInterval(-87_600), href: "/chat/chat-3"),
                NativeRecentItem(id: "p-home", kind: "project", title: "Home renovation", updatedAt: now.addingTimeInterval(-174_000), href: "/projects/p-home"),
            ]
        }
        services.localRecents = { [] }
        return services
    }

    private static func localResult(
        _ kind: NativeSearchResultKind,
        _ id: String,
        _ title: String,
        snippet: String = "",
        conversation: String? = nil,
        minutesAgo: Double
    ) -> NativeSearchResult {
        NativeSearchResult(
            kind: kind, entityID: id, conversationID: conversation ?? (kind == .conversation ? id : nil), title: title,
            snippet: snippet, score: 10, updatedAt: now.addingTimeInterval(-minutesAgo * 60)
        )
    }

    static func conversation(_ id: String, _ title: String, minutesAgo: Double) -> NativeConversation {
        let date = now.addingTimeInterval(-minutesAgo * 60)
        return NativeConversation(
            id: id, title: title, model: "auto", pinned: false, archivedAt: nil, createdAt: date, updatedAt: date,
            lastMessageAt: date, revision: 1
        )
    }

    private static func project(_ id: String, _ name: String, starred: Bool, minutesAgo: Double) -> NativeProject {
        let date = now.addingTimeInterval(-minutesAgo * 60)
        return NativeProject(
            id: id, name: name, instructions: "", starred: starred, createdAt: date, updatedAt: date, revision: 1
        )
    }

    private static func artifact(
        _ id: String,
        _ title: String,
        kind: NativeArtifactKind,
        language: String? = nil,
        content: String,
        minutesAgo: Double = 5
    ) -> NativeArtifact {
        let date = now.addingTimeInterval(-minutesAgo * 60)
        return NativeArtifact(
            id: id, conversationID: "chat-1", conversationTitle: "Q4 launch plan review", messageID: nil,
            identifier: id, title: title, kind: kind, language: language, currentVersion: 2,
            versions: [NativeArtifactVersion(id: "\(id)-v2", version: 2, content: content, origin: nil, createdAt: date)],
            createdAt: date, updatedAt: date, revision: 2
        )
    }

    private static func attachment(_ id: String, _ name: String, mime: String) -> NativeChatAttachment {
        NativeChatAttachment(id: id, fileName: name, mimeType: mime, kind: "DOCUMENT", size: 184_320, width: nil, height: nil)
    }

    private static func source(_ url: String) -> NativeChatSource {
        NativeChatSource(title: "Source", url: URL(string: url)!, snippet: "", cited: true)
    }

    private static func message(
        _ id: String,
        _ role: NativeChatRole,
        model: String? = nil,
        attachments: [NativeChatAttachment] = [],
        sources: [NativeChatSource] = [],
        activity: [NativeChatActivity] = []
    ) -> NativeChatMessage {
        NativeChatMessage(
            id: id, conversationID: "chat-1", clientID: nil, role: role, content: "", reasoning: nil, model: model,
            createdAt: now.addingTimeInterval(-600), revision: 1, sources: sources, attachments: attachments,
            activity: activity
        )
    }

    private static let launchScript = """
        from datetime import date

        CHECKS = [
            ("Pricing page signed off", date(2026, 10, 2)),
            ("Press embargo confirmed", date(2026, 10, 6)),
            ("Support macros drafted", date(2026, 10, 7)),
        ]

        def overdue(today: date) -> list[str]:
            return [name for name, due in CHECKS if due < today]

        print(overdue(date.today()))
        """

    private static let launchBrief = """
        # Launch brief

        **Date:** Tuesday 13 October
        **Owner:** Growth

        ## What ships
        - Pro and Max plans with yearly billing
        - The new onboarding
        - A refreshed pricing page

        ## Risks
        The press embargo lifts before the help centre is updated.
        """

    private static let timelineSVG = """
        <svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">\
        <rect width="320" height="180" fill="#fbf7f0"/>\
        <line x1="24" y1="90" x2="296" y2="90" stroke="#8a8578" stroke-width="2"/>\
        <circle cx="48" cy="90" r="8" fill="#ea580c"/><circle cx="128" cy="90" r="8" fill="#8a8578"/>\
        <circle cx="208" cy="90" r="8" fill="#8a8578"/><circle cx="288" cy="90" r="8" fill="#8a8578"/>\
        <text x="48" y="126" font-family="Helvetica" font-size="13" text-anchor="middle" fill="#3d3a33">Oct 2</text>\
        <text x="128" y="126" font-family="Helvetica" font-size="13" text-anchor="middle" fill="#3d3a33">Oct 6</text>\
        <text x="208" y="126" font-family="Helvetica" font-size="13" text-anchor="middle" fill="#3d3a33">Oct 7</text>\
        <text x="288" y="126" font-family="Helvetica" font-size="13" text-anchor="middle" fill="#3d3a33">Oct 13</text>\
        </svg>
        """
}

/// A share service that answers one way, or never.
@MainActor
private final class SnapshotShareService: DesktopShareService {
    enum Outcome { case share, blocked, failed, pending }

    let outcome: Outcome

    init(outcome: Outcome) {
        self.outcome = outcome
    }

    func create(_ target: DesktopShareTarget) async throws -> NativeShare {
        switch outcome {
        case .share:
            return NativeShare(
                id: "s-1", kind: "CHAT", token: "k7Qp2vXw",
                url: URL(string: "https://juno.liammagnier.com/s/k7Qp2vXwR4mTz9")!,
                title: "Q4 launch plan review",
                snapshotAt: Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 9, day: 22, hour: 10)),
                views: 14, createdAt: nil
            )
        case .blocked:
            throw NativeShareError.blocked(nil)
        case .failed:
            throw NativeShareError.failed
        case .pending:
            try await Task.sleep(for: .seconds(600))
            throw NativeShareError.failed
        }
    }

    func revoke(shareID: String) async throws {}
}
