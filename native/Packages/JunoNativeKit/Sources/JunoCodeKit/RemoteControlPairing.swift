import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

// Remote control pairing (docs/code-v2/REMOTE-CONTROL.md).
//
// The Mac asks the backend for an offer and shows it: a QR that holds a
// signed, two-minute, single-use token (a phone scans it), or a URL plus a
// short code (a browser types it). The phone, signed in to the same account,
// shows "Allow this iPhone to control Alevr on <Mac>?" and approves or denies;
// the Mac polls the offer and lists what it approved, each with Remove.

/// Phone (a QR the iPhone scans) or browser (a URL plus a code).
public enum RemotePairingKind: String, Codable, Sendable, CaseIterable, Hashable {
    case phone
    case browser
}

/// What the Mac's sheet shows: the QR's URL (phone) or the URL and code (browser).
public struct RemotePairingOffer: Codable, Sendable, Equatable {
    public let id: String
    public let kind: RemotePairingKind
    public let token: String
    public let url: String
    /// Browsers: "ABCD-EFGH".
    public let code: String?
    public let expiresAt: Date
    public let deviceName: String

    public init(id: String, kind: RemotePairingKind, token: String, url: String, code: String?, expiresAt: Date, deviceName: String) {
        self.id = id
        self.kind = kind
        self.token = token
        self.url = url
        self.code = code
        self.expiresAt = expiresAt
        self.deviceName = deviceName
    }
}

/// One phone or browser a Mac approved (or, read from the phone, one Mac it may control).
public struct RemotePair: Codable, Sendable, Equatable, Identifiable, Hashable {
    public let id: String
    public let kind: RemotePairingKind
    public let name: String
    public let platform: String
    /// The Mac (CodeDevice id).
    public let deviceId: String
    public let deviceName: String?
    public let createdAt: Date
    public let lastUsedAt: Date

    public init(
        id: String, kind: RemotePairingKind, name: String, platform: String, deviceId: String,
        deviceName: String? = nil, createdAt: Date, lastUsedAt: Date
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.platform = platform
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
    }
}

/// Where an offer stands, as the Mac's sheet polls it.
public enum RemotePairingStatus: Equatable, Sendable {
    case pending
    case approved(RemotePair?)
    case denied
    case expired
}

/// What the approve screen shows before anything is consumed.
public struct RemotePairingSummary: Codable, Sendable, Equatable {
    public let id: String
    public let kind: RemotePairingKind
    public let deviceId: String
    public let deviceName: String
    public let expiresAt: Date

    public init(id: String, kind: RemotePairingKind, deviceId: String, deviceName: String, expiresAt: Date) {
        self.id = id
        self.kind = kind
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.expiresAt = expiresAt
    }
}

/// A refusal in the server's own words (`code` is `expired`, `used`, `not_found`,
/// `wrong_kind`, `not_paired`, …).
public struct RemotePairingError: Error, Equatable, Sendable, LocalizedError {
    public let status: Int
    public let code: String?
    public let message: String

    public init(status: Int, code: String?, message: String) {
        self.status = status
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
    public var isExpiredOrUsed: Bool { code == "expired" || code == "used" }
}

/// Reads a scanned QR or an opened link: `https://…/pair?t=<token>` or
/// `com.liammagnier.juno://juno/pair?t=<token>`. Anything else is nil, so a
/// random QR never reaches the approve screen.
public enum RemotePairingLink {
    public static let appScheme = "com.liammagnier.juno"

    public static func token(from text: String) -> String? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return token(from: url)
    }

    public static func token(from url: URL) -> String? {
        let isWeb = (url.scheme == "https" || url.scheme == "http") && url.path == "/pair"
        let isApp = url.scheme == appScheme && url.host == "juno" && url.path == "/pair"
        guard isWeb || isApp else { return nil }
        let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "t" }?.value
        guard let token, token.hasPrefix("rcp1."), token.count <= 1024 else { return nil }
        return token
    }

    /// The app link the web's /pair page opens, for a phone that scanned with the Camera.
    public static func appURL(token: String) -> URL? {
        var components = URLComponents()
        components.scheme = appScheme
        components.host = "juno"
        components.path = "/pair"
        components.queryItems = [URLQueryItem(name: "t", value: token)]
        return components.url
    }
}

/// The pairing routes (`/api/code/pairing/**`).
public struct RemotePairingClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    // MARK: Mac

    /// A fresh offer for this Mac (`deviceId` is its CodeDevice id).
    public func createOffer(deviceId: String, kind: RemotePairingKind, for accountID: AccountID) async throws -> RemotePairingOffer {
        try await send("/api/code/pairing", .post, body: ["deviceId": deviceId, "kind": kind.rawValue], for: accountID)
    }

    public func offerStatus(id: String, for accountID: AccountID) async throws -> RemotePairingStatus {
        let wire: StatusWire = try await send("/api/code/pairing/offers/\(Self.segment(id))", .get, for: accountID)
        switch wire.status {
        case "approved": return .approved(wire.pair)
        case "denied": return .denied
        case "expired": return .expired
        default: return .pending
        }
    }

    /// The phones and browsers this Mac approved.
    public func pairs(deviceId: String, for accountID: AccountID) async throws -> [RemotePair] {
        let wire: PairsWire = try await send("/api/code/pairing/pairs", .get, query: [URLQueryItem(name: "deviceId", value: deviceId)], for: accountID)
        return wire.pairs
    }

    /// Remove: the pair stops working on its next request.
    public func revoke(pairId: String, for accountID: AccountID) async throws {
        let _: OKWire = try await send("/api/code/pairing/pairs/\(Self.segment(pairId))", .delete, for: accountID)
    }

    // MARK: Phone

    /// The Macs this phone may control.
    public func myPairs(for accountID: AccountID) async throws -> [RemotePair] {
        let wire: PairsWire = try await send("/api/code/pairing/pairs", .get, for: accountID)
        return wire.pairs
    }

    public func inspect(token: String, for accountID: AccountID) async throws -> RemotePairingSummary {
        try await send("/api/code/pairing/inspect", .post, body: ["token": token], for: accountID)
    }

    public func approve(token: String, for accountID: AccountID) async throws -> RemotePair {
        let wire: ApprovedWire = try await send("/api/code/pairing/approve", .post, body: ["token": token], for: accountID)
        return wire.pair
    }

    public func deny(token: String, for accountID: AccountID) async throws {
        let _: OKWire = try await send("/api/code/pairing/deny", .post, body: ["token": token], for: accountID)
    }

    // MARK: Plumbing

    static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = RemoteDates.parse(text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an ISO-8601 date: \(text)"))
        }
        return decoder
    }()

    private func send<T: Decodable>(
        _ path: String, _ method: HTTPMethod, query: [URLQueryItem] = [], body: [String: String]? = nil, for accountID: AccountID
    ) async throws -> T {
        let request = try NativeBearerRequest(
            path: path,
            method: method,
            queryItems: query,
            headers: try HTTPHeaders(["accept": "application/json", "content-type": "application/json"]),
            body: try body.map { try JSONSerialization.data(withJSONObject: $0) }
        )
        let response = try await sender.send(request, for: accountID)
        guard (200..<300).contains(response.statusCode) else {
            let wire = try? JSONDecoder().decode(ErrorWire.self, from: response.body)
            throw RemotePairingError(
                status: response.statusCode,
                code: wire?.code,
                message: wire?.message ?? wire?.error ?? "Alevr could not finish pairing. Try again."
            )
        }
        return try Self.decoder.decode(T.self, from: response.body)
    }

    private struct StatusWire: Decodable {
        let status: String
        let pair: RemotePair?
    }

    private struct PairsWire: Decodable { let pairs: [RemotePair] }
    private struct ApprovedWire: Decodable { let pair: RemotePair }
    private struct OKWire: Decodable {}
    private struct ErrorWire: Decodable {
        let error: String?
        let message: String?
        let code: String?
    }
}

/// ISO-8601 with or without fractional seconds, as the backend writes them.
public enum RemoteDates {
    public static func parse(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }

    public static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
