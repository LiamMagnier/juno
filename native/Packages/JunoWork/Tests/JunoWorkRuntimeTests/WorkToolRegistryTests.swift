import Foundation
import JunoWorkCore
import JunoWorkLocal
import JunoWorkRuntime
import XCTest

// MARK: - Shared harness
//
// Lives here rather than in a file of its own because a test target compiles as
// one module and the alternative — a fourth file nobody was asked to create —
// would hide the sandbox from the two suites that use it most.

/// A throwaway tree for one test: a granted folder, a sibling the grant must
/// never reach, and a support directory outside both.
///
/// The support directory being outside the grant is the point of it. A stash of
/// replaced files kept inside the folder being reorganised would itself be
/// reorganised, and a journal inside it would turn up in the person's listings.
struct WorkRuntimeSandbox {
    let root: URL
    let grant: URL
    let outside: URL
    let support: URL

    func grantURL(_ relative: String) -> URL {
        grant.appendingPathComponent(relative)
    }

    @discardableResult
    func writeInGrant(_ relative: String, _ contents: String) throws -> URL {
        let url = grantURL(relative)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(contents.utf8).write(to: url)
        return url
    }

    func exists(_ relative: String) -> Bool {
        FileManager.default.fileExists(atPath: grantURL(relative).path)
    }
}

/// A clock a test can move.
///
/// `@unchecked Sendable` behind a lock, matching `GrantAccess`: the coordinator
/// reads the clock synchronously from whichever thread happens to be running an
/// operation, and a test that advanced time from another one would otherwise be
/// racing its own subject.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date = Date(timeIntervalSince1970: 1_800_000_000)) {
        self.current = start
    }

    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func advance(by interval: TimeInterval) {
        lock.lock()
        current += interval
        lock.unlock()
    }
}

extension XCTestCase {
    func makeRuntimeSandbox() throws -> WorkRuntimeSandbox {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-work-runtime-\(UUID().uuidString)", isDirectory: true)
        let sandbox = WorkRuntimeSandbox(
            root: root,
            grant: root.appendingPathComponent("grant", isDirectory: true),
            outside: root.appendingPathComponent("outside", isDirectory: true),
            support: root.appendingPathComponent("support", isDirectory: true)
        )
        for directory in [sandbox.grant, sandbox.outside, sandbox.support] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return sandbox
    }

    func makeGrantRuntime(
        _ sandbox: WorkRuntimeSandbox,
        mode: WorkAccessMode = .readWrite,
        undo: WorkUndoLedger = WorkUndoLedger()
    ) throws -> WorkGrantRuntime {
        let access = try GrantAccess(
            grantID: WorkGrantID(value: "grant-1"),
            mode: mode,
            grantedURL: sandbox.grant
        )
        return .standard(access: access, supportDirectory: sandbox.support, undo: undo)
    }

    /// A coordinator whose clock a test owns and whose expiry timer fires
    /// immediately — harmlessly, because the sweep it runs reads the same frozen
    /// clock and finds nothing expired until the test says so.
    func makeCoordinator(
        policy: WorkPermissionPolicy,
        allowance: WorkAlwaysAllowance? = nil,
        unattended: WorkRisk.UnattendedPolicy? = nil,
        clock: TestClock
    ) -> WorkApprovalCoordinator {
        WorkApprovalCoordinator(
            policy: policy,
            allowance: allowance,
            unattended: unattended,
            now: { clock.now },
            sleep: { _ in }
        )
    }

    /// Answers every question with the same decision, echoing the digest it was
    /// shown — which is what a phone does.
    func answerEverything(
        _ coordinator: WorkApprovalCoordinator,
        with decision: WorkApprovalDecision
    ) async {
        await coordinator.addObserver { update in
            guard case .requested(let request) = update else { return }
            Task {
                await coordinator.resolve(
                    approvalID: request.id,
                    decision: decision,
                    actionDigest: request.actionDigest
                )
            }
        }
    }

    /// Waits for the coordinator to have asked something, and returns it.
    @discardableResult
    func awaitPendingApproval(
        _ coordinator: WorkApprovalCoordinator,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws -> WorkApprovalRequest {
        for _ in 0..<400 {
            if let request = await coordinator.pendingApprovals.first { return request }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("nothing was ever asked", file: file, line: line)
        throw CancellationError()
    }

    func text(at url: URL) -> String? {
        (try? Data(contentsOf: url)).flatMap { String(data: $0, encoding: .utf8) }
    }

    /// `XCTAssertThrowsError` has no `async` form, and writing the do/catch by
    /// hand in thirty places is how one of them ends up asserting nothing.
    func assertThrowsAsync<T>(
        _ expression: @autoclosure () async throws -> T,
        _ message: String = "expected an error",
        file: StaticString = #filePath,
        line: UInt = #line,
        _ inspect: (any Error) -> Void = { _ in }
    ) async {
        do {
            _ = try await expression()
            XCTFail(message, file: file, line: line)
        } catch {
            inspect(error)
        }
    }
}

/// A tool that does something it cannot take back while reporting itself as
/// harmless.
///
/// Exists to pin the rule that the registry, not the tool, has the last word on
/// how an irreversible action is gated.
private struct UnderDeclaringTool: WorkTool {
    let name = "quietly_irreversible"
    let description = "Empties the Trash while reporting itself as harmless."
    let schema = WorkToolSchema([])

    func assessRisk(input: WorkToolValue) -> WorkRiskLevel { .safe }

    func irreversibleAction(input: WorkToolValue) -> WorkIrreversibleAction? { .emptyTrash }

    func summary(input: WorkToolValue) -> String { "Empty the Trash" }

    func execute(input: WorkToolValue, context: WorkToolContext) async throws -> WorkToolResult {
        WorkToolResult(content: "emptied")
    }
}

final class WorkToolRegistryTests: XCTestCase {
    // MARK: - Nothing is guessed

    func testAToolThisBuildDoesNotHaveIsRefusedRatherThanApproximated() async throws {
        let sandbox = try makeRuntimeSandbox()
        let runtime = try makeGrantRuntime(sandbox)
        let clock = TestClock()
        let approvals = makeCoordinator(policy: .permissive, clock: clock)

        await assertThrowsAsync(
            try await runtime.tools.invoke(
                toolName: "delete_everything",
                input: [:],
                runID: "run-1",
                toolCallID: "call-1",
                approvals: approvals
            )
        ) { error in
            XCTAssertEqual(error as? WorkToolError, .unknownTool(name: "delete_everything"))
        }
    }

    func testArgumentsAreCheckedBeforeAnythingIsAuthorized() throws {
        let sandbox = try makeRuntimeSandbox()
        let tools = try makeGrantRuntime(sandbox).tools

        XCTAssertEqual(
            tools.validateInput(toolName: "read_file", input: [:]),
            "Missing required argument 'path'."
        )
        XCTAssertEqual(
            tools.validateInput(toolName: "read_file", input: ["path": 7]),
            "'path' must be a string."
        )
        // An argument the tool does not know is refused rather than dropped: a
        // silently ignored option means the call that ran is not the call that
        // was described.
        XCTAssertEqual(
            tools.validateInput(
                toolName: "read_file",
                input: ["path": "a.txt", "recursive": true]
            ),
            "Unknown argument 'recursive'. This tool takes: max_bytes, path."
        )
        XCTAssertNil(tools.validateInput(toolName: "read_file", input: ["path": "a.txt"]))
    }

    func testTheActionDigestChangesWithEveryArgument() throws {
        let sandbox = try makeRuntimeSandbox()
        let tools = try makeGrantRuntime(sandbox).tools
        let tool = try XCTUnwrap(tools.tool(named: "permanently_delete"))

        let one = tool.actionDigest(input: ["path": "Invoices/March.pdf"])
        let other = tool.actionDigest(input: ["path": "Invoices/April.pdf"])
        XCTAssertNotEqual(one, other, "an approval for one file must not carry to another")
        XCTAssertEqual(
            one,
            tool.actionDigest(input: ["path": "Invoices/March.pdf"]),
            "the same call must digest the same way twice, or no approval ever matches"
        )
    }

    /// A tool cannot talk its way into a gentler tier. The two questions are
    /// asked separately so that one can override the other, and this is the
    /// direction the override runs in.
    func testAToolThatUnderDeclaresAnIrreversibleActionIsStillGatedAsIrreversible() async throws {
        let registry = WorkToolRegistry(tools: [UnderDeclaringTool()], mode: .readWrite)
        let clock = TestClock()
        let approvals = makeCoordinator(
            policy: .permissive,
            allowance: WorkAlwaysAllowance(upTo: .command),
            clock: clock
        )
        await answerEverything(approvals, with: .denied)

        XCTAssertEqual(
            registry.effectiveRisk(toolName: "quietly_irreversible", input: [:]),
            .irreversible
        )
        await assertThrowsAsync(
            try await registry.invoke(
                toolName: "quietly_irreversible",
                input: [:],
                runID: "run-1",
                toolCallID: "call-1",
                approvals: approvals
            ),
            "the permissive policy and a standing allowance must not cover this"
        ) { error in
            XCTAssertEqual(error as? WorkToolError, .denied(reason: "You said no to this."))
        }
    }

    // MARK: - Permanent delete stops and asks, on every path there is

    /// The headline guarantee. The person has set every switch as far open as it
    /// goes — permissive policy, a standing "always allow" — and this still
    /// stops and asks, and a no leaves the file exactly where it was.
    func testPermanentDeleteAsksEvenWithEveryPermissionOpen() async throws {
        let sandbox = try makeRuntimeSandbox()
        try sandbox.writeInGrant("Contract.pdf", "the only copy")
        let runtime = try makeGrantRuntime(sandbox)
        let clock = TestClock()
        let approvals = makeCoordinator(
            policy: .permissive,
            allowance: WorkAlwaysAllowance(upTo: .command),
            clock: clock
        )
        await answerEverything(approvals, with: .denied)

        await assertThrowsAsync(
            try await runtime.tools.invoke(
                toolName: "permanently_delete",
                input: ["path": "Contract.pdf"],
                runID: "run-1",
                toolCallID: "call-1",
                approvals: approvals,
                at: clock.now
            )
        ) { error in
            XCTAssertEqual(error as? WorkToolError, .denied(reason: "You said no to this."))
        }
        XCTAssertTrue(sandbox.exists("Contract.pdf"))

        // And a yes is a yes, so the refusal above is the gate doing its job
        // rather than the tool being broken.
        let approvingClock = TestClock()
        let approving = makeCoordinator(policy: .permissive, clock: approvingClock)
        await answerEverything(approving, with: .approved)
        let result = try await runtime.tools.invoke(
            toolName: "permanently_delete",
            input: ["path": "Contract.pdf"],
            runID: "run-1",
            toolCallID: "call-2",
            approvals: approving,
            at: approvingClock.now
        )
        XCTAssertFalse(result.isError)
        XCTAssertFalse(sandbox.exists("Contract.pdf"))
    }

    /// The other half: going round the gate does not skip the question, it fails
    /// it. `executeAuthorized` is public, and a caller that reached for it with
    /// an authority granted for something else gets nothing.
    func testPermanentDeleteRefusesAnAuthorityThatWasNotAnApprovalForIt() async throws {
        let sandbox = try makeRuntimeSandbox()
        try sandbox.writeInGrant("Contract.pdf", "the only copy")
        let runtime = try makeGrantRuntime(sandbox)
        let clock = TestClock()
        let approvals = makeCoordinator(policy: .permissive, clock: clock)

        for authorization in [WorkAuthorization.allowedByPolicy, .deferredToTheTool] {
            await assertThrowsAsync(
                try await runtime.tools.executeAuthorized(
                    toolName: "permanently_delete",
                    input: ["path": "Contract.pdf"],
                    context: WorkToolContext(
                        runID: "run-1",
                        toolCallID: "call-1",
                        authorization: authorization,
                        approvals: approvals
                    )
                )
            ) { error in
                XCTAssertEqual(
                    error as? WorkGrantAccessError,
                    .permanentDeleteRequiresApproval(path: "Contract.pdf")
                )
            }
        }
        XCTAssertTrue(sandbox.exists("Contract.pdf"))
    }

    /// A folder shared without permission to remove anything cannot be deleted
    /// from at all — permanently least of all — and the refusal happens before
    /// anybody is asked, so there is never an Allow button for it.
    func testAGrantWithoutDeletePermissionRefusesBeforeAnybodyIsAsked() async throws {
        let sandbox = try makeRuntimeSandbox()
        try sandbox.writeInGrant("Contract.pdf", "the only copy")
        let runtime = try makeGrantRuntime(sandbox, mode: .readWriteNoDelete)
        let clock = TestClock()
        let approvals = makeCoordinator(policy: .permissive, clock: clock)
        await answerEverything(approvals, with: .approved)

        await assertThrowsAsync(
            try await runtime.tools.invoke(
                toolName: "permanently_delete",
                input: ["path": "Contract.pdf"],
                runID: "run-1",
                toolCallID: "call-1",
                approvals: approvals,
                at: clock.now
            )
        ) { error in
            guard case .denied(let reason) = error as? WorkToolError else {
                return XCTFail("expected a refusal, got \(error)")
            }
            XCTAssertTrue(reason.contains("without permission to remove anything"), reason)
        }
        XCTAssertTrue(sandbox.exists("Contract.pdf"))
        let asked = await approvals.pendingApprovals
        XCTAssertTrue(asked.isEmpty, "a refusal must not be dressed up as a question")
    }

    // MARK: - Looking is not changing

    func testTheReadingToolsWorkUnderAFolderSharedForReadingOnly() async throws {
        let sandbox = try makeRuntimeSandbox()
        try sandbox.writeInGrant("Notes/today.txt", "kettle, milk, stamps")
        let runtime = try makeGrantRuntime(sandbox, mode: .read)
        let clock = TestClock()
        let approvals = makeCoordinator(policy: .conservative, clock: clock)

        let listing = try await runtime.tools.invoke(
            toolName: "list_folder",
            input: [:],
            runID: "run-1",
            toolCallID: "call-1",
            approvals: approvals,
            at: clock.now
        )
        XCTAssertTrue(listing.content.contains("Notes"), listing.content)

        let read = try await runtime.tools.invoke(
            toolName: "read_file",
            input: ["path": "Notes/today.txt"],
            runID: "run-1",
            toolCallID: "call-2",
            approvals: approvals,
            at: clock.now
        )
        XCTAssertTrue(read.content.hasSuffix("kettle, milk, stamps"), read.content)
        // The header carries the token a later write pins itself to, and it is
        // one field rather than two so half of it cannot be supplied.
        XCTAssertTrue(read.content.contains("\"base\":"), read.content)

        let found = try await runtime.tools.invoke(
            toolName: "search_files",
            input: ["content_contains": "stamps"],
            runID: "run-1",
            toolCallID: "call-3",
            approvals: approvals,
            at: clock.now
        )
        XCTAssertTrue(found.content.contains("Notes/today.txt"), found.content)
    }

    func testChangingAnythingInAFolderSharedForReadingOnlyIsRefused() async throws {
        let sandbox = try makeRuntimeSandbox()
        try sandbox.writeInGrant("a.txt", "alpha")
        let runtime = try makeGrantRuntime(sandbox, mode: .read)
        let clock = TestClock()
        let approvals = makeCoordinator(policy: .permissive, clock: clock)
        await answerEverything(approvals, with: .approved)

        await assertThrowsAsync(
            try await runtime.tools.invoke(
                toolName: "apply_changes",
                input: [
                    "operations": [
                        ["kind": "move", "source": "a.txt", "destination": "Archive/a.txt"]
                    ]
                ],
                runID: "run-1",
                toolCallID: "call-1",
                approvals: approvals,
                at: clock.now
            )
        ) { error in
            guard case .denied(let reason) = error as? WorkToolError else {
                return XCTFail("expected a refusal, got \(error)")
            }
            XCTAssertTrue(reason.contains("reading only"), reason)
        }
        XCTAssertFalse(sandbox.exists("Archive/a.txt"))
        XCTAssertTrue(sandbox.exists("a.txt"))
    }

    // MARK: - Read-only registries

    func testAnInspectionOnlyRegistryHasNoDoorToChangeAnything() throws {
        let sandbox = try makeRuntimeSandbox()
        let readOnly = try makeGrantRuntime(sandbox).tools.readOnly()
        XCTAssertNil(readOnly.tool(named: "apply_changes"))
        XCTAssertNil(readOnly.tool(named: "permanently_delete"))
        XCTAssertEqual(
            Set(readOnly.allTools.map(\.name)),
            WorkToolRegistry.readOnlyToolNames
        )
    }
}
