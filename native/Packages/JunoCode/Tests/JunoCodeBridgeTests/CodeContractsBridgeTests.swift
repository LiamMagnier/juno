import XCTest
import JunoCodeCore
@testable import JunoCodeBridge
import JunoCodeKit

final class CodeContractsBridgeTests: XCTestCase {
    func testLocationRoundTrip() {
        for location in SessionLocation.allCases {
            let contract = CodeContractsBridge.executionLocation(from: location)
            XCTAssertEqual(CodeContractsBridge.sessionLocation(from: contract), location)
            XCTAssertEqual(contract.rawValue, location.rawValue)
        }
    }

    func testPermissionMapping() {
        XCTAssertEqual(CodeContractsBridge.contractPermission(from: .readOnly), .readOnly)
        XCTAssertEqual(CodeContractsBridge.contractPermission(from: .askBeforeChanges), .acceptEdits)
        XCTAssertEqual(CodeContractsBridge.contractPermission(from: .workspaceWrite), .acceptEdits)
        XCTAssertEqual(CodeContractsBridge.contractPermission(from: .fullAccess), .fullAccess)
        // Reverse mapping picks the safest interactive tier.
        XCTAssertEqual(CodeContractsBridge.localPermission(from: .acceptEdits), .askBeforeChanges)
        XCTAssertEqual(CodeContractsBridge.localPermission(from: .readOnly), .readOnly)
        XCTAssertEqual(CodeContractsBridge.localPermission(from: .fullAccess), .fullAccess)
    }

    func testPathBridgeRejectsWhatEitherSideRejects() throws {
        let local = try JunoCodeCore.WorkspacePath("src/main.swift")
        let contract = try CodeContractsBridge.contractPath(from: local)
        XCTAssertEqual(contract.value, "src/main.swift")
        let back = try CodeContractsBridge.localPath(from: contract)
        XCTAssertEqual(back, local)
    }

    func testApprovalBridgePreservesDigestBinding() throws {
        let digest = Digests.sha256Hex("action")
        let now = Date()
        let local = JunoCodeCore.ApprovalRequest(
            sessionID: CodeSessionID(),
            actionDigest: digest,
            toolName: "write_file",
            summary: "Write a file",
            risk: .write,
            requestedAt: now,
            expiresAt: now.addingTimeInterval(300)
        )
        let contract = try CodeContractsBridge.contractApproval(from: local)
        XCTAssertEqual(contract.id, local.id)
        XCTAssertTrue(contract.authorizes(try ActionDigest(digest), at: now))
        XCTAssertFalse(
            contract.authorizes(
                try ActionDigest(Digests.sha256Hex("other")),
                at: now
            )
        )
    }

    func testTaskConfigurationBridge() throws {
        let configuration = AgentConfiguration(
            modelID: "claude-sonnet-5",
            reasoningEffort: .high,
            role: .engineer,
            permissionMode: .workspaceWrite,
            location: .cloud
        )
        let task = try CodeContractsBridge.taskConfiguration(
            repositoryID: "repo_123",
            baseBranch: "main",
            prompt: "Fix the flaky test",
            configuration: configuration
        )
        XCTAssertEqual(task.location, .cloud)
        XCTAssertEqual(task.permission, .acceptEdits)
        XCTAssertEqual(task.modelID, "claude-sonnet-5")
        XCTAssertEqual(task.reasoningEffort, "high")
    }
}
