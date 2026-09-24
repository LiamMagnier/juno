import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import JunoSync
import JunoWorkKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// The Phase 2 sign-off set: the Chat window as a reader meets it, drawn
/// offscreen in both appearances — the transcript at a window's width beside
/// the sidebar, the kinds of reply Phase 2 added, and Phase 1's empty chat and
/// sidebar, which the transcript now sits between.
///
/// Off by default: set `JUNO_FINAL_SNAPSHOT_DIR` (through xcodebuild, as
/// `TEST_RUNNER_JUNO_FINAL_SNAPSHOT_DIR`) and the suite writes
/// `<dir>/<name>-<light|dark>.png`. Nothing is put on screen, as with
/// ``TranscriptSnapshotTests``.
///
/// **What the offscreen renderer cannot draw.** Liquid Glass is composited by
/// the window server. The composer's shell is drawn with its Reduce
/// Transparency recipe (``SwiftUI/EnvironmentValues/junoSnapshotOpaqueGlass``)
/// and the sidebar's glass not at all — its rows sit on the canvas — and the
/// toolbar, which belongs to a titled window, is absent. Everything in the
/// reading column is opaque and is drawn as the app draws it.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"] != nil,
        "Set JUNO_FINAL_SNAPSHOT_DIR to render the Phase 2 sign-off set."
    ),
    .serialized
)
struct FinalSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"]!)
    }

    @Test(arguments: FinalSnapshotFixtures.names)
    func drawsInBothAppearances(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.shared()
        let fixture = try #require(FinalSnapshotFixtures.fixture(named: name, world: world))
        if let prepare = fixture.prepare {
            try await prepare()
        }
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                fixture.view(),
                name: fixture.name,
                width: fixture.width,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

/// The preview harness's world — a throwaway encrypted store and a sender
/// that never touches the network (`PreviewWorld`) — with the configuration
/// the app's own preview root builds from it, so the sidebar and the
/// composer are the production views over fixture data.
@MainActor
final class SnapshotPreviewWorld {
    let world: PreviewWorld
    let configuration: JunoDesktopConfiguration

    private static var instance: SnapshotPreviewWorld?

    static func shared() async throws -> SnapshotPreviewWorld {
        if let instance { return instance }
        let world = try PreviewWorld(scenario: .normal)
        await world.activate()
        let made = SnapshotPreviewWorld(world: world)
        instance = made
        return made
    }

    private init(world: PreviewWorld) {
        self.world = world
        let sender = world.chatTransport
        configuration = JunoDesktopConfiguration(
            authModel: NativeAuthModel(configurationErrorDescription: "UI Preview"),
            runtime: nil,
            localStore: nil,
            syncModel: world.syncModel,
            outbox: nil,
            attachmentModel: world.attachmentModel,
            workAttachmentModel: world.attachmentModel,
            workContextAttachmentModel: world.attachmentModel,
            avatarModel: nil,
            conversationModel: world.conversationModel,
            privateChatModel: world.privateChatModel,
            generateClient: nil,
            projectModel: world.projectModel,
            artifactModel: world.artifactModel,
            memorySettingsModel: world.memorySettingsModel,
            searchModel: world.searchModel,
            connectorModel: world.connectorModel,
            scheduledTaskModel: world.scheduledTaskModel,
            codeModel: nil,
            remoteCodeModel: nil,
            codeHostModel: nil,
            workModel: nil,
            workAutomationModel: nil,
            workHostModel: nil,
            libraryModel: world.libraryModel,
            requestSender: sender,
            accountDataClient: world.accountDataClient,
            voiceTranscriptClient: nil,
            messageActionsClient: NativeMessageActionsClient(sender: sender),
            followUpClient: nil,
            pullsClient: nil,
            shareClient: nil
        )
    }

    /// A new chat: no conversation selected, the draft open.
    func showDraft() {
        world.conversationModel.isDraftingNewConversation = true
        world.conversationModel.selectedConversationID = nil
    }

    /// The first saved chat selected, as the window opens on it.
    func showConversation() {
        world.conversationModel.isDraftingNewConversation = false
        world.conversationModel.selectedConversationID = "conv-1"
    }
}

struct FinalFixture {
    let name: String
    var width: CGFloat = 832
    let view: @MainActor () -> AnyView
    var prepare: (@MainActor () async throws -> Void)? = nil
}

/// The pictures of the sign-off set.
enum FinalSnapshotFixtures {
    static let names = [
        "window-transcript",
        "generated-image",
        "file-cards",
        "artifact-html",
        "design-output",
        "notes-error-and-finish",
        "window-empty-chat",
        "sidebar",
        // main's Agents (docs/design/AGENTS.md), as merged: the roster inside
        // the redesigned shell. Its visual pass is track B; this is the
        // record of how it lands before that.
        "window-agents",
    ]

    /// A window's size: the spec's 1240-point acceptance window (§10.1), its
    /// sidebar at the ideal 304 (§2.1) and the detail column taking the rest.
    static let windowWidth: CGFloat = 1240
    static let windowHeight: CGFloat = 800
    static let sidebarWidth: CGFloat = 304
    static var detailWidth: CGFloat { windowWidth - sidebarWidth }
    /// The titled window's toolbar band, which an offscreen borderless window
    /// does not have: left empty, so nothing sits flush against the top edge
    /// that would not on screen.
    static let toolbarHeight: CGFloat = 52

    private typealias T = TranscriptSnapshotFixtures

    @MainActor
    static func fixture(named name: String, world: SnapshotPreviewWorld) -> FinalFixture? {
        switch name {
        case "window-transcript":
            return FinalFixture(name: name, width: windowWidth, view: {
                world.showConversation()
                return AnyView(window(world: world, fixedHeight: nil) {
                    VStack(spacing: 0) {
                        T.column {
                            T.row(comparisonQuestion)
                            T.row(comparisonReply, newest: true)
                        }
                        composer(world: world)
                    }
                })
            })
        case "generated-image":
            return FinalFixture(name: name, view: {
                AnyView(T.column {
                    T.row(T.posterQuestion)
                    T.row(T.generatedImage, newest: true)
                })
            })
        case "file-cards":
            return FinalFixture(name: name, view: {
                AnyView(T.column {
                    T.row(T.message("q-docs", .user, "Can you turn the forecast into a workbook and a short deck for Monday?"))
                    T.row(documentsReply, newest: true)
                })
            })
        case "artifact-html":
            return FinalFixture(name: name, view: {
                AnyView(T.column(resolver: T.pricingResolver) {
                    T.row(T.message("q-pricing", .user, "Make me a pricing card for the Pro plan."))
                    T.row(T.artifactReply(streaming: false), newest: true)
                })
            }, prepare: {
                try await SnapshotStillCache.shared.prepareArtifact(kind: .html, content: T.pricingCard)
            })
        case "design-output":
            return FinalFixture(name: name, view: {
                AnyView(T.column(resolver: T.designResolver) {
                    T.row(T.message("q-design", .user, "Design a sign-in screen for the phone."))
                    T.row(T.designReply, newest: true)
                })
            }, prepare: {
                try await SnapshotStillCache.shared.prepareDesign(svg: PreviewFixtures.designSVG)
            })
        case "notes-error-and-finish":
            // Two transcripts, one over the other: a reply that failed with
            // nothing to show (Try again on the error), and a reply that
            // stopped at its token limit (Continue on the note). Each is the
            // newest reply of its own conversation.
            return FinalFixture(name: name, view: {
                AnyView(VStack(spacing: 0) {
                    T.column {
                        T.row(T.question)
                        T.row(
                            T.reply.with {
                                $0.content = ""
                                $0.errorDescription = "The model provider is overloaded. Try again in a moment."
                                $0.finishReason = .error
                            },
                            newest: true,
                            retries: true
                        )
                    }
                    Rectangle()
                        .fill(Color.junoBorder)
                        .frame(height: 1)
                        .padding(.horizontal, JunoSpace.region)
                    T.column {
                        T.row(T.question.with { $0.id = "q-long"; $0.content = "Write the whole migration guide, every step." })
                        T.row(
                            T.reply.with { $0.id = "a-long"; $0.finishReason = .length },
                            newest: true,
                            continues: true
                        )
                    }
                })
            })
        case "window-empty-chat":
            return FinalFixture(name: name, width: windowWidth, view: {
                world.showDraft()
                return AnyView(window(world: world, fixedHeight: windowHeight) {
                    DesktopConversationView(
                        model: world.world.conversationModel,
                        attachmentModel: world.world.attachmentModel,
                        profileName: "Liam",
                        configuration: world.configuration,
                        session: world.world.session,
                        draftProjectID: .constant(nil),
                        draftPrompt: .constant(nil),
                        composerRequest: .constant(nil),
                        findCommand: .constant(nil),
                        openDestination: { _ in }
                    )
                    .frame(height: windowHeight - toolbarHeight)
                })
            })
        case "window-agents":
            let agents = NativeAgentsModel(client: NativeAgentsClient(sender: SnapshotAgentsSender()))
            return FinalFixture(
                name: name,
                width: windowWidth,
                view: {
                    AnyView(window(world: world, fixedHeight: windowHeight, selection: .destination(.agents)) {
                        NativeAgentsScreen(model: agents, openConversation: { _ in })
                            .frame(height: windowHeight - toolbarHeight)
                    })
                },
                prepare: {
                    world.showDraft()
                    await agents.start(for: world.world.accountID)
                }
            )
        case "sidebar":
            return FinalFixture(name: name, width: sidebarWidth, view: {
                world.showConversation()
                return AnyView(
                    sidebar(world: world, selection: .conversation("conv-1"))
                        .frame(height: windowHeight)
                )
            })
        default:
            return nil
        }
    }

    // MARK: - The window

    /// The sidebar beside a detail column, as the Chat window lays them out,
    /// the detail column on the canvas and tinted as `ChatDetail` tints it.
    @MainActor
    static func window<Detail: View>(
        world: SnapshotPreviewWorld,
        fixedHeight: CGFloat?,
        selection: DesktopSidebarItem? = nil,
        @ViewBuilder detail: () -> Detail
    ) -> some View {
        detail()
            .frame(width: detailWidth)
            .frame(height: fixedHeight.map { $0 - toolbarHeight }, alignment: .top)
            .padding(.top, toolbarHeight)
            .background(Color.junoCanvas)
            .junoAccentTint()
            .padding(.leading, sidebarWidth)
            // Behind the detail column, so it is exactly as tall as the
            // window's content — a list has no height of its own to offer.
            .background(alignment: .topLeading) {
                sidebar(world: world, selection: selection)
                    .frame(width: sidebarWidth)
            }
            .environment(\.junoSnapshotOpaqueGlass, true)
    }

    @MainActor
    static func sidebar(world: SnapshotPreviewWorld, selection: DesktopSidebarItem?) -> some View {
        DesktopChatSidebar(
            model: world.world.conversationModel,
            projectModel: world.world.projectModel,
            configuration: world.configuration,
            session: world.world.session,
            product: .constant(.chat),
            destination: .constant(.chat),
            selection: .constant(selection),
            renamingConversationID: .constant(nil),
            openProjectID: nil,
            actions: DesktopConversationActions(
                rename: { _ in },
                commitRename: { _, _ in },
                togglePin: { _ in },
                move: { _, _ in },
                newProject: { _ in },
                openProject: { _ in },
                share: { _ in },
                canShare: { _ in true },
                archive: { _, _ in },
                delete: { _ in }
            ),
            newChat: {},
            newChatInProject: { _ in },
            openSearch: {}
        )
        // The column's material is system glass, which cannot be drawn
        // offscreen; the list's own fallback is a cool grey. Its rows are
        // shown on the web's recessed column (`--sidebar`), the tone the
        // glass is meant to read as (errata 3), under the toolbar's band.
        .scrollContentBackground(.hidden)
        .padding(.top, toolbarHeight)
        .background(Color.junoSidebar)
        .environment(\.junoSnapshotOpaqueGlass, true)
    }

    /// The composer docked under a conversation, at rest.
    @MainActor
    static func composer(world: SnapshotPreviewWorld) -> some View {
        ChatComposerDock(
            lift: ChatComposerLift.resting,
            gutter: DesktopChatMeasure.gutter(forColumnWidth: detailWidth)
        ) {
            EmptyView()
        } composer: {
            ChatComposer(
                model: world.world.conversationModel,
                attachmentModel: world.world.attachmentModel,
                libraryModel: world.world.libraryModel,
                projectModel: world.world.projectModel,
                workspaceModel: nil,
                documentIndex: nil,
                connectorModel: world.world.connectorModel,
                memorySettings: world.world.memorySettingsModel,
                draftProjectID: .constant(nil),
                draftPrompt: .constant(nil),
                openVoiceMode: { _ in }
            )
        } footer: {
            EmptyView()
        }
        .padding(.top, JunoSpace.cozy)
    }

    // MARK: - Content

    /// A photo and a page of notes, asked about together.
    static let comparisonQuestion = T.comparisonQuestion.with {
        $0.content = "Can you compare these? The photo is from last night and the notes are my brightness readings."
    }

    /// A settled research-style answer: the run, prose, a table, code, cited
    /// sources and the five actions.
    static let comparisonReply = T.message(
        "a-compare",
        .assistant,
        """
        ## What each one shows

        The photo is a wide-field shot taken at dusk. The horizon glow is still bright enough to wash out anything fainter than about magnitude 4, so it can't confirm the flare on its own. The notes are the better record: timed readings, each against a named comparison star [1].

        | Reading | Time (UTC) | Magnitude | Comparison star |
        | --- | --- | --- | --- |
        | 1 | 21:04 | 14.2 | HD 11820 |
        | 2 | 21:19 | 13.9 | HD 11820 |
        | 3 | 21:36 | 13.6 | HD 11946 |

        That is a brightening of about 0.6 magnitudes in half an hour, which is within what has been reported for this source [2]. To check the rate yourself:

        ```python
        readings = [(21.07, 14.2), (21.32, 13.9), (21.60, 13.6)]
        (start, first), (end, last) = readings[0], readings[-1]
        print(f"{(last - first) / (end - start):.2f} mag per hour")
        ```

        A negative rate means the source is getting brighter.
        """,
        model: "anthropic:claude-sonnet-4-6"
    ).with {
        $0.promptTokens = 6_204
        $0.completionTokens = 488
        $0.costUSD = 0.0162
        $0.sources = [
            ("Measuring variable stars", "https://www.aavso.org/variable-star-observing-manual"),
            ("Quasar variability", "https://en.wikipedia.org/wiki/Quasar"),
            ("Comparison star charts", "https://www.aavso.org/apps/vsp/"),
        ].map {
            NativeChatSource(
                title: $0.0,
                url: URL(string: $0.1)!,
                snippet: "Estimate the brightness against two comparison stars of known magnitude.",
                cited: true
            )
        }
        $0.reasoning = "**Reading the notes first**\n\nThe photo can't resolve the source; the notes carry the numbers."
        $0.activity = [
            T.activityEvent("c-model", .model, "Selected model", detail: "Anthropic · Claude Sonnet 4.6", at: 0),
            T.activityEvent("c-write", .write, "Writing the answer", detail: "Streaming response text", at: 9.2),
            T.activityEvent("c-done", .done, "Finished response", detail: "3 sources", at: 14),
        ]
    }

    /// A reply that produced two documents: a workbook and a deck.
    static let documentsReply = T.message(
        "a-docs",
        .assistant,
        "Here's the workbook with the quarter broken out by month, and a five-slide deck that walks through it.",
        model: "anthropic:claude-sonnet-4-6"
    ).with {
        $0.attachments = T.workbookReply.attachments + T.deckReply.attachments
    }
}

/// `/api/agents` for the Agents picture: three agents in the three states a
/// roster is scanned for — one waiting on the reader, one at work, one idle.
/// Everything else answers 404, which the model reads as "not there".
private struct SnapshotAgentsSender: NativeAuthenticatedRequestSending {
    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        let headers = try HTTPHeaders(["content-type": "application/json"])
        guard request.path == "/api/agents" else {
            return HTTPResponse(statusCode: 404, headers: headers, body: Data("{}".utf8))
        }
        return HTTPResponse(statusCode: 200, headers: headers, body: Data(Self.roster.utf8))
    }

    private static let roster = """
    {"agents": [
      {"id": "agent-iris", "name": "Iris", "role": "Research lead",
       "avatar": {"shape": "orb", "tone": "violet", "eyes": "soft", "mark": "spark"},
       "style": "warm", "createdAt": "2026-09-20T09:00:00Z", "updatedAt": "2026-09-24T08:00:00Z",
       "state": "waiting", "stateSentence": "Needs your call on the vendor shortlist", "needsYou": 1, "sortOrder": 0},
      {"id": "agent-otto", "name": "Otto", "role": "Inbox triage",
       "avatar": {"shape": "pebble", "tone": "juniper", "eyes": "round", "mark": "none"},
       "style": "warm", "createdAt": "2026-09-19T09:00:00Z", "updatedAt": "2026-09-24T08:30:00Z",
       "state": "working", "stateSentence": "Sorting this morning’s mail", "sortOrder": 1},
      {"id": "agent-wren", "name": "Wren", "role": "Weekly digest",
       "avatar": {"shape": "capsule", "tone": "amber", "eyes": "tall", "mark": "leaf"},
       "style": "warm", "createdAt": "2026-09-18T09:00:00Z", "updatedAt": "2026-09-23T18:00:00Z",
       "state": "idle", "stateSentence": "Next digest on Friday", "sortOrder": 2}
    ]}
    """
}
