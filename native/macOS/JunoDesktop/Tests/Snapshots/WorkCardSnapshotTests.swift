import AppKit
import Foundation
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// The chat's run card (§6.8) in its three states, light and dark:
/// `$JUNO_SNAPSHOT_DIR/work/work-card-<state>-<light|dark>.png`.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the work card snapshots."
    ),
    .serialized
)
struct WorkCardSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("work", isDirectory: true)
    }

    @Test(arguments: ["running", "needs-approval", "finished"])
    func cardDrawsInBothAppearances(_ name: String) async throws {
        let state = try #require(WorkCardFixtures.state(name))
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                ChatWorkRunCard(state: state, actions: ChatWorkRunActions(pause: {}, resume: {}))
                    .padding(.horizontal, JunoSpace.regular),
                name: "work-card-\(name)",
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

@MainActor
enum WorkCardFixtures {
    static let start = Date(timeIntervalSince1970: 1_790_000_000)

    static func state(_ name: String) -> ChatWorkRunState? {
        switch name {
        case "running":
            ChatWorkRunState(
                session: session(status: "running"), status: .running,
                run: run(status: "running"), events: planEvents + [
                    event(6, .stepStarted, ["stepId": .string("s2"), "title": .string("Read each invoice")]),
                    event(7, .assistantMessage, [
                        "text": .string("Found **14 invoices** from August. Three are missing a PO number."),
                    ]),
                    event(8, .toolStarted, [
                        "summary": .string("Reading invoice 9 of 14"), "detail": .string("Acme-2026-08.pdf"),
                    ]),
                ],
                question: nil, approvals: [], now: start.addingTimeInterval(154)
            )
        case "needs-approval":
            ChatWorkRunState(
                session: session(status: "waiting_approval"), status: .waitingApproval,
                run: run(status: "waiting_approval"), events: planEvents + [
                    event(6, .stepFinished, ["stepId": .string("s2")]),
                    event(7, .stepStarted, ["stepId": .string("s3"), "title": .string("Email the three suppliers")]),
                ],
                question: WorkQuestionPrompt(
                    questionID: "q1", text: "Should I copy your accountant on the emails?",
                    options: ["Yes, copy them", "No, just the suppliers"],
                    why: "You mentioned them in the last thread about invoices."
                ),
                approvals: [
                    ChatWorkApproval(
                        request: WorkApprovalRequest(
                            approvalID: "a1", runID: "run_1", action: "send_email",
                            risk: "sensitive",
                            summary: "Send 3 emails asking Acme, Birch & Co and Corvid for PO numbers",
                            detail: [:], actionDigest: "d1",
                            expiresAt: Date().addingTimeInterval(20 * 60), decision: "pending"
                        ),
                        isLocal: true
                    ),
                ],
                now: start.addingTimeInterval(312)
            )
        case "finished":
            ChatWorkRunState(
                session: session(status: "completed"), status: .completed,
                run: run(status: "completed", finished: 540), events: planEvents + [
                    event(6, .stepFinished, ["stepId": .string("s2")]),
                    event(7, .stepFinished, ["stepId": .string("s3")]),
                    event(8, .assistantMessage, [
                        "text": .string(
                            "Done. I read all **14 invoices** and emailed the three suppliers missing a PO number:\n\n- Acme\n- Birch & Co\n- Corvid\n\nReplies will land in your inbox."
                        ),
                    ]),
                ],
                question: nil, approvals: [], now: start.addingTimeInterval(600)
            )
        default: nil
        }
    }

    private static var planEvents: [WorkEvent] {
        [
            event(4, .planCreated, [
                "steps": .array([
                    .object(["id": .string("s1"), "title": .string("Find August's invoices"), "state": .string("done")]),
                    .object(["id": .string("s2"), "title": .string("Read each invoice")]),
                    .object(["id": .string("s3"), "title": .string("Email the three suppliers")]),
                    .object(["id": .string("s4"), "title": .string("Summarise what came back")]),
                ]),
            ]),
        ]
    }

    private static func session(status: String) -> WorkSessionSummary {
        WorkSessionSummary(
            sessionID: "sess_1", title: "Chase August invoices missing a PO number",
            goal: "Chase August invoices", status: status, needsAttention: status.hasPrefix("waiting"),
            requestedTarget: "automatic", effectiveTarget: "cloud", hostID: nil,
            hostDisplayName: nil, pinned: false, archived: false, lastActivityAt: start,
            currentRunID: "run_1", lastSeq: 8, conversationID: "conv_1", createdAt: start
        )
    }

    private static func run(status: String, finished: TimeInterval? = nil) -> WorkRunSummary {
        WorkRunSummary(
            runID: "run_1", sessionID: "sess_1", attempt: 1, status: status,
            terminalReason: finished == nil ? nil : "completed", requestedTarget: "automatic",
            effectiveTarget: "cloud", hostID: nil, effectiveModel: nil, degradation: [],
            costMicroUsd: finished == nil ? 42_000 : 118_000, maxCostMicroUsd: 2_000_000,
            lastSeq: 8, startedAt: start, finishedAt: finished.map { start.addingTimeInterval($0) }
        )
    }

    private static func event(
        _ seq: Int, _ kind: JunoWorkEventKind, _ payload: [String: JunoJSONValue]
    ) -> WorkEvent {
        WorkEvent(
            seq: seq, kind: kind.rawValue, payload: payload, agentID: nil,
            createdAt: start.addingTimeInterval(Double(seq))
        )
    }
}
