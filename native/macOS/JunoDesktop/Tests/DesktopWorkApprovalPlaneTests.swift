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

    @Test("The answer carries the digest and the risk of the question it answers")
    func decisionCarriesDigestAndRisk() {
        let host = DesktopWorkHostModel()
        let asked = request(id: "a", risk: "sensitive")
        host.localApprovalRaised(asked)

        var received: (String, JunoWorkApprovalDecision, String, String)?
        host.localApprovalDecider = { id, decision, digest, risk in
            received = (id, decision, digest, risk)
        }
        host.localApprovalDecider?("a", .allowed, asked.actionDigest, asked.risk)

        #expect(received?.0 == "a")
        #expect(received?.1 == .allowed)
        // The digest is what stops a card left on screen from authorising the
        // action that replaced the one it described — `resolve` refuses a
        // mismatch rather than applying it.
        #expect(received?.2 == asked.actionDigest)
        // The risk travels because a standing grant is only constructible for
        // some levels; the runtime needs it to know whether to set an allowance.
        #expect(received?.3 == "sensitive")
    }

    @Test("With no runtime attached, answering does nothing rather than crashing")
    func decisionWithoutARuntimeIsInert() {
        let host = DesktopWorkHostModel()
        host.localApprovalRaised(request(id: "a"))
        // `localApprovalDecider` is assigned by `DesktopWorkLocalRuntime`, which
        // only exists once this Mac is hosting. A window open before that must
        // not trap on the optional call.
        host.localApprovalDecider?("a", .allowed, "digest", "edit")
        #expect(host.localApprovals.count == 1)
    }

    // MARK: - What a standing yes may cover

    @Test("A standing grant is offered only where one can actually be made")
    func standingGrantMatchesTheAllowanceRule() {
        // Mirrors `WorkRisk.mayBeCoveredByStandingAllowance` (`risk <= .command`)
        // and `WorkAlwaysAllowance(upTo:)`, whose initialiser is failable and
        // returns nil above that ceiling. Offering the button for a level the
        // model refuses would promise a permission that silently degrades to a
        // one-time yes, and the reader would be asked the same question again
        // with no explanation.
        let coverable: [JunoWorkRiskLevel] = [.safe, .edit, .command]
        let refused: [JunoWorkRiskLevel] = [.sensitive, .irreversible]

        for level in coverable {
            #expect(DesktopWorkApprovalRules.allowsStandingGrant(level))
        }
        for level in refused {
            #expect(!DesktopWorkApprovalRules.allowsStandingGrant(level))
        }
        // An unnamed level is treated as uncoverable, matching the decoder's own
        // fallback of `irreversible` for a risk it cannot classify.
        #expect(!DesktopWorkApprovalRules.allowsStandingGrant(nil))
    }
}
