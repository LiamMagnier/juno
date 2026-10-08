import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

// MARK: - Wire types

/// A standing approval: an action the person chose to let run without asking
/// (`GET /api/approvals/grants` → `{ grants }`, the rows the tool broker honours).
public struct NativeStandingGrant: Identifiable, Equatable, Sendable {
    public let id: String
    public let connectorID: String
    /// Set when the grant holds in one project only.
    public let projectID: String?
    public let toolName: String
    /// The action, in words the broker wrote for a reader.
    public let action: String
    public let maxRiskClass: String?
    public let createdAt: Date?

    public init(
        id: String,
        connectorID: String,
        projectID: String? = nil,
        toolName: String,
        action: String,
        maxRiskClass: String? = nil,
        createdAt: Date? = nil
    ) {
        self.id = id
        self.connectorID = connectorID
        self.projectID = projectID
        self.toolName = toolName
        self.action = action
        self.maxRiskClass = maxRiskClass
        self.createdAt = createdAt
    }

    /// "Allowed in one project" or "Allowed everywhere", as the app sheet says.
    public var scopeLine: String { projectID == nil ? "Allowed everywhere" : "Allowed in one project" }
}

/// When an app was last used (`GET /api/connectors/usage` → `{ usage }`, keyed
/// by connector id; the web's `ConnectorUsage`).
public struct NativeConnectorUsage: Equatable, Sendable {
    public let at: Date
    public let toolName: String
    public let access: String
    /// The chat it was used in, when that chat is still the person's.
    public let conversationID: String?
    public let conversationTitle: String?

    public init(at: Date, toolName: String, access: String = "read", conversationID: String? = nil, conversationTitle: String? = nil) {
        self.at = at
        self.toolName = toolName
        self.access = access
        self.conversationID = conversationID
        self.conversationTitle = conversationTitle
    }

    /// "Today at 14:05", "Yesterday at 09:12", "3 October at 18:40"
    /// (`usedWhen` in `app-detail-sheet.tsx`).
    public func when(now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        let time = Self.format(at, "HH:mm", calendar: calendar, locale: locale, template: true)
        let days = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: at), to: calendar.startOfDay(for: now)
        ).day ?? 0
        if days <= 0 { return "Today at \(time)" }
        if days == 1 { return "Yesterday at \(time)" }
        let sameYear = calendar.component(.year, from: at) == calendar.component(.year, from: now)
        let date = Self.format(at, sameYear ? "dMMMM" : "dMMMMy", calendar: calendar, locale: locale, template: true)
        return "\(date) at \(time)"
    }

    /// "Today at 14:05, gmail_send in Weekly plan" — the sheet's one line.
    public func line(now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        var text = "\(when(now: now, calendar: calendar, locale: locale)), \(toolName)"
        if conversationID != nil {
            let title = conversationTitle.flatMap { $0.isEmpty ? nil : $0 } ?? "a chat"
            text += " in \(title)"
        }
        return text
    }

    private static func format(_ date: Date, _ pattern: String, calendar: Calendar, locale: Locale, template: Bool) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        if template {
            formatter.setLocalizedDateFormatFromTemplate(pattern)
        } else {
            formatter.dateFormat = pattern
        }
        return formatter.string(from: date)
    }
}

public struct NativeAppAccessError: Error, Equatable, Sendable {
    public let statusCode: Int
}

// MARK: - Client

/// The two reads an app's detail sheet makes and the one write it offers:
/// standing approvals and their revocation, and each app's last use.
public struct NativeAppAccessClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func grants(for accountID: AccountID) async throws -> [NativeStandingGrant] {
        let root = try await object(.get, "/api/approvals/grants", for: accountID)
        return Self.decodeGrants(root)
    }

    /// Back to Ask first. A 404 means it is already gone, which is the outcome
    /// asked for.
    public func revokeGrant(id: String, for accountID: AccountID) async throws {
        try NativeMemoryClient.validate(id)
        let response = try await send(.delete, "/api/approvals/grants/\(id)", for: accountID)
        if response.statusCode == 404 { return }
        guard (200...299).contains(response.statusCode) else {
            throw NativeAppAccessError(statusCode: response.statusCode)
        }
    }

    public func usage(for accountID: AccountID) async throws -> [String: NativeConnectorUsage] {
        let root = try await object(.get, "/api/connectors/usage", for: accountID)
        return Self.decodeUsage(root)
    }

    // MARK: Transport

    private func send(_ method: HTTPMethod, _ path: String, for accountID: AccountID) async throws -> HTTPResponse {
        try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: method,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
    }

    private func object(_ method: HTTPMethod, _ path: String, for accountID: AccountID) async throws -> [String: JunoJSONValue] {
        let response = try await send(method, path, for: accountID)
        guard (200...299).contains(response.statusCode) else {
            throw NativeAppAccessError(statusCode: response.statusCode)
        }
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body),
            case .object(let root) = value
        else { throw NativeAppAccessError(statusCode: 0) }
        return root
    }

    // MARK: Decoding

    static func decodeGrants(_ root: [String: JunoJSONValue]) -> [NativeStandingGrant] {
        guard case .array(let values)? = root["grants"] else { return [] }
        return values.compactMap { value in
            guard case .object(let object) = value,
                let id = object["id"]?.stringValue,
                let connectorID = object["connectorId"]?.stringValue
            else { return nil }
            let toolName = object["toolName"]?.stringValue ?? ""
            return NativeStandingGrant(
                id: id,
                connectorID: connectorID,
                projectID: object["projectId"]?.stringValue,
                toolName: toolName,
                action: object["action"]?.stringValue ?? toolName,
                maxRiskClass: object["maxRiskClass"]?.stringValue,
                createdAt: object["createdAt"]?.date
            )
        }
    }

    static func decodeUsage(_ root: [String: JunoJSONValue]) -> [String: NativeConnectorUsage] {
        guard case .object(let entries)? = root["usage"] else { return [:] }
        var usage: [String: NativeConnectorUsage] = [:]
        for (connectorID, value) in entries {
            guard case .object(let object) = value,
                let at = object["at"]?.date,
                let toolName = object["toolName"]?.stringValue
            else { continue }
            usage[connectorID] = NativeConnectorUsage(
                at: at,
                toolName: toolName,
                access: object["access"]?.stringValue ?? "read",
                conversationID: object["conversationId"]?.stringValue,
                conversationTitle: object["conversationTitle"]?.stringValue
            )
        }
        return usage
    }
}

// MARK: - Model

/// One app's details: status, last used, what may run without asking (with
/// revocation back to Ask first), and the way to disconnect
/// (`app-detail-sheet.tsx`). Every line is a real server state.
@MainActor
@Observable
public final class NativeAppDetailModel {
    public enum Loadable<Value: Equatable & Sendable>: Equatable, Sendable {
        case loading
        case loaded(Value)
    }

    public let connector: NativeConnector
    /// This app's standing grants; nil while loading.
    public private(set) var grants: [NativeStandingGrant]?
    /// `.loaded(nil)` is "Alevr hasn't used it yet".
    public private(set) var usage: Loadable<NativeConnectorUsage?> = .loading
    public private(set) var revokingID: String?
    public private(set) var grantError: String?

    private let client: NativeAppAccessClient
    private let accountID: AccountID

    public init(connector: NativeConnector, client: NativeAppAccessClient, accountID: AccountID) {
        self.connector = connector
        self.client = client
        self.accountID = accountID
    }

    /// The ids a grant or a usage row may carry for this app: its own id, and
    /// for a catalog app its slug and `composio:<slug>` (the web's `matches`).
    public nonisolated static func identifiers(for connector: NativeConnector) -> Set<String> {
        var ids: Set<String> = [connector.id]
        if let slug = connector.slug {
            ids.insert(slug)
            ids.insert("composio:\(slug)")
        }
        return ids
    }

    public func load() async {
        grantError = nil
        let ids = Self.identifiers(for: connector)
        async let grantList = try? client.grants(for: accountID)
        async let usageMap = try? client.usage(for: accountID)
        let (loadedGrants, loadedUsage) = await (grantList, usageMap)
        grants = (loadedGrants ?? []).filter { ids.contains($0.connectorID) }
        let map = loadedUsage ?? [:]
        let match = map[connector.id] ?? connector.slug.flatMap { map[$0] ?? map["composio:\($0)"] }
        usage = .loaded(match)
    }

    /// Sets one action back to Ask first.
    public func revoke(_ grant: NativeStandingGrant) async {
        guard revokingID == nil else { return }
        revokingID = grant.id
        grantError = nil
        defer { revokingID = nil }
        do {
            try await client.revokeGrant(id: grant.id, for: accountID)
            grants?.removeAll { $0.id == grant.id }
        } catch {
            grantError = "Couldn’t change that. It still runs without asking; try again."
        }
    }

    /// What disconnecting costs, in the sheet's footer.
    public var consequence: String {
        "Alevr loses access at once. Nothing in \(connector.label) is deleted."
    }

    /// Puts the sheet in a known state for previews and snapshots.
    public func preview(grants: [NativeStandingGrant], usage: NativeConnectorUsage?) {
        self.grants = grants
        self.usage = .loaded(usage)
    }
}

extension NativeConnectorModel {
    /// The detail model for one app, over this model's transport and account;
    /// nil before the screen has an account.
    public func makeAppDetailModel(for connector: NativeConnector) -> NativeAppDetailModel? {
        guard let accountID = currentAccountID else { return nil }
        return NativeAppDetailModel(
            connector: connector,
            client: NativeAppAccessClient(sender: client.sender),
            accountID: accountID
        )
    }
}
