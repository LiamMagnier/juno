import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

@testable import JunoDesktop

/// Phase 2 stage 4b: the tools rework's final run UI (Tool calls & research
/// SPEC §7–§9) — the live run block with tool rows in every status, the
/// folded summary, the inline timeline, the Activity panel's three views,
/// research's transcript row, plan and panel, and "Research this".
extension TranscriptSnapshotFixtures {
    static var stageFourB: [TranscriptFixture] {
        [
            TranscriptFixture(name: "run-live-peek", stage: 45) {
                AnyView(column {
                    row(researchQuestion)
                    row(livePeekReply, newest: true, generating: true)
                }
                .environment(\.junoSnapshotRunElapsed, 18))
            },
            TranscriptFixture(name: "run-live-statuses", stage: 45) {
                AnyView(column {
                    row(question.with { $0.content = "Check the release notes, file the issue, and tidy the tracker." })
                    row(liveStatusesReply, newest: true, generating: true)
                }
                .environment(\.junoSnapshotRunExpanded, true)
                .environment(\.junoSnapshotRunElapsed, 47))
            },
            TranscriptFixture(name: "run-live-stalled", stage: 45) {
                AnyView(column {
                    row(researchQuestion)
                    row(stalledReply, newest: true, generating: true)
                }
                .environment(\.junoSnapshotRunElapsed, 140))
            },
            TranscriptFixture(name: "run-folded", stage: 45) {
                AnyView(column {
                    row(researchQuestion)
                    row(foldedReply, newest: true)
                })
            },
            TranscriptFixture(name: "run-expanded", stage: 45) {
                AnyView(column {
                    row(expandedReply, newest: true)
                }
                .environment(\.junoSnapshotRunExpanded, true))
            },
            TranscriptFixture(name: "activity-panel-timeline", stage: 45) {
                AnyView(panel(
                    DesktopActivityPanel(message: expandedReply, live: false, focusCallID: "call-nature", close: {})
                        .environment(\.junoSnapshotActivityTab, "timeline")
                ))
            },
            TranscriptFixture(name: "activity-panel-sources", stage: 45) {
                AnyView(panel(
                    DesktopActivityPanel(message: expandedReply, live: false, close: {})
                        .environment(\.junoSnapshotActivityTab, "sources")
                ))
            },
            TranscriptFixture(name: "activity-panel-details", stage: 45) {
                AnyView(panel(
                    DesktopActivityPanel(
                        message: expandedReply,
                        live: false,
                        contextWindow: 200_000,
                        forgetMemory: { _ in },
                        close: {}
                    )
                    .environment(\.junoSnapshotActivityTab, "details")
                ))
            },
            TranscriptFixture(name: "activity-panel-live", stage: 45) {
                AnyView(panel(
                    DesktopActivityPanel(message: livePeekReply, live: true, close: {})
                        .environment(\.junoSnapshotActivityTab, "timeline")
                ))
            },
            TranscriptFixture(name: "research-row", stage: 45) {
                AnyView(column {
                    row(researchQuestion)
                    DesktopResearchRow(run: liveResearchRun, open: {})
                    row(question.with { $0.id = "q-later"; $0.content = "While that runs — what's new in Swift 6.1?" })
                    DesktopResearchRow(run: doneResearchRun, ownsLoop: false, open: {})
                }
                .environment(\.junoSnapshotRunElapsed, 42))
            },
            TranscriptFixture(name: "research-plan", stage: 45) {
                AnyView(column {
                    row(researchQuestion)
                    DesktopResearchPlanCard(run: planResearchRun, atTail: true, busy: false, error: nil, start: {}, cancel: {})
                })
            },
            TranscriptFixture(name: "research-in-chat", stage: 45) {
                AnyView(column {
                    row(researchQuestion)
                    row(inChatResearchReply, newest: true, generating: true)
                }
                .environment(\.junoSnapshotRunElapsed, 26))
            },
            TranscriptFixture(name: "research-panel-progress", stage: 45) {
                AnyView(panel(DesktopResearchPanel(run: liveResearchRun, control: { _ in }, close: {})))
            },
            TranscriptFixture(name: "research-panel-report", stage: 45) {
                AnyView(panel(DesktopResearchPanel(run: doneResearchRun, close: {})))
            },
            TranscriptFixture(name: "research-this", stage: 45) {
                AnyView(column {
                    row(suggestedResearchReply, newest: true)
                })
            },
        ]
    }

    // MARK: Building blocks

    @MainActor
    static func panel<Content: View>(_ content: Content) -> some View {
        content
            .frame(width: 480, height: 640)
            .background(Color.junoCanvasWarm)
            .frame(maxWidth: .infinity)
            .padding(.vertical, JunoSpace.section)
            .environment(\.junoWebPreviewStill, SnapshotStillCache.shared.webStills)
            .junoAccentTint()
    }

    static func typed(
        _ id: String,
        _ kind: NativeChatActivity.Kind,
        _ title: String,
        seq: Int,
        at offset: TimeInterval,
        detail: String? = nil,
        call: NativeToolCall? = nil,
        segment: NativeReasoningSegment? = nil,
        commentary: NativeRunCommentary? = nil,
        notice: NativeRunNotice? = nil,
        fact: NativeRunFact? = nil,
        tool: NativeToolDetail? = nil,
        memory: [NativeMemoryReceipt] = []
    ) -> NativeChatActivity {
        NativeChatActivity(
            id: id, kind: kind, title: title, detail: detail, url: nil,
            createdAt: createdAt.addingTimeInterval(offset), seq: seq, round: call?.round ?? segment?.round,
            call: call, segment: segment, commentary: commentary, notice: notice, fact: fact, tool: tool,
            memory: memory
        )
    }

    static func at(_ offset: TimeInterval) -> Date { createdAt.addingTimeInterval(offset) }

    // MARK: Live

    /// Thinking, a search that finished, and a page being read: the peek's
    /// two slots.
    static let livePeekReply = placeholder(nil).with {
        $0.id = "a-live-peek"
        $0.model = "anthropic:claude-sonnet-4-6"
        $0.runStartedAt = Date().addingTimeInterval(-18)
        $0.lastEventAt = Date()
        $0.reasoning = "**Checking adoption numbers**\n\nThe Swift Package Index tracks which packages build cleanly in Swift 6 mode. It publishes the share every week."
        $0.activity = [
            typed("f-tools", .context, "Tools ready", seq: 1, at: 0, fact: .tools(offered: ["web_search", "web_fetch", "run_code"], nativeSearch: false, roundBudget: 10)),
            typed("s1", .reasoning, "Thinking", seq: 2, at: 1, segment: NativeReasoningSegment(round: 0, offset: 0)),
            typed("c-search", .search, "Searching the web", seq: 3, at: 2, call: NativeToolCall(
                callID: "call-search", tool: "web_search", status: .succeeded, round: 0, startedAt: at(2), endedAt: at(3),
                durationMs: 1_150, args: ["query": "swift 6 strict concurrency adoption"],
                figure: .init(kind: "results", n: 8), web: .init(query: "swift 6 strict concurrency adoption", engine: "tavily")
            )),
            typed("c-fetch", .visit, "Visited source", seq: 4, at: 4, call: NativeToolCall(
                callID: "call-fetch", tool: "web_fetch", status: .running, round: 1, startedAt: Date(), timeoutMs: 20_000,
                args: ["url": "https://swiftpackageindex.com/ready-for-swift-6", "domain": "swiftpackageindex.com"]
            )),
        ]
        $0.sources = Array(sourcedReply.sources.prefix(4))
    }

    /// One call in each of the eight statuses, the timeline open: queued,
    /// awaiting approval, running, succeeded, failed, declined, expired and
    /// cancelled.
    static let liveStatusesReply = placeholder(nil).with {
        $0.id = "a-live-statuses"
        $0.model = "anthropic:claude-sonnet-4-6"
        $0.runStartedAt = Date().addingTimeInterval(-47)
        $0.lastEventAt = Date()
        $0.activity = [
            typed("k-ok", .visit, "Visited source", seq: 1, at: 1, call: NativeToolCall(
                callID: "call-ok", tool: "web_fetch", status: .succeeded, round: 0, startedAt: at(1), endedAt: at(2.3),
                durationMs: 1_320, args: ["domain": "swift.org"], figure: .init(kind: "chars", n: 12_480),
                web: .init(finalURL: "https://www.swift.org/blog/swift-6.1-released/", contentType: "html", chars: 12_480)
            )),
            typed("k-failed", .visit, "Visited source", seq: 2, at: 2, call: NativeToolCall(
                callID: "call-failed", tool: "web_fetch", status: .failed, round: 0, startedAt: at(2), endedAt: at(22),
                durationMs: 20_000, timeoutMs: 20_000, args: ["domain": "nature.com"], errorCode: "timeout"
            )),
            typed("k-denied", .tool, "Using Linear", seq: 3, at: 5, call: NativeToolCall(
                callID: "call-denied", tool: "mcp", origin: "connector", connectorLabel: "Linear", toolTitle: "Delete issue",
                status: .denied, round: 1, startedAt: at(5),
                approval: .init(id: "appr-d", status: "denied", riskClass: "destructive_or_sensitive", decision: "deny", decidedAt: at(9))
            )),
            typed("k-expired", .tool, "Using Notion", seq: 4, at: 6, call: NativeToolCall(
                callID: "call-expired", tool: "mcp", origin: "connector", connectorLabel: "Notion", toolTitle: "Update page",
                status: .expired, round: 1, startedAt: at(6),
                approval: .init(id: "appr-e", status: "expired", riskClass: "external_write")
            )),
            typed("k-cancelled", .tool, "Using Calculate", seq: 5, at: 7, call: NativeToolCall(
                callID: "call-cancelled", tool: "calculate", status: .cancelled, round: 1, startedAt: at(7), errorCode: "cancelled"
            )),
            typed("k-running", .tool, "Using Run code", seq: 6, at: 30, call: NativeToolCall(
                callID: "call-running", tool: "run_code", status: .running, round: 2, startedAt: Date(), timeoutMs: 130_000,
                args: ["language": "python", "lines": "24"]
            )),
            typed("k-queued", .search, "Searching the web", seq: 7, at: 31, call: NativeToolCall(
                callID: "call-queued", tool: "web_search", status: .queued, round: 2, startedAt: Date(),
                args: ["query": "swift macros compile time"]
            )),
            typed("k-waiting", .tool, "Using GitHub", seq: 8, at: 32, call: NativeToolCall(
                callID: "call-waiting", tool: "mcp", origin: "connector", connectorLabel: "GitHub", toolTitle: "Create issue",
                status: .awaitingApproval, round: 2, startedAt: Date(),
                approval: .init(id: "appr-w", status: "pending", riskClass: "external_write", expiresAt: Date().addingTimeInterval(240))
            )),
        ]
    }

    /// Thinking with no frame for 35 seconds, two minutes in: the stall
    /// caption inside the line.
    static let stalledReply = placeholder(nil).with {
        $0.id = "a-stalled"
        $0.model = "anthropic:claude-sonnet-4-6"
        $0.runStartedAt = Date().addingTimeInterval(-140)
        $0.lastEventAt = Date().addingTimeInterval(-35)
        $0.reasoning = "Comparing the two surveys. The 2025 one samples fewer packages, so its share runs high."
    }

    // MARK: Settled

    private static let foldedActivity: [NativeChatActivity] = [
        typed("f-model", .model, "Selected model", seq: 1, at: 0, detail: "Anthropic · Claude Sonnet 4.6",
              fact: .model(modelID: "anthropic:claude-sonnet-4-6", provider: "Anthropic", label: "Claude Sonnet 4.6", routed: false)),
        typed("f-effort", .reasoning, "Reasoning mode enabled", seq: 2, at: 0, fact: .effort(effort: "high", auto: false)),
        typed("f-context", .context, "Reading the conversation context", seq: 3, at: 0,
              fact: .context(historyMessages: 6, attachments: 1, projectFiles: 0)),
        typed("f-tools", .context, "Tools ready", seq: 4, at: 0,
              fact: .tools(offered: ["web_search", "web_fetch", "run_code", "calculate", "current_time"], nativeSearch: false, roundBudget: 10)),
        typed("f-connectors", .tool, "Connected tools ready", seq: 5, at: 0, fact: .connectors(
            ready: [.init(id: "github", label: "GitHub", tools: 12)],
            failed: [.init(id: "notion", label: "Notion", reason: "auth_expired")]
        )),
        typed("f-memory", .context, "Memory", seq: 6, at: 0, fact: .memory, memory: [
            NativeMemoryReceipt(id: "m1", content: "Maintains two Swift packages on GitHub."),
            NativeMemoryReceipt(id: "m2", content: "Prefers answers with numbers and dates."),
        ]),
        typed("s1", .reasoning, "Thinking", seq: 7, at: 1, segment: NativeReasoningSegment(round: 0, offset: 0)),
        typed("cm1", .reasoning, "Commentary", seq: 8, at: 2, commentary: NativeRunCommentary(round: 0, text: "Let me check the package index first.", inline: true)),
        typed("c-search", .search, "Searching the web", seq: 9, at: 2.2, call: NativeToolCall(
            callID: "call-search", tool: "web_search", status: .succeeded, round: 0, startedAt: at(2.2), endedAt: at(3.4),
            durationMs: 1_150, args: ["query": "swift 6 strict concurrency adoption"], figure: .init(kind: "results", n: 8),
            web: .init(query: "swift 6 strict concurrency adoption", engine: "tavily", results: [
                .init(n: 1, title: "Ready for Swift 6", url: "https://swiftpackageindex.com/ready-for-swift-6"),
                .init(n: 2, title: "Migrating to Swift 6", url: "https://www.swift.org/migration/documentation/migrationguide/"),
                .init(n: 3, title: "Swift 6 released", url: "https://www.swift.org/blog/announcing-swift-6/"),
            ])
        )),
        typed("c-fetch", .visit, "Visited source", seq: 10, at: 3.5, call: NativeToolCall(
            callID: "call-fetch", tool: "web_fetch", status: .succeeded, round: 1, startedAt: at(3.5), endedAt: at(4.9),
            durationMs: 1_380, args: ["domain": "swiftpackageindex.com"], figure: .init(kind: "chars", n: 9_812),
            web: .init(finalURL: "https://swiftpackageindex.com/", contentType: "html", chars: 9_812)
        )),
        typed("c-code", .tool, "Using Run code", seq: 11, at: 5, call: NativeToolCall(
            callID: "call-code", tool: "run_code", status: .succeeded, round: 1, startedAt: at(5), endedAt: at(8.2),
            durationMs: 3_210, args: ["language": "python", "lines": "18", "reason": "share by quarter"],
            figure: .init(kind: "exit", value: "0")
        ), tool: NativeToolDetail(
            server: "Juno", name: "run_code",
            args: "{\n  \"code\": \"import csv\\nrows = list(csv.reader(open('packages.csv')))\\nprint(len(rows))\"\n}",
            result: "Q1 2025  41%\nQ2 2025  58%\nQ3 2025  71%\nQ4 2025  83%",
            status: "ok", durationMs: 3_210
        )),
        typed("s2", .reasoning, "Thinking", seq: 12, at: 8.4, segment: NativeReasoningSegment(
            round: 2, offset: (foldedReasoning as NSString).range(of: "**Working").location
        )),
        typed("w1", .write, "Writing the answer", seq: 13, at: 12.4),
        typed("d1", .done, "Finished response", seq: 14, at: 19),
    ]

    static let foldedReasoning = "**Checking the package index**\n\nThe index publishes which packages build cleanly in Swift 6 mode, week by week.\n\n**Working out the trend**\n\nFour quarters of data are enough to show the direction."

    /// "Thought for 12s · 6 sources · ran code ›", commentary above the answer.
    static let foldedReply = sourcedReply.with {
        $0.id = "a-folded"
        $0.reasoning = foldedReasoning
        $0.activity = foldedActivity
        $0.promptTokens = 12_480
    }

    /// The same run with a page that timed out, a connector call answered
    /// through an approval, and a notice — the timeline open.
    static let expandedReply = foldedReply.with {
        $0.id = "a-expanded"
        $0.activity.insert(contentsOf: [
            typed("c-nature", .visit, "Visited source", seq: 20, at: 9, call: NativeToolCall(
                callID: "call-nature", tool: "web_fetch", status: .failed, round: 2, startedAt: at(9), endedAt: at(11),
                durationMs: 2_040, args: ["domain": "nature.com"], errorCode: "url_not_accessible", errorDetail: "HTTP 403"
            )),
            typed("c-github", .tool, "Using GitHub", seq: 21, at: 11, call: NativeToolCall(
                callID: "call-github", tool: "mcp", origin: "connector", connectorID: "github", connectorLabel: "GitHub",
                toolTitle: "Search issues", status: .succeeded, round: 2, startedAt: at(11), endedAt: at(11.9), durationMs: 880,
                approval: .init(id: "appr-g", status: "executed", riskClass: "read_only", decision: "allow_once", decidedAt: at(11.2))
            ), tool: NativeToolDetail(
                server: "GitHub", name: "github__search_issues",
                args: "{\n  \"query\": \"strict concurrency\",\n  \"repo\": \"apple/swift\"\n}",
                result: "[\n  { \"number\": 71204, \"title\": \"Sendable diagnostics in Swift 6 mode\" }\n]",
                status: "ok", durationMs: 880
            )),
            typed("n-notion", .warning, "Connector unavailable", seq: 22, at: 0.1,
                  notice: NativeRunNotice(code: "connector_unavailable", params: ["connector": "Notion", "reason": "auth_expired"])),
        ], at: 12)
        $0.sources = sourcedReply.sources.enumerated().map { index, source in
            NativeChatSource(
                title: source.title, url: source.url, snippet: "",
                cited: true,
                origin: index == 3 || index == 4 ? "juno_fetch" : (index == 2 ? "provider_search" : "juno_search")
            )
        }
        $0.content = "Swift 6 made data-race safety an error rather than a warning [1], and the migration guide recommends one module at a time [2]. By the end of 2025 most of the index built cleanly [4]."
    }

    /// A settled answer with a "Research this" suggestion under it.
    static let suggestedResearchReply = shortReply.with {
        $0.id = "a-suggest"
        $0.activity = [
            typed("sg", .tool, "Using Suggest research", seq: 1, at: 1, call: NativeToolCall(
                callID: "call-suggest", tool: "suggest_research", status: .succeeded, round: 0, startedAt: at(1),
                args: ["question": "How have Swift package READMEs changed since Swift 6?", "reason": "Needs a survey of many packages"]
            )),
            typed("w", .write, "Writing the answer", seq: 2, at: 2),
        ]
    }

    // MARK: Research

    static let liveResearchRun = NativeResearchRun(
        id: "run-live",
        conversationID: "conv-1",
        userMessageID: "q-research",
        goal: "How widely has Swift 6's strict concurrency been adopted?",
        state: "investigating",
        title: "Swift 6 concurrency adoption",
        phase: .searching,
        phaseQuery: "swift 6 migration survey 2025",
        approach: "Read the package index's weekly readiness data, the Swift forums' migration threads and two developer surveys, then compare them.",
        questions: [
            .init(id: "q1", question: "What share of packages build in Swift 6 mode?", status: "covered"),
            .init(id: "q2", question: "Which errors slow migration the most?", status: "searching"),
            .init(id: "q3", question: "How do large apps approach it?", status: "pending"),
        ],
        counts: .init(found: 18, read: 7, cited: 0, searches: 5, pages: 7),
        workingMs: 42_000,
        leadModel: "Claude Opus 4.1",
        findings: [
            .init(
                id: "f1",
                claim: "Most of the index built cleanly in Swift 6 mode by late 2025.",
                quote: "83% of packages now compile with complete concurrency checking.",
                url: URL(string: "https://swiftpackageindex.com/ready-for-swift-6"),
                title: "Ready for Swift 6"
            ),
        ],
        sources: [
            .init(id: "r1", url: URL(string: "https://swiftpackageindex.com/ready-for-swift-6")!, title: "Ready for Swift 6", read: true),
            .init(id: "r2", url: URL(string: "https://www.swift.org/migration/documentation/migrationguide/")!, title: "Migrating to Swift 6", read: true),
            .init(id: "r3", url: URL(string: "https://forums.swift.org/c/development/concurrency")!, title: "Concurrency — Swift Forums", read: true),
            .init(id: "r4", url: URL(string: "https://www.hackingwithswift.com/swift/6.0/concurrency")!, title: "Strict concurrency", read: false),
        ],
        estimateMinutes: 12,
        estimatePages: 150,
        steps: [
            .init(id: 9, line: NativeRunPhraseLine([NativeRunPhrase([.phrase("Searching for"), .quote("swift 6 migration survey 2025")])])),
            .init(id: 8, line: NativeRunPhraseLine([NativeRunPhrase([.phrase("Read"), .domain("forums.swift.org")])])),
            .init(id: 7, line: NativeRunPhraseLine([NativeRunPhrase("Reviewing what it found")])),
            .init(id: 5, line: NativeRunPhraseLine([NativeRunPhrase([.phrase("Read"), .domain("swiftpackageindex.com")])])),
            .init(id: 2, line: NativeRunPhraseLine([NativeRunPhrase("Research started")])),
        ]
    )

    static let doneResearchRun: NativeResearchRun = {
        var run = liveResearchRun
        run = NativeResearchRun(
            id: "run-done", conversationID: "conv-1", userMessageID: "q-later", goal: run.goal, state: "completed",
            title: run.title, phase: .done, approach: run.approach,
            questions: run.questions.map { .init(id: $0.id, question: $0.question, status: "covered") },
            counts: .init(found: 24, read: 11, cited: 9, searches: 8, pages: 11), workingMs: 512_000,
            leadModel: "Claude Opus 4.1", sources: run.sources,
            report: "# Swift 6 concurrency adoption\n\n## Bottom line\n\nMost actively maintained packages build in Swift 6 mode; large apps migrate module by module [1].\n\n## Key findings\n\n- 83% of indexed packages compile with complete checking [1].\n- `Sendable` diagnostics are the most common blocker [3].",
            steps: run.steps
        )
        return run
    }()

    static let planResearchRun = NativeResearchRun(
        id: "run-plan",
        conversationID: "conv-1",
        userMessageID: "q-research",
        state: "awaiting_plan_confirmation",
        phase: .awaitingStart,
        approach: liveResearchRun.approach,
        questions: liveResearchRun.questions.map { .init(id: $0.id, question: $0.question) },
        estimateMinutes: 12,
        estimatePages: 150
    )

    /// Research a profile-1 server answers in the chat, mid-way: searches and
    /// reads, no report yet.
    static let inChatResearchReply = placeholder(nil).with {
        $0.id = "a-in-chat"
        $0.model = "anthropic:claude-sonnet-4-6"
        $0.runStartedAt = Date().addingTimeInterval(-26)
        $0.researchRequested = true
        $0.activity = [
            NativeChatActivity(id: "r0", kind: .context, title: "Research corpus ready", detail: nil, url: nil),
            NativeChatActivity(id: "r1", kind: .search, title: "Searching the web", detail: "swift 6 adoption 2025", url: nil),
            NativeChatActivity(id: "r2", kind: .visit, title: "Reading source", detail: "Swift.org", url: "https://www.swift.org/blog/announcing-swift-6/"),
            NativeChatActivity(id: "r3", kind: .visit, title: "Reading source", detail: "Swift Package Index", url: "https://swiftpackageindex.com/ready-for-swift-6"),
        ]
    }
}
