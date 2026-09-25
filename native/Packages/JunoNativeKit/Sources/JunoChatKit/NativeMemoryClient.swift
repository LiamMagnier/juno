import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

// MARK: - Wire types

/// One remembered row, as `GET /api/memory` sends it (the web's `Memory`,
/// `src/components/memory/memory-model.ts`).
///
/// Read directly from the route rather than from the synced `memory` records,
/// because Memory v2 put the fields the page is built on — the topic, the
/// lifecycle status, the project a fact is filed in, the sensitive subject —
/// on the route and not on the sync entity. `category` and `status` stay
/// strings for the reason the web gives: a row from an older build has no
/// category, and a row from a newer one may carry a value this build has never
/// heard of; both render, neither crashes.
public struct NativeMemoryFact: Identifiable, Equatable, Sendable {
    public let id: String
    public var content: String
    /// `AUTO` or `MANUAL`.
    public let source: String
    /// `FACT` is remembered; `SUPPRESSION` is the never-remember list.
    public let kind: String
    /// A conversation id, or `manual`, `edit`, `forget`, `import`.
    public let sourceRef: String?
    public let createdAt: Date
    public var category: String?
    public var projectID: String?
    public var projectName: String?
    public let sourceMessageID: String?
    public let confidence: Double
    public var status: String
    public var reason: String?
    public let expiresAt: Date?
    public let lastUsedAt: Date?
    public let lastVerifiedAt: Date?
    public let supersededByID: String?
    /// The sensitive subject the server computed from the content, or nil.
    public let sensitive: String?

    public init(
        id: String,
        content: String,
        source: String = "AUTO",
        kind: String = "FACT",
        sourceRef: String? = nil,
        createdAt: Date,
        category: String? = nil,
        projectID: String? = nil,
        projectName: String? = nil,
        sourceMessageID: String? = nil,
        confidence: Double = 0.8,
        status: String = "active",
        reason: String? = nil,
        expiresAt: Date? = nil,
        lastUsedAt: Date? = nil,
        lastVerifiedAt: Date? = nil,
        supersededByID: String? = nil,
        sensitive: String? = nil
    ) {
        self.id = id
        self.content = content
        self.source = source
        self.kind = kind
        self.sourceRef = sourceRef
        self.createdAt = createdAt
        self.category = category
        self.projectID = projectID
        self.projectName = projectName
        self.sourceMessageID = sourceMessageID
        self.confidence = confidence
        self.status = status
        self.reason = reason
        self.expiresAt = expiresAt
        self.lastUsedAt = lastUsedAt
        self.lastVerifiedAt = lastVerifiedAt
        self.supersededByID = supersededByID
        self.sensitive = sensitive
    }

    public var isFact: Bool { kind == "FACT" }
    public var isSuppression: Bool { kind == "SUPPRESSION" }

    /// "Juno used to believe this" rather than "Juno believes this"
    /// (`RETIRED_STATUSES`).
    public var isRetired: Bool { NativeMemoryVocabulary.retiredStatuses.contains(status) }

    /// Where the fact came from, in the web's words; nil for a fact learned
    /// from a chat (`learnedFrom` in `entry-row.tsx`).
    public var learnedFrom: String? {
        switch sourceRef {
        case "manual": return "You added this"
        case "edit": return "From an edit you made"
        case "forget": return "From a fact you forgot"
        case "import": return "Imported from another assistant"
        default: return source == "MANUAL" ? "You told Juno" : nil
        }
    }

    /// The conversation a learned fact came from, when the row names one.
    public var sourceChatID: String? {
        guard learnedFrom == nil, let sourceRef, !sourceRef.isEmpty else { return nil }
        return sourceRef
    }
}

/// The consolidated prose Juno reads before a chat.
public struct NativeMemoryPageSummary: Equatable, Sendable {
    public let content: String
    public let updatedAt: Date
    public let entryCount: Int

    public init(content: String, updatedAt: Date, entryCount: Int) {
        self.content = content
        self.updatedAt = updatedAt
        self.entryCount = entryCount
    }
}

/// One project's own summary: what that project's chats read instead.
public struct NativeProjectMemorySummary: Equatable, Sendable, Identifiable {
    public let projectID: String
    public let projectName: String
    public let summary: NativeMemoryPageSummary

    public var id: String { projectID }

    public init(projectID: String, projectName: String, summary: NativeMemoryPageSummary) {
        self.projectID = projectID
        self.projectName = projectName
        self.summary = summary
    }
}

/// `GET /api/memory`, and what `/api/memory/edit/apply` answers with.
public struct NativeMemorySnapshot: Equatable, Sendable {
    public var facts: [NativeMemoryFact]
    public var summary: NativeMemoryPageSummary?
    public var projectSummaries: [NativeProjectMemorySummary]

    public init(
        facts: [NativeMemoryFact],
        summary: NativeMemoryPageSummary?,
        projectSummaries: [NativeProjectMemorySummary]
    ) {
        self.facts = facts
        self.summary = summary
        self.projectSummaries = projectSummaries
    }
}

/// One step of a change to memory (the web's `Operation`).
public enum NativeMemoryOperation: Equatable, Sendable {
    /// `suppress` makes it a never-remember entry: it reads as "forget".
    case add(content: String, suppress: Bool, projectID: String?)
    case update(id: String, before: String, content: String)
    case remove(id: String, before: String)

    var json: JunoJSONValue {
        switch self {
        case let .add(content, suppress, projectID):
            var object: [String: JunoJSONValue] = ["op": .string("add"), "content": .string(content)]
            if suppress { object["suppress"] = .bool(true) }
            if let projectID { object["projectId"] = .string(projectID) }
            return .object(object)
        case let .update(id, before, content):
            return .object([
                "op": .string("update"), "id": .string(id),
                "before": .string(before), "content": .string(content),
            ])
        case let .remove(id, before):
            return .object(["op": .string("remove"), "id": .string(id), "before": .string(before)])
        }
    }

    /// Nil for an operation this build does not know: it is dropped, never
    /// half-understood, because a diff drawn from a guess is a lie.
    init?(json: JunoJSONValue) {
        guard case .object(let object) = json else { return nil }
        switch object["op"]?.stringValue {
        case "add":
            guard let content = object["content"]?.stringValue else { return nil }
            self = .add(
                content: content,
                suppress: object["suppress"]?.boolValue == true,
                projectID: object["projectId"]?.stringValue
            )
        case "update":
            guard let id = object["id"]?.stringValue,
                let content = object["content"]?.stringValue
            else { return nil }
            self = .update(id: id, before: object["before"]?.stringValue ?? "", content: content)
        case "remove":
            guard let id = object["id"]?.stringValue else { return nil }
            self = .remove(id: id, before: object["before"]?.stringValue ?? "")
        default:
            return nil
        }
    }
}

/// A change asked for in words, on the server-synced ledger
/// (`/api/memory/edits`).
public struct NativeMemoryEdit: Identifiable, Equatable, Sendable {
    public enum Status: String, Sendable {
        case pending, applied, rejected
    }

    public let id: String
    public let instruction: String
    public let summary: String?
    public let note: String?
    public let operations: [NativeMemoryOperation]
    public let inverse: [NativeMemoryOperation]?
    public let status: Status
    public let createdAt: Date

    public init(
        id: String,
        instruction: String,
        summary: String? = nil,
        note: String? = nil,
        operations: [NativeMemoryOperation],
        inverse: [NativeMemoryOperation]? = nil,
        status: Status,
        createdAt: Date
    ) {
        self.id = id
        self.instruction = instruction
        self.summary = summary
        self.note = note
        self.operations = operations
        self.inverse = inverse
        self.status = status
        self.createdAt = createdAt
    }
}

/// A new ledger record. `clientID` is the idempotency key.
public struct NativeMemoryEditDraft: Equatable, Sendable {
    public var clientID: String
    public var instruction: String
    public var summary: String?
    public var note: String?
    public var status: NativeMemoryEdit.Status
    public var operations: [NativeMemoryOperation]

    public init(
        clientID: String = UUID().uuidString.lowercased(),
        instruction: String,
        summary: String? = nil,
        note: String? = nil,
        status: NativeMemoryEdit.Status,
        operations: [NativeMemoryOperation]
    ) {
        self.clientID = clientID
        self.instruction = instruction
        self.summary = summary
        self.note = note
        self.status = status
        self.operations = operations
    }
}

/// What `POST /api/memory/edit` made of an instruction. It writes nothing.
public enum NativeMemoryDraftAnswer: Equatable, Sendable {
    case proposal(summary: String, operations: [NativeMemoryOperation])
    /// The model declined, with its sentence.
    case refusal(String)
}

/// The recap's server half: chat themes and the chat count.
public struct NativeMemoryRecapExtras: Equatable, Sendable {
    public let themes: [String]
    public let conversations: Int

    public init(themes: [String], conversations: Int) {
        self.themes = themes
        self.conversations = conversations
    }
}

/// One `POST /api/memory/backfill`: two chats read per call, by design.
public struct NativeMemoryBackfillStep: Equatable, Sendable {
    public let processedConversations: Int
    public let created: Int
    public let remaining: Int
}

/// A line of a pasted answer, as the import review shows it.
public struct NativeMemoryImportCandidate: Equatable, Sendable, Identifiable {
    public enum Status: String, Sendable {
        case new, known, forgotten, secret
    }

    public let id: Int
    public let content: String
    public let category: String?
    public let sensitive: String?
    public let status: Status
    /// Ticked when the review opens.
    public let selected: Bool

    public init(
        id: Int,
        content: String,
        category: String?,
        sensitive: String?,
        status: Status,
        selected: Bool
    ) {
        self.id = id
        self.content = content
        self.category = category
        self.sensitive = sensitive
        self.status = status
        self.selected = selected
    }

    /// Forgotten and secret rows cannot be ticked: the write door refuses
    /// them, and a checkbox that does nothing is a lie.
    public var isSelectable: Bool { status != .forgotten && status != .secret }
}

public struct NativeMemoryImportResult: Equatable, Sendable {
    public let created: Int
    public let refreshed: Int
    public let superseded: Int
    public let rejected: Int
}

/// A memory route's refusal, in the sentence the route wrote.
public struct NativeMemoryRequestError: Error, Equatable, LocalizedError, Sendable {
    public let statusCode: Int
    /// The route's own words, or the web's generic sentence.
    public let message: String
    /// `suppressed`, `background_policy_denied`, …
    public let code: String?

    public init(statusCode: Int, message: String, code: String? = nil) {
        self.statusCode = statusCode
        self.message = message
        self.code = code
    }

    public var errorDescription: String? { message }

    /// The web's `GENERIC_FAILURE`.
    public static let generic = "Couldn’t update memory. Try again in a moment."
    public static let malformed = NativeMemoryRequestError(statusCode: 0, message: generic, code: "malformed")
}

// MARK: - Client

/// `/api/memory/**` as the memory page uses it (`use-memory.ts`,
/// `memory-model.ts`, `use-backfill.ts`, `import-dialog.tsx`, `recap-view.tsx`).
///
/// Separate from ``NativeMemoryAPIClient``, which keeps the settings role: the
/// summary the Settings pane caches and the reset it offers. This one is the
/// page's whole wire: the rows with their Memory v2 fields, the drafted and
/// applied changes and their ledger, the recap, reading past chats, and the
/// import. Every reader is tolerant: an unknown field is ignored and an
/// unknown operation or status is dropped rather than guessed at.
public struct NativeMemoryClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    // MARK: Rows

    public func snapshot(for accountID: AccountID) async throws -> NativeMemorySnapshot {
        let root = try await object(.get, "/api/memory", for: accountID)
        return try Self.decodeSnapshot(root)
    }

    /// Saves a fact by hand, account-wide or in one project.
    public func add(
        content: String,
        projectID: String?,
        for accountID: AccountID
    ) async throws -> NativeMemoryFact {
        var body: [String: JunoJSONValue] = ["content": .string(content)]
        if let projectID { body["projectId"] = .string(projectID) }
        let root = try await object(.post, "/api/memory", body: .object(body), for: accountID)
        guard let fact = root["memory"].flatMap(Self.decodeFact) else {
            throw NativeMemoryRequestError.malformed
        }
        return fact
    }

    public func edit(id: String, content: String, for accountID: AccountID) async throws {
        try Self.validate(id)
        _ = try await object(
            .patch, "/api/memory/\(id)", body: .object(["content": .string(content)]), for: accountID
        )
    }

    /// Retires the fact and blocks it from being learned again.
    public func forget(id: String, for accountID: AccountID) async throws {
        try Self.validate(id)
        _ = try await object(
            .patch, "/api/memory/\(id)", body: .object(["forget": .bool(true)]), for: accountID
        )
    }

    /// Files the fact in a project, or (nil) back under the whole account.
    public func move(id: String, toProject projectID: String?, for accountID: AccountID) async throws {
        try Self.validate(id)
        _ = try await object(
            .patch,
            "/api/memory/\(id)",
            body: .object(["projectId": projectID.map(JunoJSONValue.string) ?? .null]),
            for: accountID
        )
    }

    /// A 404 is the outcome asked for: the row is already gone.
    public func delete(id: String, for accountID: AccountID) async throws {
        try Self.validate(id)
        let response = try await transmit(.delete, "/api/memory/\(id)", body: nil, for: accountID)
        if response.statusCode == 404 { return }
        try Self.requireSuccess(response)
    }

    /// Everything remembered, account-wide, and the edit history.
    public func reset(for accountID: AccountID) async throws {
        _ = try await object(.delete, "/api/memory", for: accountID)
    }

    // MARK: Changes in words

    public func draft(instruction: String, for accountID: AccountID) async throws -> NativeMemoryDraftAnswer {
        let root = try await object(
            .post, "/api/memory/edit", body: .object(["instruction": .string(instruction)]), for: accountID
        )
        if let refusal = root["refusal"]?.stringValue, !refusal.isEmpty {
            return .refusal(refusal)
        }
        guard case .object(let proposal)? = root["proposal"] else {
            throw NativeMemoryRequestError.malformed
        }
        return .proposal(
            summary: proposal["summary"]?.stringValue ?? "",
            operations: Self.operations(proposal["operations"])
        )
    }

    /// Commits operations and returns the fresh rows and the server's inverse.
    public func apply(
        _ operations: [NativeMemoryOperation],
        for accountID: AccountID
    ) async throws -> (snapshot: NativeMemorySnapshot, inverse: [NativeMemoryOperation]) {
        let root = try await object(
            .post,
            "/api/memory/edit/apply",
            body: .object(["operations": .array(operations.map(\.json))]),
            for: accountID
        )
        return (try Self.decodeSnapshot(root), Self.operations(root["inverse"]))
    }

    public func edits(for accountID: AccountID) async throws -> [NativeMemoryEdit] {
        Self.edits(try await object(.get, "/api/memory/edits", for: accountID))
    }

    public func createEdits(
        _ drafts: [NativeMemoryEditDraft],
        for accountID: AccountID
    ) async throws -> [NativeMemoryEdit] {
        let body: JunoJSONValue = .object(["edits": .array(drafts.map { draft in
            var object: [String: JunoJSONValue] = [
                "clientId": .string(draft.clientID),
                "instruction": .string(draft.instruction),
                "status": .string(draft.status.rawValue),
                "operations": .array(draft.operations.map(\.json)),
            ]
            if let summary = draft.summary { object["summary"] = .string(summary) }
            if let note = draft.note { object["note"] = .string(note) }
            return .object(object)
        })])
        return Self.edits(try await object(.post, "/api/memory/edits", body: body, for: accountID))
    }

    /// `inverse: .some(nil)` clears it, as an Undo does.
    public func updateEdit(
        id: String,
        status: NativeMemoryEdit.Status? = nil,
        note: String? = nil,
        inverse: [NativeMemoryOperation]?? = nil,
        for accountID: AccountID
    ) async throws -> [NativeMemoryEdit] {
        try Self.validate(id)
        var object: [String: JunoJSONValue] = [:]
        if let status { object["status"] = .string(status.rawValue) }
        if let note { object["note"] = .string(note) }
        if let inverse { object["inverse"] = inverse.map { .array($0.map(\.json)) } ?? .null }
        return Self.edits(try await self.object(
            .patch, "/api/memory/edits/\(id)", body: .object(object), for: accountID
        ))
    }

    public func deleteEdit(id: String, for accountID: AccountID) async throws -> [NativeMemoryEdit] {
        try Self.validate(id)
        return Self.edits(try await object(.delete, "/api/memory/edits/\(id)", for: accountID))
    }

    // MARK: Summary, recap, past chats

    /// Rebuilds the account's summary, or one project's. Nil when there is
    /// nothing to write it from yet.
    public func consolidate(
        projectID: String?,
        for accountID: AccountID
    ) async throws -> NativeMemoryPageSummary? {
        let path: String
        if let projectID {
            try Self.validate(projectID)
            path = "/api/projects/\(projectID)/memory"
        } else {
            path = "/api/memory/consolidate"
        }
        let root = try await object(.post, path, body: .object([:]), for: accountID)
        return root["summary"].flatMap(Self.decodeSummary)
    }

    public func recap(days: Int, for accountID: AccountID) async throws -> NativeMemoryRecapExtras {
        let root = try await object(
            .get, "/api/memory/recap", query: [URLQueryItem(name: "days", value: String(days))], for: accountID
        )
        let themes: [String]
        if case .array(let values)? = root["themes"] { themes = values.compactMap(\.stringValue) } else { themes = [] }
        return NativeMemoryRecapExtras(
            themes: themes,
            conversations: root["conversations"]?.numberValue.map { Int($0) } ?? 0
        )
    }

    /// How many past chats Juno has not learned from; nil when unknown.
    public func backfillRemaining(for accountID: AccountID) async throws -> Int? {
        let root = try await object(.get, "/api/memory/backfill", for: accountID)
        return root["remaining"]?.numberValue.map { Int($0) }
    }

    public func backfill(for accountID: AccountID) async throws -> NativeMemoryBackfillStep {
        let root = try await object(.post, "/api/memory/backfill", body: .object([:]), for: accountID)
        return NativeMemoryBackfillStep(
            processedConversations: root["processedConversations"]?.numberValue.map { Int($0) } ?? 0,
            created: root["created"]?.numberValue.map { Int($0) } ?? 0,
            remaining: root["remaining"]?.numberValue.map { Int($0) } ?? 0
        )
    }

    // MARK: Import

    public func importPreview(text: String, for accountID: AccountID) async throws -> [NativeMemoryImportCandidate] {
        let root = try await object(
            .post, "/api/memory/import/preview", body: .object(["text": .string(text)]), for: accountID
        )
        guard case .array(let values)? = root["candidates"] else {
            throw NativeMemoryRequestError(statusCode: 0, message: "Couldn’t read that list.", code: "malformed")
        }
        return values.enumerated().compactMap { index, value in
            guard case .object(let object) = value, let content = object["content"]?.stringValue else {
                return nil
            }
            let status = object["status"]?.stringValue.flatMap(NativeMemoryImportCandidate.Status.init) ?? .new
            return NativeMemoryImportCandidate(
                id: index,
                content: content,
                category: object["category"]?.stringValue,
                sensitive: object["sensitive"]?.stringValue,
                status: status,
                selected: object["selected"]?.boolValue == true
            )
        }
    }

    public func importFacts(_ facts: [String], for accountID: AccountID) async throws -> NativeMemoryImportResult {
        let root = try await object(
            .post, "/api/memory/import", body: .object(["facts": .array(facts.map(JunoJSONValue.string))]),
            for: accountID
        )
        func count(_ key: String) -> Int { root[key]?.numberValue.map { Int($0) } ?? 0 }
        return NativeMemoryImportResult(
            created: count("created"), refreshed: count("refreshed"),
            superseded: count("superseded"), rejected: count("rejected")
        )
    }

    // MARK: Transport

    private func object(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = [],
        body: JunoJSONValue? = nil,
        for accountID: AccountID
    ) async throws -> [String: JunoJSONValue] {
        let response = try await transmit(method, path, query: query, body: body, for: accountID)
        try Self.requireSuccess(response)
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body),
            case .object(let root) = value
        else { throw NativeMemoryRequestError.malformed }
        return root
    }

    private func transmit(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = [],
        body: JunoJSONValue?,
        for accountID: AccountID
    ) async throws -> HTTPResponse {
        var headers = ["accept": "application/json"]
        if body != nil { headers["content-type"] = "application/json" }
        return try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: method,
                queryItems: query,
                headers: try HTTPHeaders(headers),
                body: try body.map { try JSONEncoder().encode($0) }
            ),
            for: accountID
        )
    }

    /// A refusal in the route's own words (`readRefusal` in `use-memory.ts`):
    /// every memory route answers `{ error, code? }`, already written for a
    /// reader, so it is never rewritten here; the generic sentence covers a
    /// body that is missing or unreadable.
    static func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        var message = NativeMemoryRequestError.generic
        var code: String?
        if let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body),
            case .object(let object) = value
        {
            if let error = object["error"]?.stringValue, !error.isEmpty { message = error }
            code = object["code"]?.stringValue
        }
        throw NativeMemoryRequestError(statusCode: response.statusCode, message: message, code: code)
    }

    static func validate(_ identifier: String) throws {
        guard !identifier.isEmpty, identifier.count <= 200,
            !identifier.contains("/"), !identifier.contains("\\"),
            !identifier.contains(".."), !identifier.contains("%"),
            !identifier.contains("?"), !identifier.contains("#"),
            identifier.allSatisfy({ !$0.isWhitespace && !$0.isNewline })
        else { throw NativeMemoryRequestError(statusCode: 0, message: NativeMemoryRequestError.generic, code: "invalid_id") }
    }

    // MARK: Decoding

    static func decodeSnapshot(_ root: [String: JunoJSONValue]) throws -> NativeMemorySnapshot {
        let facts: [NativeMemoryFact]
        if case .array(let values)? = root["memories"] {
            facts = values.compactMap(decodeFact)
        } else {
            facts = []
        }
        var projects: [NativeProjectMemorySummary] = []
        if case .array(let values)? = root["projectSummaries"] {
            for value in values {
                guard case .object(let object) = value,
                    let projectID = object["projectId"]?.stringValue,
                    let summary = decodeSummary(value)
                else { continue }
                projects.append(NativeProjectMemorySummary(
                    projectID: projectID,
                    projectName: object["projectName"]?.stringValue ?? "Untitled project",
                    summary: summary
                ))
            }
        }
        return NativeMemorySnapshot(
            facts: facts,
            summary: root["summary"].flatMap(decodeSummary),
            projectSummaries: projects
        )
    }

    static func decodeSummary(_ value: JunoJSONValue) -> NativeMemoryPageSummary? {
        guard case .object(let object) = value,
            let content = object["content"]?.stringValue,
            let updatedAt = object["updatedAt"]?.date
        else { return nil }
        return NativeMemoryPageSummary(
            content: content,
            updatedAt: updatedAt,
            entryCount: object["entryCount"]?.numberValue.map { Int($0) } ?? 0
        )
    }

    static func decodeFact(_ value: JunoJSONValue) -> NativeMemoryFact? {
        guard case .object(let object) = value,
            let id = object["id"]?.stringValue,
            let content = object["content"]?.stringValue,
            let createdAt = object["createdAt"]?.date
        else { return nil }
        return NativeMemoryFact(
            id: id,
            content: content,
            source: object["source"]?.stringValue ?? "AUTO",
            kind: object["kind"]?.stringValue ?? "FACT",
            sourceRef: object["sourceRef"]?.stringValue,
            createdAt: createdAt,
            category: object["category"]?.stringValue,
            projectID: object["projectId"]?.stringValue,
            projectName: object["projectName"]?.stringValue,
            sourceMessageID: object["sourceMessageId"]?.stringValue,
            confidence: object["confidence"]?.numberValue ?? 0,
            status: object["status"]?.stringValue ?? "active",
            reason: object["reason"]?.stringValue,
            expiresAt: object["expiresAt"]?.date,
            lastUsedAt: object["lastUsedAt"]?.date,
            lastVerifiedAt: object["lastVerifiedAt"]?.date,
            supersededByID: object["supersededById"]?.stringValue,
            sensitive: object["sensitive"]?.stringValue
        )
    }

    static func operations(_ value: JunoJSONValue?) -> [NativeMemoryOperation] {
        guard case .array(let values)? = value else { return [] }
        return values.compactMap(NativeMemoryOperation.init(json:))
    }

    /// Every ledger call answers with the canonical capped list, newest first.
    static func edits(_ root: [String: JunoJSONValue]) -> [NativeMemoryEdit] {
        guard case .array(let values)? = root["edits"] else { return [] }
        return values.compactMap { value in
            guard case .object(let object) = value,
                let id = object["id"]?.stringValue,
                let instruction = object["instruction"]?.stringValue,
                let status = object["status"]?.stringValue.flatMap(NativeMemoryEdit.Status.init)
            else { return nil }
            let inverse: [NativeMemoryOperation]?
            if case .array? = object["inverse"] { inverse = operations(object["inverse"]) } else { inverse = nil }
            return NativeMemoryEdit(
                id: id,
                instruction: instruction,
                summary: object["summary"]?.stringValue,
                note: object["note"]?.stringValue,
                operations: operations(object["operations"]),
                inverse: inverse,
                status: status,
                createdAt: object["createdAt"]?.date ?? .distantPast
            )
        }
    }
}
