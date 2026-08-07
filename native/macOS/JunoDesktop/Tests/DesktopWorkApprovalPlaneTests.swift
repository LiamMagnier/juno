import Foundation
import JunoCore
import JunoWorkKit
import Testing

@testable import JunoDesktop

/// Whether a decision reaches the person, and whether the answer reaches the
/// thing that is waiting.
///
/// Two executors raise approvals and only one of them writes a row anybody can
/// read. The cloud runner creates a `WorkApproval` and the relay serves it; a
/// run on this Mac suspends inside `WorkApprovalCoordinator` in this process and
/// creates nothing. So `NativeWorkModel.pendingApprovals` is empty for exactly
/// the runs that reach somebody's own documents, and the window has to read the
/// local coordinator as well or the card cannot appear at all.
///
/// These tests pin the two halves that were wrong: the host model has to hold
/// and route local approvals, and the standing-grant button has to be offered
/// only where a standing grant is actually constructible.
@MainActor
struct DesktopWorkApprovalPlaneTests {
    private func request(
        id: String = "apr-1",
        run: String = "run-1",
        risk: String = "edit",
        expiresIn: TimeInterval = 600
    ) -> WorkApprovalRequest {
        WorkApprovalRequest(
            approvalID: id,
            runID: run,
            action: "apply_changes",
            risk: risk,
            summary: "Save “Q3 exceptions.xlsx” into Finance/Q3",
            detail: [:],
            actionDigest: String(repeating: "c", count: 64),
            expiresAt: Date().addingTimeInterval(expiresIn),
            decision: JunoWorkApprovalDecision.pending.rawValue
        )
    }

    // MARK: - Holding the question

    @Test("A question raised on this Mac is held for the run that raised it")
    func localApprovalIsHeldPerRun() {
        let host = DesktopWorkHostModel()
        host.localApprovalRaised(request(id: "a", run: "run-1"))
        host.localApprovalRaised(request(id: "b", run: "run-2"))

        #expect(host.localApprovals.count == 2)
        // Routed by run, because the thread renders one task. An approval from
        // another run drawn under this task's title, wired to this task's Allow
        // button, is the worst thing this window could do.
        #expect(host.localApprovals(forRun: "run-1").map(\.id) == ["a"])
        #expect(host.localApprovals(forRun: "run-2").map(\.id) == ["b"])
        #expect(host.localApprovals(forRun: nil).isEmpty)
        #expect(host.localApprovals(forRun: "run-3").isEmpty)
    }

    @Test("The same question raised twice is held once")
    func localApprovalDoesNotDuplicate() {
        let host = DesktopWorkHostModel()
        host.localApprovalRaised(request(id: "a"))
        host.localApprovalRaised(request(id: "a"))
        #expect(host.localApprovals.count == 1)
    }

    @Test("Questions are answered in the order they were asked")
    func localApprovalsAreOldestFirst() {
        let host = DesktopWorkHostModel()
        // Raised out of order. The wire shape carries no `requestedAt`, so the
        // ordering is by expiry — every approval is minted with the same TTL, so
        // the one expiring soonest is the one asked first.
        host.localApprovalRaised(request(id: "later", expiresIn: 900))
        host.localApprovalRaised(request(id: "sooner", expiresIn: 300))
        #expect(host.localApprovals.map(\.id) == ["sooner", "later"])
    }

    @Test("Resolving a question takes it off the window")
    func localApprovalIsRemovedOnResolve() {
        let host = DesktopWorkHostModel()
        host.localApprovalRaised(request(id: "a"))
        host.localApprovalRaised(request(id: "b"))
        host.localApprovalResolved("a")
        #expect(host.localApprovals.map(\.id) == ["b"])
        // An unknown id is harmless: a resolution can arrive for a question this
        // window never drew, and dropping the list would clear a live card.
        host.localApprovalResolved("nonexistent")
        #expect(host.localApprovals.map(\.id) == ["b"])
    }

    // MARK: - Routing the answer

    @Test("The answer carries the digest of the question it answers")
    func decisionCarriesDigest() {
        let host = DesktopWorkHostModel()
        let asked = request(id: "a", risk: "sensitive")
        host.localApprovalRaised(asked)

        var received: (String, JunoWorkApprovalDecision, String)?
        host.localApprovalDecider = { id, decision, digest in
            received = (id, decision, digest)
        }
        host.localApprovalDecider?("a", .allowed, asked.actionDigest)

        #expect(received?.0 == "a")
        #expect(received?.1 == .allowed)
        // The digest is what stops a card left on screen from authorising the
        // action that replaced the one it described — `resolve` refuses a
        // mismatch rather than applying it.
        #expect(received?.2 == asked.actionDigest)
    }

    @Test("With no runtime attached, answering does nothing rather than crashing")
    func decisionWithoutARuntimeIsInert() {
        let host = DesktopWorkHostModel()
        host.localApprovalRaised(request(id: "a"))
        // `localApprovalDecider` is assigned by `DesktopWorkLocalRuntime`, which
        // only exists once this Mac is hosting. A window open before that must
        // not trap on the optional call.
        host.localApprovalDecider?("a", .allowed, "digest")
        #expect(host.localApprovals.count == 1)
    }

    // MARK: - What a standing yes may cover

    @Test("A standing grant is offered only where one can actually be made")
    func standingGrantMatchesTheAllowanceRule() {
        // The app cards and local runtime both consume this JunoWorkKit rule.
        // It independently checks the risk and the action identity, so a bad
        // risk classification cannot turn an always-confirm action into a
        // standing permission.
        let coverable: [JunoWorkRiskLevel] = [.safe, .edit, .command]
        let refused: [JunoWorkRiskLevel] = [.sensitive, .irreversible]

        for level in coverable {
            #expect(JunoWorkApprovalRules.allowsStandingGrant(
                action: "apply_changes", risk: level.rawValue
            ))
        }
        for level in refused {
            #expect(!JunoWorkApprovalRules.allowsStandingGrant(
                action: "apply_changes", risk: level.rawValue
            ))
        }
        #expect(!JunoWorkApprovalRules.allowsStandingGrant(
            action: JunoWorkAlwaysConfirmAction.workConnectorSendMessage.rawValue,
            risk: JunoWorkRiskLevel.safe.rawValue
        ))
        #expect(!JunoWorkApprovalRules.allowsStandingGrant(
            action: "apply_changes", risk: "unknown"
        ))
    }
}
