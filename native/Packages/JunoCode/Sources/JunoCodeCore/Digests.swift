import CryptoKit
import Foundation

public enum Digests {
    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func sha256Hex(_ text: String) -> String {
        sha256Hex(Data(text.utf8))
    }
}

public enum FileFingerprintError: Error, Equatable, Sendable {
    /// Not 64 hexadecimal characters. Carries no fragment of the offending
    /// value: a rejected fingerprint is echoed back to the model, and a model
    /// that sent a secret by mistake should not have it repeated.
    case malformed
}

/// Content identity used for concurrent-change detection: a mutation may pin
/// the fingerprint it was computed against and fails if the file moved on.
///
/// The digest is always over the file's **complete** bytes, never over a
/// truncated view of them — see `FileReadResult`, which withholds the value
/// entirely when the caller only received part of a file.
public struct FileFingerprint: Hashable, Codable, Sendable {
    public let sha256: String

    public init(of content: String) {
        self.sha256 = Digests.sha256Hex(content)
    }

    /// Trusted construction from a value this process computed.
    public init(sha256: String) {
        self.sha256 = sha256
    }

    /// Construction from a value a **model** supplied.
    ///
    /// A fingerprint arriving as a tool argument is untrusted text. Without
    /// this check a malformed one — a truncated digest, a hash of the wrong
    /// thing, the string "unknown" — simply failed to match and surfaced as
    /// "the file changed underneath you", sending the model off to re-read a
    /// file nobody had touched. Rejecting the shape says what actually
    /// happened.
    ///
    /// Case-insensitive on input and lowercased on the way in, so a model that
    /// upper-cases its hex is not told its correct digest is stale.
    public init(validating raw: String) throws {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 64,
            trimmed.allSatisfy({ $0.isHexDigit && $0.isASCII })
        else {
            throw FileFingerprintError.malformed
        }
        self.sha256 = trimmed.lowercased()
    }
}
