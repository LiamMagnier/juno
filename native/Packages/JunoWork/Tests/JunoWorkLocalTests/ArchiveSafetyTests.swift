import Foundation
import JunoWorkCore
import XCTest

@testable import JunoWorkLocal

final class ArchiveSafetyTests: XCTestCase {
    // MARK: - Zip Slip

    /// The archive attack, end to end, with a real zip on a real disk: an entry
    /// literally called `../escape.txt`, unpacked into a folder inside the
    /// grant. Nothing may be written outside the granted folder — and because
    /// vetting happens before the first byte, nothing is written at all.
    func testUnpackingAZipContainingDotDotEscapeWritesNothingOutsideTheGrant() async throws {
        let sandbox = try makeWorkSandbox()
        let (_, service) = try makeService(sandbox)

        let archive = ZipArchiveWriter.archiveData(for: [
            ZipArchiveWriter.Entry(name: "innocent.txt", contents: Data("harmless".utf8)),
            ZipArchiveWriter.Entry(
                name: "../escape.txt",
                contents: Data("this should never be written".utf8)
            ),
        ])
        try archive.write(to: sandbox.grantURL("delivery.zip"))

        await assertThrowsAsync(
            try await service.unarchive(try GrantedPath("delivery.zip"), into: try GrantedPath("Out"))
        ) { error in
            XCTAssertEqual(
                error as? ArchiveSafetyRefusal,
                .traversalEntryPath(name: "../escape.txt")
            )
        }

        // Nowhere the entry could plausibly have landed.
        XCTAssertFalse(sandbox.exists(sandbox.root.appendingPathComponent("escape.txt")))
        XCTAssertFalse(sandbox.exists(sandbox.outsideURL("escape.txt")))
        XCTAssertFalse(sandbox.exists(sandbox.grantURL("escape.txt")))
        XCTAssertFalse(sandbox.exists(sandbox.grantURL("Out/escape.txt")))
        // Not even the safe entry, and not even the destination folder: one bad
        // entry means the archive is not unpacked.
        XCTAssertFalse(sandbox.exists(sandbox.grantURL("Out")))
    }

    func testAnEntryNamedWithAnAbsolutePathIsRefused() async throws {
        let sandbox = try makeWorkSandbox()
        let (_, service) = try makeService(sandbox)

        for hostile in ["/etc/hosts", "~/.ssh/authorized_keys", "..\\..\\Windows\\x.txt"] {
            let archive = ZipArchiveWriter.archiveData(for: [
                ZipArchiveWriter.Entry(name: hostile, contents: Data("no".utf8))
            ])
            let name = "delivery-\(UUID().uuidString).zip"
            try archive.write(to: sandbox.grantURL(name))
            await assertThrowsAsync(
                try await service.unarchive(try GrantedPath(name), into: try GrantedPath("Out"))
            ) { error in
                XCTAssertEqual(
                    error as? ArchiveSafetyRefusal,
                    .absoluteEntryPath(name: hostile),
                    "expected \(hostile) to be refused as absolute"
                )
            }
        }
        XCTAssertFalse(sandbox.exists(sandbox.grantURL("Out")))
    }

    /// A deep traversal is refused even when the folders it walks through do not
    /// exist, because the check is on the name and never on what happens to be
    /// on disk.
    func testADeepTraversalIsRefusedRegardlessOfWhatExists() throws {
        let entries = [
            ArchiveEntry(
                name: "a/b/../../../../../../etc/passwd",
                kind: .file,
                uncompressedByteCount: 10,
                compressedByteCount: 10
            )
        ]
        XCTAssertThrowsError(try ArchiveSafety.vet(entries, into: try GrantedPath("Out"))) { error in
            XCTAssertEqual(
                error as? ArchiveSafetyRefusal,
                .traversalEntryPath(name: "a/b/../../../../../../etc/passwd")
            )
        }
    }

    // MARK: - Links

    /// Every symlink entry, not only ones that currently point outside. Entry
    /// one is a link called `config` pointing at somebody's `.ssh` folder; entry
    /// two is a plain file called `config/authorized_keys`. Both names pass a
    /// containment check on their own, and the second write lands wherever the
    /// first one pointed.
    func testEverySymbolicLinkEntryIsRefused() throws {
        for target in ["/etc/passwd", "inside.txt"] {
            let entries = [
                ArchiveEntry(
                    name: "config",
                    kind: .symbolicLink,
                    uncompressedByteCount: target.utf8.count,
                    compressedByteCount: target.utf8.count
                ),
                ArchiveEntry(
                    name: "config/authorized_keys",
                    kind: .file,
                    uncompressedByteCount: 20,
                    compressedByteCount: 20
                ),
            ]
            XCTAssertThrowsError(
                try ArchiveSafety.vet(entries, into: try GrantedPath("Out"))
            ) { error in
                XCTAssertEqual(error as? ArchiveSafetyRefusal, .symbolicLinkEntry(name: "config"))
            }
        }
    }

    func testHardLinkAndDeviceEntriesAreRefused() throws {
        XCTAssertThrowsError(
            try ArchiveSafety.vet(
                [ArchiveEntry(name: "link", kind: .hardLink, uncompressedByteCount: 0, compressedByteCount: 0)],
                into: try GrantedPath("Out")
            )
        ) { error in
            XCTAssertEqual(error as? ArchiveSafetyRefusal, .hardLinkEntry(name: "link"))
        }
        XCTAssertThrowsError(
            try ArchiveSafety.vet(
                [
                    ArchiveEntry(
                        name: "null",
                        kind: .otherNodeType(mode: 0x2000),
                        uncompressedByteCount: 0,
                        compressedByteCount: 0
                    )
                ],
                into: try GrantedPath("Out")
            )
        ) { error in
            XCTAssertEqual(error as? ArchiveSafetyRefusal, .unsupportedEntryType(name: "null"))
        }
    }

    // MARK: - Bombs

    func testAZipBombIsRefusedFromItsHeadersBeforeAnythingIsDecompressed() throws {
        let limits = WorkArchiveLimits(
            maximumEntryCount: 3,
            maximumTotalUncompressedBytes: 1_000,
            maximumEntryUncompressedBytes: 800,
            maximumCompressionRatio: 100
        )
        let destination = try GrantedPath("Out")

        // Too many entries.
        let many = (0..<4).map {
            ArchiveEntry(
                name: "f\($0).txt",
                kind: .file,
                uncompressedByteCount: 1,
                compressedByteCount: 1
            )
        }
        XCTAssertThrowsError(try ArchiveSafety.vet(many, into: destination, limits: limits)) {
            XCTAssertEqual($0 as? ArchiveSafetyRefusal, .tooManyEntries(count: 4, maximum: 3))
        }

        // One entry over the per-entry ceiling.
        let huge = [
            ArchiveEntry(
                name: "huge.bin",
                kind: .file,
                uncompressedByteCount: 900,
                compressedByteCount: 900
            )
        ]
        XCTAssertThrowsError(try ArchiveSafety.vet(huge, into: destination, limits: limits)) {
            XCTAssertEqual(
                $0 as? ArchiveSafetyRefusal,
                .entryTooLarge(name: "huge.bin", byteCount: 900, maximum: 800)
            )
        }

        // Individually fine, collectively over the total.
        let together = (0..<3).map {
            ArchiveEntry(
                name: "f\($0).bin",
                kind: .file,
                uncompressedByteCount: 400,
                compressedByteCount: 400
            )
        }
        XCTAssertThrowsError(try ArchiveSafety.vet(together, into: destination, limits: limits)) {
            XCTAssertEqual(
                $0 as? ArchiveSafetyRefusal,
                .totalTooLarge(byteCount: 800 + 400, maximum: 1_000)
            )
        }

        // The classic shape: a few bytes that expand enormously.
        let bomb = [
            ArchiveEntry(
                name: "bomb.txt",
                kind: .file,
                uncompressedByteCount: 700,
                compressedByteCount: 1
            )
        ]
        XCTAssertThrowsError(try ArchiveSafety.vet(bomb, into: destination, limits: limits)) {
            XCTAssertEqual(
                $0 as? ArchiveSafetyRefusal,
                .suspiciousCompressionRatio(name: "bomb.txt", ratio: 700, maximum: 100)
            )
        }
    }

    func testAnArchiveThatNamesTheSameLocationTwiceIsRefused() throws {
        let entries = [
            ArchiveEntry(name: "a.txt", kind: .file, uncompressedByteCount: 1, compressedByteCount: 1),
            ArchiveEntry(name: "a.txt", kind: .file, uncompressedByteCount: 2, compressedByteCount: 2),
        ]
        XCTAssertThrowsError(try ArchiveSafety.vet(entries, into: try GrantedPath("Out"))) {
            XCTAssertEqual($0 as? ArchiveSafetyRefusal, .duplicateEntryName(name: "a.txt"))
        }
    }

    // MARK: - Ordinary archives

    func testArchivingAndUnpackingRoundTrips() async throws {
        let sandbox = try makeWorkSandbox()
        let (_, service) = try makeService(sandbox)
        try sandbox.writeInGrant("Matter/Notes.txt", String(repeating: "billable hours\n", count: 200))
        try sandbox.writeInGrant("Matter/Sub/Deep.txt", "buried")
        try sandbox.writeInGrant("Loose.txt", "on its own")

        try await service.archive(
            sources: [try GrantedPath("Matter"), try GrantedPath("Loose.txt")],
            to: try GrantedPath("Bundle.zip")
        )
        XCTAssertTrue(sandbox.exists(sandbox.grantURL("Bundle.zip")))

        let created = try await service.unarchive(
            try GrantedPath("Bundle.zip"),
            into: try GrantedPath("Restored")
        )
        XCTAssertEqual(
            text(at: sandbox.grantURL("Restored/Matter/Notes.txt")),
            String(repeating: "billable hours\n", count: 200)
        )
        XCTAssertEqual(text(at: sandbox.grantURL("Restored/Matter/Sub/Deep.txt")), "buried")
        XCTAssertEqual(text(at: sandbox.grantURL("Restored/Loose.txt")), "on its own")
        XCTAssertTrue(created.contains(try GrantedPath("Restored/Loose.txt")))
        XCTAssertTrue(created.contains(try GrantedPath("Restored")))
    }

    /// A symlink inside the folder being packed is left out rather than followed
    /// — packing it would put a copy of whatever it points at into an archive
    /// the person is about to send somewhere.
    func testArchivingDoesNotFollowASymlinkOutOfTheGrant() async throws {
        let sandbox = try makeWorkSandbox()
        let (_, service) = try makeService(sandbox)
        try sandbox.writeInGrant("Matter/Notes.txt", "billable")
        try Data("not yours".utf8).write(to: sandbox.outsideURL("secret.txt"))
        try FileManager.default.createSymbolicLink(
            atPath: sandbox.grantURL("Matter/linked.txt").path,
            withDestinationPath: sandbox.outsideURL("secret.txt").path
        )

        try await service.archive(
            sources: [try GrantedPath("Matter")],
            to: try GrantedPath("Bundle.zip")
        )
        let reader = try ZipArchiveReader(contentsOf: sandbox.grantURL("Bundle.zip"))
        // The trailing separator on the folder is the zip format's own way of
        // marking a directory entry.
        XCTAssertEqual(reader.entries.map(\.name).sorted(), ["Matter/", "Matter/Notes.txt"])
        XCTAssertEqual(reader.entries.first { $0.name == "Matter/" }?.kind, .directory)
    }

    func testAnArchiveThatIsNotAZipIsRefused() throws {
        let sandbox = try makeWorkSandbox()
        let url = try sandbox.writeInGrant("not-a.zip", "just some text, honestly")
        XCTAssertThrowsError(try ZipArchiveReader(contentsOf: url)) { error in
            XCTAssertEqual(error as? ZipArchiveError, .notAZipArchive)
        }
    }

    /// A header that lies about what it contains is caught by the checksum,
    /// which is the last line of defence when everything about the names looked
    /// reasonable.
    func testATamperedEntryFailsItsChecksum() throws {
        let sandbox = try makeWorkSandbox()
        // Random bytes do not compress, so this entry is stored verbatim and a
        // single flipped byte lands squarely in the payload.
        var body = Data()
        for index in 0..<1_000 { body.append(UInt8((index * 37 + 11) % 256)) }
        var archive = ZipArchiveWriter.archiveData(for: [
            ZipArchiveWriter.Entry(name: "data.bin", contents: body)
        ])
        let payloadStart = 30 + "data.bin".utf8.count
        archive[payloadStart + 4] ^= 0xFF

        let url = sandbox.grantURL("tampered.zip")
        try archive.write(to: url)
        let reader = try ZipArchiveReader(contentsOf: url)
        XCTAssertThrowsError(try reader.contents(ofEntryAt: 0)) { error in
            XCTAssertEqual(error as? ZipArchiveError, .checksumMismatch(name: "data.bin"))
        }
    }

    func testUnpackingRefusesToOverwriteSomethingAlreadyInTheFolder() async throws {
        let sandbox = try makeWorkSandbox()
        let (_, service) = try makeService(sandbox)
        let archive = ZipArchiveWriter.archiveData(for: [
            ZipArchiveWriter.Entry(name: "Notes.txt", contents: Data("from the archive".utf8))
        ])
        try archive.write(to: sandbox.grantURL("delivery.zip"))
        try sandbox.writeInGrant("Out/Notes.txt", "mine, written earlier")

        await assertThrowsAsync(
            try await service.unarchive(try GrantedPath("delivery.zip"), into: try GrantedPath("Out"))
        ) { error in
            XCTAssertEqual(
                error as? WorkFileServiceError,
                .alreadyExists(path: "Out/Notes.txt")
            )
        }
        XCTAssertEqual(text(at: sandbox.grantURL("Out/Notes.txt")), "mine, written earlier")
    }

    /// Unpacking through a batch records what came out, so the extraction can be
    /// tidied away again.
    func testUndoingAnUnarchiveRemovesExactlyWhatCameOutOfIt() async throws {
        let sandbox = try makeWorkSandbox()
        let access = try makeAccess(sandbox)
        let service = WorkFileService(access: access)
        let support = sandbox.root.appendingPathComponent("support", isDirectory: true)
        let executor = WorkBatchExecutor(
            access: access,
            service: service,
            replacedContentDirectory: support.appendingPathComponent("replaced"),
            journalURL: support.appendingPathComponent("journal.json")
        )

        let archive = ZipArchiveWriter.archiveData(for: [
            ZipArchiveWriter.Entry(name: "Matter", isDirectory: true),
            ZipArchiveWriter.Entry(name: "Matter/Notes.txt", contents: Data("billable".utf8)),
        ])
        try archive.write(to: sandbox.grantURL("delivery.zip"))
        try sandbox.writeInGrant("Keep.txt", "untouched")

        var facts: [GrantedPath: WorkPathFacts] = [:]
        facts[try GrantedPath("delivery.zip")] = WorkPathFacts(exists: true)
        let plan = try WorkBatchPlan.plan(
            grantID: WorkGrantID(value: "grant-1"),
            operations: [
                .unarchive(
                    archive: try GrantedPath("delivery.zip"),
                    destination: try GrantedPath("Out")
                )
            ],
            against: WorkFileSnapshot(facts)
        )
        let approval = WorkBatchApproval(
            grantID: plan.grantID,
            planDigest: plan.digest,
            decidedAt: Date(),
            expiresAt: Date().addingTimeInterval(600)
        )

        let execution = try await executor.execute(plan, approvedBy: approval)
        XCTAssertTrue(execution.isComplete, execution.failure?.reason ?? "")
        XCTAssertEqual(text(at: sandbox.grantURL("Out/Matter/Notes.txt")), "billable")

        let outcome = await executor.undo(execution.journal)
        XCTAssertTrue(outcome.isComplete, outcome.summary)
        XCTAssertFalse(sandbox.exists(sandbox.grantURL("Out")))
        XCTAssertEqual(text(at: sandbox.grantURL("Keep.txt")), "untouched")
        XCTAssertTrue(sandbox.exists(sandbox.grantURL("delivery.zip")))
    }
}
