import Compression
import Foundation
import JunoWorkCore

// MARK: - What an archive claims to contain

/// What one entry in an archive says it is.
///
/// Modelled independently of the container format. The vetting below is the
/// policy for *any* archive Juno unpacks, and a zip reader, a tar reader and a
/// cloud provider's manifest all describe their entries in these terms.
public enum ArchiveEntryKind: Hashable, Sendable {
    case file
    case directory
    case symbolicLink
    case hardLink
    /// A device node, a FIFO, a socket — anything the extractor has no business
    /// creating in somebody's Documents folder.
    case otherNodeType(mode: UInt16)
}

/// One entry as the archive describes it, before anything is written.
///
/// The sizes are what the archive *claims*. They are used to refuse a bomb
/// before decompressing, and they are verified against reality afterwards: an
/// entry whose header lies about its size fails its checksum.
public struct ArchiveEntry: Hashable, Sendable {
    /// The name exactly as stored, including any `../`, leading `/` or backslash
    /// the archive happens to contain. Never sanitized in place — a name that
    /// needs sanitizing is a name Juno refuses, because "we cleaned it up" is
    /// how a traversal becomes a silently renamed file.
    public let name: String
    public let kind: ArchiveEntryKind
    public let uncompressedByteCount: Int
    public let compressedByteCount: Int

    public init(
        name: String,
        kind: ArchiveEntryKind,
        uncompressedByteCount: Int,
        compressedByteCount: Int
    ) {
        self.name = name
        self.kind = kind
        self.uncompressedByteCount = uncompressedByteCount
        self.compressedByteCount = compressedByteCount
    }
}

/// One entry that passed vetting, with the grant-relative location it may be
/// written to.
public struct ArchivePlannedEntry: Hashable, Sendable {
    public let entry: ArchiveEntry
    public let destination: GrantedPath

    public init(entry: ArchiveEntry, destination: GrantedPath) {
        self.entry = entry
        self.destination = destination
    }
}

// MARK: - Limits

/// Ceilings that turn a malicious archive into a refusal instead of a full disk.
public struct WorkArchiveLimits: Hashable, Sendable {
    /// Matches `ARTIFACT_MAX_BYTES.archive` in `src/lib/work/domain.ts`, so the
    /// Mac refuses the same archive the web app refuses rather than accepting
    /// one it will not be able to hand back.
    public var maximumArchiveBytes: Int
    public var maximumEntryCount: Int
    public var maximumTotalUncompressedBytes: Int
    public var maximumEntryUncompressedBytes: Int
    /// The signature of a decompression bomb: a few hundred kilobytes that
    /// expand to gigabytes of the same byte. Real documents rarely exceed about
    /// 50:1, so 200:1 refuses the attack without arguing with a text-heavy
    /// export.
    public var maximumCompressionRatio: Int

    public init(
        maximumArchiveBytes: Int = 200 * 1_024 * 1_024,
        maximumEntryCount: Int = 10_000,
        maximumTotalUncompressedBytes: Int = 512 * 1_024 * 1_024,
        maximumEntryUncompressedBytes: Int = 256 * 1_024 * 1_024,
        maximumCompressionRatio: Int = 200
    ) {
        self.maximumArchiveBytes = maximumArchiveBytes
        self.maximumEntryCount = maximumEntryCount
        self.maximumTotalUncompressedBytes = maximumTotalUncompressedBytes
        self.maximumEntryUncompressedBytes = maximumEntryUncompressedBytes
        self.maximumCompressionRatio = maximumCompressionRatio
    }

    public static let `default` = WorkArchiveLimits()
}

// MARK: - Refusals

public enum ArchiveSafetyRefusal: Error, Equatable, Sendable {
    case absoluteEntryPath(name: String)
    case traversalEntryPath(name: String)
    case unusableEntryName(name: String)
    case symbolicLinkEntry(name: String)
    case hardLinkEntry(name: String)
    case unsupportedEntryType(name: String)
    case duplicateEntryName(name: String)
    case tooManyEntries(count: Int, maximum: Int)
    case totalTooLarge(byteCount: Int, maximum: Int)
    case entryTooLarge(name: String, byteCount: Int, maximum: Int)
    case suspiciousCompressionRatio(name: String, ratio: Int, maximum: Int)
}

extension ArchiveSafetyRefusal: LocalizedError {
    /// Written for the person, and deliberately not apologetic. Each of these
    /// means the archive tried to write somewhere it was not asked to, and
    /// saying so plainly is more useful than "extraction failed".
    public var errorDescription: String? {
        switch self {
        case .absoluteEntryPath(let name):
            "This archive contains an item (\(name)) that names a location on your disk rather than a place inside the folder, so Juno did not unpack it."
        case .traversalEntryPath(let name):
            "This archive contains an item (\(name)) that steps outside the folder it was being unpacked into, so Juno did not unpack it."
        case .unusableEntryName(let name):
            "This archive contains an item whose name Juno cannot use safely (\(name))."
        case .symbolicLinkEntry(let name):
            "This archive contains a link (\(name)). Juno does not create links when unpacking, because a link can point anywhere on your disk."
        case .hardLinkEntry(let name):
            "This archive contains a hard link (\(name)), which would tie a new file to one that already exists elsewhere."
        case .unsupportedEntryType(let name):
            "This archive contains an item (\(name)) that is not a file or a folder."
        case .duplicateEntryName(let name):
            "This archive contains \(name) twice, so what ended up on disk would depend on which one was unpacked last."
        case .tooManyEntries(let count, let maximum):
            "This archive contains \(count) items, and Juno unpacks at most \(maximum) at once."
        case .totalTooLarge(let byteCount, let maximum):
            "Unpacking this archive would write \(byteCount / (1_024 * 1_024)) MB, and Juno stops at \(maximum / (1_024 * 1_024)) MB."
        case .entryTooLarge(let name, _, let maximum):
            "One item in this archive (\(name)) is larger than the \(maximum / (1_024 * 1_024)) MB Juno will unpack."
        case .suspiciousCompressionRatio(let name, let ratio, _):
            "One item in this archive (\(name)) expands to \(ratio) times its stored size, which is how a deliberately oversized archive is built. Juno did not unpack it."
        }
    }
}

// MARK: - The policy

/// The rules an archive must satisfy before a single byte of it is written.
///
/// **Every rule here is a named attack that has been used against real
/// extractors, not a hypothetical.**
///
/// - **Zip Slip** (`../../../../Library/LaunchAgents/x.plist`). An entry name
///   containing `..` walks out of the destination folder while every individual
///   write still looks like it is going "into" the archive's own tree. This is
///   the single most common archive vulnerability and it is why entry names are
///   refused rather than cleaned: a sanitizer that strips `..` turns a hostile
///   name into a plausible one and writes it anyway.
/// - **Absolute paths.** The zip format stores names as text and nothing stops
///   an entry being called `/etc/hosts`. An extractor that joins that onto a
///   destination with a naive concatenation, or that hands it to `open(2)`
///   directly, writes to the absolute location.
/// - **Symlink-then-write.** Entry one is a link named `config` pointing at
///   `/Users/you/.ssh`; entry two is a plain file named `config/authorized_keys`.
///   Each entry passes a containment check on its own name, and the second write
///   lands wherever the first entry pointed. Juno refuses *every* symlink entry,
///   not only ones that currently point outside, because "currently" is decided
///   by a tree the archive is still in the middle of building.
/// - **Hard links.** A hard-link entry names an existing inode instead of
///   carrying content. Extracting one gives the archive a second name for a file
///   the person never offered, and subsequent writes through that name modify
///   the original.
/// - **Device and FIFO entries.** A character device or a named pipe in a
///   documents folder is never what somebody asked for, and an extractor that
///   opens one blocks forever.
/// - **Zip bombs.** A few hundred kilobytes of highly redundant data expands to
///   gigabytes. The entry count, the per-entry size, the total size and the
///   compression ratio are all checked from the archive's own headers *before*
///   anything is decompressed, so the refusal costs nothing.
///
/// Vetting is name-level and therefore only half the job. The other half is that
/// every planned destination is resolved through ``GrantAccessing`` immediately
/// before it is written, which is what catches an entry whose name is innocent
/// but whose parent folder is a symlink that already existed in the grant.
public enum ArchiveSafety {
    /// Checks every entry against the rules above and returns where each one may
    /// be written, or refuses the archive whole.
    ///
    /// **All-or-nothing on purpose.** A partial extraction that skipped the
    /// hostile entries would leave the person with a folder that looks unpacked
    /// and is missing pieces, and would train them to ignore the warning. One
    /// bad entry means the archive is not unpacked.
    ///
    /// The result is index-parallel to `entries`: either every entry is planned,
    /// in order, or nothing is returned at all. Extractors rely on that to line a
    /// planned destination up with the entry it came from.
    public static func vet(
        _ entries: [ArchiveEntry],
        into destination: GrantedPath,
        limits: WorkArchiveLimits = .default
    ) throws -> [ArchivePlannedEntry] {
        guard entries.count <= limits.maximumEntryCount else {
            throw ArchiveSafetyRefusal.tooManyEntries(
                count: entries.count,
                maximum: limits.maximumEntryCount
            )
        }

        var planned: [ArchivePlannedEntry] = []
        planned.reserveCapacity(entries.count)
        var seen: Set<GrantedPath> = []
        var total = 0

        for entry in entries {
            switch entry.kind {
            case .file, .directory:
                break
            case .symbolicLink:
                throw ArchiveSafetyRefusal.symbolicLinkEntry(name: entry.name)
            case .hardLink:
                throw ArchiveSafetyRefusal.hardLinkEntry(name: entry.name)
            case .otherNodeType:
                throw ArchiveSafetyRefusal.unsupportedEntryType(name: entry.name)
            }

            guard entry.uncompressedByteCount <= limits.maximumEntryUncompressedBytes else {
                throw ArchiveSafetyRefusal.entryTooLarge(
                    name: entry.name,
                    byteCount: entry.uncompressedByteCount,
                    maximum: limits.maximumEntryUncompressedBytes
                )
            }
            // Only meaningful when something was actually compressed; a stored
            // entry has a ratio of one and an empty entry has none at all.
            if entry.compressedByteCount > 0, entry.uncompressedByteCount > 0 {
                let ratio = entry.uncompressedByteCount / max(1, entry.compressedByteCount)
                guard ratio <= limits.maximumCompressionRatio else {
                    throw ArchiveSafetyRefusal.suspiciousCompressionRatio(
                        name: entry.name,
                        ratio: ratio,
                        maximum: limits.maximumCompressionRatio
                    )
                }
            }
            total += entry.uncompressedByteCount
            guard total <= limits.maximumTotalUncompressedBytes else {
                throw ArchiveSafetyRefusal.totalTooLarge(
                    byteCount: total,
                    maximum: limits.maximumTotalUncompressedBytes
                )
            }

            let path = try location(for: entry, under: destination)
            guard seen.insert(path).inserted else {
                throw ArchiveSafetyRefusal.duplicateEntryName(name: entry.name)
            }
            planned.append(ArchivePlannedEntry(entry: entry, destination: path))
        }
        return planned
    }

    /// Turns one entry name into a location under the destination, or refuses.
    ///
    /// The order of the checks is the order in which they are cheap and in which
    /// they give the most specific answer: absolute first, then traversal, then
    /// everything ``GrantedPath`` already refuses. The final construction is the
    /// belt to that braces — a name that got past the explicit checks still has
    /// to survive shape validation.
    private static func location(
        for entry: ArchiveEntry,
        under destination: GrantedPath
    ) throws -> GrantedPath {
        var name = entry.name
        // A trailing separator is how a zip marks a folder; it is part of the
        // format, not part of the name.
        while name.hasSuffix("/") { name.removeLast() }

        guard !name.isEmpty else {
            throw ArchiveSafetyRefusal.unusableEntryName(name: entry.name)
        }
        // A backslash is refused rather than translated. Archives written on
        // Windows use it as a separator, so `..\..\x` is a traversal that a
        // forward-slash-only check reads as one long, harmless file name.
        guard !name.hasPrefix("/"), !name.hasPrefix("~"), !name.contains("\\") else {
            throw ArchiveSafetyRefusal.absoluteEntryPath(name: entry.name)
        }
        // A drive letter is absolute on the system that wrote it, and joining it
        // onto a destination produces a folder literally called `C:`.
        if let colon = name.firstIndex(of: ":"), name.distance(from: name.startIndex, to: colon) == 1 {
            throw ArchiveSafetyRefusal.absoluteEntryPath(name: entry.name)
        }
        let components = name.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains("..") else {
            throw ArchiveSafetyRefusal.traversalEntryPath(name: entry.name)
        }

        var path = destination
        for component in components {
            do {
                path = try path.appending(String(component))
            } catch {
                throw ArchiveSafetyRefusal.unusableEntryName(name: entry.name)
            }
        }
        return path
    }
}

// MARK: - Zip container

public enum ZipArchiveError: Error, Equatable, Sendable {
    case notAZipArchive
    /// Zip64 is refused rather than half-parsed. The 32-bit fields carry
    /// sentinel values when the real ones live in an extra-field record, and an
    /// extractor that reads the sentinel as a size allocates four gigabytes or
    /// truncates a file without noticing.
    case unsupportedZip64
    case unsupportedCompressionMethod(name: String, method: UInt16)
    case encryptedEntry(name: String)
    case malformed(reason: String)
    /// The extracted bytes do not match the checksum the archive recorded, which
    /// is also how a header that lied about its size is caught.
    case checksumMismatch(name: String)
    case archiveTooLarge(byteCount: Int, maximum: Int)
}

extension ZipArchiveError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .notAZipArchive:
            "That file is not a zip archive Juno can read."
        case .unsupportedZip64:
            "That archive uses the large-archive format, which Juno does not unpack."
        case .unsupportedCompressionMethod(let name, _):
            "One item in that archive (\(name)) is compressed in a way Juno cannot read."
        case .encryptedEntry(let name):
            "That archive is password-protected (\(name)), and Juno does not have the password."
        case .malformed(let reason):
            "That archive is damaged (\(reason))."
        case .checksumMismatch(let name):
            "One item in that archive (\(name)) did not come out the way the archive said it would, so Juno stopped."
        case .archiveTooLarge(_, let maximum):
            "That archive is larger than the \(maximum / (1_024 * 1_024)) MB Juno will unpack."
        }
    }
}

/// A minimal, deliberately strict zip reader.
///
/// Written rather than shelled out to `unzip` or `ditto` because the whole point
/// of this file is that Juno decides where every byte lands. A command-line
/// extractor takes the destination and the archive and does the traversal check
/// itself, with its own idea of what is safe, after which Juno can only inspect
/// the damage. Parsing the central directory first means every entry is vetted
/// while the disk is still untouched.
public struct ZipArchiveReader: Sendable {
    private struct Record: Sendable {
        let name: String
        let kind: ArchiveEntryKind
        let method: UInt16
        let crc32: UInt32
        let compressedSize: Int
        let uncompressedSize: Int
        let localHeaderOffset: Int
    }

    private let data: Data
    private let records: [Record]

    /// Every entry the archive's central directory declares, in stored order.
    public let entries: [ArchiveEntry]

    public init(contentsOf url: URL, limits: WorkArchiveLimits = .default) throws {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? nil
        if let size, size > limits.maximumArchiveBytes {
            throw ZipArchiveError.archiveTooLarge(
                byteCount: size,
                maximum: limits.maximumArchiveBytes
            )
        }
        // Memory-mapped: the central directory lives at the *end* of a zip, so a
        // sequential read would have to pull the whole archive through memory to
        // find out what is in it. Mapping lets a 200 MB archive be inspected for
        // the cost of the pages actually touched.
        let mapped: Data
        do {
            mapped = try Data(contentsOf: url, options: [.mappedIfSafe])
        } catch {
            throw ZipArchiveError.malformed(reason: error.localizedDescription)
        }
        try self.init(archiveData: mapped, limits: limits)
    }

    public init(archiveData: Data, limits: WorkArchiveLimits = .default) throws {
        guard archiveData.count <= limits.maximumArchiveBytes else {
            throw ZipArchiveError.archiveTooLarge(
                byteCount: archiveData.count,
                maximum: limits.maximumArchiveBytes
            )
        }
        self.data = archiveData
        self.records = try Self.readCentralDirectory(archiveData, limits: limits)
        self.entries = records.map {
            ArchiveEntry(
                name: $0.name,
                kind: $0.kind,
                uncompressedByteCount: $0.uncompressedSize,
                compressedByteCount: $0.compressedSize
            )
        }
    }

    /// The decompressed contents of one entry, verified against its checksum.
    public func contents(ofEntryAt index: Int) throws -> Data {
        guard records.indices.contains(index) else {
            throw ZipArchiveError.malformed(reason: "no such entry")
        }
        let record = records[index]
        if case .directory = record.kind { return Data() }

        let local = record.localHeaderOffset
        guard let signature = Self.uint32(data, local), signature == 0x0403_4b50,
            let nameLength = Self.uint16(data, local + 26),
            let extraLength = Self.uint16(data, local + 28)
        else {
            throw ZipArchiveError.malformed(reason: "an item's header is missing")
        }
        // The local header's own name and extra lengths are used, not the
        // central directory's: the two are allowed to differ, and reading the
        // wrong one starts the payload a few bytes off.
        let start = local + 30 + Int(nameLength) + Int(extraLength)
        guard start >= 0, start + record.compressedSize <= data.count else {
            throw ZipArchiveError.malformed(reason: "an item runs past the end of the archive")
        }
        let payload = data[
            (data.startIndex + start)..<(data.startIndex + start + record.compressedSize)
        ]

        let result: Data
        switch record.method {
        case 0:
            result = Data(payload)
        case 8:
            result = try Self.inflate(
                Data(payload),
                expecting: record.uncompressedSize,
                name: record.name
            )
        default:
            throw ZipArchiveError.unsupportedCompressionMethod(
                name: record.name,
                method: record.method
            )
        }
        // Checked always, not only in debug. The checksum is what turns "the
        // header claimed 40 bytes and produced 4 GB" from a memory incident into
        // a refusal.
        guard ZipCRC32.checksum(result) == record.crc32 else {
            throw ZipArchiveError.checksumMismatch(name: record.name)
        }
        return result
    }

    // MARK: Parsing

    private static func readCentralDirectory(
        _ data: Data,
        limits: WorkArchiveLimits
    ) throws -> [Record] {
        let endRecordSize = 22
        guard data.count >= endRecordSize else { throw ZipArchiveError.notAZipArchive }
        // The end-of-central-directory record is last, but a trailing comment of
        // up to 65,535 bytes may follow it, so it has to be searched for.
        let earliest = max(0, data.count - (endRecordSize + 65_535))
        var end: Int?
        var cursor = data.count - endRecordSize
        while cursor >= earliest {
            if uint32(data, cursor) == 0x0605_4b50 {
                end = cursor
                break
            }
            cursor -= 1
        }
        guard let end,
            let declaredCount = uint16(data, end + 10),
            let directorySize = uint32(data, end + 12),
            let directoryOffset = uint32(data, end + 16)
        else {
            throw ZipArchiveError.notAZipArchive
        }
        guard declaredCount != 0xFFFF, directorySize != 0xFFFF_FFFF,
            directoryOffset != 0xFFFF_FFFF
        else {
            throw ZipArchiveError.unsupportedZip64
        }
        guard Int(declaredCount) <= limits.maximumEntryCount else {
            throw ArchiveSafetyRefusal.tooManyEntries(
                count: Int(declaredCount),
                maximum: limits.maximumEntryCount
            )
        }

        var records: [Record] = []
        records.reserveCapacity(Int(declaredCount))
        var offset = Int(directoryOffset)
        for _ in 0..<Int(declaredCount) {
            guard uint32(data, offset) == 0x0201_4b50,
                let madeBy = uint16(data, offset + 4),
                let flags = uint16(data, offset + 8),
                let method = uint16(data, offset + 10),
                let crc = uint32(data, offset + 16),
                let compressed = uint32(data, offset + 20),
                let uncompressed = uint32(data, offset + 24),
                let nameLength = uint16(data, offset + 28),
                let extraLength = uint16(data, offset + 30),
                let commentLength = uint16(data, offset + 32),
                let externalAttributes = uint32(data, offset + 38),
                let localOffset = uint32(data, offset + 42)
            else {
                throw ZipArchiveError.malformed(reason: "the archive's index is incomplete")
            }
            let nameStart = offset + 46
            guard nameStart + Int(nameLength) <= data.count else {
                throw ZipArchiveError.malformed(reason: "an item's name runs past the end")
            }
            let nameData = data[
                (data.startIndex + nameStart)..<(data.startIndex + nameStart + Int(nameLength))
            ]
            guard let name = String(data: Data(nameData), encoding: .utf8) else {
                // Refused rather than lossily decoded: a name that is not valid
                // UTF-8 cannot be compared with what the vetting approved.
                throw ZipArchiveError.malformed(reason: "an item's name is not readable text")
            }
            guard flags & 0x0001 == 0 else {
                throw ZipArchiveError.encryptedEntry(name: name)
            }
            guard compressed != 0xFFFF_FFFF, uncompressed != 0xFFFF_FFFF,
                localOffset != 0xFFFF_FFFF
            else {
                throw ZipArchiveError.unsupportedZip64
            }

            records.append(
                Record(
                    name: name,
                    kind: kind(
                        name: name,
                        madeBy: madeBy,
                        externalAttributes: externalAttributes
                    ),
                    method: method,
                    crc32: crc,
                    compressedSize: Int(compressed),
                    uncompressedSize: Int(uncompressed),
                    localHeaderOffset: Int(localOffset)
                )
            )
            offset = nameStart + Int(nameLength) + Int(extraLength) + Int(commentLength)
        }
        return records
    }

    /// Reads the Unix mode an archiver stored in the external attributes.
    ///
    /// Only trusted when the archive says it was made on Unix (`madeBy` high
    /// byte 3). A zip written on Windows puts DOS attribute flags in the same
    /// field, and reading those as a mode makes an ordinary read-only file look
    /// like a symbolic link.
    private static func kind(
        name: String,
        madeBy: UInt16,
        externalAttributes: UInt32
    ) -> ArchiveEntryKind {
        if name.hasSuffix("/") { return .directory }
        guard madeBy >> 8 == 3 else { return .file }
        let mode = UInt16(truncatingIfNeeded: externalAttributes >> 16)
        switch mode & 0xF000 {
        case 0xA000: return .symbolicLink
        case 0x4000: return .directory
        case 0x8000, 0x0000: return .file
        default: return .otherNodeType(mode: mode)
        }
    }

    private static func inflate(_ payload: Data, expecting size: Int, name: String) throws -> Data {
        guard size > 0 else { return Data() }
        var output = Data(count: size)
        let written = payload.withUnsafeBytes { source -> Int in
            guard let sourceBase = source.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return output.withUnsafeMutableBytes { destination -> Int in
                guard let destinationBase = destination.bindMemory(to: UInt8.self).baseAddress
                else { return 0 }
                // COMPRESSION_ZLIB is libcompression's name for raw DEFLATE
                // (RFC 1951), which is exactly what a zip entry holds — no zlib
                // wrapper, no gzip header.
                return compression_decode_buffer(
                    destinationBase,
                    size,
                    sourceBase,
                    payload.count,
                    nil,
                    COMPRESSION_ZLIB
                )
            }
        }
        guard written == size else {
            throw ZipArchiveError.checksumMismatch(name: name)
        }
        return output
    }

    private static func uint16(_ data: Data, _ offset: Int) -> UInt16? {
        guard offset >= 0, offset + 2 <= data.count else { return nil }
        let base = data.startIndex + offset
        return UInt16(data[base]) | (UInt16(data[base + 1]) << 8)
    }

    private static func uint32(_ data: Data, _ offset: Int) -> UInt32? {
        guard offset >= 0, offset + 4 <= data.count else { return nil }
        let base = data.startIndex + offset
        return UInt32(data[base]) | (UInt32(data[base + 1]) << 8) | (UInt32(data[base + 2]) << 16)
            | (UInt32(data[base + 3]) << 24)
    }
}

/// A minimal zip writer.
///
/// **Names are written exactly as given.** This type is the container format and
/// nothing else; it does not vet, because the safety rules belong to unpacking,
/// where somebody else's archive is being trusted. Producing an archive whose
/// entry is called `../x` is harmless — it becomes dangerous only if something
/// unpacks it without ``ArchiveSafety``, which is the case those rules exist to
/// cover and which the tests exercise by building exactly such an archive.
public enum ZipArchiveWriter {
    public struct Entry: Hashable, Sendable {
        /// Forward-slash separated, relative, as the zip format requires.
        public let name: String
        public let contents: Data
        public let isDirectory: Bool
        public let modifiedAt: Date

        public init(
            name: String,
            contents: Data = Data(),
            isDirectory: Bool = false,
            modifiedAt: Date = Date()
        ) {
            self.name = name
            self.contents = contents
            self.isDirectory = isDirectory
            self.modifiedAt = modifiedAt
        }
    }

    public static func archiveData(for entries: [Entry]) -> Data {
        var output = Data()
        var directory = Data()
        var count: UInt16 = 0

        for entry in entries {
            let storedName = entry.isDirectory && !entry.name.hasSuffix("/")
                ? entry.name + "/" : entry.name
            let nameBytes = Data(storedName.utf8)
            let contents = entry.isDirectory ? Data() : entry.contents
            let crc = ZipCRC32.checksum(contents)
            let deflated = entry.isDirectory ? nil : deflate(contents)
            let payload = deflated ?? contents
            let method: UInt16 = deflated == nil ? 0 : 8
            let (dosTime, dosDate) = dosTimestamp(entry.modifiedAt)
            let localOffset = UInt32(output.count)

            output.append(uint32: 0x0403_4b50)
            output.append(uint16: 20)
            // Bit 11 declares the name is UTF-8, so an accented file name is not
            // mangled by whatever code page the reader would otherwise assume.
            output.append(uint16: 0x0800)
            output.append(uint16: method)
            output.append(uint16: dosTime)
            output.append(uint16: dosDate)
            output.append(uint32: crc)
            output.append(uint32: UInt32(payload.count))
            output.append(uint32: UInt32(contents.count))
            output.append(uint16: UInt16(nameBytes.count))
            output.append(uint16: 0)
            output.append(nameBytes)
            output.append(payload)

            directory.append(uint32: 0x0201_4b50)
            // High byte 3 says "made on Unix", which is what makes the mode in
            // the external attributes meaningful to a reader.
            directory.append(uint16: (3 << 8) | 20)
            directory.append(uint16: 20)
            directory.append(uint16: 0x0800)
            directory.append(uint16: method)
            directory.append(uint16: dosTime)
            directory.append(uint16: dosDate)
            directory.append(uint32: crc)
            directory.append(uint32: UInt32(payload.count))
            directory.append(uint32: UInt32(contents.count))
            directory.append(uint16: UInt16(nameBytes.count))
            directory.append(uint16: 0)
            directory.append(uint16: 0)
            directory.append(uint16: 0)
            directory.append(uint16: 0)
            directory.append(uint32: entry.isDirectory ? 0x4155_0000 : 0x81A4_0000)
            directory.append(uint32: localOffset)
            directory.append(nameBytes)
            count += 1
        }

        let directoryOffset = UInt32(output.count)
        output.append(directory)
        output.append(uint32: 0x0605_4b50)
        output.append(uint16: 0)
        output.append(uint16: 0)
        output.append(uint16: count)
        output.append(uint16: count)
        output.append(uint32: UInt32(directory.count))
        output.append(uint32: directoryOffset)
        output.append(uint16: 0)
        return output
    }

    /// Raw DEFLATE, or nil when compressing did not help.
    ///
    /// Falling back to stored rather than accepting a larger payload keeps an
    /// archive of already-compressed files (photographs, PDFs) from growing.
    private static func deflate(_ data: Data) -> Data? {
        guard !data.isEmpty else { return nil }
        var output = Data(count: data.count)
        let written = data.withUnsafeBytes { source -> Int in
            guard let sourceBase = source.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return output.withUnsafeMutableBytes { destination -> Int in
                guard let destinationBase = destination.bindMemory(to: UInt8.self).baseAddress
                else { return 0 }
                return compression_encode_buffer(
                    destinationBase,
                    data.count,
                    sourceBase,
                    data.count,
                    nil,
                    COMPRESSION_ZLIB
                )
            }
        }
        guard written > 0, written < data.count else { return nil }
        return Data(output.prefix(written))
    }

    /// The MS-DOS date and time fields the zip format still uses.
    ///
    /// Two-second resolution and a 1980 epoch, both inherited from the format.
    /// Clamped rather than allowed to wrap: a file dated 1970 would otherwise
    /// encode as a year in the far future and sort to the top of every listing.
    private static func dosTimestamp(_ date: Date) -> (time: UInt16, date: UInt16) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        let parts = calendar.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: date
        )
        let year = max(1_980, min(2_107, parts.year ?? 1_980))
        let time =
            UInt16(parts.hour ?? 0) << 11 | UInt16(parts.minute ?? 0) << 5
            | UInt16((parts.second ?? 0) / 2)
        let day =
            UInt16(year - 1_980) << 9 | UInt16(parts.month ?? 1) << 5 | UInt16(parts.day ?? 1)
        return (time, day)
    }
}

// MARK: - Checksum

/// The CRC-32 the zip format records for every entry.
enum ZipCRC32 {
    private static let table: [UInt32] = (0..<256).map { index in
        var value = UInt32(index)
        for _ in 0..<8 {
            value = (value & 1) == 1 ? (value >> 1) ^ 0xEDB8_8320 : value >> 1
        }
        return value
    }

    static func checksum(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in data {
            crc = (crc >> 8) ^ table[Int((crc ^ UInt32(byte)) & 0xFF)]
        }
        return crc ^ 0xFFFF_FFFF
    }
}

extension Data {
    /// Little-endian, which is what every field in the zip format is.
    fileprivate mutating func append(uint16 value: UInt16) {
        append(UInt8(value & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
    }

    fileprivate mutating func append(uint32 value: UInt32) {
        append(UInt8(value & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8((value >> 16) & 0xFF))
        append(UInt8((value >> 24) & 0xFF))
    }
}
