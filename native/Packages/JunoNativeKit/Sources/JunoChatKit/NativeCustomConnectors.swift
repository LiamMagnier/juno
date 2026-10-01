import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

// Bring your own MCP server: the native side of `/api/connectors/custom/*`.
//
// A custom server is a connector like any other once it is signed in — the
// directory lists it (kind `custom_mcp`), the composer's picker offers it, the
// approval broker asks before its writes — so ``NativeConnector`` carries it
// as a third ``NativeConnector/Source``. What is new is the two flows around
// it, and they live here: adding one by its address (check, name, sign in)
// and managing one (rename, choose its tools, sign out, remove). Shapes mirror
// `src/components/connections/custom-connector-api.ts` field for field.

// MARK: - Values

/// One tool a custom server offers, as the server last listed it.
public struct NativeCustomConnectorTool: Identifiable, Equatable, Sendable, Decodable {
    /// What the tool does to the world, which is how the manage sheet groups
    /// them: the server's own read-only hint first, Juno's name heuristics as
    /// the fallback — the same split the runtime uses to decide what to ask.
    public enum Access: String, Equatable, Sendable {
        case read
        case write
        case unknown
    }

    public let name: String
    public let title: String?
    public let description: String?
    public let access: Access

    public var id: String { name }

    /// The server's human title when it wrote one, else the tool's own name.
    public var displayName: String {
        guard let title, !title.trimmingCharacters(in: .whitespaces).isEmpty else { return name }
        return title
    }

    public init(name: String, title: String? = nil, description: String? = nil, access: Access) {
        self.name = name
        self.title = title
        self.description = description
        self.access = access
    }

    private enum CodingKeys: String, CodingKey { case name, title, description, access }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        // A value from a newer server is "unknown", which groups with the
        // tools that change things — the cautious side of the split.
        access = (try? container.decodeIfPresent(String.self, forKey: .access))
            .flatMap(Access.init(rawValue:)) ?? .unknown
    }
}

/// One server the reader added: `CustomConnectorView` on the server.
public struct NativeCustomConnector: Identifiable, Equatable, Sendable, Decodable {
    public let id: String
    public var name: String
    public let url: String
    public let host: String
    public let description: String?
    public let serverName: String?
    public var connected: Bool
    public let connectedAt: String?
    public var disabledTools: [String]
    /// Nil until the server has been asked (the first list after sign-in can
    /// time out); an empty list is a server that offers nothing.
    public let tools: [NativeCustomConnectorTool]?
    public let toolsCheckedAt: String?
    public let createdAt: String?

    public init(
        id: String,
        name: String,
        url: String,
        host: String,
        description: String? = nil,
        serverName: String? = nil,
        connected: Bool,
        connectedAt: String? = nil,
        disabledTools: [String] = [],
        tools: [NativeCustomConnectorTool]? = nil,
        toolsCheckedAt: String? = nil,
        createdAt: String? = nil
    ) {
        self.id = id
        self.name = name
        self.url = url
        self.host = host
        self.description = description
        self.serverName = serverName
        self.connected = connected
        self.connectedAt = connectedAt
        self.disabledTools = disabledTools
        self.tools = tools
        self.toolsCheckedAt = toolsCheckedAt
        self.createdAt = createdAt
    }

    /// Tools that only read: Juno uses these as needed.
    public var reads: [NativeCustomConnectorTool] {
        (tools ?? []).filter { $0.access == .read }
    }

    /// Tools that write, or could: Juno asks in the chat before each use.
    public var changes: [NativeCustomConnectorTool] {
        (tools ?? []).filter { $0.access != .read }
    }

    public func isEnabled(_ tool: NativeCustomConnectorTool) -> Bool {
        !disabledTools.contains(tool.name)
    }

    public var enabledCount: Int {
        (tools ?? []).filter(isEnabled).count
    }
}

/// A server that passed the check and can be saved.
public struct NativeCustomConnectorCandidate: Equatable, Sendable {
    /// The canonical address the server settled on — what is saved.
    public let url: String
    public let host: String
    /// Where the reader will sign in, which is often not the server's host.
    public let authHost: String
    public let suggestedName: String
    /// This account already has a server at this address.
    public let existingID: String?
    public let existingName: String?

    public init(
        url: String,
        host: String,
        authHost: String,
        suggestedName: String,
        existingID: String? = nil,
        existingName: String? = nil
    ) {
        self.url = url
        self.host = host
        self.authHost = authHost
        self.suggestedName = suggestedName
        self.existingID = existingID
        self.existingName = existingName
    }

    public var isExisting: Bool { existingID != nil }
}

/// The answer to "is there a server Juno can use at this address?".
public enum NativeCustomConnectorProbe: Equatable, Sendable {
    case ready(NativeCustomConnectorCandidate)
    /// The server's own sentence for why not (no MCP server there, no OAuth,
    /// no dynamic registration, unreachable…), shown verbatim.
    case refused(reason: String, message: String)
}

// MARK: - Paths

/// Where a custom server's routes live.
///
/// Ids are `mcp:<10>`, and the colon travels percent-encoded, exactly as the
/// web's `encodeURIComponent` sends it — the server decodes it either way, but
/// two clients spelling one resource two ways is a difference nobody needs to
/// debug later.
public enum NativeCustomConnectorPath {
    /// `encodeURIComponent`'s unreserved set: everything else is escaped.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    )

    public static func encode(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: unreserved) ?? id
    }

    public static let collection = "/api/connectors/custom"
    public static let probe = "/api/connectors/custom/probe"

    public static func resource(_ id: String) -> String { "\(collection)/\(encode(id))" }
    public static func tools(_ id: String) -> String { "\(resource(id))/tools" }
    public static func connect(_ id: String) -> String { "\(resource(id))/connect" }
    /// Signing out is the shared connector route: it drops the tokens and
    /// keeps the entry.
    public static func signOut(_ id: String) -> String { "/api/connectors/\(encode(id))" }

    /// The sign-in page to open in the reader's browser.
    ///
    /// Built on `percentEncodedPath` rather than `appendingPathComponent`,
    /// which would escape the `%` of the encoded colon a second time.
    public static func connectURL(backend: URL, id: String) -> URL? {
        guard var components = URLComponents(url: backend, resolvingAgainstBaseURL: false) else { return nil }
        let base = components.percentEncodedPath.hasSuffix("/")
            ? String(components.percentEncodedPath.dropLast())
            : components.percentEncodedPath
        components.percentEncodedPath = base + connect(id)
        components.query = nil
        components.fragment = nil
        return components.url
    }

    /// A server's monogram: the first letter or digit of its name, the web's
    /// `monogram()`. "M" for a name with neither.
    public static func monogram(_ name: String) -> String {
        let first = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .first { $0.isLetter || $0.isNumber }
        return first.map { String($0).uppercased() } ?? "M"
    }
}

// MARK: - Client

extension NativeConnectorClient {
    /// Checks an address before anything is saved. A refusal is an answer,
    /// not a failure: the route says why in words with a 200.
    public func probeCustomConnector(
        url: String,
        for accountID: AccountID
    ) async throws -> NativeCustomConnectorProbe {
        let response = try await sendJSON(
            NativeCustomConnectorPath.probe, method: .post, body: ["url": .string(url)], for: accountID
        )
        try requireCustomSuccess(response)
        guard let wire = try? JSONDecoder().decode(ProbeWire.self, from: response.body)
        else { throw NativeConnectorError.malformedResponse }
        if wire.ok,
            let url = wire.url,
            let host = wire.host,
            let authHost = wire.authHost,
            let suggestedName = wire.suggestedName
        {
            return .ready(
                NativeCustomConnectorCandidate(
                    url: url,
                    host: host,
                    authHost: authHost,
                    suggestedName: suggestedName,
                    existingID: wire.existing?.id,
                    existingName: wire.existing?.name
                )
            )
        }
        guard !wire.ok else { throw NativeConnectorError.malformedResponse }
        return .refused(
            reason: wire.reason ?? "unknown",
            message: wire.message ?? Self.checkFailed
        )
    }

    /// Saves a server (the route checks it again) and returns it, not yet
    /// signed in. The same address twice answers with the one already saved.
    public func createCustomConnector(
        url: String,
        name: String,
        for accountID: AccountID
    ) async throws -> (connector: NativeCustomConnector, existing: Bool) {
        let response = try await sendJSON(
            NativeCustomConnectorPath.collection,
            method: .post,
            body: ["url": .string(url), "name": .string(name)],
            for: accountID
        )
        try requireCustomSuccess(response)
        guard let wire = try? JSONDecoder().decode(CreateWire.self, from: response.body)
        else { throw NativeConnectorError.malformedResponse }
        return (wire.connector, wire.existing ?? false)
    }

    public func customConnector(id: String, for accountID: AccountID) async throws -> NativeCustomConnector {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: NativeCustomConnectorPath.resource(id),
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        return try decodeConnector(response)
    }

    /// Renames it, or chooses which of its tools Juno may use. Only what is
    /// passed is sent; the route refuses a PATCH with nothing in it.
    public func updateCustomConnector(
        id: String,
        name: String? = nil,
        disabledTools: [String]? = nil,
        for accountID: AccountID
    ) async throws -> NativeCustomConnector {
        var body: [String: JunoJSONValue] = [:]
        if let name { body["name"] = .string(name) }
        if let disabledTools { body["disabledTools"] = .array(disabledTools.map(JunoJSONValue.string)) }
        let response = try await sendJSON(
            NativeCustomConnectorPath.resource(id), method: .patch, body: body, for: accountID
        )
        return try decodeConnector(response)
    }

    /// Removes the server and signs out of it.
    public func removeCustomConnector(id: String, for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: NativeCustomConnectorPath.resource(id),
                method: .delete,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireCustomSuccess(response)
    }

    /// Asks the server for its tools now; the answer is remembered for the page.
    public func refreshCustomConnectorTools(
        id: String,
        for accountID: AccountID
    ) async throws -> NativeCustomConnector {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: NativeCustomConnectorPath.tools(id),
                method: .post,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        return try decodeConnector(response)
    }

    static let checkFailed = "Juno couldn’t check that server. Try again."

    private func sendJSON(
        _ path: String,
        method: HTTPMethod,
        body: [String: JunoJSONValue],
        for accountID: AccountID
    ) async throws -> HTTPResponse {
        try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: method,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(JunoJSONValue.object(body))
            ),
            for: accountID
        )
    }

    private func decodeConnector(_ response: HTTPResponse) throws -> NativeCustomConnector {
        try requireCustomSuccess(response)
        guard let wire = try? JSONDecoder().decode(ConnectorWire.self, from: response.body)
        else { throw NativeConnectorError.malformedResponse }
        return wire.connector
    }

    /// The route's own sentence when it wrote one. Its bare codes
    /// (`not_found`, `invalid_body`) are not sentences, so those fall back to
    /// the status line rather than being read out.
    private func requireCustomSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let wire = try? JSONDecoder().decode(CustomErrorWire.self, from: response.body)
        let message: String
        if let written = wire?.message, !written.isEmpty {
            message = written
        } else if response.statusCode == 404 {
            message = "This server isn’t in your connections any more."
        } else {
            message = "Something went wrong (\(response.statusCode)). Try again."
        }
        throw NativeConnectorError.server(statusCode: response.statusCode, message: message)
    }
}

private struct ProbeWire: Decodable {
    struct Existing: Decodable {
        let id: String
        let name: String
    }

    let ok: Bool
    let url: String?
    let host: String?
    let authHost: String?
    let suggestedName: String?
    let existing: Existing?
    let reason: String?
    let message: String?
}

private struct CreateWire: Decodable {
    let connector: NativeCustomConnector
    let existing: Bool?
}

private struct CustomErrorWire: Decodable {
    let message: String?
}

private struct ConnectorWire: Decodable {
    let connector: NativeCustomConnector
}

// MARK: - Add

/// Adding a server by its address, in two steps (the web's
/// `AddCustomConnectorDialog`):
///
/// 1. **Address.** Paste a URL; Juno checks it server-side and says why not in
///    the server's words when it can't, instead of saving something that will
///    never work.
/// 2. **Ready.** The server's name (editable), where the reader will sign in,
///    and Continue — which saves it and hands back the connector whose sign-in
///    page to open.
///
/// Nothing is saved until Continue.
@MainActor
@Observable
public final class NativeCustomConnectorDraft: Identifiable {
    /// One add flow, for a sheet to present by identity.
    public nonisolated let id = UUID()

    public enum Step: Equatable, Sendable {
        case address
        case ready(NativeCustomConnectorCandidate)
    }

    public static let nameLimit = 60

    /// Editing the address clears a refusal about the previous one.
    public var address = "" {
        didSet {
            guard address != oldValue, refusal != nil, step == .address else { return }
            refusal = nil
        }
    }

    public var name = "" {
        didSet {
            if name.count > Self.nameLimit { name = String(name.prefix(Self.nameLimit)) }
        }
    }

    public private(set) var step: Step = .address
    public private(set) var isChecking = false
    /// True from Continue until the sign-in page opens — and it stays true
    /// on success, because the reader is leaving for the browser.
    public private(set) var isCreating = false
    /// Why the address or the save was refused, in the server's words.
    public private(set) var refusal: String?

    private let client: NativeConnectorClient
    private let accountID: AccountID

    public init(client: NativeConnectorClient, accountID: AccountID) {
        self.client = client
        self.accountID = accountID
    }

    private var trimmedAddress: String {
        address.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var canCheck: Bool { !trimmedAddress.isEmpty && !isChecking }

    public var candidate: NativeCustomConnectorCandidate? {
        if case .ready(let candidate) = step { return candidate }
        return nil
    }

    public var canContinue: Bool {
        candidate != nil && !isCreating
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The host being checked, for the "Looking for a server at…" line — the
    /// wait names what it is waiting on.
    public var checkingHost: String {
        let text = trimmedAddress
        let withScheme = text.range(of: "://") == nil ? "https://\(text)" : text
        return URLComponents(string: withScheme)?.host.flatMap { $0.isEmpty ? nil : $0 } ?? text
    }

    public func check() async {
        let value = trimmedAddress
        guard !value.isEmpty, !isChecking else { return }
        isChecking = true
        refusal = nil
        defer { isChecking = false }
        do {
            switch try await client.probeCustomConnector(url: value, for: accountID) {
            case .refused(_, let message):
                refusal = message
            case .ready(let candidate):
                name = candidate.existingName ?? candidate.suggestedName
                step = .ready(candidate)
            }
        } catch let error as NativeConnectorError {
            refusal = error.errorDescription ?? NativeConnectorClient.checkFailed
        } catch {
            refusal = NativeConnectorClient.checkFailed
        }
    }

    public func back() {
        guard !isCreating else { return }
        refusal = nil
        step = .address
    }

    /// Saves the server and returns it, for the caller to open its sign-in.
    /// Nil when it was refused; ``refusal`` says why and nothing was saved.
    public func create() async -> NativeCustomConnector? {
        guard let candidate, !isCreating else { return nil }
        isCreating = true
        refusal = nil
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let result = try await client.createCustomConnector(
                url: candidate.url,
                name: trimmed.isEmpty ? candidate.suggestedName : trimmed,
                for: accountID
            )
            return result.connector
        } catch {
            isCreating = false
            refusal = (error as? NativeConnectorError)?.errorDescription
                ?? "Couldn’t add that server. Nothing was saved."
            return nil
        }
    }
}

// MARK: - Manage

/// One added server, managed (the web's `CustomConnectorDialog`): its name,
/// whether Juno is signed in, and the tools Juno may use, one switch each.
///
/// Changes are applied locally first and rolled back when the save fails, so
/// a switch answers the click rather than the round trip. Each method returns
/// the sentence to show when it failed, nil when it worked.
@MainActor
@Observable
public final class NativeCustomConnectorEditor: Identifiable {
    public nonisolated let id: String
    public private(set) var connector: NativeCustomConnector?
    /// The server couldn't be read at all.
    public private(set) var loadError: String?
    public private(set) var isRefreshing = false
    /// Why the tools couldn't be listed, while they have never been listed.
    public private(set) var toolsError: String?
    public private(set) var isSigningOut = false
    public private(set) var isRemoving = false

    private let client: NativeConnectorClient
    private let accountID: AccountID
    private let changed: @MainActor () async -> Void

    public init(
        id: String,
        client: NativeConnectorClient,
        accountID: AccountID,
        changed: @escaping @MainActor () async -> Void = {}
    ) {
        self.id = id
        self.client = client
        self.accountID = accountID
        self.changed = changed
    }

    public func load() async {
        do {
            let loaded = try await client.customConnector(id: id, for: accountID)
            connector = loaded
            loadError = nil
            // Never listed (the first list after sign-in timed out): ask now.
            if loaded.connected, loaded.tools == nil {
                await refreshTools()
            }
        } catch {
            if connector == nil {
                loadError = (error as? NativeConnectorError)?.errorDescription
                    ?? "Couldn’t load this server."
            }
        }
    }

    @discardableResult
    public func refreshTools() async -> String? {
        guard !isRefreshing else { return nil }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            connector = try await client.refreshCustomConnectorTools(id: id, for: accountID)
            toolsError = nil
            await changed()
            return nil
        } catch {
            let message = (error as? NativeConnectorError)?.errorDescription
                ?? "Couldn’t reach the server."
            if connector?.tools == nil { toolsError = message }
            return message
        }
    }

    /// Switches tools on or off together — one switch, or a whole group's
    /// "Turn all on".
    @discardableResult
    public func setTools(_ names: [String], enabled: Bool) async -> String? {
        guard var next = connector else { return nil }
        var disabled = next.disabledTools
        for name in names {
            if enabled {
                disabled.removeAll { $0 == name }
            } else if !disabled.contains(name) {
                disabled.append(name)
            }
        }
        guard disabled != next.disabledTools else { return nil }
        let before = next
        next.disabledTools = disabled
        connector = next
        return await save(rollback: before) {
            try await self.client.updateCustomConnector(id: self.id, disabledTools: disabled, for: self.accountID)
        }
    }

    @discardableResult
    public func rename(_ value: String) async -> String? {
        guard var next = connector else { return nil }
        let trimmed = String(
            value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(NativeCustomConnectorDraft.nameLimit)
        )
        guard !trimmed.isEmpty, trimmed != next.name else { return nil }
        let before = next
        next.name = trimmed
        connector = next
        return await save(rollback: before) {
            try await self.client.updateCustomConnector(id: self.id, name: trimmed, for: self.accountID)
        }
    }

    /// Drops Juno's sign-in and keeps the server, so it can sign in again.
    @discardableResult
    public func signOut() async -> String? {
        guard let current = connector, !isSigningOut else { return nil }
        isSigningOut = true
        defer { isSigningOut = false }
        do {
            try await client.disconnect(
                NativeConnector(
                    id: current.id, source: .custom, kind: "custom_mcp",
                    label: current.name, detail: "", connected: true
                ),
                for: accountID
            )
            connector?.connected = false
            await changed()
            return nil
        } catch {
            return (error as? NativeConnectorError)?.errorDescription
                ?? "Couldn’t sign out. Try again."
        }
    }

    /// Removes the server and signs out of it. Nil when it is gone.
    @discardableResult
    public func remove() async -> String? {
        guard !isRemoving else { return nil }
        isRemoving = true
        do {
            try await client.removeCustomConnector(id: id, for: accountID)
            await changed()
            return nil
        } catch {
            isRemoving = false
            return (error as? NativeConnectorError)?.errorDescription
                ?? "Couldn’t remove it. Try again."
        }
    }

    private func save(
        rollback: NativeCustomConnector,
        _ request: @escaping () async throws -> NativeCustomConnector
    ) async -> String? {
        do {
            connector = try await request()
            await changed()
            return nil
        } catch {
            connector = rollback
            return (error as? NativeConnectorError)?.errorDescription
                ?? "Couldn’t save that change."
        }
    }
}
