import Foundation
import XCTest

@testable import JunoWorkCore

/// A symlink-safe ``GrantAccessing`` used only by these tests.
///
/// It exists here rather than being imported because the containment rules are
/// Core's contract and the local layer's implementation, and the adversarial
/// cases below have to hold for *any* conformance. Anything that claims to be a
/// `GrantAccessing` must pass this file.
///
/// The technique is copied deliberately from `JunoCodeLocal/WorkspaceAccess`:
/// reading canonicalizes the whole candidate, mutation canonicalizes the deepest
/// **existing** ancestor and re-appends the remaining components. The two differ
/// because canonicalizing a location that does not exist yet returns it
/// unchanged, so a check that only ever looked at the leaf would wave through a
/// new file under a symlinked folder.
private struct ReferenceGrantAccess: GrantAccessing {
    let grantID: WorkGrantID
    let mode: WorkAccessMode
    let rootURL: URL
    private let canonicalRoot: String

    init(grantID: WorkGrantID = WorkGrantID(), mode: WorkAccessMode, rootURL: URL) {
        self.grantID = grantID
        self.mode = mode
        self.rootURL = rootURL
        self.canonicalRoot = Self.canonical(rootURL.path)
    }

    /// `realpath(3)`, never Foundation.
    ///
    /// `resolvingSymlinksInPath()` and `standardizedFileURL` both strip a
    /// leading `/private`, turning `/private/tmp/x` into `/tmp/x`. That is the
    /// wrong direction for a containment check: canonicalize the root one way
    /// and a candidate the other and two names for the same directory stop
    /// comparing equal, which either lets a location out or locks the person out
    /// of their own folder.
    static func canonical(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    private func isContained(_ canonicalPath: String) -> Bool {
        if canonicalPath == canonicalRoot { return true }
        let prefix = canonicalRoot.hasSuffix("/") ? canonicalRoot : canonicalRoot + "/"
        return canonicalPath.hasPrefix(prefix)
    }

    func resolveForReading(_ path: GrantedPath) throws -> URL {
        let candidate = rootURL.appendingPathComponent(path.value, isDirectory: false)
        guard realpath(candidate.path, nil) != nil else {
            // A location that does not resolve is not a location inside the
            // grant. Failing closed here keeps a dangling link from being
            // treated as a contained one.
            throw WorkGrantAccessError.outsideGrant(path: path.value)
        }
        let canonical = Self.canonical(candidate.path)
        guard isContained(canonical) else {
            throw WorkGrantAccessError.symlinkEscapesGrant(path: path.value)
        }
        return URL(fileURLWithPath: canonical)
    }

    func resolveForMutation(_ path: GrantedPath) throws -> URL {
        let candidate = rootURL.appendingPathComponent(path.value, isDirectory: false)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let canonical = Self.canonical(candidate.path)
            guard isContained(canonical) else {
                throw WorkGrantAccessError.symlinkEscapesGrant(path: path.value)
            }
            return URL(fileURLWithPath: canonical)
        }
        var ancestor = candidate.deletingLastPathComponent()
        var remaining = [candidate.lastPathComponent]
        while !FileManager.default.fileExists(atPath: ancestor.path) {
            guard ancestor.path.count > 1, ancestor.path != canonicalRoot else { break }
            remaining.append(ancestor.lastPathComponent)
            let parent = ancestor.deletingLastPathComponent()
            guard parent.path != ancestor.path else {
                throw WorkGrantAccessError.parentDoesNotExist(path: path.value)
            }
            ancestor = parent
        }
        let canonicalAncestor = Self.canonical(ancestor.path)
        guard isContained(canonicalAncestor) else {
            throw WorkGrantAccessError.symlinkEscapesGrant(path: path.value)
        }
        var resolved = URL(fileURLWithPath: canonicalAncestor)
        for component in remaining.reversed() { resolved.appendPathComponent(component) }
        return resolved
    }

    func makeRelative(_ url: URL) throws -> GrantedPath {
        let canonical = Self.canonical(url.path)
        let prefix = canonicalRoot.hasSuffix("/") ? canonicalRoot : canonicalRoot + "/"
        guard canonical != canonicalRoot, canonical.hasPrefix(prefix) else {
            throw WorkGrantAccessError.outsideGrant(path: url.path)
        }
        do {
            return try GrantedPath(String(canonical.dropFirst(prefix.count)))
        } catch {
            throw WorkGrantAccessError.outsideGrant(path: url.path)
        }
    }
}

final class GrantedPathTests: XCTestCase {
    // MARK: - Shape validation

    func testAcceptsOrdinaryRelativeLocations() throws {
        XCTAssertEqual(try GrantedPath("Report.pdf").value, "Report.pdf")
        XCTAssertEqual(try GrantedPath("Clients/Ashworth/Report.pdf").lastComponent, "Report.pdf")
        XCTAssertEqual(try GrantedPath("Clients/Ashworth/Report.pdf").fileExtension, "pdf")
        // A name may legitimately contain dots without being a traversal.
        XCTAssertNoThrow(try GrantedPath("...pdf"))
        XCTAssertNoThrow(try GrantedPath("a..b/c"))
        XCTAssertNoThrow(try GrantedPath("..pdf"))
    }

    func testTraversalIsRefusedInEveryPosition() {
        for raw in ["..", "../a", "a/..", "a/../b", "a/b/../c", "../../etc/passwd", "a/b/.."] {
            XCTAssertThrowsError(try GrantedPath(raw), "expected \(raw) to be refused") { error in
                XCTAssertEqual(error as? GrantedPathError, .traversal)
            }
        }
    }

    func testAbsoluteAndHomeRelativeAndWindowsSeparatorsAreRefused() {
        for raw in ["/etc/passwd", "/", "~", "~/Documents/a.pdf", "a\\b"] {
            XCTAssertThrowsError(try GrantedPath(raw)) { error in
                XCTAssertEqual(error as? GrantedPathError, .absolute)
            }
        }
    }

    func testEmptyComponentsDotComponentsAndNULAreRefused() {
        XCTAssertThrowsError(try GrantedPath("")) { error in
            XCTAssertEqual(error as? GrantedPathError, .empty)
        }
        for raw in ["a//b", "a/", "./a", "a/./b", "a/.", "a\u{0}b", "a/\u{0}/b", "a\nb"] {
            XCTAssertThrowsError(try GrantedPath(raw), "expected \(raw) to be refused") { error in
                XCTAssertEqual(error as? GrantedPathError, .invalidComponent)
            }
        }
    }

    func testOverlongLocationIsRefused() {
        let raw = String(repeating: "a", count: GrantedPath.maximumUTF8Bytes + 1)
        XCTAssertThrowsError(try GrantedPath(raw)) { error in
            XCTAssertEqual(error as? GrantedPathError, .tooLong)
        }
    }

    func testDecodingRevalidates() {
        let json = Data(#""../../etc/passwd""#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(GrantedPath.self, from: json))
    }

    func testAncestorsListsEveryContainingFolderOutermostFirst() throws {
        let path = try GrantedPath("Clients/Ashworth/2026/Report.pdf")
        XCTAssertEqual(
            path.ancestors.map(\.value),
            ["Clients", "Clients/Ashworth", "Clients/Ashworth/2026"]
        )
        XCTAssertEqual(try GrantedPath("Report.pdf").ancestors, [])
    }

    // MARK: - Containment

    private func makeGrantRoot(in parent: URL, named name: String) throws -> URL {
        let url = parent.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func testSymlinkPointingOutsideTheGrantIsRefusedForReading() throws {
        let sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-work-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }

        let root = try makeGrantRoot(in: sandbox, named: "grant")
        let outside = try makeGrantRoot(in: sandbox, named: "outside")
        try Data("secret".utf8).write(to: outside.appendingPathComponent("secrets.txt"))
        try FileManager.default.createSymbolicLink(
            atPath: root.appendingPathComponent("escape.txt").path,
            withDestinationPath: outside.appendingPathComponent("secrets.txt").path
        )

        let access = ReferenceGrantAccess(mode: .readWrite, rootURL: root)
        XCTAssertThrowsError(try access.resolveForReading(try GrantedPath("escape.txt"))) { error in
            XCTAssertEqual(
                error as? WorkGrantAccessError,
                .symlinkEscapesGrant(path: "escape.txt")
            )
        }
    }

    func testSymlinkPointingOutsideTheGrantIsRefusedForMutation() throws {
        let sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-work-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }

        let root = try makeGrantRoot(in: sandbox, named: "grant")
        let outside = try makeGrantRoot(in: sandbox, named: "outside")
        try Data("secret".utf8).write(to: outside.appendingPathComponent("secrets.txt"))
        try FileManager.default.createSymbolicLink(
            atPath: root.appendingPathComponent("escape.txt").path,
            withDestinationPath: outside.appendingPathComponent("secrets.txt").path
        )

        let access = ReferenceGrantAccess(mode: .readWrite, rootURL: root)
        XCTAssertThrowsError(try access.resolveForMutation(try GrantedPath("escape.txt"))) { error in
            XCTAssertEqual(
                error as? WorkGrantAccessError,
                .symlinkEscapesGrant(path: "escape.txt")
            )
        }
    }

    /// The case a leaf-only check misses entirely: the file does not exist yet,
    /// so there is nothing to canonicalize, and the folder that would hold it is
    /// a link out of the grant. Creating it would write outside the folder the
    /// person shared while every name involved still looked contained.
    func testNotYetExistingLocationUnderASymlinkedAncestorIsRefusedForMutation() throws {
        let sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-work-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }

        let root = try makeGrantRoot(in: sandbox, named: "grant")
        let outside = try makeGrantRoot(in: sandbox, named: "outside")
        try FileManager.default.createSymbolicLink(
            atPath: root.appendingPathComponent("linked").path,
            withDestinationPath: outside.path
        )

        let access = ReferenceGrantAccess(mode: .readWrite, rootURL: root)
        let path = try GrantedPath("linked/nested/new-file.txt")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(path.value).path))
        XCTAssertThrowsError(try access.resolveForMutation(path)) { error in
            XCTAssertEqual(error as? WorkGrantAccessError, .symlinkEscapesGrant(path: path.value))
        }
    }

    func testOrdinaryLocationsInsideTheGrantResolveForBothReadingAndMutation() throws {
        let sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-work-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }

        let root = try makeGrantRoot(in: sandbox, named: "grant")
        try Data("hello".utf8).write(to: root.appendingPathComponent("Report.pdf"))
        let access = ReferenceGrantAccess(mode: .readWrite, rootURL: root)

        let existing = try access.resolveForReading(try GrantedPath("Report.pdf"))
        XCTAssertEqual(existing.lastPathComponent, "Report.pdf")
        let new = try access.resolveForMutation(try GrantedPath("Reports/2026/New.pdf"))
        XCTAssertTrue(new.path.hasSuffix("/Reports/2026/New.pdf"))
        XCTAssertEqual(try access.makeRelative(existing), try GrantedPath("Report.pdf"))
    }

    func testMakeRelativeRefusesLocationsOutsideTheGrant() throws {
        let sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-work-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }

        let root = try makeGrantRoot(in: sandbox, named: "grant")
        let outside = try makeGrantRoot(in: sandbox, named: "outside")
        let access = ReferenceGrantAccess(mode: .readWrite, rootURL: root)
        XCTAssertThrowsError(try access.makeRelative(outside.appendingPathComponent("x.txt")))
        // The root itself is not a location *inside* the grant.
        XCTAssertThrowsError(try access.makeRelative(root))
    }

    /// The macOS `/tmp` case, and the reason `realpath(3)` is not optional.
    ///
    /// `/tmp` is a symlink to `/private/tmp`, and Foundation resolves the pair in
    /// the opposite direction from the kernel. Canonicalize the grant root with
    /// one and a candidate with the other and containment silently stops working
    /// — in the permissive direction if the root loses its `/private`, and in the
    /// "nothing in your folder is in your folder" direction if the candidate does.
    func testTheSlashPrivateFormOfTheSameFolderIsTreatedAsTheSameFolder() throws {
        let viaFoundation = URL(fileURLWithPath: "/private/tmp").resolvingSymlinksInPath().path
        XCTAssertEqual(viaFoundation, "/tmp", "Foundation still strips a leading /private")
        XCTAssertEqual(ReferenceGrantAccess.canonical("/tmp"), "/private/tmp")

        let name = "juno-work-\(UUID().uuidString)"
        let shortRoot = URL(fileURLWithPath: "/tmp").appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: shortRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: shortRoot) }
        try Data("hello".utf8).write(to: shortRoot.appendingPathComponent("Report.pdf"))

        // The grant was opened by its /tmp name; the disk knows it by its
        // /private/tmp name.
        let access = ReferenceGrantAccess(mode: .readWrite, rootURL: shortRoot)
        let resolved = try access.resolveForReading(try GrantedPath("Report.pdf"))
        XCTAssertEqual(resolved.path, "/private/tmp/\(name)/Report.pdf")

        // Both spellings of the same file map back to the same relative location.
        XCTAssertEqual(
            try access.makeRelative(URL(fileURLWithPath: "/tmp/\(name)/Report.pdf")),
            try GrantedPath("Report.pdf")
        )
        XCTAssertEqual(
            try access.makeRelative(URL(fileURLWithPath: "/private/tmp/\(name)/Report.pdf")),
            try GrantedPath("Report.pdf")
        )
        XCTAssertNoThrow(try access.resolveForMutation(try GrantedPath("Reports/New.pdf")))
    }

    // MARK: - Modes

    func testReadWriteNoDeleteRefusesTrashButPermitsEveryOtherOperation() throws {
        let mode = WorkAccessMode.readWriteNoDelete
        XCTAssertFalse(mode.allowsTrash)
        XCTAssertTrue(mode.allowsWrite)
        for kind in WorkFileOperation.Kind.allCases where kind != .trash {
            XCTAssertTrue(mode.permits(kind), "\(kind.rawValue) should be permitted")
        }
        XCTAssertFalse(mode.permits(.trash))

        let access = ReferenceGrantAccess(
            mode: mode,
            rootURL: FileManager.default.temporaryDirectory
        )
        let path = try GrantedPath("Report.pdf")
        XCTAssertThrowsError(try access.requireMode(for: .trash, path: path)) { error in
            XCTAssertEqual(
                error as? WorkGrantAccessError,
                .modeForbidsTrash(path: "Report.pdf", mode: .readWriteNoDelete)
            )
        }
        XCTAssertNoThrow(try access.requireMode(for: .move, path: path))
    }

    func testReadOnlyRefusesEveryMutation() throws {
        let access = ReferenceGrantAccess(
            mode: .read,
            rootURL: FileManager.default.temporaryDirectory
        )
        let path = try GrantedPath("Report.pdf")
        for kind in WorkFileOperation.Kind.allCases {
            XCTAssertFalse(WorkAccessMode.read.permits(kind))
            XCTAssertThrowsError(try access.requireMode(for: kind, path: path))
        }
    }

    /// The structural half of "no mode permits a permanent delete": there is no
    /// operation to permit. A mode is never in a position to answer the
    /// question, so no future mode can answer it wrongly.
    func testNoFileOperationCanExpressAPermanentDelete() {
        XCTAssertEqual(
            Set(WorkFileOperation.Kind.allCases.map(\.rawValue)),
            ["create_folder", "copy", "move", "rename", "write", "trash", "tag", "archive", "unarchive"]
        )
        XCTAssertEqual(WorkIrreversibleAction.permanentDelete.rawValue, "work.file.permanent_delete")
    }

    func testAccessModeRawValuesMatchTheSharedVocabulary() {
        XCTAssertEqual(
            WorkAccessMode.allCases.map(\.rawValue),
            ["read", "read_write_no_delete", "read_write"]
        )
    }

    func testARevokedGrantIsInactiveFromTheMomentItWasRevoked() {
        let granted = Date(timeIntervalSince1970: 1_000)
        let grant = WorkGrant(
            kind: .localFolder,
            mode: .readWrite,
            displayName: "Documents",
            hostID: "mac-1",
            grantedAt: granted
        )
        XCTAssertTrue(grant.isActive(at: granted.addingTimeInterval(60)))
        let revoked = grant.revoked(at: granted.addingTimeInterval(30))
        XCTAssertTrue(revoked.isActive(at: granted.addingTimeInterval(29)))
        XCTAssertFalse(revoked.isActive(at: granted.addingTimeInterval(30)))
        XCTAssertFalse(revoked.isActive(at: granted.addingTimeInterval(60)))
        // Revoking twice does not move the moment access ended.
        XCTAssertEqual(revoked.revoked(at: granted.addingTimeInterval(90)).revokedAt, revoked.revokedAt)
    }
}
