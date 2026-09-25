import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// A reusable specialist (`JunoAssistantConfig`, `src/lib/assistants.ts`): a
/// name, a role, starter prompts and a preferred model.
public struct NativeAssistant: Identifiable, Equatable, Sendable {
    public let id: String
    public let slug: String
    public var name: String
    public var description: String
    public var avatarIcon: String
    public var systemPrompt: String
    public var starterPrompts: [String]
    /// Nil is Auto.
    public var preferredModelID: String?
    public var isPinned: Bool
    public var version: Int
    public let createdAt: Date?
    public var updatedAt: Date?

    public init(
        id: String,
        slug: String = "",
        name: String,
        description: String = "",
        avatarIcon: String = "bot",
        systemPrompt: String = "",
        starterPrompts: [String] = [],
        preferredModelID: String? = nil,
        isPinned: Bool = false,
        version: Int = 1,
        createdAt: Date? = nil,
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.slug = slug
        self.name = name
        self.description = description
        self.avatarIcon = avatarIcon
        self.systemPrompt = systemPrompt
        self.starterPrompts = starterPrompts
        self.preferredModelID = preferredModelID
        self.isPinned = isPinned
        self.version = version
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// What the editor saves (`CreateAssistantInput`).
public struct NativeAssistantDraft: Equatable, Sendable {
    public var name: String
    public var description: String
    public var systemPrompt: String
    public var starterPrompts: [String]
    /// Nil is Auto (`juno:auto` on the web, sent as absent).
    public var preferredModelID: String?
    public var avatarIcon: String

    public init(
        name: String = "",
        description: String = "",
        systemPrompt: String = "",
        starterPrompts: [String] = ["How can you help me today?"],
        preferredModelID: String? = nil,
        avatarIcon: String = "bot"
    ) {
        self.name = name
        self.description = description
        self.systemPrompt = systemPrompt
        self.starterPrompts = starterPrompts
        self.preferredModelID = preferredModelID
        self.avatarIcon = avatarIcon
    }

    public init(_ assistant: NativeAssistant) {
        self.init(
            name: assistant.name,
            description: assistant.description,
            systemPrompt: assistant.systemPrompt,
            starterPrompts: assistant.starterPrompts.isEmpty ? ["How can you help me today?"] : assistant.starterPrompts,
            preferredModelID: assistant.preferredModelID,
            avatarIcon: assistant.avatarIcon
        )
    }

    /// A name and instructions are required, as the web's editor says.
    public var isComplete: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The body the route takes: trimmed, empty starters dropped, Auto absent.
    var json: JunoJSONValue {
        var object: [String: JunoJSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "description": .string(description.trimmingCharacters(in: .whitespacesAndNewlines)),
            "avatarIcon": .string(avatarIcon.isEmpty ? "bot" : avatarIcon),
            "systemPrompt": .string(systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)),
            "starterPrompts": .array(
                starterPrompts
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                    .map(JunoJSONValue.string)
            ),
        ]
        if let preferredModelID, !preferredModelID.isEmpty, preferredModelID != "juno:auto" {
            object["preferredModelId"] = .string(preferredModelID)
        }
        return .object(object)
    }
}

/// An assistants request's refusal, in the route's words when it wrote some.
public struct NativeAssistantsError: Error, Equatable, LocalizedError, Sendable {
    public let statusCode: Int
    public let message: String?

    public var errorDescription: String? { message }
}

/// `/api/assistants` and `/api/assistants/{id}`.
public struct NativeAssistantsClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func list(for accountID: AccountID) async throws -> [NativeAssistant] {
        let root = try await object(.get, "/api/assistants", for: accountID)
        guard case .array(let values)? = root["assistants"] else { return [] }
        return values.compactMap(Self.decode)
    }

    public func create(_ draft: NativeAssistantDraft, for accountID: AccountID) async throws -> NativeAssistant {
        let root = try await object(.post, "/api/assistants", body: draft.json, for: accountID)
        guard let assistant = root["assistant"].flatMap(Self.decode) else {
            throw NativeAssistantsError(statusCode: 0, message: nil)
        }
        return assistant
    }

    public func update(
        id: String,
        _ draft: NativeAssistantDraft,
        for accountID: AccountID
    ) async throws -> NativeAssistant {
        try Self.validate(id)
        let root = try await object(.patch, "/api/assistants/\(id)", body: draft.json, for: accountID)
        guard let assistant = root["assistant"].flatMap(Self.decode) else {
            throw NativeAssistantsError(statusCode: 0, message: nil)
        }
        return assistant
    }

    public func setPinned(id: String, _ pinned: Bool, for accountID: AccountID) async throws -> NativeAssistant {
        try Self.validate(id)
        let root = try await object(
            .patch, "/api/assistants/\(id)", body: .object(["isPinned": .bool(pinned)]), for: accountID
        )
        guard let assistant = root["assistant"].flatMap(Self.decode) else {
            throw NativeAssistantsError(statusCode: 0, message: nil)
        }
        return assistant
    }

    public func delete(id: String, for accountID: AccountID) async throws {
        try Self.validate(id)
        _ = try await object(.delete, "/api/assistants/\(id)", for: accountID)
    }

    // MARK: Transport

    private func object(
        _ method: HTTPMethod,
        _ path: String,
        body: JunoJSONValue? = nil,
        for accountID: AccountID
    ) async throws -> [String: JunoJSONValue] {
        var headers = ["accept": "application/json"]
        if body != nil { headers["content-type"] = "application/json" }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: method,
                headers: try HTTPHeaders(headers),
                body: try body.map { try JSONEncoder().encode($0) }
            ),
            for: accountID
        )
        let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body)
        var root: [String: JunoJSONValue] = [:]
        if case .object(let object)? = value { root = object }
        guard (200...299).contains(response.statusCode) else {
            throw NativeAssistantsError(
                statusCode: response.statusCode,
                message: root["error"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
            )
        }
        return root
    }

    static func validate(_ identifier: String) throws {
        guard !identifier.isEmpty, identifier.count <= 200,
            !identifier.contains("/"), !identifier.contains("\\"),
            !identifier.contains(".."), !identifier.contains("%"),
            !identifier.contains("?"), !identifier.contains("#"),
            identifier.allSatisfy({ !$0.isWhitespace && !$0.isNewline })
        else { throw NativeAssistantsError(statusCode: 0, message: nil) }
    }

    static func decode(_ value: JunoJSONValue) -> NativeAssistant? {
        guard case .object(let object) = value,
            let id = object["id"]?.stringValue,
            let name = object["name"]?.stringValue
        else { return nil }
        var starters: [String] = []
        if case .array(let values)? = object["starterPrompts"] { starters = values.compactMap(\.stringValue) }
        return NativeAssistant(
            id: id,
            slug: object["slug"]?.stringValue ?? "",
            name: name,
            description: object["description"]?.stringValue ?? "",
            avatarIcon: object["avatarIcon"]?.stringValue ?? "bot",
            systemPrompt: object["systemPrompt"]?.stringValue ?? "",
            starterPrompts: starters,
            preferredModelID: object["preferredModelId"]?.stringValue,
            isPinned: object["isPinned"]?.boolValue == true,
            version: object["version"]?.numberValue.map { Int($0) } ?? 1,
            createdAt: object["createdAt"]?.date,
            updatedAt: object["updatedAt"]?.date
        )
    }
}

/// The assistants gallery (`/assistants`): the list, the search, and every
/// write, each answering with the web's sentence on failure.
@MainActor
@Observable
public final class NativeAssistantsModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var assistants: [NativeAssistant] = []
    public var query = ""

    private let client: NativeAssistantsClient
    private var accountID: AccountID?

    public init(client: NativeAssistantsClient) {
        self.client = client
    }

    /// Remembers the account; the gallery reads on first appearance.
    public func start(for accountID: AccountID) {
        guard self.accountID != accountID else { return }
        stop()
        self.accountID = accountID
    }

    public func stop() {
        accountID = nil
        phase = .idle
        assistants = []
        query = ""
    }

    /// The search, over name and description.
    public var filtered: [NativeAssistant] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return assistants }
        return assistants.filter {
            $0.name.lowercased().contains(needle) || $0.description.lowercased().contains(needle)
        }
    }

    public func loadIfNeeded() async {
        guard phase == .idle else { return }
        await reload()
    }

    public func reload() async {
        guard let accountID else { return }
        phase = .loading
        do {
            let list = try await client.list(for: accountID)
            guard self.accountID == accountID else { return }
            assistants = list
            phase = .ready
        } catch {
            guard self.accountID == accountID else { return }
            phase = .failed
        }
    }

    /// Creates or saves. Returns the saved assistant, or the sentence.
    public func save(_ draft: NativeAssistantDraft, editing id: String?) async -> Result<NativeAssistant, NativeAssistantsError> {
        guard draft.isComplete else {
            return .failure(NativeAssistantsError(
                statusCode: 0, message: "Add a name and instructions before saving this assistant."
            ))
        }
        guard let accountID else { return .failure(NativeAssistantsError(statusCode: 0, message: Self.saveFailure)) }
        do {
            let saved: NativeAssistant
            if let id {
                saved = try await client.update(id: id, draft, for: accountID)
            } else {
                saved = try await client.create(draft, for: accountID)
            }
            if let index = assistants.firstIndex(where: { $0.id == saved.id }) {
                assistants[index] = saved
            } else {
                assistants.insert(saved, at: 0)
            }
            return .success(saved)
        } catch let error as NativeAssistantsError {
            return .failure(NativeAssistantsError(statusCode: error.statusCode, message: error.message ?? Self.saveFailure))
        } catch {
            return .failure(NativeAssistantsError(statusCode: 0, message: Self.saveFailure))
        }
    }

    public nonisolated static let saveFailure = "Juno could not save this assistant."

    /// Pin or unpin; nil when it moved, or the sentence.
    public func togglePin(_ assistant: NativeAssistant) async -> String? {
        guard let accountID else { return "Couldn’t update the pin." }
        do {
            let saved = try await client.setPinned(id: assistant.id, !assistant.isPinned, for: accountID)
            if let index = assistants.firstIndex(where: { $0.id == saved.id }) { assistants[index] = saved }
            return nil
        } catch {
            return "Couldn’t update the pin."
        }
    }

    /// Delete; nil when it went, or the sentence.
    public func delete(_ assistant: NativeAssistant) async -> String? {
        guard let accountID else { return "Couldn’t delete the assistant. Nothing was removed." }
        do {
            try await client.delete(id: assistant.id, for: accountID)
            assistants.removeAll { $0.id == assistant.id }
            return nil
        } catch {
            return "Couldn’t delete the assistant. Nothing was removed."
        }
    }

    /// Puts the gallery in a known state for the preview harness and snapshots.
    public func preview(_ assistants: [NativeAssistant], phase: Phase = .ready) {
        self.assistants = assistants
        self.phase = phase
    }
}
