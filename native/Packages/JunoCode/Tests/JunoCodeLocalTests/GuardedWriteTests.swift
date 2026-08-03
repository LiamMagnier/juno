import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// The guarded-edit contract: `read_file` hands back a fingerprint of the
/// *complete* file, and a whole-file overwrite has to present it.
///
/// The defect these cover: the fingerprint was computed and then dropped on the
/// floor, so nothing the model could see carried it, and `write` accepted a nil
/// base — which made "pass base_sha256 so the edit fails safely" a sentence in
/// a tool description and nothing more.
final class GuardedWriteTests: XCTestCase {
    private var workspaceURL: URL!
    private var access: WorkspaceAccess!
    private var checkpoints: CheckpointStore!
    private var service: FileOperationService!
    private let sessionID = CodeSessionID()

    override func setUpWithError() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-guarded-\(UUID().uuidString)")
        workspaceURL = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
        access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        checkpoints = CheckpointStore(
            directoryURL: base.appendingPathComponent("checkpoints"),
            access: access
        )
        service = FileOperationService(access: access, checkpoints: checkpoints)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL.deletingLastPathComponent())
    }

    private func path(_ value: String) throws -> WorkspacePath {
        try WorkspacePath(value)
    }

    // MARK: - Read then guarded write

    func testAReadFingerprintAuthorisesTheWriteThatFollowsIt() async throws {
        _ = try await service.create(path("a.txt"), content: "one\n", sessionID: sessionID)
        let read = try await service.read(path("a.txt"), limit: .fileRead)

        let written = try await service.write(
            path("a.txt"),
            content: "two\n",
            expectedBase: read.fingerprint,
            sessionID: sessionID
        )
        XCTAssertEqual(written.kind, .modified)
        XCTAssertEqual(
            try String(contentsOf: workspaceURL.appendingPathComponent("a.txt"), encoding: .utf8),
            "two\n"
        )
    }

    /// The case the whole mechanism exists for: something else moved the file
    /// between the read and the write.
    func testAWriteOnAStaleBaseIsRefusedAndChangesNothing() async throws {
        _ = try await service.create(path("a.txt"), content: "one\n", sessionID: sessionID)
        let read = try await service.read(path("a.txt"), limit: .fileRead)

        try "edited by someone else\n".write(
            to: workspaceURL.appendingPathComponent("a.txt"),
            atomically: true,
            encoding: .utf8
        )

        do {
            _ = try await service.write(
                path("a.txt"),
                content: "two\n",
                expectedBase: read.fingerprint,
                sessionID: sessionID
            )
            XCTFail("a stale base must not be allowed to overwrite")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .concurrentModification(path: "a.txt"))
        }

        XCTAssertEqual(
            try String(contentsOf: workspaceURL.appendingPathComponent("a.txt"), encoding: .utf8),
            "edited by someone else\n",
            "the refused write must not have touched the file"
        )
    }

    /// An unguarded overwrite is the same data loss with no error at all, so it
    /// is refused outright rather than merely discouraged in a tool description.
    func testOverwritingAnExistingFileWithoutABaseIsRefused() async throws {
        _ = try await service.create(path("a.txt"), content: "one\n", sessionID: sessionID)

        do {
            _ = try await service.write(
                path("a.txt"),
                content: "clobbered\n",
                expectedBase: nil,
                sessionID: sessionID
            )
            XCTFail("an unguarded overwrite must be refused")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .baseFingerprintRequired(path: "a.txt"))
        }

        XCTAssertEqual(
            try String(contentsOf: workspaceURL.appendingPathComponent("a.txt"), encoding: .utf8),
            "one\n"
        )
    }

    /// Creating through `write` still needs no fingerprint: there is nothing to
    /// be stale against.
    func testCreatingANewFileThroughWriteNeedsNoBase() async throws {
        let written = try await service.write(
            path("new.txt"),
            content: "fresh\n",
            expectedBase: nil,
            sessionID: sessionID
        )
        XCTAssertEqual(written.kind, .created)
    }

    // MARK: - Patches

    func testPatchHonoursAMatchingBaseAndRejectsAStaleOne() async throws {
        _ = try await service.create(
            path("p.txt"),
            content: "alpha\nbeta\n",
            sessionID: sessionID
        )
        let read = try await service.read(path("p.txt"), limit: .fileRead)

        let patched = try await service.applyPatch(
            path("p.txt"),
            patch: TextPatch(target: "beta", replacement: "gamma", replaceAll: false),
            expectedBase: read.fingerprint,
            sessionID: sessionID
        )
        XCTAssertEqual(patched.kind, .modified)

        // `read.fingerprint` is now stale — the patch above moved the file on.
        do {
            _ = try await service.applyPatch(
                path("p.txt"),
                patch: TextPatch(target: "gamma", replacement: "delta", replaceAll: false),
                expectedBase: read.fingerprint,
                sessionID: sessionID
            )
            XCTFail("a patch on a stale base must be refused")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .concurrentModification(path: "p.txt"))
        }

        XCTAssertEqual(
            try String(contentsOf: workspaceURL.appendingPathComponent("p.txt"), encoding: .utf8),
            "alpha\ngamma\n"
        )
    }

    // MARK: - Truncation

    /// The dangerous shape: the digest covers the whole file, but the caller was
    /// only shown part of it. The service still reports the true digest — what
    /// stops the unsafe overwrite is that `ReadFileTool` refuses to hand that
    /// digest to a model that received a partial read.
    func testATruncatedReadStillDigestsTheCompleteFile() async throws {
        let whole = String(repeating: "x", count: 500)
        _ = try await service.create(path("big.txt"), content: whole, sessionID: sessionID)

        let read = try await service.read(
            path("big.txt"),
            limit: OutputLimit(maximumBytes: 20, truncationNotice: "…")
        )

        XCTAssertTrue(read.wasTruncated)
        XCTAssertEqual(read.byteCount, 500)
        XCTAssertEqual(read.fingerprint, FileFingerprint(of: whole))
        XCTAssertNotEqual(
            read.fingerprint,
            FileFingerprint(of: read.content),
            "a digest of the truncated view would authorise discarding the rest"
        )
    }

    // MARK: - Awkward content

    func testUnicodeSurvivesAReadWriteRoundTripAndItsFingerprint() async throws {
        let original = "héllo 🌍 — ünïcode\nsecond line\n"
        _ = try await service.create(path("u.txt"), content: original, sessionID: sessionID)

        let read = try await service.read(path("u.txt"), limit: .fileRead)
        XCTAssertEqual(read.content, original)
        XCTAssertEqual(read.fingerprint, FileFingerprint(of: original))
        // Bytes, not characters: the emoji alone is four of them.
        XCTAssertEqual(read.byteCount, original.utf8.count)

        let replacement = "goodbye 👋\n"
        _ = try await service.write(
            path("u.txt"),
            content: replacement,
            expectedBase: read.fingerprint,
            sessionID: sessionID
        )
        let reread = try await service.read(path("u.txt"), limit: .fileRead)
        XCTAssertEqual(reread.content, replacement)
    }

    func testAnEmptyFileHasAUsableFingerprint() async throws {
        _ = try await service.create(path("empty.txt"), content: "", sessionID: sessionID)

        let read = try await service.read(path("empty.txt"), limit: .fileRead)
        XCTAssertEqual(read.content, "")
        XCTAssertEqual(read.byteCount, 0)
        XCTAssertFalse(read.wasTruncated)
        XCTAssertEqual(read.fingerprint, FileFingerprint(of: ""))

        // An empty file is still an existing file, so it is still guarded.
        do {
            _ = try await service.write(
                path("empty.txt"),
                content: "filled\n",
                expectedBase: nil,
                sessionID: sessionID
            )
            XCTFail("an empty existing file must still require a base")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .baseFingerprintRequired(path: "empty.txt"))
        }

        _ = try await service.write(
            path("empty.txt"),
            content: "filled\n",
            expectedBase: read.fingerprint,
            sessionID: sessionID
        )
        let reread = try await service.read(path("empty.txt"), limit: .fileRead)
        XCTAssertEqual(reread.content, "filled\n")
    }
}
