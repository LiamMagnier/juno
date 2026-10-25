import Foundation
import JunoCore
import JunoDesignSystem
import XCTest

@testable import JunoWorkKit

/// Where an agent's work runs, as its thread header and the iPhone's profile
/// say it: held to the web's `threadWorkNotice` and `CLOUD_WORKER_DOWN_MESSAGE`
/// (src/components/agents/thread-agent-state.ts) and to the Mac list in
/// `RunsOnSection` (src/components/agents/agent-panel.tsx).
/// tests/agents-execution-target.test.ts pins the same strings from the web side.
final class NativeAgentRunsOnTests: XCTestCase {
    private func agent(
        target: NativeAgentExecutionTarget = .cloud,
        cloudWorkAvailable: Bool? = false,
        status: NativeAgentStatus = .active
    ) -> NativeAgent {
        let date = Date(timeIntervalSince1970: 1_789_000_000)
        return NativeAgent(
            id: "agent-mira", name: "Mira", role: "", avatar: JunoAgentAvatar(shape: .orb, tone: .coral, eyes: .soft),
            style: .warm, instructions: "", model: nil, reasoningEffort: nil, approvalMode: .balanced,
            connectorIDs: [], projectID: nil, conversationID: nil, status: status, proactive: true,
            template: nil, lastReflectedAt: nil, sortOrder: 0, createdAt: date, updatedAt: date,
            state: .idle, stateSentence: "", task: nil, needsYou: 0, nextRoutine: nil, newIdeas: 0,
            executionTarget: target, cloudWorkAvailable: cloudWorkAvailable
        )
    }

    private func host(
        _ id: String,
        state: String = "online",
        enabled: Bool = true,
        revoked: Bool = false
    ) -> WorkHostSummary {
        let date = Date(timeIntervalSince1970: 1_789_000_000)
        return WorkHostSummary(
            hostID: id, deviceID: "device-\(id)", displayName: "Mac \(id)", state: state,
            enabled: enabled, capabilities: [], activeRunCount: 0, queuedRunCount: 0,
            lastSeenAt: date, revokedAt: revoked ? date : nil
        )
    }

    // MARK: The thread's notice

    func testTheThreadSaysWhenCloudWorkCannotStartInTheWebsWords() {
        XCTAssertEqual(NativeAgentFormat.cloudWorkerDownMessage, "No cloud worker is running, so tasks can't start.")
        XCTAssertEqual(
            NativeAgentFormat.workNotice(for: agent(), state: .idle),
            NativeAgentFormat.cloudWorkerDownMessage
        )
        XCTAssertNil(NativeAgentFormat.workNotice(for: agent(cloudWorkAvailable: true), state: .idle))
        XCTAssertNil(NativeAgentFormat.workNotice(for: agent(cloudWorkAvailable: nil), state: .idle), "unknown is not down")
        XCTAssertNil(NativeAgentFormat.workNotice(for: agent(target: .mac), state: .idle), "a Mac agent's Mac is on its profile")
        XCTAssertNil(NativeAgentFormat.workNotice(for: agent(status: .paused), state: .sleeping))
        for busy in [JunoAgentState.working, .thinking, .listening] {
            XCTAssertNil(NativeAgentFormat.workNotice(for: agent(), state: busy), "\(busy) says what it is doing")
        }
        XCTAssertEqual(NativeAgentFormat.workNotice(for: agent(), state: .done), NativeAgentFormat.cloudWorkerDownMessage)
    }

    // MARK: The iPhone's Mac list

    func testEachMacIsDescribedInTheWebsWords() {
        XCTAssertEqual(NativeAgentMacChoice.stateWords(host("a")), "Online")
        XCTAssertEqual(NativeAgentMacChoice.stateWords(host("a", state: "idle")), "Online")
        XCTAssertEqual(NativeAgentMacChoice.stateWords(host("a", state: "stale")), "Not responding")
        XCTAssertEqual(NativeAgentMacChoice.stateWords(host("a", state: "offline")), "Offline")
        XCTAssertEqual(NativeAgentMacChoice.stateWords(host("a", enabled: false)), "Work is switched off on this Mac")
    }

    func testRevokedMacsAreNotOffered() {
        let listed = NativeAgentsModel.runsOnHosts([host("a"), host("b", revoked: true), host("c", enabled: false)])
        XCTAssertEqual(listed.map(\.hostID), ["a", "c"], "switched off stays listed and says so; revoked is gone")
    }

    func testPickingAMacSendsTheTargetAndTheMacTogether() {
        // A cloud agent moved from the list: both, as the web's chooseMac sends
        // them, so a move refused with "Pick which Mac" goes through.
        XCTAssertEqual(
            NativeAgentMacChoice.patch("b", target: .cloud, preferredHostID: nil),
            NativeAgentPatch(executionTarget: .mac, preferredHostID: "b")
        )
        // Already on a Mac: the Mac alone.
        XCTAssertEqual(
            NativeAgentMacChoice.patch("b", target: .mac, preferredHostID: "a"),
            NativeAgentPatch(preferredHostID: "b")
        )
        XCTAssertNil(NativeAgentMacChoice.patch("a", target: .mac, preferredHostID: "a"), "already chosen")
    }

    func testTheChosenMacIsThePreferredOneOnlyWhileItRunsThereAndIsListed() {
        let hosts = [host("a"), host("b")]
        XCTAssertEqual(NativeAgentMacChoice.chosen(target: .mac, preferredHostID: "b", among: hosts), "b")
        XCTAssertNil(NativeAgentMacChoice.chosen(target: .mac, preferredHostID: nil, among: hosts), "any Mac")
        XCTAssertNil(NativeAgentMacChoice.chosen(target: .mac, preferredHostID: "gone", among: hosts))
        XCTAssertNil(NativeAgentMacChoice.chosen(target: .cloud, preferredHostID: "b", among: hosts))
    }

    func testWithNothingToListItSaysWhereToPickInstead() {
        XCTAssertEqual(NativeAgentMacChoice.emptyWords(canList: false, loaded: false, failed: false), NativeAgentMacChoice.elsewhere)
        XCTAssertEqual(NativeAgentMacChoice.emptyWords(canList: true, loaded: false, failed: true), NativeAgentMacChoice.elsewhere)
        XCTAssertEqual(NativeAgentMacChoice.emptyWords(canList: true, loaded: false, failed: false), NativeAgentMacChoice.checking)
        XCTAssertEqual(NativeAgentMacChoice.emptyWords(canList: true, loaded: true, failed: false), NativeAgentMacChoice.noMac)
        XCTAssertEqual(NativeAgentMacChoice.elsewhere, "Pick which Mac it uses in the Alevr Mac app or on the web.")
        XCTAssertFalse(NativeAgentMacChoice.elsewhere.contains("—"))
    }
}
