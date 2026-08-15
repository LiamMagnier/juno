import Foundation

/// The smallest ZIP reader that can open a `.docx`.
///
/// This exists because `JunoStorage` has, deliberately, no dependencies — that
/// is what lets the storage layer be linked and tested without dragging auth,
/// sync, or networking in behind it. Adding a zip package to read one XML part
/// out of a Word file would trade that property away for a few hundred lines we
/// can write here.
///
/// Scope is intentionally narrow: it reads the central directory and inflates
/// stored or deflated entries. It does not write, does not decrypt, and does not
/// implement Zip64 — and it says so with a named error rather than returning
/// truncated bytes, because truncated XML would parse into a document that is
/// silently missing its second half.
struct ZIPArchiveReader {
    private struct Entry {
        let name: String
        let compressionMethod: UInt16
        let compressedSize: Int
        let uncompressedSize: Int
        let localHeaderOffset: Int
    }

    private let data: Data
    private let entries: [String: Entry]

    init(data: Data) throws {
        // Re-based to a zero start index on purpose. Every offset in a ZIP is
        // absolute from the beginning of the file, and a `Data` that arrived as
        // a slice of a larger buffer carries a non-zero `startIndex` — mixing
        // the two reads the central directory from the wrong place and reports a
        // damaged archive for a perfectly good file.
        let rebased = Data(data)
        self.data = rebased
        entries = try Self.readCentralDirectory(rebased)
    }

    var entryNames: [String] { Array(entries.keys) }

    /// The decompressed bytes of one entry, or nil when the archive has no such
    /// entry. Nil rather than empty `Data`: "the part is missing" and "the part
    /// is empty" lead to different messages for the person importing the file.
    func contents(of name: String) throws -> Data? {
        guard let entry = entries[name] else { return nil }
        let payload = try localPayload(for: entry)
        switch entry.compressionMethod {
        case 0:
            return payload
        case 8:
            return try Self.inflate(payload, expectedSize: entry.uncompressedSize)
        default:
            throw DocumentIngestionError.malformedArchive(
                reason: "unsupported compression method \(entry.compressionMethod)"
            )
        }
    }

    // MARK: - Central directory

    private static let endOfCentralDirectorySignature: UInt32 = 0x0605_4B50
    private static let centralFileHeaderSignature: UInt32 = 0x0201_4B50
    private static let localFileHeaderSignature: UInt32 = 0x0403_4B50
    private static let zip64Sentinel: UInt32 = 0xFFFF_FFFF

    private static func readCentralDirectory(_ data: Data) throws -> [String: Entry] {
        // The end-of-central-directory record sits at the tail, after a comment
        // of up to 64 KiB, so it is found by scanning backwards rather than by
        // seeking to a fixed offset.
        let minimumEOCD = 22
        guard data.count >= minimumEOCD else {
            throw DocumentIngestionError.malformedArchive(reason: "the file is too small")
        }
        let searchFloor = max(0, data.count - minimumEOCD - 65_535)
        var eocd: Int?
        var cursor = data.count - minimumEOCD
        while cursor >= searchFloor {
            if readUInt32(data, at: cursor) == endOfCentralDirectorySignature {
                eocd = cursor
                break
            }
            cursor -= 1
        }
        guard let eocd else {
            throw DocumentIngestionError.malformedArchive(
                reason: "no end-of-central-directory record"
            )
        }

        let entryCount = Int(readUInt16(data, at: eocd + 10))
        let directorySize = readUInt32(data, at: eocd + 12)
        let directoryOffset = readUInt32(data, at: eocd + 16)
        guard directorySize != zip64Sentinel, directoryOffset != zip64Sentinel else {
            throw DocumentIngestionError.malformedArchive(reason: "Zip64 is not supported")
        }

        var offset = Int(directoryOffset)
        var entries: [String: Entry] = [:]
        for _ in 0 ..< entryCount {
            guard offset + 46 <= data.count,
                readUInt32(data, at: offset) == centralFileHeaderSignature
            else {
                throw DocumentIngestionError.malformedArchive(
                    reason: "the central directory is truncated"
                )
            }
            let method = readUInt16(data, at: offset + 10)
            let compressedSize = readUInt32(data, at: offset + 20)
            let uncompressedSize = readUInt32(data, at: offset + 24)
            let nameLength = Int(readUInt16(data, at: offset + 28))
            let extraLength = Int(readUInt16(data, at: offset + 30))
            let commentLength = Int(readUInt16(data, at: offset + 32))
            let localOffset = readUInt32(data, at: offset + 42)
            guard compressedSize != zip64Sentinel,
                uncompressedSize != zip64Sentinel,
                localOffset != zip64Sentinel
            else {
                throw DocumentIngestionError.malformedArchive(reason: "Zip64 is not supported")
            }

            let nameStart = offset + 46
            guard nameStart + nameLength <= data.count else {
                throw DocumentIngestionError.malformedArchive(
                    reason: "an entry name is truncated"
                )
            }
            // ZIP names are documented as CP437 unless the UTF-8 flag is set.
            // Every part name we care about is ASCII, where the two agree.
            let name = String(
                decoding: data[nameStart ..< nameStart + nameLength],
                as: UTF8.self
            )
            entries[name] = Entry(
                name: name,
                compressionMethod: method,
                compressedSize: Int(compressedSize),
                uncompressedSize: Int(uncompressedSize),
                localHeaderOffset: Int(localOffset)
            )
            offset = nameStart + nameLength + extraLength + commentLength
        }
        return entries
    }

    /// The compressed bytes of an entry.
    ///
    /// The local header's name and extra lengths are read again here rather than
    /// reused from the central directory, because the two are allowed to differ
    /// — and when they do, trusting the central directory's lengths starts the
    /// read a few bytes into the payload, which inflates to garbage.
    private func localPayload(for entry: Entry) throws -> Data {
        let offset = entry.localHeaderOffset
        guard offset + 30 <= data.count,
            Self.readUInt32(data, at: offset) == Self.localFileHeaderSignature
        else {
            throw DocumentIngestionError.malformedArchive(
                reason: "the local header for \(entry.name) is missing"
            )
        }
        let nameLength = Int(Self.readUInt16(data, at: offset + 26))
        let extraLength = Int(Self.readUInt16(data, at: offset + 28))
        let start = offset + 30 + nameLength + extraLength
        let end = start + entry.compressedSize
        guard start <= end, end <= data.count else {
            throw DocumentIngestionError.malformedArchive(
                reason: "\(entry.name) is truncated"
            )
        }
        return data.subdata(in: start ..< end)
    }

    private static func inflate(_ payload: Data, expectedSize: Int) throws -> Data {
        guard !payload.isEmpty else { return Data() }
        #if canImport(Darwin)
        do {
            // ZIP method 8 is raw DEFLATE with no zlib wrapper, which is exactly
            // what Foundation's `.zlib` algorithm decodes.
            let inflated = try (payload as NSData).decompressed(using: .zlib) as Data
            guard expectedSize == 0 || inflated.count == expectedSize else {
                throw DocumentIngestionError.malformedArchive(
                    reason: "an entry inflated to \(inflated.count) bytes, not \(expectedSize)"
                )
            }
            return inflated
        } catch let error as DocumentIngestionError {
            throw error
        } catch {
            throw DocumentIngestionError.malformedArchive(
                reason: "an entry could not be decompressed"
            )
        }
        #else
        throw DocumentIngestionError.extractorUnavailable(format: .docx)
        #endif
    }

    // MARK: - Little-endian reads

    private static func readUInt16(_ data: Data, at offset: Int) -> UInt16 {
        guard offset >= 0, offset + 2 <= data.count else { return 0 }
        let base = data.startIndex + offset
        return UInt16(data[base]) | (UInt16(data[base + 1]) << 8)
    }

    private static func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
        guard offset >= 0, offset + 4 <= data.count else { return 0 }
        let base = data.startIndex + offset
        return UInt32(data[base])
            | (UInt32(data[base + 1]) << 8)
            | (UInt32(data[base + 2]) << 16)
            | (UInt32(data[base + 3]) << 24)
    }
}
