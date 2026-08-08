import Foundation
import JunoCore

/// The risk class the server assigned to a connector action.
///
/// The server is authoritative here. Unknown values deliberately fall back to
/// `.unknown` and the card keeps the most cautious copy rather than guessing
/// that a new class is harmless.
public enum NativeChatApprovalRiskClass: String, Codable, Equatable, Sendable {
    case readOnly = "read_only"
    case reversibleWrite = "reversible_write"
    case externalWrite = "external_write"
    case destructiveOrSensitive = "destructive_or_sensitive"
    case unknown
}

public enum NativeChatApprovalStatus: String, Codable, Equatable, Sendable {
    case pending
    case allowed
    case denied
    case executing
    case executed
    case failed
    case expired
    case superseded
    case blocked
}

public enum NativeChatApprovalDecision: String, Codable, Equatable, Sendable {
    case allowOnce = "allow_once"
    case allowScope = "allow_scope"
    case deny
}

/// The server's redacted, digest-bound projection of one connector action.
///
/// `detail` is intentionally structured rather than flattened into a sentence:
/// the user must be able to inspect the exact safe arguments the digest covers.
/// Credentials and other sensitive values have already been removed server-side
/// before this object crosses the wire.
public struct NativeChatApproval: Identifiable, Equatable, Sendable {
    public let id: String
    public let surface: String
    public let sessionID: String
    public let conversationID: String?
    public let connectorID: String
    public let connectorLabel: String
    public let toolName: String
    public let action: String
    public let riskClass: NativeChatApprovalRiskClass
    public let preview: String
    public let detail: [String: JunoJSONValue]
    public let receiptDigest: String
    public let status: NativeChatApprovalStatus
    /// The server's stored decision, including policy decisions. It is kept as
    /// a string because the receipt has more values than the three user buttons.
    public let decision: String?
    public let canAllowScope: Bool
    public let derivedFromUntrusted: Bool
    public let expiresAt: Date
    public let decidedAt: Date?
    public let completedAt: Date?
    public let createdAt: Date

    public var isPending: Bool { status == .pending }

    public init(
        id: String,
        surface: String,
        sessionID: String,
        conversationID: String?,
        connectorID: String,
        connectorLabel: String,
        toolName: String,
        action: String,
        riskClass: NativeChatApprovalRiskClass,
        preview: String,
        detail: [String: JunoJSONValue],
        receiptDigest: String,
        status: NativeChatApprovalStatus,
        decision: String?,
        canAllowScope: Bool,
        derivedFromUntrusted: Bool,
        expiresAt: Date,
        decidedAt: Date?,
        completedAt: Date?,
        createdAt: Date
    ) {
        self.id = id
        self.surface = surface
        self.sessionID = sessionID
        self.conversationID = conversationID
        self.connectorID = connectorID
        self.connectorLabel = connectorLabel
        self.toolName = toolName
        self.action = action
        self.riskClass = riskClass
        self.preview = preview
        self.detail = detail
        self.receiptDigest = receiptDigest
        self.status = status
        self.decision = decision
        self.canAllowScope = canAllowScope
        self.derivedFromUntrusted = derivedFromUntrusted
        self.expiresAt = expiresAt
        self.decidedAt = decidedAt
        self.completedAt = completedAt
        self.createdAt = createdAt
    }

    /// Deterministic, readable JSON for the disclosure on the native card.
    /// The values are already redacted by the server; this formatter does not
    /// reinterpret or hide them a second time.
    public var prettyDetail: String {
        guard !detail.isEmpty,
            let data = try? JSONEncoder.withPrettySortedKeys.encode(detail),
            let string = String(data: data, encoding: .utf8)
        else { return "{}" }
        return string
    }
}

private extension JSONEncoder {
    static let withPrettySortedKeys: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}
