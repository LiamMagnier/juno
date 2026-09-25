import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI

@testable import JunoDesktop

/// One picture the snapshot suite takes, in both appearances.
struct TranscriptFixture {
    let name: String
    /// The Phase 2 stage whose renderer this fixture was written for. Earlier
    /// stages render what the transcript draws today, so each stage's change
    /// shows up as a difference in a picture that already existed.
    let stage: Int
    let view: @MainActor () -> AnyView
    /// Work to finish before the picture is taken — the web stills an
    /// artifact fixture draws from (``SnapshotStillCache``).
    var prepare: (@MainActor () async throws -> Void)? = nil
}

/// The transcript fixtures of §2.5 of the Phase 2 brief: `NativeChatMessage`
/// values, no store, drawn through the real ``DesktopMessageRow`` inside the
/// real ``TranscriptColumn``.
///
/// Not main-actor isolated as a whole, so Swift Testing can read the fixture
/// names as test arguments; everything that builds a view is.
enum TranscriptSnapshotFixtures {
    static var all: [TranscriptFixture] {
        replyActions + userTurns + media + artifacts + visuals + prose + notes + activity + stageFour + stageFourB
    }

    // MARK: 1. Reply actions

    static var replyActions: [TranscriptFixture] {
        [
            TranscriptFixture(name: "reply-actions", stage: 1) {
                AnyView(column {
                    row(question)
                    row(reply, newest: true)
                })
            },
            TranscriptFixture(name: "reply-actions-rated", stage: 1) {
                AnyView(column {
                    row(reply.with { $0.feedback = .up }, newest: true)
                })
            },
            TranscriptFixture(name: "reply-actions-copied", stage: 1) {
                AnyView(column {
                    row(reply, newest: true)
                }
                .environment(\.junoSnapshotCopied, true))
            },
            // The three states in one transcript, top to bottom: an older
            // reply under the pointer (its row faded in), an older reply at
            // rest (no row), and the newest reply, whose row is always there.
            TranscriptFixture(name: "reply-actions-older-hover", stage: 1) {
                AnyView(column {
                    row(shortReply.with { $0.id = "a-1" })
                        .environment(\.junoSnapshotHover, true)
                    row(question.with { $0.id = "q-2"; $0.content = "And for an app?" })
                    row(shortReply.with { $0.id = "a-2" })
                    row(question.with { $0.id = "q-3"; $0.content = "Which of those matters most?" })
                    row(shortReply.with { $0.id = "a-3" }, newest: true)
                })
            },
            // The menu triggers as they look while their menu is open (a
            // menu itself cannot be drawn offscreen), beside a thumb that is
            // on and a pager at its first version.
            TranscriptFixture(name: "reply-actions-states", stage: 1) {
                AnyView(column {
                    HStack(spacing: 0) {
                        MessageVersionPager(
                            position: NativeMessageBranchPosition(index: 0, siblingMessageIDs: ["a", "b"]),
                            isEnabled: true,
                            step: { _ in }
                        )
                        MessageActionButton("Good response", icon: .thumbsUp, isOn: true) {}
                        MessageActionButton("Bad response", icon: .thumbsDown) {}
                        MessageRegenerateMenu(
                            items: [.tryAgain],
                            models: [],
                            currentModelID: nil,
                            isOpen: true,
                            regenerate: { _ in }
                        )
                        MessageMoreMenu(items: [.quote], actions: MessageRowActions(), isOpen: true)
                        MessageMoreMenu(items: [.quote], actions: MessageRowActions(), isOpen: false, isBranching: true)
                    }
                })
            },
            // A regenerated reply: the server keeps two earlier versions, and
            // the live row is the last of three pages.
            TranscriptFixture(name: "reply-actions-versions", stage: 5) {
                AnyView(column {
                    row(reply.with { $0.versionCount = 2 }, newest: true)
                })
            },
            TranscriptFixture(name: "reply-actions-pager", stage: 1) {
                AnyView(column {
                    row(
                        reply,
                        newest: true,
                        branch: NativeMessageBranchPosition(
                            index: 1,
                            siblingMessageIDs: ["a-0", "a-1", "a-2"]
                        )
                    )
                })
            },
        ]
    }

    // MARK: 2. The reader's turn

    static var userTurns: [TranscriptFixture] {
        [
            TranscriptFixture(name: "user-image-pdf", stage: 2) {
                AnyView(column { row(comparisonQuestion) })
            },
            TranscriptFixture(name: "user-image-pdf-hover", stage: 1) {
                AnyView(column { row(comparisonQuestion) }
                    .environment(\.junoSnapshotHover, true))
            },
            TranscriptFixture(name: "user-long-collapsed", stage: 1) {
                AnyView(column { row(longQuestion) }
                    .environment(\.junoSnapshotHover, true))
            },
            // The bubble opened for rewriting: the editor's lines should sit
            // on the bubble's 1.7 rhythm, with Cancel and Send under it.
            TranscriptFixture(name: "user-editing", stage: 5) {
                AnyView(column {
                    SnapshotEditingRow(message: question.with {
                        $0.content = "What makes a good README for a Swift package?\nAnd how long should it be before it stops being read?"
                    })
                })
            },
            TranscriptFixture(name: "user-unsent", stage: 1) {
                AnyView(column { row(question, unsent: true) })
            },
            // Files with no words: the tiles alone, and no empty bubble.
            TranscriptFixture(name: "user-attachments-only", stage: 2) {
                AnyView(column { row(filesOnlyQuestion) })
            },
        ]
    }

    // MARK: 3–6. Media and files

    static var media: [TranscriptFixture] {
        [
            TranscriptFixture(name: "generated-image", stage: 2) {
                AnyView(column {
                    row(posterQuestion)
                    row(generatedImage, newest: true)
                })
            },
            TranscriptFixture(name: "generated-image-loading", stage: 2) {
                AnyView(column(media: SnapshotMediaProvider(pictures: .loading)) {
                    row(posterQuestion)
                    row(generatedImage, newest: true)
                })
            },
            TranscriptFixture(name: "generated-image-failed", stage: 2) {
                AnyView(column(media: SnapshotMediaProvider(pictures: .failed)) {
                    row(posterQuestion)
                    row(generatedImage, newest: true)
                })
            },
            TranscriptFixture(name: "generated-image-hover", stage: 2) {
                AnyView(column {
                    row(posterQuestion)
                    row(generatedImage, newest: true)
                }
                .environment(\.junoSnapshotHover, true))
            },
            TranscriptFixture(name: "media-placeholder", stage: 2) {
                AnyView(column {
                    row(placeholder(NativeMediaProgress(modality: .image, stage: "generating", pct: 40)), newest: true)
                })
            },
            TranscriptFixture(name: "media-placeholder-video", stage: 2) {
                AnyView(column {
                    row(placeholder(NativeMediaProgress(modality: .video, stage: "queued", pct: nil)), newest: true)
                })
            },
            TranscriptFixture(name: "file-card-xlsx", stage: 2) {
                AnyView(column { row(workbookReply, newest: true) })
            },
            TranscriptFixture(name: "file-card-pptx", stage: 2) {
                AnyView(column { row(deckReply, newest: true) })
            },
            TranscriptFixture(name: "file-card-pptx-extension-only", stage: 2) {
                AnyView(column(media: SnapshotMediaProvider(previews: [:])) {
                    row(deckReply, newest: true)
                })
            },
            // A clip, as an offscreen window can draw one: the card and its
            // footer with the stage still preparing.
            TranscriptFixture(name: "generated-video", stage: 2) {
                AnyView(column {
                    row(clipQuestion)
                    row(generatedVideo, newest: true)
                })
            },
        ]
    }

    // MARK: 7–8. Artifacts and designs

    static var artifacts: [TranscriptFixture] {
        [
            TranscriptFixture(name: "artifact-html", stage: 3, view: {
                AnyView(column(resolver: pricingResolver) { row(artifactReply(streaming: false), newest: true) })
            }, prepare: {
                try await SnapshotStillCache.shared.prepareArtifact(kind: .html, content: pricingCard)
            }),
            TranscriptFixture(name: "artifact-html-streaming", stage: 3) {
                AnyView(column { row(artifactReply(streaming: true), newest: true) })
            },
            TranscriptFixture(name: "artifact-html-code", stage: 3, view: {
                AnyView(column(resolver: pricingResolver, artifactView: .code) {
                    row(artifactReply(streaming: false), newest: true)
                })
            }, prepare: {
                try await SnapshotStillCache.shared.prepareArtifact(kind: .html, content: pricingCard)
            }),
            TranscriptFixture(name: "artifact-html-console-error", stage: 3, view: {
                AnyView(column(artifactView: .console) { row(brokenArtifactReply, newest: true) })
            }, prepare: {
                try await SnapshotStillCache.shared.prepareArtifact(kind: .html, content: brokenCard)
            }),
            TranscriptFixture(name: "artifact-html-console-error-preview", stage: 3, view: {
                AnyView(column { row(brokenArtifactReply, newest: true) })
            }, prepare: {
                try await SnapshotStillCache.shared.prepareArtifact(kind: .html, content: brokenCard)
            }),
            TranscriptFixture(name: "artifact-updated", stage: 3, view: {
                AnyView(column(resolver: pricingResolver) { row(revisedArtifactReply, newest: true) })
            }, prepare: {
                try await SnapshotStillCache.shared.prepareArtifact(kind: .html, content: pricingCard)
            }),
            TranscriptFixture(name: "artifact-source-unavailable", stage: 3) {
                AnyView(column {
                    // A reply that stopped right after opening the tag: the
                    // card is settled, and there is no source to show.
                    row(message(
                        "a-empty",
                        .assistant,
                        "Here it is. <juno:artifact identifier=\"parser\" type=\"code\" language=\"swift\" title=\"Parser\">",
                        model: "anthropic:claude-sonnet-4-6"
                    ), newest: true)
                })
            },
            TranscriptFixture(name: "design-output", stage: 3, view: {
                AnyView(column(resolver: designResolver) { row(designReply, newest: true) })
            }, prepare: {
                try await SnapshotStillCache.shared.prepareDesign(svg: PreviewFixtures.designSVG)
            }),
            TranscriptFixture(name: "design-output-unavailable", stage: 3) {
                AnyView(column(resolver: designResolver, designs: SnapshotDesignProvider(state: .unavailable)) {
                    row(designReply, newest: true)
                })
            },
            TranscriptFixture(name: "canvas-dock-html", stage: 3, view: {
                AnyView(
                    DesktopArtifactCanvas(
                        artifact: DesktopChatArtifact(
                            reference: NativeMessageContent.ArtifactReference(
                                identifier: "pricing-card",
                                title: "Pricing card",
                                kind: "HTML",
                                language: nil,
                                streaming: false,
                                content: pricingCard
                            ),
                            stored: pricingArtifact
                        ),
                        close: {},
                        requestEdit: { _ in },
                        save: { _, _, _ in nil }
                    )
                    .frame(width: 520, height: 560)
                    .environment(\.junoWebPreviewStill, SnapshotStillCache.shared.webStills)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, JunoSpace.section)
                )
            }, prepare: {
                try await SnapshotStillCache.shared.prepareArtifact(kind: .html, content: pricingCard)
            }),
        ]
    }

    // MARK: Mermaid and juno-visual

    static var visuals: [TranscriptFixture] {
        [
            TranscriptFixture(name: "mermaid-figure", stage: 3, view: {
                AnyView(column { row(mermaidReply(closed: true), newest: true) })
            }, prepare: {
                try await SnapshotStillCache.shared.prepareMermaid(mermaidSource)
            }),
            TranscriptFixture(name: "mermaid-streaming", stage: 3) {
                AnyView(column { row(mermaidReply(closed: false), newest: true) })
            },
            TranscriptFixture(name: "juno-visual-flow", stage: 3) {
                AnyView(column { row(visualReply(flowVisual), newest: true) })
            },
            TranscriptFixture(name: "juno-visual-cards", stage: 3) {
                AnyView(column { row(visualReply(cardsVisual), newest: true) })
            },
            TranscriptFixture(name: "juno-visual-compare", stage: 3) {
                AnyView(column { row(visualReply(compareVisual), newest: true) })
            },
            TranscriptFixture(name: "juno-visual-quiz-timeline", stage: 3) {
                AnyView(column {
                    row(visualReply(quizVisual + "\n```\n\nAnd how it got here:\n\n```juno-visual\n" + timelineVisual), newest: true)
                })
            },
            TranscriptFixture(name: "juno-visual-callout-streaming", stage: 3) {
                AnyView(column {
                    row(message(
                        "a-visual-stream",
                        .assistant,
                        "The short version:\n\n```juno-visual\n\(calloutVisual)\n```\n\nAnd the long one is on its way:\n\n```juno-visual\n{\"type\":\"cards\",\"items\":[{\"title\":\"Half",
                        model: "anthropic:claude-sonnet-4-6"
                    ).with { $0.isPending = true }, newest: true)
                })
            },
        ]
    }

    // MARK: 9–11. Prose

    static var prose: [TranscriptFixture] {
        [
            TranscriptFixture(name: "code-block", stage: 4) {
                AnyView(column { row(codeReply, newest: true) })
            },
            TranscriptFixture(name: "code-block-long", stage: 4) {
                AnyView(column { row(longCodeReply, newest: true) })
            },
            TranscriptFixture(name: "table", stage: 4) {
                AnyView(column { row(tableReply, newest: true) })
            },
            TranscriptFixture(name: "table-wide", stage: 4) {
                AnyView(column { row(wideTableReply, newest: true) })
            },
            TranscriptFixture(name: "prose", stage: 4) {
                AnyView(column {
                    row(question)
                    row(proseReply, newest: true)
                })
            },
            TranscriptFixture(name: "prose-streaming", stage: 4) {
                AnyView(column {
                    row(proseReply.with {
                        $0.isPending = true
                        $0.content = String($0.content.prefix(620))
                        $0.runStartedAt = Date().addingTimeInterval(-9)
                        $0.answerStartedAt = Date().addingTimeInterval(-3)
                    }, newest: true, generating: true)
                })
            },
            TranscriptFixture(name: "sources-pill", stage: 4) {
                AnyView(column { row(sourcedReply, newest: true) })
            },
            TranscriptFixture(name: "sources-pill-expanded", stage: 4) {
                AnyView(column {
                    DesktopMessageSources(sources: sourcedReply.sources, startsExpanded: true)
                })
            },
            TranscriptFixture(name: "citations", stage: 4) {
                AnyView(column { row(citedReply, newest: true) })
            },
        ]
    }

    // MARK: 12. Notes and errors

    static var notes: [TranscriptFixture] {
        [
            TranscriptFixture(name: "error-note", stage: 4) {
                AnyView(column {
                    row(question)
                    row(
                        reply.with {
                            $0.content = ""
                            $0.errorDescription = "The model provider is overloaded. Try again in a moment."
                            $0.finishReason = .error
                        },
                        newest: true,
                        retries: true
                    )
                })
            },
            TranscriptFixture(name: "error-note-partial", stage: 4) {
                AnyView(column {
                    row(
                        shortReply.with {
                            $0.errorDescription = "The stream was interrupted. The partial answer was preserved."
                            $0.finishReason = .networkError
                        },
                        newest: true,
                        continues: true
                    )
                })
            },
            TranscriptFixture(name: "finish-note", stage: 4) {
                AnyView(column {
                    row(
                        reply.with { $0.finishReason = .length },
                        newest: true,
                        continues: true
                    )
                })
            },
            TranscriptFixture(name: "finish-note-stopped", stage: 4) {
                AnyView(column {
                    row(shortReply.with { $0.finishReason = .userStopped }, newest: true)
                })
            },
        ]
    }

    // MARK: 13. Activity

    static var activity: [TranscriptFixture] {
        [
            TranscriptFixture(name: "activity-live", stage: 4) {
                AnyView(column {
                    row(question)
                    row(placeholder(nil).with {
                        $0.model = "anthropic:claude-sonnet-4-6"
                        $0.runStartedAt = Date().addingTimeInterval(-14)
                        $0.reasoning = "The reader wants the parts of a README that matter for a package. Start with what it does and how to add it, then the smallest example that compiles."
                    }, newest: true, generating: true)
                })
            },
            TranscriptFixture(name: "activity-live-tools", stage: 4) {
                AnyView(column {
                    row(researchQuestion)
                    row(liveToolsReply, newest: true, generating: true)
                })
            },
            TranscriptFixture(name: "activity-settled", stage: 4) {
                AnyView(column {
                    row(settledReply, newest: true)
                })
            },
            TranscriptFixture(name: "activity-expanded", stage: 4) {
                AnyView(column {
                    row(settledToolReply, newest: true)
                }
                .environment(\.junoSnapshotRunExpanded, true))
            },
            TranscriptFixture(name: "activity-panel", stage: 4) {
                AnyView(
                    DesktopActivityPanel(message: settledToolReply, live: false, close: {})
                        .frame(width: 480, height: 640)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, JunoSpace.section)
                )
            },
            TranscriptFixture(name: "activity-panel-call", stage: 4) {
                AnyView(
                    DesktopActivityPanel(message: settledToolReply, live: false, focusCallID: "act-linear", close: {})
                        .frame(width: 480, height: 640)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, JunoSpace.section)
                )
            },
        ]
    }

    // MARK: Stage 4: approvals, follow-ups, find

    static var stageFour: [TranscriptFixture] {
        [
            TranscriptFixture(name: "approval-card", stage: 4) {
                AnyView(column {
                    row(question.with { $0.content = "File a Linear issue for the flaky login test." })
                    row(
                        placeholder(nil).with {
                            $0.model = "anthropic:claude-sonnet-4-6"
                            $0.runStartedAt = Date().addingTimeInterval(-6)
                        },
                        newest: true,
                        generating: true,
                        approvals: MessageRowApprovals(approvals: [pendingApproval])
                    )
                })
            },
            TranscriptFixture(name: "follow-ups", stage: 4) {
                AnyView(column {
                    row(shortReply, newest: true)
                    DesktopFollowUpChips(
                        conversationID: "conv-1",
                        replyID: shortReply.id,
                        accountID: try! AccountID("account-under-test"),
                        client: nil,
                        ready: true,
                        draftIsEmpty: true,
                        send: { _ in },
                        preset: [
                            "Show me a README template for a Swift package",
                            "What should the Installation section say for a package with platform requirements?",
                            "How long should a README be?",
                        ]
                    )
                })
            },
            TranscriptFixture(name: "find-highlight", stage: 4) {
                AnyView(column {
                    row(question)
                        .environment(\.junoFindHighlight, JunoFindHighlight(query: "readme", current: nil))
                    row(reply, newest: true)
                        .environment(\.junoFindHighlight, JunoFindHighlight(query: "readme", current: 0))
                    row(codeReply)
                        .environment(\.junoFindHighlight, JunoFindHighlight(query: "entry", current: 2))
                })
            },
            // The transcript's two glass sites, drawn with their opaque
            // stand-in (offscreen cannot composite glass): the find capsule
            // with a count and with none, and Scroll to latest.
            TranscriptFixture(name: "find-bar-query", stage: 4) {
                AnyView(
                    DesktopFindBar(query: .constant("readme"), current: 2, total: 12, next: {}, previous: {}, done: {})
                        .padding(24)
                        .frame(width: 560)
                        .background(Color.junoCanvas)
                        .environment(\.junoSnapshotOpaqueGlass, true)
                )
            },
            TranscriptFixture(name: "find-bar-no-matches", stage: 4) {
                AnyView(
                    DesktopFindBar(query: .constant("quasar flare"), current: nil, total: 0, next: {}, previous: {}, done: {})
                        .padding(24)
                        .frame(width: 560)
                        .background(Color.junoCanvas)
                        .environment(\.junoSnapshotOpaqueGlass, true)
                )
            },
            TranscriptFixture(name: "scroll-to-latest", stage: 4) {
                AnyView(
                    ScrollToLatestButton(isShown: true, action: {})
                        .padding(24)
                        .frame(width: 120)
                        .background(Color.junoCanvas)
                        .environment(\.junoSnapshotOpaqueGlass, true)
                )
            },
        ]
    }

    // MARK: - Building blocks

    /// The transcript's own column and rhythm around the rows, with the
    /// harness's pictures standing in for the network and an image model
    /// that edits, so a hovered picture shows Edit.
    @MainActor
    static func column<Content: View>(
        media: SnapshotMediaProvider = SnapshotMediaProvider(),
        resolver: ChatArtifactResolver = .empty,
        designs: SnapshotDesignProvider = SnapshotDesignProvider(),
        artifactView: InlineArtifactView? = nil,
        @ViewBuilder _ content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            content()
        }
        // The transcript's lazy stack takes the column's whole width; a plain
        // stack hugs its content, so it is told to.
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(TranscriptColumn())
        .padding(.vertical, JunoSpace.section)
        .environment(\.junoTranscriptMedia, media)
        .environment(\.junoTranscriptMediaActions, TranscriptMediaActions(editImage: { _ in }))
        .environment(\.junoArtifactResolver, resolver)
        .environment(\.junoDesignPreviews, designs)
        .environment(\.junoSnapshotArtifactView, artifactView)
        .environment(\.junoWebPreviewStill, SnapshotStillCache.shared.webStills)
        .environment(\.junoMermaidStill, SnapshotStillCache.shared.mermaidStills)
        // The accent the detail column tints with (`ChatDetail`): the one
        // prominent button a surface has wears it, as in the app.
        .junoAccentTint()
    }

    /// A row with every action a saved turn has, each doing nothing.
    @MainActor
    static func row(
        _ message: NativeChatMessage,
        newest: Bool = false,
        branch: NativeMessageBranchPosition? = nil,
        unsent: Bool = false,
        continues: Bool = false,
        generating: Bool = false,
        retries: Bool = false,
        approvals: MessageRowApprovals = MessageRowApprovals(),
        editRequest: UUID? = nil
    ) -> some View {
        var actions = MessageRowActions()
        actions.copy = { _ in }
        actions.setFeedback = { _ in }
        actions.readAloud = { _ in }
        actions.stopReading = {}
        actions.branch = {}
        actions.forkPrivately = {}
        actions.share = {}
        actions.quote = { _ in }
        actions.copyLink = {}
        if message.versionCount > 0 { actions.loadVersions = { [] } }
        actions.stepBranch = { _ in }
        if newest, message.role == .assistant { actions.regenerate = { _ in } }
        if continues { actions.continueResponse = {} }
        if retries { actions.retry = {} }
        if message.role == .assistant {
            actions.openActivity = { _ in }
            actions.openResearch = { _ in }
            if newest { actions.researchThis = { _ in } }
        }
        if unsent { actions.retrySend = {} }
        if message.role == .user { actions.editMessage = { _ in } }
        return DesktopMessageRow(
            message: message,
            isVoice: false,
            isNewest: newest,
            modelDisplayName: message.model.map(modelName),
            currentModelID: message.model,
            switchableModels: models,
            actions: actions,
            branchPosition: branch,
            isGenerating: generating,
            isUnsent: unsent,
            editRequest: editRequest,
            approvals: approvals
        )
    }

    static func modelName(_ id: String) -> String {
        switch id {
        case "anthropic:claude-sonnet-4-6": "Claude Sonnet 4.6"
        case "openai:gpt-image-2": "GPT Image 2"
        default: id
        }
    }

    static let models = [
        DesktopRegenerateModel(id: "anthropic:claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", providerLabel: "Anthropic"),
        DesktopRegenerateModel(id: "openai:gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", providerLabel: "OpenAI"),
    ]

    static let createdAt = Date(timeIntervalSince1970: 1_758_000_000)

    static func message(
        _ id: String,
        _ role: NativeChatRole,
        _ content: String,
        model: String? = nil
    ) -> NativeChatMessage {
        NativeChatMessage(
            id: id,
            conversationID: "conv-1",
            clientID: nil,
            role: role,
            content: content,
            reasoning: nil,
            model: model,
            createdAt: createdAt,
            revision: 1
        )
    }

    static let question = message("q-1", .user, "What makes a good README for a Swift package?")

    static let reply = message(
        "a-1",
        .assistant,
        """
        A good README answers the three questions a visitor arrives with: what this is, whether it fits their project, and how to start. Lead with one sentence that names the problem the package solves, then show the smallest complete example.

        Keep the rest scannable. Most readers skim headings and code before they read a paragraph, so put the details where a skimmer will find them:

        - **Installation** — the exact `Package.swift` line, with a version.
        - **Usage** — two or three examples that compile as written.
        - **Requirements** — platforms, Swift version, and anything it will not do.
        """,
        model: "anthropic:claude-sonnet-4-6"
    ).with {
        $0.promptTokens = 8_421
        $0.completionTokens = 612
        $0.costUSD = 0.0214
    }

    static let shortReply = message(
        "a-short",
        .assistant,
        "Lead with what it does and the smallest example that runs; everything else is reference.",
        model: "anthropic:claude-sonnet-4-6"
    ).with {
        $0.promptTokens = 1_204
        $0.completionTokens = 38
        $0.costUSD = 0.0041
    }

    static let comparisonQuestion = message("q-img", .user, "Can you compare these?").with {
        $0.attachments = [
            NativeChatAttachment(
                id: PreviewImageFixtures.userPhotoID,
                fileName: "IMG_4821.jpg",
                mimeType: "image/jpeg",
                kind: "IMAGE",
                size: 1_830_000,
                width: 1_200,
                height: 800
            ),
            NativeChatAttachment(
                id: "file-pdf-1",
                fileName: "quasar-notes.pdf",
                mimeType: "application/pdf",
                kind: "FILE",
                size: 248_000,
                width: nil,
                height: nil
            ),
        ]
    }

    static let longQuestion = message(
        "q-long",
        .user,
        (1...22).map { "Line \($0) of a pasted log: request \($0 * 17) took \(120 + $0 * 3)ms and returned 200." }
            .joined(separator: "\n")
    )

    /// `msg-7` from the preview world, with its photo: 1200×800, so a
    /// 216×144 tile above the bubble.
    static let posterQuestion = message(
        "q-poster",
        .user,
        "Here's the view from the office tonight — can you make a poster-style version of it?"
    ).with {
        $0.attachments = [
            NativeChatAttachment(
                id: PreviewImageFixtures.userPhotoID,
                fileName: "IMG_4821.jpg",
                mimeType: "image/jpeg",
                kind: "IMAGE",
                size: 1_830_000,
                width: 1_200,
                height: 800,
                url: "/api/files/u1/img-user-1.jpg"
            ),
        ]
    }

    /// A reader sending three documents with no words: tiles, no bubble.
    static let filesOnlyQuestion = message("q-files", .user, "").with {
        $0.attachments = [
            NativeChatAttachment(
                id: "file-pdf-1",
                fileName: "quasar-notes.pdf",
                mimeType: "application/pdf",
                kind: "FILE",
                size: 248_000,
                width: nil,
                height: nil
            ),
            NativeChatAttachment(
                id: "file-docx-1",
                fileName: "Brand guidelines.docx",
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                kind: "FILE",
                size: 412_300,
                width: nil,
                height: nil
            ),
            NativeChatAttachment(
                id: "file-csv-1",
                fileName: "signups.csv",
                mimeType: "text/csv",
                kind: "FILE",
                size: 3_400,
                width: nil,
                height: nil
            ),
        ]
    }

    static let clipQuestion = message("q-clip", .user, "Make a five-second clip of the rings turning.")

    static let generatedVideo = message("a-video", .assistant, "", model: "google:veo-3").with {
        $0.attachments = [
            NativeChatAttachment(
                id: "vid-gen-1",
                fileName: "Veo 3 — Rings.mp4",
                mimeType: "video/mp4",
                kind: "FILE",
                size: 6_400_000,
                width: 1_280,
                height: 720
            ),
        ]
    }

    static let generatedImage = message("a-img", .assistant, "", model: "openai:gpt-image-2").with {
        $0.attachments = [
            NativeChatAttachment(
                id: PreviewImageFixtures.generatedID,
                fileName: "GPT Image 2 — Poster.png",
                mimeType: "image/png",
                kind: "IMAGE",
                size: 920_000,
                width: 1_024,
                height: 1_024
            ),
        ]
        $0.promptTokens = 140
        $0.completionTokens = 0
        $0.costUSD = 0.042
    }

    static func placeholder(_ progress: NativeMediaProgress?) -> NativeChatMessage {
        message("a-pending", .assistant, "", model: "openai:gpt-image-2").with {
            $0.isPending = true
            $0.mediaProgress = progress
        }
    }

    static let workbookReply = message("a-xlsx", .assistant, "Here's the workbook.", model: "anthropic:claude-sonnet-4-6").with {
        $0.attachments = [
            NativeChatAttachment(
                id: "file-xlsx-1",
                fileName: "Q3 forecast.xlsx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                kind: "FILE",
                size: 90_112,
                width: nil,
                height: nil
            ),
        ]
    }

    static let deckReply = message("a-pptx", .assistant, "Here's the deck.", model: "anthropic:claude-sonnet-4-6").with {
        $0.attachments = [
            NativeChatAttachment(
                id: "file-pptx-1",
                fileName: "Launch plan.pptx",
                mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                kind: "FILE",
                size: 1_258_291,
                width: nil,
                height: nil
            ),
        ]
    }

    static let pricingCard = """
    <div style="font-family: -apple-system, sans-serif; padding: 24px; background: #FAF9F6;">
      <div style="max-width: 280px; margin: 0 auto; background: white; border: 1px solid #E1DFD8; border-radius: 16px; padding: 20px;">
        <div style="font-size: 13px; color: #6A6862;">Pro</div>
        <div style="font-size: 32px; font-weight: 600; margin: 4px 0 12px;">$20<span style="font-size: 14px; color: #6A6862;">/month</span></div>
        <ul style="padding-left: 18px; margin: 0 0 16px; font-size: 14px; line-height: 1.6;"><li>Every model</li><li>Deep research</li><li>Juno Code</li></ul>
        <div style="background: #1D1D1B; color: white; text-align: center; border-radius: 10px; padding: 10px; font-size: 14px;">Upgrade</div>
      </div>
    </div>
    """

    static func artifactReply(streaming: Bool) -> NativeChatMessage {
        let tag = "<juno:artifact identifier=\"pricing-card\" type=\"html\" title=\"Pricing card\">\(pricingCard)"
        return message(
            "a-artifact",
            .assistant,
            "Here's a pricing card you can drop into the page.\n\n" + tag + (streaming ? "" : "</juno:artifact>"),
            model: "anthropic:claude-sonnet-4-6"
        ).with { $0.isPending = streaming }
    }

    /// The pricing card's stored row: version 2, written by this message.
    static let pricingArtifact = NativeArtifact(
        id: "art-pricing",
        conversationID: "conv-1",
        conversationTitle: "Pricing",
        messageID: "a-artifact",
        identifier: "pricing-card",
        title: "Pricing card",
        kind: .html,
        language: nil,
        currentVersion: 2,
        versions: [
            NativeArtifactVersion(id: "art-pricing#1", version: 1, content: "<p>First draft</p>", origin: .generated, createdAt: createdAt),
            NativeArtifactVersion(id: "art-pricing#2", version: 2, content: pricingCard, origin: .edit, createdAt: createdAt),
        ],
        createdAt: createdAt,
        updatedAt: createdAt,
        revision: 2
    )

    static let pricingResolver = ChatArtifactResolver(artifacts: [pricingArtifact], conversationID: "conv-1")

    /// A later reply that rewrote the same identifier: its card says "Updated".
    static let revisedArtifactReply = message(
        "a-artifact-2",
        .assistant,
        "I tightened the spacing and kept the same plan.\n\n<juno:artifact identifier=\"pricing-card\" type=\"html\" title=\"Pricing card\">\(pricingCard)</juno:artifact>",
        model: "anthropic:claude-sonnet-4-6"
    )

    /// A page whose script throws before it loads: status Error, Console 1.
    static let brokenCard = pricingCard + "\n<script>document.getElementById('plan-total').textContent = '$240';</script>"

    static let brokenArtifactReply = message(
        "a-artifact-broken",
        .assistant,
        "Here's the card with the yearly total.\n\n<juno:artifact identifier=\"pricing-card-yearly\" type=\"html\" title=\"Pricing card (yearly)\">\(brokenCard)</juno:artifact>",
        model: "anthropic:claude-sonnet-4-6"
    )

    /// `art-design` from the preview world: the stored, expanded document.
    static let designResolver = ChatArtifactResolver(
        artifacts: [
            NativeArtifact(
                id: "art-design",
                conversationID: "conv-1",
                conversationTitle: "Sign-in",
                messageID: "msg-6",
                identifier: "signin-screen",
                title: "Sign-in screen",
                kind: .design,
                language: nil,
                currentVersion: 1,
                versions: [NativeArtifactVersion(
                    id: "artv-design",
                    version: 1,
                    content: PreviewFixtures.designDocument,
                    origin: .generated,
                    createdAt: createdAt
                )],
                createdAt: createdAt,
                updatedAt: createdAt,
                revision: 1
            ),
        ],
        conversationID: "conv-1"
    )

    static let mermaidSource = """
    flowchart LR
      Q[Question] --> R{Needs the web?}
      R -- yes --> S[Search] --> A[Answer]
      R -- no --> A
    """

    static func mermaidReply(closed: Bool) -> NativeChatMessage {
        message(
            closed ? "a-mermaid" : "a-mermaid-stream",
            .assistant,
            "Here's how a question is routed:\n\n```mermaid\n\(mermaidSource)\n" + (closed ? "```\n\nSearch runs only when the answer needs something current." : ""),
            model: "anthropic:claude-sonnet-4-6"
        ).with { $0.isPending = !closed }
    }

    static func visualReply(_ json: String) -> NativeChatMessage {
        message(
            "a-visual-\(abs(json.hashValue % 10_000))",
            .assistant,
            "Here it is at a glance:\n\n```juno-visual\n\(json)\n```",
            model: "anthropic:claude-sonnet-4-6"
        )
    }

    static let flowVisual = #"""
    {"type":"flow","title":"How a request reaches the model","subtitle":"Tap a step to read what happens there.","nodes":[{"title":"Composer","body":"The question, its files and the chosen tools."},{"title":"Router","body":"Picks the model and whether to search."},{"title":"Model","body":"Writes the answer, calling tools as it goes."},{"title":"Transcript","body":"Streams the reply and stores it."}],"edges":[{"from":"Composer","to":"Router","label":"POST /api/chat"},{"from":"Model","to":"Transcript","label":"SSE"}]}
    """#

    static let cardsVisual = #"""
    {"type":"cards","title":"Three ways to cache","items":[{"label":"A","title":"In memory","body":"Fastest, gone on relaunch.","detail":"Good for decoded pictures."},{"label":"B","title":"On disk","body":"Survives relaunch; purge on sign-out."},{"label":"C","title":"On the server","body":"Shared across devices, costs a round trip."}]}
    """#

    static let compareVisual = #"""
    {"type":"comparison","title":"Sync or stream","columns":["Sync","Stream"],"rows":[{"title":"Latency","values":["After the reply","As it is written"]},{"title":"Offline","values":["Reads the local copy","Needs the connection"]},{"title":"Cost","values":["One request","One long request"]}]}
    """#

    static let quizVisual = #"""
    {"type":"quiz","question":"Which HTTP method is idempotent?","options":[{"label":"POST","body":"Creates a new resource each time."},{"label":"PUT","body":"Replaces the resource at a path.","correct":true,"explanation":"Sending it twice leaves the same state."}]}
    """#

    static let timelineVisual = #"""
    {"type":"timeline","items":[{"label":"2014","title":"Swift announced","body":"At WWDC, as Objective-C without the C."},{"label":"2019","title":"SwiftUI","body":"A declarative UI framework ships with iOS 13."},{"label":"2024","title":"Swift 6","body":"Data-race safety becomes an error."}]}
    """#

    static let calloutVisual = #"""
    {"type":"callout","title":"Keep secrets out of the bundle","body":"Anything shipped in the app can be read by anyone who has it.","items":[{"title":"Keychain","body":"for tokens"},{"title":"Server","body":"for API keys"}]}
    """#

    /// `msg-6` from the preview world: a Juno Design document in a tag.
    static let designReply = message(
        "msg-6",
        .assistant,
        "Here it is — a 375×812 frame with the card centred and the primary action at the bottom of it.  <juno:artifact identifier='signin-screen' type='design' title='Sign-in screen'>\(PreviewFixtures.designDocument)</juno:artifact>",
        model: "anthropic:claude-sonnet-4-6"
    )

    static let codeReply = message(
        "a-code",
        .assistant,
        """
        Here's a small cache with an expiry:

        ```swift
        import Foundation

        actor ExpiringCache<Key: Hashable, Value> {
            private var entries: [Key: (value: Value, expires: Date)] = [:]
            private let lifetime: TimeInterval

            init(lifetime: TimeInterval) { self.lifetime = lifetime }

            func value(for key: Key) -> Value? {
                guard let entry = entries[key], entry.expires > .now else { return nil }
                return entry.value
            }
        }
        ```

        And to run the tests:

        ```bash
        swift build
        swift test --parallel
        swift test --filter ExpiringCacheTests
        ```
        """,
        model: "anthropic:claude-sonnet-4-6"
    )

    static let tableReply = message(
        "a-table",
        .assistant,
        """
        The three plans side by side:

        | Plan | Price | Models | What it is for, in a sentence long enough to make the column wide |
        | --- | --- | --- | --- |
        | Free | $0 | Auto | Trying Juno out and the occasional question when you need a second opinion. |
        | Plus | $8 | Most | Daily use across chat, research and the library, with room to spare. |
        | Pro | $20 | Every | Heavy research, long documents, Juno Code and everything the product can do. |
        | Team | $30 | Every | Shared projects, billing in one place and administration for a group. |
        | Enterprise | Custom | Every | Single sign-on, audit logs, and a contract that your legal team will read. |
        """,
        model: "anthropic:claude-sonnet-4-6"
    )

    static let sourcedReply = message(
        "a-sources",
        .assistant,
        "Swift 6 turned data-race safety from warnings into errors, and most packages adopted it over the following year [1][2].",
        model: "anthropic:claude-sonnet-4-6"
    ).with {
        $0.sources = [
            ("Swift 6 released", "https://www.swift.org/blog/announcing-swift-6/"),
            ("Migrating to Swift 6", "https://www.swift.org/migration/documentation/migrationguide/"),
            ("Data race safety", "https://developer.apple.com/documentation/swift/adoptingswift6"),
            ("Swift Package Index", "https://swiftpackageindex.com/"),
            ("Concurrency checking", "https://github.com/apple/swift-evolution/blob/main/proposals/0337-support-incremental-migration-to-concurrency-checking.md"),
            ("Strict concurrency", "https://www.hackingwithswift.com/swift/6.0/concurrency"),
        ].map { NativeChatSource(title: $0.0, url: URL(string: $0.1)!, snippet: "") }
    }

    /// Twenty-six lines, so the gutter shows and the block scrolls inside
    /// itself past 520pt.
    static let longCodeReply = message(
        "a-code-long",
        .assistant,
        "The whole parser:\n\n```python\n" + (1...30).map { index in
            index % 7 == 0
                ? "    # step \(index): keep the offset for the next token"
                : "    tokens.append(Token(kind=\"word\", start=\(index * 4), text=source[\(index * 4):\(index * 4 + 3)]))"
        }.joined(separator: "\n") + "\n```",
        model: "anthropic:claude-sonnet-4-6"
    )

    /// Fourteen columns: wider than the measure even at their floors, so the
    /// table scrolls sideways instead of squeezing. (`table` shows the other
    /// case: a long column wrapping so the table fits.)
    static let wideTableReply = message(
        "a-table-wide",
        .assistant,
        """
        Monthly signups by region:

        | Region | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec | Total for the year |
        | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
        | North America and the Caribbean | 1,204 | 1,388 | 1,512 | 1,690 | 1,733 | 1,902 | 1,944 | 2,011 | 2,080 | 2,151 | 2,190 | 2,304 | 22,109 |
        | Europe, the Middle East and Africa | 988 | 1,041 | 1,137 | 1,254 | 1,301 | 1,399 | 1,420 | 1,466 | 1,532 | 1,588 | 1,610 | 1,702 | 16,438 |
        | Asia and the Pacific | 1,512 | 1,603 | 1,788 | 1,905 | 2,044 | 2,230 | 2,301 | 2,388 | 2,450 | 2,512 | 2,601 | 2,733 | 26,067 |
        """,
        model: "anthropic:claude-sonnet-4-6"
    )

    static let proseReply = message(
        "a-prose",
        .assistant,
        """
        # Writing a README that gets read

        A README is the front door of a package. Most visitors decide within a few seconds whether it fits their project, so the first screen has to answer that question on its own. The rest of the document is reference, and it should read like one.

        ## What goes first

        Lead with **one sentence** that names the problem, then show the smallest complete example. Keep `import` lines in it: a snippet that does not compile teaches the reader to distrust the rest. Link to the [Swift Package Index](https://swiftpackageindex.com) page when there is one.

        ### The sections, in order

        1. What it does, in a sentence.
        2. How to add it — the exact `Package.swift` line.
        3. The smallest example that runs.
           - Keep it under twenty lines.
           - Show the output.

        > Documentation is a product, not a chore. The README is the part of it everybody reads.

        ---

        Everything after that is detail: configuration, the full API, and the changelog.
        """,
        model: "anthropic:claude-sonnet-4-6"
    )

    /// A research answer written from a numbered corpus: its `[n]` are
    /// citations, drawn as chips.
    static let citedReply = message(
        "a-cited",
        .assistant,
        "Swift 6 turned data-race safety from warnings into errors [1], and the migration guide recommends enabling it one module at a time [2]. Most of the top packages had adopted it within a year [4].",
        model: "anthropic:claude-sonnet-4-6"
    ).with {
        $0.sources = sourcedReply.sources.map {
            NativeChatSource(title: $0.title, url: $0.url, snippet: "Complete concurrency checking is on by default in the Swift 6 language mode.", cited: true)
        }
    }

    static let researchQuestion = message("q-research", .user, "How widely has Swift 6's strict concurrency been adopted?")

    static let runStart = Date().addingTimeInterval(-18)

    static func activityEvent(
        _ id: String,
        _ kind: NativeChatActivity.Kind,
        _ title: String,
        detail: String? = nil,
        url: String? = nil,
        at offset: TimeInterval,
        seq: Int? = nil,
        call: NativeToolCall? = nil,
        tool: NativeToolDetail? = nil
    ) -> NativeChatActivity {
        NativeChatActivity(
            id: id, kind: kind, title: title, detail: detail, url: url,
            createdAt: createdAt.addingTimeInterval(offset), seq: seq, call: call, tool: tool
        )
    }

    /// A live run on the rework's typed timeline: a search that finished, a
    /// page being read, and the reasoning between them.
    static let liveToolsReply = placeholder(nil).with {
        $0.id = "a-live-tools"
        $0.model = "anthropic:claude-sonnet-4-6"
        $0.runStartedAt = Date().addingTimeInterval(-18)
        $0.reasoning = "**Checking adoption numbers**\n\nThe Swift Package Index tracks which packages build cleanly in Swift 6 mode."
        $0.activity = [
            activityEvent("act-search", .search, "Searching the web", detail: "swift 6 strict concurrency adoption", at: 1, seq: 1, call: NativeToolCall(
                callID: "call-search", tool: "web_search", status: .succeeded, round: 0,
                figure: NativeToolCall.Figure(kind: "results", n: 8),
                web: NativeToolCall.Web(query: "swift 6 strict concurrency adoption")
            )),
            activityEvent("act-fetch", .visit, "Visited source", at: 4, seq: 2, call: NativeToolCall(
                callID: "call-fetch", tool: "web_fetch", status: .running, round: 1,
                web: NativeToolCall.Web(requestedURL: "https://swiftpackageindex.com/ready-for-swift-6")
            )),
        ]
        $0.sources = Array(sourcedReply.sources.prefix(3))
    }

    /// A settled run from today's server: timestamps on its rows, reasoning,
    /// and six sources — "Thought for 12s · 6 sources".
    static let settledReply = sourcedReply.with {
        $0.id = "a-settled"
        $0.reasoning = "**Weighing the sources**\n\nThe release post gives the date; the migration guide and the package index give the adoption picture."
        $0.activity = [
            activityEvent("s-context", .context, "Reading the conversation context", detail: "3 messages", at: 0),
            activityEvent("s-model", .model, "Selected model", detail: "Anthropic · Claude Sonnet 4.6", at: 0.1),
            activityEvent("s-effort", .reasoning, "Reasoning mode enabled", detail: "High effort", at: 0.1),
            activityEvent("s-write", .write, "Writing the answer", detail: "Streaming response text", at: 12.4),
            activityEvent("s-done", .done, "Finished response", detail: "6 sources", at: 19),
        ]
    }

    /// The same run with a connector call and a warning, from today's rows:
    /// "Worked for 12s · 6 sources · used Linear".
    static let settledToolReply = settledReply.with {
        $0.id = "a-settled-tools"
        $0.activity.insert(
            activityEvent(
                "act-linear", .tool, "Using Linear", detail: "linear__search_issues", at: 5,
                tool: NativeToolDetail(
                    server: "Linear",
                    name: "linear__search_issues",
                    args: "{\n  \"query\": \"swift 6 migration\",\n  \"limit\": 5\n}",
                    result: "[\n  { \"id\": \"ENG-412\", \"title\": \"Enable strict concurrency in Core\" },\n  { \"id\": \"ENG-388\", \"title\": \"Audit Sendable conformances\" }\n]",
                    status: "ok",
                    durationMs: 842
                )
            ),
            at: 3
        )
        $0.activity.insert(
            activityEvent("act-warning", .warning, "Connector unavailable", detail: "GitHub could not be reached, so its tools were left out.", at: 0.2),
            at: 3
        )
    }

    static let pendingApproval = NativeChatApproval(
        id: "appr-1",
        surface: "chat",
        sessionID: "juno-native-1",
        conversationID: "conv-1",
        connectorID: "linear",
        connectorLabel: "Linear",
        toolName: "linear__create_issue",
        action: "create_issue",
        riskClass: .externalWrite,
        preview: "Create the issue “Login test fails on CI” in the Mobile team",
        detail: [
            "team": .string("Mobile"),
            "title": .string("Login test fails on CI"),
            "priority": .number(2),
        ],
        receiptDigest: "digest",
        status: .pending,
        decision: nil,
        canAllowScope: false,
        derivedFromUntrusted: false,
        expiresAt: Date().addingTimeInterval(4 * 60 + 12),
        decidedAt: nil,
        completedAt: nil,
        createdAt: Date()
    )
}

extension NativeChatMessage {
    /// A copy with some fields changed — fixtures read better as a base
    /// message and its variations.
    func with(_ change: (inout NativeChatMessage) -> Void) -> NativeChatMessage {
        var copy = self
        change(&copy)
        return copy
    }
}

/// A reader's turn with its editor open — the one state a still cannot reach
/// by clicking. The request arrives after the row appears, as ↑ in the
/// composer sends it.
struct SnapshotEditingRow: View {
    let message: NativeChatMessage
    @State private var request: UUID?

    var body: some View {
        TranscriptSnapshotFixtures.row(message, editRequest: request)
            .task { request = UUID() }
    }
}
