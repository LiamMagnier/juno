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

/// Content identity used for concurrent-change detection: a mutation may pin
/// the fingerprint it was computed against and fails if the file moved on.
public struct FileFingerprint: Hashable, Codable, Sendable {
    public let sha256: String

    public init(of content: String) {
        self.sha256 = Digests.sha256Hex(content)
    }

    public init(sha256: String) {
        self.sha256 = sha256
    }
}
