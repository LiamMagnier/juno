import Foundation
import XCTest

@testable import JunoWorkCore

final class WorkRiskTests: XCTestCase {
    private func path(_ raw: String) throws -> GrantedPath {
        try GrantedPath(raw)
    }

    /// Every standing allowance that can exist, for the exhaustive sweeps below.
    private var everyAllowance: [WorkAlwaysAllowance?] {
        [nil] + WorkRiskLevel.allCases.map { WorkAlwaysAllowance(upTo: $0) }
    }

    // MARK: - The vocabulary the wire shares

    func testRawValuesMatchTheSharedVocabulary() {
        XCTAssertEqual(
            WorkRiskLevel.allCases.map(\.rawValue),
            ["safe", "edit", "command", "sensitive", "irreversible"]
        )
        XCTAssertEqual(
            WorkPermissionPolicy.allCases.map(\.rawValue),
            ["conservative", "balanced", "permissive"]
        )
        XCTAssertEqual(
            WorkRisk.UnattendedPolicy.allCases.map(\.rawValue),
            ["pause_for_approval", "skip_irreversible", "disallow_irreversible"]
        )
        XCTAssertEqual(
            WorkHostState.allCases.map(\.rawValue),
            ["online", "idle", "stale", "offline"]
        )
    }

    // MARK: - Classification

    /// Trash is not delete. The file is recoverable by dragging it out of a
    /// folder, and spending the word `irreversible` on it teaches people to
    /// click through the prompts that matter.
    func testTrashIsSensitiveAndEveryOtherFileOperationIsAnEdit() throws {
        XCTAssertEqual(WorkRisk.level(of: WorkFileOperation.Kind.trash), .sensitive)
        XCTAssertNotEqual(WorkRisk.level(of: WorkFileOperation.Kind.trash), .irreversible)
        for kind in WorkFileOperation.Kind.allCases where kind != .trash {
            XCTAssertEqual(WorkRisk.level(of: kind), .edit, "\(kind.rawValue)")
        }
        for action in WorkIrreversibleAction.allCases {
            XCTAssertEqual(WorkRisk.level(of: action), .irreversible, action.rawValue)
        }
    }

    func testABatchCarriesTheRiskOfItsRiskiestOperation() throws {
        let editsOnly = try WorkBatchPlan.plan(
            grantID: WorkGrantID(value: "g"),
            operations: [
                .copy(source: try path("a.pdf"), destination: try path("b.pdf")),
                .createFolder(path: try path("Reports")),
            ]
        )
        XCTAssertEqual(WorkRisk.level(of: editsOnly), .edit)

        let withOneTrash = try WorkBatchPlan.plan(
            grantID: WorkGrantID(value: "g"),
            operations: [
                .copy(source: try path("a.pdf"), destination: try path("b.pdf")),
                .trash(path: try path("c.pdf")),
            ]
        )
        XCTAssertEqual(WorkRisk.level(of: withOneTrash), .sensitive)
    }

    // MARK: - The property the whole design exists to guarantee

    /// No policy, no mode, and no standing allowance can auto-approve a
    /// permanent delete.
    ///
    /// Swept exhaustively rather than sampled, because the failure this prevents
    /// is somebody adding a permission mode or a policy tier a year from now and
    /// nobody noticing which combination it opened.
    func testNothingCanAutoApproveAPermanentDelete() {
        for action in WorkIrreversibleAction.allCases {
            for policy in WorkPermissionPolicy.allCases {
                for mode in WorkAccessMode.allCases {
                    for allowance in everyAllowance {
                        let ruling = WorkRisk.ruling(
                            policy: policy,
                            mode: mode,
                            irreversible: action,
                            allowance: allowance
                        )
                        XCTAssertNotEqual(
                            ruling,
                            .allow,
                            "\(action.rawValue) + \(policy.rawValue) + \(mode.rawValue) auto-approved"
                        )
                    }
                }
            }
        }
    }

    /// The structural half: an "always allow" that covers an irreversible action
    /// is not a value that can be built, so there is no check to skip.
    func testNoStandingAllowanceCanEverCoverSensitiveOrIrreversibleWork() {
        XCTAssertNil(WorkAlwaysAllowance(upTo: .irreversible))
        XCTAssertNil(WorkAlwaysAllowance(upTo: .sensitive))
        XCTAssertNotNil(WorkAlwaysAllowance(upTo: .command))
        XCTAssertNotNil(WorkAlwaysAllowance(upTo: .edit))
        XCTAssertNotNil(WorkAlwaysAllowance(upTo: .safe))

        let widest = WorkAlwaysAllowance(upTo: .command)
        XCTAssertFalse(widest?.covers(.sensitive) ?? true)
        XCTAssertFalse(widest?.covers(.irreversible) ?? true)
        XCTAssertTrue(widest?.covers(.command) ?? false)
    }

    /// Stored state is not trusted to have been written by a build that knew the
    /// rule. A row saying "always allow irreversible" fails closed on the way in.
    func testAStoredAllowanceClaimingIrreversibleFailsToDecode() throws {
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                WorkAlwaysAllowance.self,
                from: Data(#"{"highestRiskCovered":"irreversible"}"#.utf8)
            )
        )
        let decoded = try JSONDecoder().decode(
            WorkAlwaysAllowance.self,
            from: Data(#"{"highestRiskCovered":"command"}"#.utf8)
        )
        XCTAssertEqual(decoded.highestRiskCovered, .command)
    }

    func testEveryPolicyStillAsksForSensitiveAndIrreversibleWork() {
        for policy in WorkPermissionPolicy.allCases {
            for allowance in everyAllowance {
                XCTAssertEqual(
                    WorkRisk.ruling(policy: policy, risk: .sensitive, allowance: allowance),
                    .requireApproval
                )
                XCTAssertEqual(
                    WorkRisk.ruling(policy: policy, risk: .irreversible, allowance: allowance),
                    .requireApproval
                )
            }
        }
    }

    // MARK: - The ordinary ladder

    func testThePolicyLadder() {
        XCTAssertEqual(WorkRisk.ruling(policy: .conservative, risk: .safe), .allow)
        XCTAssertEqual(WorkRisk.ruling(policy: .conservative, risk: .edit), .requireApproval)
        XCTAssertEqual(WorkRisk.ruling(policy: .conservative, risk: .command), .requireApproval)

        XCTAssertEqual(WorkRisk.ruling(policy: .balanced, risk: .edit), .allow)
        XCTAssertEqual(WorkRisk.ruling(policy: .balanced, risk: .command), .requireApproval)

        XCTAssertEqual(WorkRisk.ruling(policy: .permissive, risk: .command), .allow)

        // A standing allowance lifts the ladder, but only within its ceiling.
        let allowance = WorkAlwaysAllowance(upTo: .command)
        XCTAssertEqual(
            WorkRisk.ruling(policy: .conservative, risk: .command, allowance: allowance),
            .allow
        )
    }

    func testAModeThatForbidsTheOperationDeniesRatherThanOffersAPrompt() throws {
        let trash = WorkFileOperation.trash(path: try path("a.pdf"))
        let ruling = WorkRisk.ruling(
            policy: .permissive,
            mode: .readWriteNoDelete,
            operation: trash,
            allowance: WorkAlwaysAllowance(upTo: .command)
        )
        guard case .deny(let reason) = ruling else {
            return XCTFail("expected a refusal, got \(ruling)")
        }
        XCTAssertTrue(reason.contains("without permission to remove anything"))

        // The same operation under a mode that permits it still asks, because
        // trash is sensitive.
        XCTAssertEqual(
            WorkRisk.ruling(policy: .permissive, mode: .readWrite, operation: trash),
            .requireApproval
        )

        // An ordinary edit under a permissive policy proceeds.
        XCTAssertEqual(
            WorkRisk.ruling(
                policy: .permissive,
                mode: .readWrite,
                operation: .copy(source: try path("a.pdf"), destination: try path("b.pdf"))
            ),
            .allow
        )
    }

    func testAReadOnlyGrantRefusesEvenAnIrreversibleActionRatherThanAskingAboutIt() {
        let ruling = WorkRisk.ruling(
            policy: .permissive,
            mode: .read,
            irreversible: .permanentDelete
        )
        guard case .deny = ruling else {
            return XCTFail("expected a refusal, got \(ruling)")
        }
    }

    func testPolicyNarrowingOnlyEverNarrows() {
        XCTAssertEqual(WorkPermissionPolicy.narrowest([]), .permissive)
        XCTAssertEqual(WorkPermissionPolicy.narrowest([nil, nil]), .permissive)
        XCTAssertEqual(
            WorkPermissionPolicy.narrowest([.permissive, .balanced, nil]),
            .balanced
        )
        XCTAssertEqual(
            WorkPermissionPolicy.narrowest([.permissive, .conservative, .balanced]),
            .conservative
        )
    }

    // MARK: - Unattended runs

    func testAnUnattendedRunNeverAcquiresPermissionByNobodyBeingThere() {
        for policy in WorkRisk.UnattendedPolicy.allCases {
            XCTAssertNotEqual(
                WorkRisk.unattendedRuling(.requireApproval, policy: policy),
                .allow,
                policy.rawValue
            )
            // A refusal stays a refusal, and an allowance stays an allowance.
            XCTAssertEqual(WorkRisk.unattendedRuling(.allow, policy: policy), .allow)
            XCTAssertEqual(
                WorkRisk.unattendedRuling(.deny(reason: "no"), policy: policy),
                .deny(reason: "no")
            )
        }
        XCTAssertEqual(
            WorkRisk.unattendedRuling(.requireApproval, policy: .pauseForApproval),
            .requireApproval
        )
        guard case .deny = WorkRisk.unattendedRuling(.requireApproval, policy: .skipIrreversible)
        else {
            return XCTFail("skip_irreversible should refuse rather than wait")
        }
    }

    // MARK: - Honest manifests

    func testAManifestCanOnlyClaimWhatWasActuallyGranted() {
        let now = Date(timeIntervalSince1970: 1_000)
        let nothing = WorkCapabilityManifest(
            hostID: "mac-1",
            displayName: "Robin's MacBook",
            toggles: WorkHostToggles(workEnabled: true),
            generatedAt: now
        )
        XCTAssertEqual(nothing.capabilities, [])
        XCTAssertFalse(nothing.supports(.localFiles))

        let withFolders = WorkCapabilityManifest(
            hostID: "mac-1",
            displayName: "Robin's MacBook",
            toggles: WorkHostToggles(workEnabled: true, activeFolderGrants: 2),
            generatedAt: now
        )
        XCTAssertEqual(withFolders.capabilities, [.localFiles])

        // Screen control needs both permissions; one of them advertises a Mac
        // that can watch and not touch.
        let seeingOnly = WorkCapabilityManifest(
            hostID: "mac-1",
            displayName: "Robin's MacBook",
            toggles: WorkHostToggles(
                workEnabled: true,
                screenRecordingPermissionGranted: true
            ),
            generatedAt: now
        )
        XCTAssertFalse(seeingOnly.supports(.localComputerUse))

        // The master switch beats everything below it.
        let switchedOff = WorkCapabilityManifest(
            hostID: "mac-1",
            displayName: "Robin's MacBook",
            toggles: WorkHostToggles(
                workEnabled: false,
                activeFolderGrants: 5,
                accessibilityPermissionGranted: true,
                shellEnabled: true
            ),
            generatedAt: now
        )
        XCTAssertEqual(switchedOff.capabilities, [])

        // Cloud-served capabilities are never a Mac's to assert.
        let everything = WorkCapabilityManifest(
            hostID: "mac-1",
            displayName: "Robin's MacBook",
            toggles: WorkHostToggles(
                workEnabled: true,
                activeFolderGrants: 1,
                accessibilityPermissionGranted: true,
                browserProfileGrants: 1,
                screenRecordingPermissionGranted: true,
                shellEnabled: true,
                webResearchEnabled: true,
                deliverablesAvailable: true
            ),
            generatedAt: now
        )
        XCTAssertFalse(everything.supports(.connectors))
        XCTAssertFalse(everything.supports(.cloudFiles))
        XCTAssertFalse(everything.supports(.backgroundContinuation))
        XCTAssertEqual(everything.missing(from: [.cloudFiles, .localFiles]), [.cloudFiles])
    }

    func testAHostStateFollowsItsHeartbeat() {
        let seen = Date(timeIntervalSince1970: 10_000)
        XCTAssertEqual(
            WorkHostState.state(lastSeenAt: seen, now: seen, activeRuns: 1),
            .online
        )
        XCTAssertEqual(
            WorkHostState.state(lastSeenAt: seen, now: seen, activeRuns: 0),
            .idle
        )
        XCTAssertEqual(
            WorkHostState.state(
                lastSeenAt: seen,
                now: seen.addingTimeInterval(WorkHostState.staleAfter + 1),
                activeRuns: 1
            ),
            .stale
        )
        XCTAssertEqual(
            WorkHostState.state(
                lastSeenAt: seen,
                now: seen.addingTimeInterval(WorkHostState.offlineAfter + 1),
                activeRuns: 1
            ),
            .offline
        )
    }

    /// A sleeping Mac is missing everything, not everything its last heartbeat
    /// claimed. Answering from a stale manifest is how a task is sent to a Mac
    /// that cannot start it and the person watches a spinner that never resolves.
    func testAnUnusableHostIsMissingEverythingRatherThanAnsweringFromAStaleManifest() {
        let manifest = WorkCapabilityManifest(
            hostID: "mac-1",
            displayName: "Robin's MacBook",
            toggles: WorkHostToggles(workEnabled: true, activeFolderGrants: 1),
            generatedAt: Date(timeIntervalSince1970: 1_000)
        )
        func snapshot(state: WorkHostState, enabled: Bool = true, revoked: Bool = false)
            -> WorkHostSnapshot
        {
            WorkHostSnapshot(
                hostID: "mac-1",
                displayName: "Robin's MacBook",
                state: state,
                enabled: enabled,
                revoked: revoked,
                manifest: manifest
            )
        }
        XCTAssertTrue(snapshot(state: .idle).canServe([.localFiles]))
        XCTAssertTrue(snapshot(state: .online).canServe([.localFiles]))
        XCTAssertFalse(snapshot(state: .stale).canServe([.localFiles]))
        XCTAssertFalse(snapshot(state: .offline).canServe([.localFiles]))
        XCTAssertFalse(snapshot(state: .idle, enabled: false).canServe([.localFiles]))
        XCTAssertFalse(snapshot(state: .idle, revoked: true).canServe([.localFiles]))
        XCTAssertEqual(snapshot(state: .offline).missing(from: [.localFiles]), [.localFiles])
    }
}
