import CryptoKit
import Foundation

public enum WorkDigests {
    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func sha256Hex(_ text: String) -> String {
        sha256Hex(Data(text.utf8))
    }

    /// Length-prefixes a field before it joins a canonical string.
    ///
    /// A file name may contain any byte except `/` and NUL — tabs, newlines,
    /// colons, the lot. A canonical form built by joining fields with a
    /// separator is therefore forgeable: two different batches can be spelled so
    /// that they flatten to the same string, hash to the same digest, and an
    /// approval the person granted for one authorises the other. Prefixing each
    /// field with its byte count removes the ambiguity entirely, because the
    /// reader never has to guess where a field ends.
    public static func canonicalField(_ value: String) -> String {
        "\(value.utf8.count):\(value)"
    }

    public static func canonicalRecord(_ fields: [String]) -> String {
        fields.map(canonicalField).joined()
    }
}

public enum WorkContentFingerprintError: Error, Equatable, Sendable {
    /// Not 64 hexadecimal characters, or a negative size. Carries no fragment of
    /// the offending value: a rejected fingerprint is echoed back to the model,
    /// and a model that sent a secret by mistake should not have it repeated.
    case malformed
}

/// Content identity for one item: what it is, not where it is.
///
/// Two uses, and they are the same fact seen from two sides. The batch planner
/// groups equal fingerprints to tell a person "eleven of these forty files are
/// the same document"; the undo journal pins the fingerprint an operation was
/// computed against so a restore refuses when the file moved on underneath it.
public struct WorkContentFingerprint: Hashable, Codable, Sendable, Comparable {
    public let sha256: String
    public let byteCount: Int

    public init(of content: Data) {
        self.sha256 = WorkDigests.sha256Hex(content)
        self.byteCount = content.count
    }

    public init(of text: String) {
        self.init(of: Data(text.utf8))
    }

    /// Trusted construction from values this process computed.
    public init(sha256: String, byteCount: Int) {
        self.sha256 = sha256
        self.byteCount = byteCount
    }

    /// Construction from values a **model or a relay message** supplied.
    ///
    /// A fingerprint arriving as an argument is untrusted text. Without this
    /// check a malformed one — a truncated digest, a hash of the wrong thing,
    /// the string "unknown" — simply fails to match and surfaces as "this file
    /// changed underneath you", which sends the caller off to re-read a file
    /// nobody had touched.
    public init(validating raw: String, byteCount: Int) throws {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 64,
            trimmed.allSatisfy({ $0.isHexDigit && $0.isASCII }),
            byteCount >= 0
        else {
            throw WorkContentFingerprintError.malformed
        }
        self.sha256 = trimmed.lowercased()
        self.byteCount = byteCount
    }

    /// The digest alone, for the canonical form of an operation.
    public var canonicalForm: String { "\(sha256):\(byteCount)" }

    public static func < (lhs: WorkContentFingerprint, rhs: WorkContentFingerprint) -> Bool {
        lhs.sha256 < rhs.sha256
    }
}

/// One change to one or more items inside a single grant.
///
/// Every location is a ``GrantedPath`` rather than a string, so an operation
/// cannot be built from a location that has not passed shape validation. That is
/// a floor, not a boundary: the mode check and the canonical containment check
/// still run at the moment the filesystem is touched.
///
/// There is no permanent-delete case, and that is the whole design. A case here
/// would be reachable from a plan, a plan is approvable in one gesture, and one
/// gesture that erases forty documents beyond recovery is precisely the outcome
/// Work is built to make impossible. Permanent deletion lives in
/// ``WorkIrreversibleAction``, which no grant mode can authorise.
public enum WorkFileOperation: Hashable, Codable, Sendable {
    case createFolder(path: GrantedPath)
    case copy(source: GrantedPath, destination: GrantedPath)
    case move(source: GrantedPath, destination: GrantedPath)
    case rename(path: GrantedPath, newName: String)
    /// `content` is the fingerprint of the bytes to be written, never the bytes.
    /// A plan is previewed on a phone and digested for approval; carrying
    /// megabytes of file content through both would make the approval sheet a
    /// data transfer. `expectedBase` pins what the writer believed it was
    /// changing, so a file edited by a person mid-batch is refused rather than
    /// silently overwritten.
    case write(path: GrantedPath, content: WorkContentFingerprint, expectedBase: WorkContentFingerprint?)
    case trash(path: GrantedPath)
    case tag(path: GrantedPath, tags: [String])
    case archive(sources: [GrantedPath], destination: GrantedPath)
    case unarchive(archive: GrantedPath, destination: GrantedPath)

    /// The operation's identity without its arguments.
    ///
    /// This is the type ``WorkAccessMode/permits(_:)`` is asked about, which is
    /// why it has no permanent-delete case either: a mode is never in a position
    /// to answer that question.
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case createFolder = "create_folder"
        case copy
        case move
        case rename
        case write
        case trash
        case tag
        case archive
        case unarchive

        /// The word a person reads in a preview. Present tense, because they are
        /// approving something that has not happened.
        public var verb: String {
            switch self {
            case .createFolder: "Create folder"
            case .copy: "Copy"
            case .move: "Move"
            case .rename: "Rename"
            case .write: "Update"
            case .trash: "Move to Trash"
            case .tag: "Tag"
            case .archive: "Archive"
            case .unarchive: "Unarchive"
            }
        }
    }

    public var kind: Kind {
        switch self {
        case .createFolder: .createFolder
        case .copy: .copy
        case .move: .move
        case .rename: .rename
        case .write: .write
        case .trash: .trash
        case .tag: .tag
        case .archive: .archive
        case .unarchive: .unarchive
        }
    }

    /// Where the operation puts something, when it puts something somewhere.
    ///
    /// `nil` for a rename whose new name is not a usable single component; the
    /// planner turns that into ``WorkBatchPlanError/invalidRename(path:newName:)``
    /// rather than letting it reach the filesystem as a surprise.
    public var destination: GrantedPath? {
        switch self {
        case .createFolder(let path): path
        case .copy(_, let destination): destination
        case .move(_, let destination): destination
        case .rename(let path, let newName):
            newName.contains("/") ? nil : try? path.renamed(to: newName)
        case .write(let path, _, _): path
        case .trash: nil
        case .tag: nil
        case .archive(_, let destination): destination
        case .unarchive(_, let destination): destination
        }
    }

    /// Locations that must exist before this runs, whether because the world
    /// already holds them or because an earlier operation in the same plan
    /// creates them.
    ///
    /// A destination's own parent folder is included. That is what makes "move
    /// these into a folder you are also creating" sort correctly instead of
    /// failing on the first item.
    public var requires: [GrantedPath] {
        var result: [GrantedPath] = []
        switch self {
        case .createFolder:
            break
        case .copy(let source, _), .move(let source, _), .unarchive(let source, _):
            result.append(source)
        case .rename(let path, _), .trash(let path), .tag(let path, _):
            result.append(path)
        case .write:
            break
        case .archive(let sources, _):
            result.append(contentsOf: sources)
        }
        if let parent = destination?.parent {
            result.append(parent)
        }
        return result
    }

    /// Locations that exist after this runs.
    ///
    /// Only what the operation names. An operation whose destination sits in a
    /// folder that nothing creates is not an error — the executor makes
    /// intermediate folders the way `FileOperationService.move` does — but it
    /// imposes no ordering either, and pretending otherwise invents dependencies
    /// between unrelated operations.
    public var produces: [GrantedPath] {
        destination.map { [$0] } ?? []
    }

    /// Locations that stop existing where they were.
    public var removes: [GrantedPath] {
        switch self {
        case .move(let source, _): [source]
        case .rename(let path, _): [path]
        case .trash(let path): [path]
        case .createFolder, .copy, .write, .tag, .archive, .unarchive: []
        }
    }

    /// Every location this operation touches, for the "what will change" list a
    /// person reads before approving.
    ///
    /// De-duplicated, because a write and a folder creation name the same
    /// location as both subject and destination, and counting it twice would
    /// tell someone that a batch touches more of their disk than it does.
    public var touchedPaths: [GrantedPath] {
        var result: [GrantedPath] = []
        switch self {
        case .createFolder(let path), .trash(let path), .tag(let path, _):
            result.append(path)
        case .write(let path, _, _):
            result.append(path)
        case .rename(let path, _):
            result.append(path)
        case .copy(let source, _), .move(let source, _), .unarchive(let source, _):
            result.append(source)
        case .archive(let sources, _):
            result.append(contentsOf: sources)
        }
        if let destination {
            result.append(destination)
        }
        var seen: Set<GrantedPath> = []
        return result.filter { seen.insert($0).inserted }
    }

    /// The stable string this operation contributes to a plan's digest.
    ///
    /// Written by hand rather than derived from `Codable`. A synthesized
    /// encoder's field names and ordering are an implementation detail of the
    /// compiler, not part of this type's contract; if they changed, every stored
    /// approval would stop matching the plan it was granted for, and every
    /// in-flight approval would either fail closed for no visible reason or —
    /// worse, if the change collided — start matching a different batch.
    public var canonicalForm: String {
        switch self {
        case .createFolder(let path):
            WorkDigests.canonicalRecord([kind.rawValue, path.value])
        case .copy(let source, let destination):
            WorkDigests.canonicalRecord([kind.rawValue, source.value, destination.value])
        case .move(let source, let destination):
            WorkDigests.canonicalRecord([kind.rawValue, source.value, destination.value])
        case .rename(let path, let newName):
            WorkDigests.canonicalRecord([kind.rawValue, path.value, newName])
        case .write(let path, let content, let expectedBase):
            WorkDigests.canonicalRecord([
                kind.rawValue, path.value, content.canonicalForm,
                expectedBase?.canonicalForm ?? "",
            ])
        case .trash(let path):
            WorkDigests.canonicalRecord([kind.rawValue, path.value])
        case .tag(let path, let tags):
            // Sorted, because "tag with red and blue" and "tag with blue and
            // red" are the same request and must not read as two different
            // plans to a person who already approved one of them.
            WorkDigests.canonicalRecord([kind.rawValue, path.value] + tags.sorted())
        case .archive(let sources, let destination):
            WorkDigests.canonicalRecord(
                [kind.rawValue, destination.value] + sources.map(\.value)
            )
        case .unarchive(let archive, let destination):
            WorkDigests.canonicalRecord([kind.rawValue, archive.value, destination.value])
        }
    }
}
