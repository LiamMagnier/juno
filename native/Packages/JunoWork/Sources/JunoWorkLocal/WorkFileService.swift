import Foundation
import JunoWorkCore

// MARK: - Values

/// One item in a listing or a search result.
public struct WorkDirectoryEntry: Hashable, Sendable {
    public let path: GrantedPath
    public let isDirectory: Bool
    public let byteCount: Int?
    public let modifiedAt: Date?

    /// The name a person reads. Everything shown outside the Mac uses this and
    /// not ``path``, for the reason ``WorkBatchPreview`` spells out.
    public var displayName: String { path.displayName }

    public init(path: GrantedPath, isDirectory: Bool, byteCount: Int?, modifiedAt: Date?) {
        self.path = path
        self.isDirectory = isDirectory
        self.byteCount = byteCount
        self.modifiedAt = modifiedAt
    }
}

public struct WorkItemMetadata: Hashable, Sendable {
    public let path: GrantedPath
    public let isDirectory: Bool
    public let byteCount: Int
    public let createdAt: Date?
    public let modifiedAt: Date?
    public let tags: [String]

    public init(
        path: GrantedPath,
        isDirectory: Bool,
        byteCount: Int,
        createdAt: Date?,
        modifiedAt: Date?,
        tags: [String]
    ) {
        self.path = path
        self.isDirectory = isDirectory
        self.byteCount = byteCount
        self.createdAt = createdAt
        self.modifiedAt = modifiedAt
        self.tags = tags
    }
}

/// The result of reading a file, with the cap that was applied stated on the
/// value itself.
public struct WorkFileRead: Hashable, Sendable {
    public let path: GrantedPath
    public let data: Data
    /// The file's real size, which is not `data.count` when the read was capped.
    public let totalByteCount: Int
    public let maximumBytes: Int
    public let wasTruncated: Bool
    /// **Nil when the read was truncated.** A fingerprint of a prefix would
    /// compare unequal to the same file's real fingerprint forever, so every
    /// conflict check that saw one would report a change nobody made. A missing
    /// fingerprint is a fact the caller can act on; a wrong one is not.
    public let fingerprint: WorkContentFingerprint?

    public init(
        path: GrantedPath,
        data: Data,
        totalByteCount: Int,
        maximumBytes: Int,
        wasTruncated: Bool,
        fingerprint: WorkContentFingerprint?
    ) {
        self.path = path
        self.data = data
        self.totalByteCount = totalByteCount
        self.maximumBytes = maximumBytes
        self.wasTruncated = wasTruncated
        self.fingerprint = fingerprint
    }

    /// The bytes as text, when they are text.
    public var text: String? { String(data: data, encoding: .utf8) }
}

public struct WorkSearchQuery: Hashable, Sendable {
    public var nameContains: String?
    public var contentContains: String?
    public var limit: Int
    /// Files above this size are skipped by a content search rather than read.
    /// A grep that pulls a 400 MB database file through memory to find nothing
    /// is how a search over a Documents folder stops responding.
    public var maximumFileBytes: Int

    public init(
        nameContains: String? = nil,
        contentContains: String? = nil,
        limit: Int = 100,
        maximumFileBytes: Int = 1_024 * 1_024
    ) {
        self.nameContains = nameContains
        self.contentContains = contentContains
        self.limit = limit
        self.maximumFileBytes = maximumFileBytes
    }
}

public struct WorkSearchResult: Hashable, Sendable {
    public let entry: WorkDirectoryEntry
    /// The matching line, already bounded, when the match was in the contents.
    public let matchedLine: String?
    public let lineNumber: Int?

    public init(entry: WorkDirectoryEntry, matchedLine: String? = nil, lineNumber: Int? = nil) {
        self.entry = entry
        self.matchedLine = matchedLine
        self.lineNumber = lineNumber
    }
}

// MARK: - Failures

public enum WorkFileServiceError: Error, Equatable, Sendable {
    case notFound(path: String)
    case alreadyExists(path: String)
    case isADirectory(path: String)
    case notADirectory(path: String)
    case tooLarge(path: String, byteCount: Int, maximumBytes: Int)
    /// The file changed since the caller last looked at it.
    case contentChangedUnderneath(path: String)
    /// Tagging exists only on macOS. Named for what the person is missing rather
    /// than for the API that is absent.
    case taggingNotAvailableOnThisDevice
    case ioFailure(path: String, message: String)
}

extension WorkFileServiceError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .notFound(let path):
            "There is nothing at \(path)."
        case .alreadyExists(let path):
            "There is already something at \(path), and Juno did not replace it."
        case .isADirectory(let path):
            "\(path) is a folder, and Juno was asked to treat it as a file."
        case .notADirectory(let path):
            "\(path) is a file, and Juno was asked to treat it as a folder."
        case .tooLarge(let path, _, let maximumBytes):
            "\(path) is bigger than the \(maximumBytes / (1_024 * 1_024)) MB Juno reads in one go."
        case .contentChangedUnderneath(let path):
            "\(path) changed since Juno last read it, so Juno stopped rather than write over the newer version."
        case .taggingNotAvailableOnThisDevice:
            "Tags are a Mac feature, and this is not a Mac."
        case .ioFailure(let path, let message):
            "Juno could not finish working with \(path) (\(message))."
        }
    }
}

// MARK: - The service

/// Every filesystem operation Work performs on a granted folder.
///
/// Two rules hold for every method, without exception:
///
/// 1. **Locations arrive as ``GrantedPath`` and are resolved through
///    ``GrantAccessing`` immediately before the disk is touched.** Not at the
///    start of the batch, not once per session — immediately before, every time.
///    A resolution is a statement about the filesystem at one instant, and the
///    filesystem does not hold still.
/// 2. **The grant's mode is checked before the resolution**, via
///    ``GrantAccessing/requireMode(for:path:)``, so a read-only grant refuses
///    before anything is opened.
///
/// **There is no permanent-delete method on this type, and that absence is the
/// design.** ``trash(_:)`` uses `FileManager.trashItem`, which moves an item
/// somewhere the person can get it back from; nothing here calls `removeItem` on
/// something a person put in the folder. The only route to an unrecoverable
/// delete is a separate call site gated on an approval bound to that exact item
/// (``WorkIrreversibleAction/permanentDelete``). Leaving the method off entirely
/// is what makes an accidental call impossible: a rule that says "do not call
/// this without an approval" is a rule that is eventually broken in one branch,
/// and there is no such branch if there is no such method.
public final class WorkFileService: Sendable {
    /// Two megabytes matches Juno Code's file ceiling. Big enough for any
    /// document made of text, small enough that reading one never becomes a
    /// memory event.
    public static let defaultMaximumReadBytes = 2 * 1_024 * 1_024

    /// Enough to walk a large Documents folder, few enough that a runaway
    /// symlink loop or a mounted network share stops rather than hangs.
    public static let maximumWalkEntries = 50_000

    private let access: any GrantAccessing
    private let maximumReadBytes: Int
    private let archiveLimits: WorkArchiveLimits

    public init(
        access: any GrantAccessing,
        maximumReadBytes: Int = WorkFileService.defaultMaximumReadBytes,
        archiveLimits: WorkArchiveLimits = .default
    ) {
        self.access = access
        self.maximumReadBytes = maximumReadBytes
        self.archiveLimits = archiveLimits
    }

    public var grantID: WorkGrantID { access.grantID }
    public var mode: WorkAccessMode { access.mode }

    // MARK: - Looking

    /// The immediate contents of one folder, or of the grant root.
    public func list(_ path: GrantedPath? = nil) async throws -> [WorkDirectoryEntry] {
        let directoryURL: URL
        if let path {
            directoryURL = try resolveExisting(path)
            guard isDirectory(directoryURL) else {
                throw WorkFileServiceError.notADirectory(path: path.value)
            }
        } else {
            directoryURL = access.rootURL
        }
        let children = (try? FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: Self.resourceKeys,
            options: [.skipsHiddenFiles]
        )) ?? []
        return children.compactMap(makeEntry(url:)).sorted(by: Self.listingOrder)
    }

    /// Name and content search across the whole grant.
    public func search(_ query: WorkSearchQuery) async throws -> [WorkSearchResult] {
        let name = query.nameContains?.lowercased()
        let needle = query.contentContains
        guard name != nil || needle != nil else { return [] }

        var results: [WorkSearchResult] = []
        let limit = max(1, query.limit)
        try await walk { entry in
            guard !entry.isDirectory else { return true }
            if let name, !entry.path.lastComponent.lowercased().contains(name) { return true }
            guard let needle, !needle.isEmpty else {
                results.append(WorkSearchResult(entry: entry))
                return results.count < limit
            }
            if let byteCount = entry.byteCount, byteCount > query.maximumFileBytes { return true }
            // Resolved again here rather than reusing whatever the walk saw: the
            // walk may have been running for a while, and this is the moment a
            // file is actually opened.
            guard let url = try? self.access.resolveForReading(entry.path),
                let data = try? Data(contentsOf: url),
                data.count <= query.maximumFileBytes,
                // A NUL byte means this is not text, and searching a binary for
                // a word finds matches that mean nothing.
                !data.contains(0),
                let text = String(data: data, encoding: .utf8)
            else { return true }

            var lineNumber = 0
            for line in text.components(separatedBy: "\n") {
                lineNumber += 1
                guard line.range(of: needle, options: .caseInsensitive) != nil else { continue }
                results.append(
                    WorkSearchResult(
                        entry: entry,
                        matchedLine: String(line.prefix(512)),
                        lineNumber: lineNumber
                    )
                )
                if results.count >= limit { return false }
                break
            }
            return true
        }
        return results
    }

    public func metadata(of path: GrantedPath) async throws -> WorkItemMetadata {
        let url = try resolveExisting(path)
        let values = try? url.resourceValues(forKeys: Self.metadataKeys)
        return WorkItemMetadata(
            path: path,
            isDirectory: values?.isDirectory ?? false,
            byteCount: values?.fileSize ?? 0,
            createdAt: values?.creationDate,
            modifiedAt: values?.contentModificationDate,
            tags: (try? tags(of: path)) ?? []
        )
    }

    /// Reads a file, capped.
    ///
    /// The cap is reported on the result rather than applied silently: a caller
    /// that hands a truncated document to a model and calls it "the contents" is
    /// summarising the first two megabytes of a contract and saying it read the
    /// contract.
    public func read(
        _ path: GrantedPath,
        maximumBytes: Int? = nil
    ) async throws -> WorkFileRead {
        let cap = maximumBytes ?? maximumReadBytes
        let url = try resolveExisting(path)
        guard !isDirectory(url) else { throw WorkFileServiceError.isADirectory(path: path.value) }

        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: url)
        } catch {
            throw WorkFileServiceError.ioFailure(
                path: path.value,
                message: error.localizedDescription
            )
        }
        defer { try? handle.close() }

        let total = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let data: Data
        do {
            data = try handle.read(upToCount: cap) ?? Data()
        } catch {
            throw WorkFileServiceError.ioFailure(
                path: path.value,
                message: error.localizedDescription
            )
        }
        let wasTruncated = total > data.count
        return WorkFileRead(
            path: path,
            data: data,
            totalByteCount: max(total, data.count),
            maximumBytes: cap,
            wasTruncated: wasTruncated,
            fingerprint: wasTruncated ? nil : WorkContentFingerprint(of: data)
        )
    }

    /// The content fingerprint of a file, streamed rather than read.
    public func fingerprint(of path: GrantedPath) async throws -> WorkContentFingerprint {
        try ContentFingerprint.fingerprint(ofFileAt: try resolveExisting(path))
    }

    public func exists(_ path: GrantedPath) -> Bool {
        guard let url = try? access.resolveForReading(path) else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    // MARK: - Making and changing

    /// Creates a folder, and says whether it had to.
    ///
    /// Returns `false` when the folder was already there. The undo journal needs
    /// that distinction: removing a folder the batch did not create deletes
    /// something the person put there.
    @discardableResult
    public func createFolder(at path: GrantedPath) async throws -> Bool {
        try access.requireMode(for: .createFolder, path: path)
        let url = try access.resolveForMutation(path)
        if FileManager.default.fileExists(atPath: url.path) {
            guard isDirectory(url) else {
                throw WorkFileServiceError.alreadyExists(path: path.value)
            }
            return false
        }
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        } catch {
            throw WorkFileServiceError.ioFailure(
                path: path.value,
                message: error.localizedDescription
            )
        }
        return true
    }

    /// Copies an item. Refuses when the destination is taken unless the caller
    /// has explicitly said the replacement was approved.
    public func copy(
        from source: GrantedPath,
        to destination: GrantedPath,
        replacingApprovedExistingItem replacing: Bool = false
    ) async throws {
        try access.requireMode(for: .copy, path: destination)
        let sourceURL = try resolveExisting(source)
        let destinationURL = try access.resolveForMutation(destination)
        try prepareParent(of: destinationURL, path: destination)

        if FileManager.default.fileExists(atPath: destinationURL.path) {
            guard replacing else {
                throw WorkFileServiceError.alreadyExists(path: destination.value)
            }
            try replaceItem(at: destinationURL, byCopying: sourceURL, path: destination)
            return
        }
        do {
            try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
        } catch {
            throw WorkFileServiceError.ioFailure(
                path: destination.value,
                message: error.localizedDescription
            )
        }
    }

    /// Moves or renames an item.
    public func move(
        from source: GrantedPath,
        to destination: GrantedPath,
        replacingApprovedExistingItem replacing: Bool = false
    ) async throws {
        try access.requireMode(for: .move, path: destination)
        let sourceURL = try resolveExisting(source)
        let destinationURL = try access.resolveForMutation(destination)
        try prepareParent(of: destinationURL, path: destination)

        if FileManager.default.fileExists(atPath: destinationURL.path) {
            guard replacing else {
                throw WorkFileServiceError.alreadyExists(path: destination.value)
            }
            do {
                // `replaceItemAt` swaps the new item into place in one step. The
                // alternative — remove the old, then move — leaves the person
                // with neither file if the process dies between the two, and the
                // file that would be lost is the one they already had.
                _ = try FileManager.default.replaceItemAt(destinationURL, withItemAt: sourceURL)
            } catch {
                throw WorkFileServiceError.ioFailure(
                    path: destination.value,
                    message: error.localizedDescription
                )
            }
            return
        }
        do {
            try FileManager.default.moveItem(at: sourceURL, to: destinationURL)
        } catch {
            throw WorkFileServiceError.ioFailure(
                path: source.value,
                message: error.localizedDescription
            )
        }
    }

    /// Renames an item in place, returning where it ended up.
    @discardableResult
    public func rename(
        _ path: GrantedPath,
        to newName: String,
        replacingApprovedExistingItem replacing: Bool = false
    ) async throws -> GrantedPath {
        let destination: GrantedPath
        do {
            destination = try path.renamed(to: newName)
        } catch {
            throw WorkFileServiceError.ioFailure(
                path: path.value,
                message: "\"\(newName)\" is not a usable name"
            )
        }
        guard !newName.contains("/") else {
            throw WorkFileServiceError.ioFailure(
                path: path.value,
                message: "\"\(newName)\" is a location, not a name"
            )
        }
        try await move(from: path, to: destination, replacingApprovedExistingItem: replacing)
        return destination
    }

    /// Writes bytes, atomically, optionally pinned to the version the caller
    /// believed it was changing.
    public func write(
        _ path: GrantedPath,
        data: Data,
        expectedBase: WorkContentFingerprint? = nil
    ) async throws {
        try access.requireMode(for: .write, path: path)
        let url = try access.resolveForMutation(path)
        if FileManager.default.fileExists(atPath: url.path) {
            guard !isDirectory(url) else {
                throw WorkFileServiceError.isADirectory(path: path.value)
            }
            if let expectedBase {
                let current = try ContentFingerprint.fingerprint(ofFileAt: url)
                guard current == expectedBase else {
                    throw WorkFileServiceError.contentChangedUnderneath(path: path.value)
                }
            }
        }
        try prepareParent(of: url, path: path)
        do {
            // Atomic: a half-written document is worse than an unwritten one,
            // because the person cannot tell by looking.
            try data.write(to: url, options: [.atomic])
        } catch {
            throw WorkFileServiceError.ioFailure(
                path: path.value,
                message: error.localizedDescription
            )
        }
    }

    /// Moves an item to the Trash and returns where it landed.
    ///
    /// **`FileManager.trashItem`, never `removeItem`.** The Trash is the entire
    /// difference between a `sensitive` action and an `irreversible` one: the
    /// person can open a window and drag the file back. The returned token is
    /// the Trash's own location for the item, which the undo journal needs
    /// because the Trash renames collisions — trash two files called
    /// `Report.pdf` and the second one is not called `Report.pdf` any more.
    public func trash(_ path: GrantedPath) async throws -> String {
        try access.requireMode(for: .trash, path: path)
        let url = try resolveExisting(path)
        var resulting: NSURL?
        do {
            try FileManager.default.trashItem(at: url, resultingItemURL: &resulting)
        } catch {
            throw WorkFileServiceError.ioFailure(
                path: path.value,
                message: error.localizedDescription
            )
        }
        guard let resulting = resulting as URL? else {
            // Without a token the item is in the Trash and Juno cannot describe
            // how to get it back, so the caller is told rather than handed a
            // record whose undo would fail later.
            throw WorkFileServiceError.ioFailure(
                path: path.value,
                message: "the Trash did not say where the item went"
            )
        }
        return resulting.path
    }

    // MARK: - Tags

    /// Finder tags, which exist on macOS and nowhere else.
    ///
    /// Reached through `NSURL` rather than `URLResourceValues` because the Swift
    /// accessors for `tagNames` are annotated as macOS 26 and this package
    /// deploys to macOS 14. The Objective-C key has been there since 10.9 and
    /// carries the same value; the alternative would be an availability check
    /// that silently drops tagging for most of the Macs Juno runs on.
    public func tags(of path: GrantedPath) throws -> [String] {
        #if os(macOS)
            let url = try resolveExisting(path)
            let values = try? (url as NSURL).resourceValues(forKeys: [.tagNamesKey])
            return values?[.tagNamesKey] as? [String] ?? []
        #else
            _ = path
            throw WorkFileServiceError.taggingNotAvailableOnThisDevice
        #endif
    }

    public func setTags(_ tags: [String], on path: GrantedPath) async throws {
        try access.requireMode(for: .tag, path: path)
        #if os(macOS)
            let url = try resolveExisting(path)
            do {
                try (url as NSURL).setResourceValue(tags as NSArray, forKey: .tagNamesKey)
            } catch {
                throw WorkFileServiceError.ioFailure(
                    path: path.value,
                    message: error.localizedDescription
                )
            }
        #else
            _ = (tags, path)
            throw WorkFileServiceError.taggingNotAvailableOnThisDevice
        #endif
    }

    // MARK: - Archives

    /// Packs items into a zip at `destination`.
    ///
    /// Entry names are `<item name>/<path inside it>`, so unpacking the archive
    /// somewhere else reproduces what the person selected rather than a tree of
    /// folders that only makes sense relative to their disk.
    public func archive(
        sources: [GrantedPath],
        to destination: GrantedPath,
        replacingApprovedExistingItem replacing: Bool = false
    ) async throws {
        try access.requireMode(for: .archive, path: destination)
        let destinationURL = try access.resolveForMutation(destination)
        if FileManager.default.fileExists(atPath: destinationURL.path), !replacing {
            throw WorkFileServiceError.alreadyExists(path: destination.value)
        }

        var entries: [ZipArchiveWriter.Entry] = []
        var names: Set<String> = []
        for source in sources {
            for (name, path, isDirectory) in try collectArchiveMembers(of: source) {
                guard names.insert(name).inserted else {
                    throw ArchiveSafetyRefusal.duplicateEntryName(name: name)
                }
                let url = try resolveExisting(path)
                let modifiedAt =
                    (try? url.resourceValues(forKeys: [.contentModificationDateKey])
                        .contentModificationDate) ?? Date()
                if isDirectory {
                    entries.append(
                        ZipArchiveWriter.Entry(
                            name: name,
                            isDirectory: true,
                            modifiedAt: modifiedAt
                        )
                    )
                    continue
                }
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                guard size <= archiveLimits.maximumEntryUncompressedBytes else {
                    throw ArchiveSafetyRefusal.entryTooLarge(
                        name: name,
                        byteCount: size,
                        maximum: archiveLimits.maximumEntryUncompressedBytes
                    )
                }
                guard let contents = try? Data(contentsOf: url) else {
                    throw WorkFileServiceError.ioFailure(
                        path: path.value,
                        message: "the file could not be read"
                    )
                }
                entries.append(
                    ZipArchiveWriter.Entry(
                        name: name,
                        contents: contents,
                        modifiedAt: modifiedAt
                    )
                )
            }
        }

        let archiveData = ZipArchiveWriter.archiveData(for: entries)
        guard archiveData.count <= archiveLimits.maximumArchiveBytes else {
            throw ZipArchiveError.archiveTooLarge(
                byteCount: archiveData.count,
                maximum: archiveLimits.maximumArchiveBytes
            )
        }
        try await write(destination, data: archiveData)
    }

    /// Unpacks an archive into a folder, refusing the whole archive if any entry
    /// is unsafe.
    ///
    /// Returns every location it created, deepest last, which is what the undo
    /// journal needs in order to tidy an extraction away again.
    @discardableResult
    public func unarchive(
        _ archive: GrantedPath,
        into destination: GrantedPath
    ) async throws -> [GrantedPath] {
        try access.requireMode(for: .unarchive, path: destination)
        let archiveURL = try resolveExisting(archive)
        let reader = try ZipArchiveReader(contentsOf: archiveURL, limits: archiveLimits)
        // Vetted in full before a single byte is written. Half an extraction
        // that stopped at the hostile entry has already created the folders the
        // attack needed.
        let planned = try ArchiveSafety.vet(
            reader.entries,
            into: destination,
            limits: archiveLimits
        )

        var created: [GrantedPath] = []
        if try await createFolder(at: destination) { created.append(destination) }

        // `vet` returns one planned entry per archive entry, in order, or throws
        // — so `index` addresses the same entry in both lists. If that ever
        // stopped holding, this loop would write one entry's bytes to another
        // entry's approved location.
        for (index, member) in planned.enumerated() {
            try Task.checkCancellation()
            // Resolved through the grant here, individually, *after* the name
            // was vetted. The name check cannot see a folder inside the grant
            // that is already a symlink pointing out of it; this can.
            switch member.entry.kind {
            case .directory:
                if try await createFolder(at: member.destination) {
                    created.append(member.destination)
                }
            case .file:
                for ancestor in member.destination.ancestors
                where ancestor == destination || ancestor.isDescendant(of: destination) {
                    if try await createFolder(at: ancestor) { created.append(ancestor) }
                }
                let contents = try reader.contents(ofEntryAt: index)
                let url = try access.resolveForMutation(member.destination)
                guard !FileManager.default.fileExists(atPath: url.path) else {
                    // Refused rather than overwritten: an archive that quietly
                    // replaces a file already in the folder is the same problem
                    // as one that writes outside it, only harder to notice.
                    throw WorkFileServiceError.alreadyExists(path: member.destination.value)
                }
                do {
                    try contents.write(to: url, options: [.atomic])
                } catch {
                    throw WorkFileServiceError.ioFailure(
                        path: member.destination.value,
                        message: error.localizedDescription
                    )
                }
                created.append(member.destination)
            case .symbolicLink, .hardLink, .otherNodeType:
                // Unreachable: `ArchiveSafety.vet` refuses these outright. Named
                // rather than defaulted so that adding a kind is a compile
                // error here and not a silent extraction.
                throw ArchiveSafetyRefusal.unsupportedEntryType(name: member.entry.name)
            }
        }
        return created
    }

    // MARK: - Walking

    /// Depth-first walk of the grant.
    ///
    /// **Never descends a directory symlink.** A link pointing outside is an
    /// escape; a link pointing back inside is an infinite loop and a listing
    /// that shows the same file twice. Both are refused by never following one,
    /// which also matches `WorkspaceIndexService.walk` in Juno Code, so the two
    /// products cannot disagree about what "inside the folder" means.
    private func walk(_ visit: (WorkDirectoryEntry) throws -> Bool) async throws {
        var stack: [URL] = [access.rootURL]
        var visited = 0
        while let directory = stack.popLast() {
            try Task.checkCancellation()
            let children = (try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: Self.resourceKeys,
                options: [.skipsHiddenFiles]
            )) ?? []
            for url in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                try Task.checkCancellation()
                visited += 1
                guard visited <= Self.maximumWalkEntries else { return }
                guard let entry = makeEntry(url: url) else { continue }
                guard try visit(entry) else { return }
                guard entry.isDirectory else { continue }
                let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey])
                if values?.isSymbolicLink != true { stack.append(url) }
            }
        }
    }

    /// Builds an entry, or nil for anything the grant does not own.
    ///
    /// `makeRelative` is the filter: it canonicalizes, so a symlink whose target
    /// is outside the grant produces no entry at all and never reaches a caller
    /// that might then try to read it.
    private func makeEntry(url: URL) -> WorkDirectoryEntry? {
        guard let path = try? access.makeRelative(url) else { return nil }
        let values = try? url.resourceValues(forKeys: Self.resourceKeySet)
        return WorkDirectoryEntry(
            path: path,
            isDirectory: values?.isDirectory ?? false,
            byteCount: values?.fileSize,
            modifiedAt: values?.contentModificationDate
        )
    }

    /// Every member an archive should contain for one selected item.
    private func collectArchiveMembers(
        of source: GrantedPath
    ) throws -> [(name: String, path: GrantedPath, isDirectory: Bool)] {
        let url = try resolveExisting(source)
        guard isDirectory(url) else { return [(source.lastComponent, source, false)] }

        var members: [(name: String, path: GrantedPath, isDirectory: Bool)] = [
            (source.lastComponent, source, true)
        ]
        var stack: [(URL, String)] = [(url, source.lastComponent)]
        var visited = 0
        while let (directory, prefix) = stack.popLast() {
            let children = (try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: Self.resourceKeys,
                options: [.skipsHiddenFiles]
            )) ?? []
            for child in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                visited += 1
                guard visited <= archiveLimits.maximumEntryCount else {
                    throw ArchiveSafetyRefusal.tooManyEntries(
                        count: visited,
                        maximum: archiveLimits.maximumEntryCount
                    )
                }
                guard let path = try? access.makeRelative(child) else { continue }
                let name = prefix + "/" + child.lastPathComponent
                let values = try? child.resourceValues(forKeys: [
                    .isDirectoryKey, .isSymbolicLinkKey,
                ])
                // A symlink is not packed at all, for the reason
                // `ArchiveSafety` gives about unpacking one.
                if values?.isSymbolicLink == true { continue }
                if values?.isDirectory == true {
                    members.append((name, path, true))
                    stack.append((child, name))
                } else {
                    members.append((name, path, false))
                }
            }
        }
        return members
    }

    // MARK: - Helpers

    /// Prefetched while enumerating a directory, so a listing of a thousand
    /// items is one round trip to the filesystem rather than four thousand.
    private static let resourceKeys: [URLResourceKey] = [
        .isDirectoryKey, .fileSizeKey, .contentModificationDateKey, .isSymbolicLinkKey,
    ]

    /// The same keys, in the shape `URL.resourceValues(forKeys:)` wants.
    private static let resourceKeySet = Set(resourceKeys)

    private static let metadataKeys: Set<URLResourceKey> = [
        .isDirectoryKey, .fileSizeKey, .creationDateKey, .contentModificationDateKey,
    ]

    private static func listingOrder(_ lhs: WorkDirectoryEntry, _ rhs: WorkDirectoryEntry) -> Bool {
        if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
        return lhs.path.value.localizedCaseInsensitiveCompare(rhs.path.value) == .orderedAscending
    }

    /// Resolves for reading, distinguishing "there is nothing there" from "that
    /// leaves the grant".
    ///
    /// ``GrantAccessing/resolveForReading(_:)`` fails closed: anything that does
    /// not resolve is reported as outside the grant, which is the right answer
    /// for containment and the wrong words for somebody who simply mistyped a
    /// file name. The distinction is drawn *after* the refusal and never before
    /// it, so the containment check is still the first thing that runs.
    private func resolveExisting(_ path: GrantedPath) throws -> URL {
        do {
            return try access.resolveForReading(path)
        } catch WorkGrantAccessError.outsideGrant(let refusedPath) {
            let candidate = access.rootURL.appendingPathComponent(path.value)
            guard FileManager.default.fileExists(atPath: candidate.path) else {
                throw WorkFileServiceError.notFound(path: path.value)
            }
            throw WorkGrantAccessError.outsideGrant(path: refusedPath)
        }
    }

    private func isDirectory(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
        return exists && isDirectory.boolValue
    }

    /// Creates the folders a new item needs, matching what a person expects when
    /// they say "put these in Reports/2026".
    private func prepareParent(of url: URL, path: GrantedPath) throws {
        let parent = url.deletingLastPathComponent()
        guard !FileManager.default.fileExists(atPath: parent.path) else { return }
        // Re-resolved through the grant rather than created from the URL we
        // already hold, so an intermediate folder cannot be created outside the
        // grant even if the URL was built moments ago.
        if let parentPath = path.parent {
            let parentURL = try access.resolveForMutation(parentPath)
            do {
                try FileManager.default.createDirectory(
                    at: parentURL,
                    withIntermediateDirectories: true
                )
            } catch {
                throw WorkFileServiceError.ioFailure(
                    path: parentPath.value,
                    message: error.localizedDescription
                )
            }
        }
    }

    /// Copy-then-swap, so the destination is never absent while the copy runs.
    private func replaceItem(at destination: URL, byCopying source: URL, path: GrantedPath) throws {
        let staging = destination.deletingLastPathComponent()
            .appendingPathComponent(".juno-work-\(UUID().uuidString)")
        do {
            try FileManager.default.copyItem(at: source, to: staging)
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: staging)
        } catch {
            try? FileManager.default.removeItem(at: staging)
            throw WorkFileServiceError.ioFailure(
                path: path.value,
                message: error.localizedDescription
            )
        }
    }
}
