import Foundation
import XCTest
@testable import JunoChatKit

final class NativeRunTimelineTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_758_000_000)

    private func event(
        _ id: String,
        _ kind: NativeChatActivity.Kind,
        _ title: String,
        detail: String? = nil,
        at offset: TimeInterval? = nil,
        seq: Int? = nil,
        call: NativeToolCall? = nil,
        segment: NativeReasoningSegment? = nil,
        commentary: NativeRunCommentary? = nil,
        tool: NativeToolDetail? = nil
    ) -> NativeChatActivity {
        NativeChatActivity(
            id: id, kind: kind, title: title, detail: detail, url: nil,
            createdAt: offset.map { start.addingTimeInterval($0) },
            seq: seq, call: call, segment: segment, commentary: commentary, tool: tool
        )
    }

    // MARK: The legacy adapter

    /// Today's rows: a connector call that carries its detail becomes a call;
    /// an approval request is dropped (its outcome is unknown); a warning is a
    /// notice; the reasoning comes first; facts and timing come from the rest.
    func testTheLegacyAdapterReadsTodaysRows() {
        let rows = [
            event("c", .context, "Reading the conversation context", detail: "3 messages", at: 0),
            event("m", .model, "Selected model", detail: "Anthropic · Claude Sonnet 4.6", at: 0.1),
            event("e", .reasoning, "Reasoning mode enabled", detail: "High effort", at: 0.1),
            event("w1", .warning, "Model changed", detail: "Routed to a faster model.", at: 0.2),
            event("t0", .tool, "Linear needs approval", detail: "linear__create_issue", at: 1),
            event("t1", .tool, "Using Linear", detail: "linear__search_issues", at: 2, tool: NativeToolDetail(
                server: "Linear", name: "linear__search_issues", args: "{}", result: "[]", status: "ok", durationMs: 840
            )),
            event("t2", .tool, "Using Linear", detail: "linear__create_issue", at: 3, tool: NativeToolDetail(
                server: "Linear", name: "linear__create_issue", status: "failed"
            )),
            event("v", .visit, "Visited source", detail: "swift.org", at: 4),
            event("wr", .write, "Writing the answer", at: 12.4),
            event("d", .done, "Finished response", at: 19),
        ]
        let view = NativeRunView.build(activity: rows, reasoning: "Thinking it through.", reasoningParts: nil)

        XCTAssertFalse(view.typed)
        XCTAssertEqual(view.items.map(\.id), ["reasoning", "w1", "t1", "t2"])
        XCTAssertEqual(view.calls.map(\.tool), ["mcp", "mcp"])
        XCTAssertEqual(view.calls.map(\.status), [.succeeded, .failed])
        XCTAssertEqual(view.calls.first?.connectorLabel, "Linear")
        XCTAssertEqual(view.calls.first?.toolTitle, "Search issues")
        XCTAssertEqual(view.counts.failedTools, 1)
        XCTAssertEqual(view.counts.warnings, 1)
        XCTAssertEqual(view.counts.connectorsUsed, ["Linear"])
        XCTAssertEqual(view.facts.model, "Anthropic · Claude Sonnet 4.6")
        XCTAssertEqual(view.facts.effort, "High effort")
        XCTAssertEqual(view.facts.context, "3 messages")
        XCTAssertEqual(view.timing.workedMs, 12_400)
    }

    /// Reasoning parts become one item each; a turn with nothing but an answer
    /// has nothing to show.
    func testReasoningPartsAndTheTrivialTurn() {
        let parted = NativeRunView.build(activity: [], reasoning: "a b", reasoningParts: ["First part.", "Second part."])
        XCTAssertEqual(parted.items.map(\.id), ["reasoning-0", "reasoning-1"])
        XCTAssertTrue(parted.hasContent(sourceCount: 0))

        let trivial = NativeRunView.build(activity: [event("wr", .write, "Writing the answer", at: 0.2)], reasoning: nil)
        XCTAssertTrue(trivial.items.isEmpty)
        XCTAssertFalse(trivial.hasContent(sourceCount: 0))
        XCTAssertTrue(trivial.hasContent(sourceCount: 2), "sources alone earn the line")
    }

    // MARK: The typed timeline

    /// With `seq`, the order is the server's, reasoning is sliced by its
    /// segments, commentary stays out of the answer, and calls keep their
    /// records.
    func testTheTypedTimelineIsOrderedBySequence() {
        let reasoning = "Plan the search.Compare the two."
        let search = NativeToolCall(
            callID: "c1", tool: "web_search", status: .succeeded, round: 0,
            figure: NativeToolCall.Figure(kind: "results", n: 8),
            web: NativeToolCall.Web(query: "swift 6 adoption")
        )
        let fetch = NativeToolCall(
            callID: "c2", tool: "web_fetch", status: .running, round: 1,
            web: NativeToolCall.Web(requestedURL: "https://www.swift.org/blog/")
        )
        let rows = [
            event("f", .visit, "Visited source", seq: 4, call: fetch),
            event("s1", .reasoning, "Thinking", seq: 1, segment: NativeReasoningSegment(round: 0, offset: 0)),
            event("k", .search, "Searching the web", seq: 2, call: search),
            event("cm", .reasoning, "Commentary", seq: 3, commentary: NativeRunCommentary(round: 0, text: "Let me check.", inline: true)),
            event("s2", .reasoning, "Thinking", seq: 5, segment: NativeReasoningSegment(round: 1, offset: 16)),
        ]
        let view = NativeRunView.build(activity: rows, reasoning: reasoning)

        XCTAssertTrue(view.typed)
        XCTAssertEqual(view.items.map(\.id), ["s1", "k", "cm", "f", "s2"])
        guard case .reasoning(_, let first) = view.items[0], case .reasoning(_, let second) = view.items[4] else {
            return XCTFail("expected reasoning at both ends")
        }
        XCTAssertEqual(first, "Plan the search.")
        XCTAssertEqual(second, "Compare the two.")
        XCTAssertEqual(view.counts.searches, 1)

        let phase = NativeRunPhase.derive(
            view: view, live: true, failed: false, finishReason: nil, answerStarted: false, awaitingApproval: false
        )
        XCTAssertEqual(phase, .reading)
        XCTAssertEqual(
            NativeToolPresentation.liveLabel(phase: phase, view: view, elapsed: 5, recovering: false),
            "Reading swift.org"
        )
    }

    // MARK: Phases

    func testPhasesFollowTheSpecsOrder() {
        let thinking = NativeRunView.build(activity: [], reasoning: "Hmm.")
        XCTAssertEqual(
            NativeRunPhase.derive(view: thinking, live: true, failed: false, finishReason: nil, answerStarted: false, awaitingApproval: false),
            .thinking
        )
        XCTAssertEqual(
            NativeRunPhase.derive(view: thinking, live: true, failed: false, finishReason: nil, answerStarted: false, awaitingApproval: true),
            .waiting
        )
        XCTAssertEqual(
            NativeRunPhase.derive(view: thinking, live: true, failed: false, finishReason: nil, answerStarted: true, awaitingApproval: false),
            .answering
        )
        XCTAssertEqual(
            NativeRunPhase.derive(view: thinking, live: false, failed: false, finishReason: .userStopped, answerStarted: true, awaitingApproval: false),
            .stopped
        )
        XCTAssertEqual(
            NativeRunPhase.derive(view: thinking, live: false, failed: true, finishReason: .error, answerStarted: false, awaitingApproval: false),
            .failed
        )
        let empty = NativeRunView.build(activity: [], reasoning: nil)
        XCTAssertEqual(
            NativeRunPhase.derive(view: empty, live: true, failed: false, finishReason: nil, answerStarted: false, awaitingApproval: false),
            .queued
        )
    }

    /// The web's rungs, verbatim, and a provider headline over "Thinking".
    func testTheThinkingLadder() {
        let plain = NativeRunView.build(activity: [], reasoning: "Working it out.")
        XCTAssertEqual(NativeToolPresentation.liveLabel(phase: .thinking, view: plain, elapsed: 4, recovering: false), "Thinking")
        XCTAssertEqual(
            NativeToolPresentation.liveLabel(phase: .thinking, view: plain, elapsed: 130, recovering: false),
            "Still thinking. This can take a few minutes."
        )
        XCTAssertEqual(
            NativeToolPresentation.liveLabel(phase: .thinking, view: plain, elapsed: 700, recovering: false),
            "Still working. You can leave; the answer will be here."
        )
        XCTAssertEqual(NativeToolPresentation.liveLabel(phase: .thinking, view: plain, elapsed: 4, recovering: true), "Reconnecting…")
        let headed = NativeRunView.build(activity: [], reasoning: "**Weighing the options**\n\nFirst, the costs.")
        XCTAssertEqual(NativeToolPresentation.liveLabel(phase: .thinking, view: headed, elapsed: 4, recovering: false), "Weighing the options")
    }

    // MARK: Words

    func testTheSummaryLineGrammar() {
        let thought = NativeRunView.build(activity: [], reasoning: "Hmm.")
        XCTAssertEqual(NativeToolPresentation.summaryLead(thought, workedMs: 12_400), "Thought for 12s")
        XCTAssertEqual(NativeToolPresentation.summaryLead(thought, workedMs: 64_000), "Thought for 1m 4s")
        XCTAssertEqual(NativeToolPresentation.summaryLead(thought, workedMs: nil), "Thought process")
        XCTAssertEqual(NativeToolPresentation.summaryFacts(thought, sourceCount: 5), ["5 sources"])

        let worked = NativeRunView.build(
            activity: [event("t", .tool, "Using Linear", tool: NativeToolDetail(server: "Linear", name: "linear__x", status: "ok"))],
            reasoning: nil
        )
        XCTAssertEqual(NativeToolPresentation.summaryLead(worked, workedMs: 3_000), "Worked for 3s")
        XCTAssertEqual(NativeToolPresentation.summaryFacts(worked, sourceCount: 1), ["1 source", "used Linear"])
    }

    func testToolPhrasesAndFailures() {
        let search = NativeToolCall(callID: "a", tool: "web_search", status: .running, web: NativeToolCall.Web(query: "rust async runtimes compared in depth for servers"))
        XCTAssertEqual(NativeToolPresentation.running(search), "Searching the web for \u{201C}rust async runtimes compared in depth f…\u{201D}")
        var done = search
        done.status = .succeeded
        XCTAssertTrue(NativeToolPresentation.phrase(done).hasPrefix("Searched the web for"))

        let timeout = NativeToolCall(callID: "b", tool: "web_fetch", status: .failed, timeoutMs: 20_000, errorCode: "timeout")
        XCTAssertEqual(NativeToolPresentation.phrase(timeout), "Timed out after 20s")
        let denied = NativeToolCall(callID: "c", tool: "mcp", connectorLabel: "GitHub", status: .denied)
        XCTAssertEqual(NativeToolPresentation.phrase(denied), "You declined this")
        let code = NativeToolCall(callID: "d", tool: "run_code", status: .succeeded, figure: NativeToolCall.Figure(kind: "files", n: 2))
        XCTAssertEqual(NativeToolPresentation.figure(code), "2 files created")
        XCTAssertEqual(NativeToolPresentation.clock(seconds: 64), "1:04")
        XCTAssertEqual(NativeToolPresentation.clock(seconds: 9), "9s")
    }
}
