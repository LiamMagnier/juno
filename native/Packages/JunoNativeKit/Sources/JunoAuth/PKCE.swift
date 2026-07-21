import CryptoKit
import Foundation
import Security

public enum PKCEError: Error, Equatable, Sendable {
    case invalidVerifierLength
    case invalidVerifierCharacter
    case invalidRandomByteCount
    case secureRandomFailure(status: OSStatus)
}

public protocol RandomByteGenerating: Sendable {
    func bytes(count: Int) throws -> [UInt8]
}

public struct SecureRandomByteGenerator: RandomByteGenerating, Sendable {
    public init() {}

    public func bytes(count: Int) throws -> [UInt8] {
        guard count > 0 else {
            throw PKCEError.invalidRandomByteCount
        }
        var result = [UInt8](repeating: 0, count: count)
        let status = result.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw PKCEError.secureRandomFailure(status: status)
        }
        return result
    }
}

public struct PKCECodeVerifier: Hashable, Sendable, CustomStringConvertible {
    public let value: String

    public init(_ value: String) throws {
        guard (43...128).contains(value.utf8.count) else {
            throw PKCEError.invalidVerifierLength
        }
        guard value.utf8.allSatisfy(Self.isAllowed) else {
            throw PKCEError.invalidVerifierCharacter
        }
        self.value = value
    }

    public var description: String { "<pkce-verifier>" }

    private static func isAllowed(_ byte: UInt8) -> Bool {
        switch byte {
        case 48...57, 65...90, 97...122, 45, 46, 95, 126:
            true
        default:
            false
        }
    }
}

public struct PKCECodeChallenge: Hashable, Codable, Sendable {
    public let value: String

    public init(verifier: PKCECodeVerifier) {
        let digest = SHA256.hash(data: Data(verifier.value.utf8))
        value = Base64URL.encode(digest)
    }
}

public struct OAuthCorrelationValue: Hashable, Sendable, CustomStringConvertible {
    public let value: String

    public init(_ value: String) throws {
        guard value.utf8.count >= 32, value.utf8.count <= 256,
            value.utf8.allSatisfy({ byte in
                switch byte {
                case 48...57, 65...90, 97...122, 45, 95:
                    true
                default:
                    false
                }
            })
        else {
            throw PKCEError.invalidVerifierCharacter
        }
        self.value = value
    }

    public var description: String { "<oauth-correlation>" }
}

public struct PKCEPair: Hashable, Sendable {
    public let verifier: PKCECodeVerifier
    public let challenge: PKCECodeChallenge

    public init(verifier: PKCECodeVerifier) {
        self.verifier = verifier
        challenge = PKCECodeChallenge(verifier: verifier)
    }
}

public struct PKCEGenerator: Sendable {
    private let random: any RandomByteGenerating

    public init(random: any RandomByteGenerating = SecureRandomByteGenerator()) {
        self.random = random
    }

    /// Thirty-two random bytes encode to the RFC 7636 minimum 43-character verifier.
    public func makePair() throws -> PKCEPair {
        let verifier = try PKCECodeVerifier(Base64URL.encode(try random.bytes(count: 32)))
        return PKCEPair(verifier: verifier)
    }

    /// Generates state or nonce material independently from the verifier.
    public func makeCorrelationValue() throws -> OAuthCorrelationValue {
        try OAuthCorrelationValue(Base64URL.encode(try random.bytes(count: 32)))
    }
}

private enum Base64URL {
    static func encode<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
