import CryptoKit
import Foundation
import JunoWorkCore

public enum ContentFingerprintError: Error, Equatable, Sendable {
    /// The file is larger than the caller was willing to hash. Carries the cap
    /// so the refusal can say what the limit was rather than "too large".
    case tooLarge(byteCount: Int, maximumBytes: Int)
    /// Includes the ordinary case of pointing this at a folder.
    case unreadable(reason: String)
}

extension ContentFingerprintError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .tooLarge(_, let maximumBytes):
            "That file is bigger than the \(maximumBytes / (1_024 * 1_024)) MB Juno will read in one go."
        case .unreadable(let reason):
            "Juno could not read that file (\(reason))."
        }
    }
}

/// Streaming SHA-256 of a file's contents, capped.
///
/// **Nothing is ever held whole in memory.** The fingerprint of a 3 GB video and
/// the fingerprint of a 3 KB note cost the same resident bytes, because the file
/// is hashed a chunk at a time and each chunk is released before the next is
/// read. Reading a file in to hash it is the obvious implementation and it is
/// how a duplicate-detection pass over somebody's Downloads folder turns into a
/// memory alarm.
///
/// The cap is a second, independent guard. A path can name something that is not
/// a finite file — `/dev/zero`, a FIFO nobody closes, a network mount that
/// stalls — and a hash loop over one of those never returns. Counting bytes as
/// they go past and refusing at the ceiling turns an unbounded loop into a
/// refusal the person can read.
public enum ContentFingerprint {
    /// Large enough for a video somebody would reasonably keep in a work folder,
    /// small enough that a runaway read stops in seconds rather than filling a
    /// disk with nothing.
    public static let defaultMaximumBytes = 2 * 1_024 * 1_024 * 1_024

    /// One page-aligned megabyte: big enough that the syscall overhead vanishes,
    /// small enough that it never lands in the large-allocation path.
    public static let chunkBytes = 1_024 * 1_024

    /// Hashes the file at `url`, which the caller must already have resolved
    /// through ``GrantAccessing``.
    ///
    /// Takes a URL rather than a ``GrantedPath`` precisely so it cannot be
    /// mistaken for an authorization step: this function opens whatever it is
    /// given, and containment is the caller's job, done immediately before the
    /// call.
    public static func fingerprint(
        ofFileAt url: URL,
        maximumBytes: Int = defaultMaximumBytes
    ) throws -> WorkContentFingerprint {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw ContentFingerprintError.unreadable(reason: "there is nothing there")
        }
        guard !isDirectory.boolValue else {
            throw ContentFingerprintError.unreadable(reason: "it is a folder, not a file")
        }

        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: url)
        } catch {
            throw ContentFingerprintError.unreadable(reason: error.localizedDescription)
        }
        defer { try? handle.close() }

        var hasher = SHA256()
        var total = 0
        while true {
            let chunk: Data?
            do {
                chunk = try handle.read(upToCount: chunkBytes)
            } catch {
                throw ContentFingerprintError.unreadable(reason: error.localizedDescription)
            }
            guard let chunk, !chunk.isEmpty else { break }
            total += chunk.count
            // Checked inside the loop rather than from the file's reported size,
            // because a file being written while this runs can outgrow its own
            // stat between the check and the read.
            guard total <= maximumBytes else {
                throw ContentFingerprintError.tooLarge(
                    byteCount: total,
                    maximumBytes: maximumBytes
                )
            }
            hasher.update(data: chunk)
        }

        return WorkContentFingerprint(sha256: hexadecimal(hasher.finalize()), byteCount: total)
    }

    /// The fingerprint of a file that may not exist, for the common "what is
    /// there right now" question.
    public static func fingerprintIfPresent(
        ofFileAt url: URL,
        maximumBytes: Int = defaultMaximumBytes
    ) -> WorkContentFingerprint? {
        try? fingerprint(ofFileAt: url, maximumBytes: maximumBytes)
    }

    /// Lower-case hexadecimal, byte for byte the same as
    /// ``WorkDigests/sha256Hex(_:)`` produces for the same content.
    ///
    /// Written out here rather than reusing that helper because it takes a
    /// `Data` and this function's whole purpose is never to have one. The two
    /// agreeing is pinned by a test rather than left to inspection — a streamed
    /// hash that disagreed with the in-memory one would make every conflict
    /// check report a change nobody made.
    private static func hexadecimal(_ digest: SHA256Digest) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}
