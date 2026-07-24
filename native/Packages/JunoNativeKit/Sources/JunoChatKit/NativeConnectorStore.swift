import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// One app Juno can act through.
///
/// Juno has two connector backends — a handful of first-party integrations with
/// their own OAuth/credential flow, and Composio's managed catalog of hundreds of
/// apps — and this type deliberately flattens them into one. The website learned
/// the same lesson: rendering them as two sections made the page look broken
/// whenever Composio was unconfigured, and forced the reader to understand an
/// implementation detail to find an app.
public struct NativeConnector: Identifiable, Equatable, Sendable {
    public enum Source: String, Equatable, Sendable {
        case native
        case composio
    }

    /// `"github"` for a first-party connector, `"composio:gmail"` for a catalog
    /// app. Unique across both backends, which is why it is the identity.
    public let id: String
    /// The Composio toolkit slug, needed to address its own endpoints.
    public let slug: String?
    public let source: Source
    /// `oauth_app` · `mcp_oauth` · `credentials` · `composio_app`.
    public let kind: String
    public let label: String
    public let detail: String
    public let logoURL: URL?
    public var connected: Bool
    /// First-party only: false when this server has no OAuth app configured for
    /// the connector, so Connect cannot work and must not be offered.
    public let configured: Bool
    /// Composio only: false when Composio hosts no OAuth app for the toolkit.
    /// Connect would 400 with "Composio does not manage auth for toolkit …", so
    /// the row says so instead of offering a button that always fails.
    public let managedAuth: Bool
    public var accountLabel: String?
    /// Curated categories this connector belongs to. Composio items carry none
    /// in the list payload — the catalog is filtered server-side instead — so
    /// this is populated only for the first-party set.
    public let categories: [String]

    public init(
        id: String,
        slug: String? = nil,
        source: Source,
        kind: String,
        label: String,
        detail: String,
        logoURL: URL? = nil,
        connected: Bool,
        configured: Bool = true,
        managedAuth: Bool = true,
        accountLabel: String? = nil,
        categories: [String] = []
    ) {
        self.id = id
        self.slug = slug
        self.source = source
        self.kind = kind
        self.label = label
        self.detail = detail
        self.logoURL = logoURL
        self.connected = connected
        self.configured = configured
        self.managedAuth = managedAuth
        self.accountLabel = accountLabel
        self.categories = categories
    }

    /// Whether Connect can plausibly succeed right now. A row that cannot
    /// connect still appears — hiding it would leave the reader hunting for an
    /// app that exists — but it says why instead of offering a dead button.
    public var canConnect: Bool {
        source == .native ? configured : managedAuth
    }

    /// The reason Connect is unavailable, or nil when it is available.
    public var blockedReason: String? {
        if connected { return nil }
        if source == .native, !configured {
            return String(localized: "connections.blocked.not-configured")
        }
        if source == .composio, !managedAuth {
            return String(localized: "connections.blocked.no-auth-config")
        }
        return nil
    }
}

public struct NativeConnectorCategory: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let count: Int?

    public init(id: String, label: String, count: Int?) {
        self.id = id
        self.label = label
        self.count = count
    }
}

public enum NativeConnectorError: Error, Equatable, LocalizedError, Sendable {
    case malformedResponse
    case composioUnconfigured
    case server(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .malformedResponse: String(localized: "connections.error.malformed")
        case .composioUnconfigured: String(localized: "connections.error.composio-off")
        case .server(_, let message): message
        }
    }
}

/// Reads and changes the account's connections through the same routes the web
/// dashboard uses. They are all `getCurrentUser()`-authenticated, so a native
/// bearer works on every one of them without a parallel v1 surface.
public struct NativeConnectorClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// The first-party connectors plus the catalog apps already linked.
    public func connectors(
        for accountID: AccountID
    ) async throws -> (connectors: [NativeConnector], composioConfigured: Bool) {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/connectors",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        guard let wire = try? JSONDecoder().decode(ConnectorListWire.self, from: response.body)
        else { throw NativeConnectorError.malformedResponse }

        let connectors = wire.connectors.map { item -> NativeConnector in
            let isComposio = item.kind == "composio_app"
            let slug = isComposio ? String(item.id.dropFirst("composio:".count)) : nil
            return NativeConnector(
                id: item.id,
                slug: slug,
                source: isComposio ? .composio : .native,
                kind: item.kind,
                label: item.label,
                detail: item.capability ?? item.description ?? "",
                connected: item.connected,
                configured: item.configured,
                accountLabel: item.accountLabel,
                categories: NativeConnectorCatalog.nativeCategories[item.id] ?? []
            )
        }
        return (connectors, wire.composioConfigured ?? false)
    }

    /// One page of the Composio directory.
    public func catalog(
        query: String,
        category: String?,
        cursor: String?,
        connectedOnly: Bool,
        for accountID: AccountID
    ) async throws -> (
        items: [NativeConnector], cursor: String?, categories: [NativeConnectorCategory]
    ) {
        var items: [URLQueryItem] = []
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { items.append(URLQueryItem(name: "q", value: String(trimmed.prefix(100)))) }
        if let category, !category.isEmpty { items.append(URLQueryItem(name: "category", value: category)) }
        if let cursor, !cursor.isEmpty { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        if connectedOnly { items.append(URLQueryItem(name: "connected", value: "1")) }

        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/connectors/composio/catalog",
                queryItems: items,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        // 503 is the honest "this server has no Composio credentials" answer, not
        // a failure to report as one.
        if response.statusCode == 503 { throw NativeConnectorError.composioUnconfigured }
        try requireSuccess(response)
        guard let wire = try? JSONDecoder().decode(CatalogWire.self, from: response.body)
        else { throw NativeConnectorError.malformedResponse }

        return (
            wire.items.map { item in
                NativeConnector(
                    id: "composio:\(item.slug)",
                    slug: item.slug,
                    source: .composio,
                    kind: "composio_app",
                    label: item.name.isEmpty ? NativeConnectorCatalog.titleize(item.slug) : item.name,
                    detail: String(
                        format: String(localized: "connections.composio.detail"),
                        item.name.isEmpty ? NativeConnectorCatalog.titleize(item.slug) : item.name
                    ),
                    logoURL: item.logo.flatMap(URL.init(string:)),
                    connected: item.connected,
                    managedAuth: item.managedAuth || item.noAuth,
                    accountLabel: nil
                )
            },
            wire.cursor,
            (wire.categories ?? []).map {
                NativeConnectorCategory(id: $0.id, label: $0.label, count: $0.count)
            }
        )
    }

    public func disconnect(_ connector: NativeConnector, for accountID: AccountID) async throws {
        let path: String
        switch connector.source {
        case .native:
            path = "/api/connectors/\(connector.id)"
        case .composio:
            guard let slug = connector.slug else { throw NativeConnectorError.malformedResponse }
            path = "/api/connectors/composio/\(slug)"
        }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: .delete,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let message = (try? JSONDecoder().decode(ErrorWire.self, from: response.body))?.message
            ?? (try? JSONDecoder().decode(ErrorWire.self, from: response.body))?.error
            ?? String(
                format: String(localized: "connections.error.status"), response.statusCode
            )
        throw NativeConnectorError.server(statusCode: response.statusCode, message: message)
    }
}

/// Static catalog knowledge shared with the web directory.
public enum NativeConnectorCatalog {
    /// First-party connectors carry no Composio categories, so without this they
    /// would vanish the moment any category is picked — including Notion under
    /// "Productivity", the one place a reader would most expect to find it. Ids
    /// match the curated set in `src/lib/composio.ts`.
    public static let nativeCategories: [String: [String]] = [
        "github": ["developer-tools"],
        "figma": ["images-&-design"],
        "notion": ["productivity", "documents"],
        "apple-calendar": ["calendar"],
        "apple-mail": ["email"],
        "apple-music": ["video-&-audio"],
    ]

    /// Composio toolkit slugs that duplicate a first-party connector. The
    /// first-party one wins: it has a dedicated MCP endpoint and a richer
    /// permission flow, and two rows for GitHub is just a question the reader
    /// has to answer for no reason.
    public static let nativeEquivalents: Set<String> = ["github", "figma", "notion"]

    public static func titleize(_ slug: String) -> String {
        slug.split(whereSeparator: { $0 == "-" || $0 == "_" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

// MARK: - Model

/// Drives the Connections screen.
@MainActor
@Observable
public final class NativeConnectorModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed
    }

    public private(set) var phase: Phase = .idle
    /// The first-party connectors and every catalog app already linked.
    public private(set) var linked: [NativeConnector] = []
    /// The current page of the Composio directory.
    public private(set) var catalog: [NativeConnector] = []
    public private(set) var categories: [NativeConnectorCategory] = []
    public private(set) var composioConfigured = false
    public private(set) var catalogCursor: String?
    public private(set) var isLoadingCatalog = false
    public private(set) var isMutating = false
    public private(set) var lastErrorDescription: String?
    /// Non-nil while Composio is configured but its catalog could not be read.
    /// Kept separate from `lastErrorDescription` so a catalog outage never hides
    /// the connectors that *are* working.
    public private(set) var catalogErrorDescription: String?

    public var query = "" {
        didSet { guard query != oldValue else { return }; scheduleCatalogReload() }
    }

    public var selectedCategory: String? {
        didSet { guard selectedCategory != oldValue else { return }; reloadCatalogNow() }
    }

    public var showsConnectedOnly = false {
        didSet { guard showsConnectedOnly != oldValue else { return }; reloadCatalogNow() }
    }

    private let client: NativeConnectorClient
    private var accountID: AccountID?
    private var searchTask: Task<Void, Never>?
    private var catalogTask: Task<Void, Never>?

    public init(client: NativeConnectorClient) {
        self.client = client
    }

    public func start(for accountID: AccountID) async {
        guard self.accountID != accountID else {
            await refresh()
            return
        }
        stop()
        self.accountID = accountID
        phase = .loading
        await refresh()
    }

    public func stop() {
        searchTask?.cancel()
        catalogTask?.cancel()
        searchTask = nil
        catalogTask = nil
        accountID = nil
        linked = []
        catalog = []
        categories = []
        catalogCursor = nil
        composioConfigured = false
        lastErrorDescription = nil
        catalogErrorDescription = nil
        query = ""
        selectedCategory = nil
        showsConnectedOnly = false
        phase = .idle
    }

    /// Everything the screen shows, first-party first, then the catalog page with
    /// duplicates of a first-party connector dropped.
    public var visibleConnectors: [NativeConnector] {
        let linkedIDs = Set(linked.map(\.id))
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let first = linked.filter { connector in
            if showsConnectedOnly, !connector.connected { return false }
            if let selectedCategory, !connector.categories.contains(selectedCategory) {
                return false
            }
            if !trimmed.isEmpty, !connector.label.lowercased().contains(trimmed) { return false }
            return true
        }
        let rest = catalog.filter { item in
            guard !linkedIDs.contains(item.id) else { return false }
            guard let slug = item.slug else { return true }
            return !NativeConnectorCatalog.nativeEquivalents.contains(slug)
        }
        return first + rest
    }

    public var connectedCount: Int { linked.filter(\.connected).count }

    public func refresh() async {
        guard let accountID else { return }
        do {
            let result = try await client.connectors(for: accountID)
            guard self.accountID == accountID else { return }
            linked = result.connectors
            composioConfigured = result.composioConfigured
            lastErrorDescription = nil
            phase = .ready
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
            phase = linked.isEmpty ? .failed : .ready
        }
        if composioConfigured { reloadCatalogNow() }
    }

    public func disconnect(_ connector: NativeConnector) async {
        guard let accountID else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await client.disconnect(connector, for: accountID)
            guard self.accountID == accountID else { return }
            // Applied locally as well as refetched: the Composio disconnect can
            // take a second, and a row that stays "Connected" until the refetch
            // lands reads as the tap having done nothing.
            apply(connected: false, to: connector.id)
            await refresh()
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    /// Called when the connect flow's browser sheet closes. The result is not
    /// knowable from the sheet — the reader may have completed it, cancelled, or
    /// bounced off a provider error — so the state is re-read rather than assumed.
    public func connectFlowFinished() async {
        await refresh()
    }

    public func loadMoreCatalog() {
        guard composioConfigured, catalogCursor != nil, !isLoadingCatalog else { return }
        loadCatalog(reset: false)
    }

    private func scheduleCatalogReload() {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled else { return }
            self?.reloadCatalogNow()
        }
    }

    private func reloadCatalogNow() {
        guard composioConfigured else { return }
        loadCatalog(reset: true)
    }

    private func loadCatalog(reset: Bool) {
        guard let accountID else { return }
        catalogTask?.cancel()
        let cursor = reset ? nil : catalogCursor
        if reset { catalogCursor = nil }
        isLoadingCatalog = true
        catalogTask = Task { [weak self] in
            guard let self else { return }
            do {
                let page = try await client.catalog(
                    query: query,
                    category: selectedCategory,
                    cursor: cursor,
                    connectedOnly: showsConnectedOnly,
                    for: accountID
                )
                guard !Task.isCancelled, self.accountID == accountID else { return }
                catalog = reset ? page.items : catalog + page.items
                catalogCursor = page.cursor
                if !page.categories.isEmpty { categories = page.categories }
                catalogErrorDescription = nil
            } catch is CancellationError {
                return
            } catch NativeConnectorError.composioUnconfigured {
                guard !Task.isCancelled, self.accountID == accountID else { return }
                composioConfigured = false
                catalog = []
                catalogErrorDescription = nil
            } catch {
                guard !Task.isCancelled, self.accountID == accountID else { return }
                if reset { catalog = [] }
                catalogErrorDescription = NativeFailureMessage.presentable(error)
            }
            isLoadingCatalog = false
        }
    }

    private func apply(connected: Bool, to id: String) {
        if let index = linked.firstIndex(where: { $0.id == id }) {
            linked[index].connected = connected
            if !connected { linked[index].accountLabel = nil }
        }
        if let index = catalog.firstIndex(where: { $0.id == id }) {
            catalog[index].connected = connected
        }
    }
}

// MARK: - Wire

private struct ConnectorListWire: Decodable {
    struct Item: Decodable {
        let id: String
        let kind: String
        let label: String
        let description: String?
        let capability: String?
        let configured: Bool
        let connected: Bool
        let accountLabel: String?
    }

    let connectors: [Item]
    let composioConfigured: Bool?
}

private struct CatalogWire: Decodable {
    struct Item: Decodable {
        let slug: String
        let name: String
        let logo: String?
        let connected: Bool
        let noAuth: Bool
        let managedAuth: Bool
    }

    struct Category: Decodable {
        let id: String
        let label: String
        let count: Int?
    }

    let items: [Item]
    let cursor: String?
    let categories: [Category]?
}

private struct ErrorWire: Decodable {
    let error: String?
    let message: String?
}
