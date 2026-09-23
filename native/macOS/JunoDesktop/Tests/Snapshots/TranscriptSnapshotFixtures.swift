import AppKit
import Foundation
import JunoChatKit
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
}

/// The transcript fixtures of §2.5 of the Phase 2 brief: `NativeChatMessage`
/// values, no store, drawn through the real ``DesktopMessageRow`` inside the
/// real ``TranscriptColumn``.
///
/// Not main-actor isolated as a whole, so Swift Testing can read the fixture
/// names as test arguments; everything that builds a view is.
enum TranscriptSnapshotFixtures {
    static var all: [TranscriptFixture] {
        replyActions + userTurns + media + artifacts + prose + notes + activity
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
            TranscriptFixture(name: "user-unsent", stage: 1) {
                AnyView(column { row(question, unsent: true) })
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
                AnyView(column {
                    row(posterQuestion)
                    row(generatedImage, newest: true)
                })
            },
            TranscriptFixture(name: "generated-image-failed", stage: 2) {
                AnyView(column {
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
                AnyView(column { row(deckReply, newest: true) })
            },
        ]
    }

    // MARK: 7–8. Artifacts and designs

    static var artifacts: [TranscriptFixture] {
        [
            TranscriptFixture(name: "artifact-html", stage: 3) {
                AnyView(column { row(artifactReply(streaming: false), newest: true) })
            },
            TranscriptFixture(name: "artifact-html-streaming", stage: 3) {
                AnyView(column { row(artifactReply(streaming: true), newest: true) })
            },
            TranscriptFixture(name: "artifact-html-code", stage: 3) {
                AnyView(column { row(artifactReply(streaming: false), newest: true) })
            },
            TranscriptFixture(name: "artifact-html-console-error", stage: 3) {
                AnyView(column { row(artifactReply(streaming: false), newest: true) })
            },
            TranscriptFixture(name: "design-output", stage: 3) {
                AnyView(column { row(designReply, newest: true) })
            },
        ]
    }

    // MARK: 9–11. Prose

    static var prose: [TranscriptFixture] {
        [
            TranscriptFixture(name: "code-block", stage: 4) {
                AnyView(column { row(codeReply, newest: true) })
            },
            TranscriptFixture(name: "table", stage: 4) {
                AnyView(column { row(tableReply, newest: true) })
            },
            TranscriptFixture(name: "sources-pill", stage: 4) {
                AnyView(column { row(sourcedReply, newest: true) })
            },
            TranscriptFixture(name: "sources-pill-expanded", stage: 4) {
                AnyView(column {
                    DesktopMessageSources(sources: sourcedReply.sources, startsExpanded: true)
                })
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
                        newest: true
                    )
                    // Where the transcript draws the store's error today; it
                    // moves into the turn in stage 4.
                    DesktopChatError(
                        message: "The model provider is overloaded. Try again in a moment.",
                        canRetry: true,
                        retry: {}
                    )
                })
            },
            TranscriptFixture(name: "finish-note", stage: 1) {
                AnyView(column {
                    row(
                        reply.with { $0.finishReason = .length },
                        newest: true,
                        continues: true
                    )
                })
            },
        ]
    }

    // MARK: 13. Activity (stage 4 extras)

    static var activity: [TranscriptFixture] {
        [
            TranscriptFixture(name: "activity-live", stage: 4) {
                AnyView(column {
                    row(question)
                    row(placeholder(nil), newest: true, generating: true)
                })
            },
            TranscriptFixture(name: "activity-settled", stage: 4) {
                AnyView(column {
                    row(
                        reply.with {
                            $0.reasoning = "The reader wants the parts of a README that matter for a package.\n\nStart with what it does and how to add it, then the smallest example."
                        },
                        newest: true
                    )
                })
            },
        ]
    }

    // MARK: - Building blocks

    /// The transcript's own column and rhythm around the rows.
    @MainActor
    static func column<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            content()
        }
        // The transcript's lazy stack takes the column's whole width; a plain
        // stack hugs its content, so it is told to.
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(TranscriptColumn())
        .padding(.vertical, JunoSpace.section)
    }

    /// A row with every action a saved turn has, each doing nothing.
    @MainActor
    static func row(
        _ message: NativeChatMessage,
        newest: Bool = false,
        branch: NativeMessageBranchPosition? = nil,
        unsent: Bool = false,
        continues: Bool = false,
        generating: Bool = false
    ) -> some View {
        var actions = MessageRowActions()
        actions.copy = {}
        actions.setFeedback = { _ in }
        actions.readAloud = {}
        actions.stopReading = {}
        actions.branch = {}
        actions.forkPrivately = {}
        actions.share = {}
        actions.quote = {}
        actions.copyLink = {}
        actions.stepBranch = { _ in }
        if newest, message.role == .assistant { actions.regenerate = { _ in } }
        if continues { actions.continueResponse = {} }
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
            isUnsent: unsent
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

    /// `msg-7` from the preview world, without its photo.
    static let posterQuestion = message(
        "q-poster",
        .user,
        "Here's the view from the office tonight — can you make a poster-style version of it?"
    )

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
