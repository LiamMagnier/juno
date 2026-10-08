import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// The @username's rules and words, as `src/lib/username.ts` has them.
///
/// The apps check the SHAPE locally (so typing gets an instant answer and
/// spends none of the route's per-minute checks), and leave reserved words and
/// whether anyone holds the name to `GET /api/account/username?check=`, which
/// answers in the same words. One list of reserved names, on the server.
public enum NativeUsernameRules {
    public static let minLength = 3
    public static let maxLength = 30

    public enum Problem: String, Sendable, Equatable {
        case tooShort = "too_short"
        case tooLong = "too_long"
        case characters
        case start
        case dots
        case reserved
        case taken
        case invalid
    }

    /// The web's `USERNAME_MESSAGES`, word for word.
    public static func message(_ problem: Problem) -> String {
        switch problem {
        case .tooShort: "Use at least \(minLength) characters."
        case .tooLong: "Keep it to \(maxLength) characters or fewer."
        case .characters: "Use only lowercase letters, numbers, dots, underscores and hyphens."
        case .start: "Start with a letter or a number."
        case .dots: "Dots can’t sit next to each other or end the name."
        case .reserved: "That name is reserved."
        case .taken: "That username is taken."
        case .invalid: "That name isn’t allowed."
        }
    }

    /// The forgiving read: no "@", no surrounding space, lowercase.
    public static func normalize(_ raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasPrefix("@") { value.removeFirst() }
        return value.lowercased()
    }

    /// The shape checks, in the order a reader would fix them (`checkUsername`
    /// without the reserved list). Nil when the shape is fine.
    public static func shapeProblem(_ raw: String) -> Problem? {
        let name = normalize(raw)
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._-")
        if !name.allSatisfy({ allowed.contains($0) }) { return .characters }
        if name.count < minLength { return .tooShort }
        if name.count > maxLength { return .tooLong }
        if let first = name.first, !(first.isLetter || first.isNumber) { return .start }
        if name.contains("..") || name.hasSuffix(".") { return .dots }
        return nil
    }
}

/// `GET /api/account/username?check=<name>`.
public struct NativeUsernameAvailability: Equatable, Sendable {
    /// The normalised form the server read ("@Liam" → "liam").
    public let username: String
    public let available: Bool
    public let problem: NativeUsernameRules.Problem?
    public let message: String?
}

/// A refusal of `PATCH /api/account/username`: the server's sentence, and the
/// rule it broke when it named one (`taken` on a 409).
public struct NativeUsernameError: Error, Equatable, LocalizedError, Sendable {
    public let statusCode: Int
    public let message: String
    public let problem: NativeUsernameRules.Problem?
    public var errorDescription: String? { message }
}

/// Reads, checks and sets the account's @username.
public struct NativeUsernameClient: Sendable {
    public static let path = "/api/account/username"

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// `{ username, handle }`: the chosen name (nil until one is picked) and the
    /// @handle the profile shows.
    public func current(for accountID: AccountID) async throws -> (username: String?, handle: String) {
        let object = try await json(method: .get, query: [], body: nil, fallback: "Couldn’t load your username.", for: accountID)
        let username = (object["username"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return (username, object["handle"] as? String ?? username ?? "you")
    }

    public func check(_ name: String, for accountID: AccountID) async throws -> NativeUsernameAvailability {
        let object = try await json(
            method: .get,
            query: [URLQueryItem(name: "check", value: name)],
            body: nil,
            fallback: "Couldn’t check that name.",
            for: accountID
        )
        return NativeUsernameAvailability(
            username: object["username"] as? String ?? NativeUsernameRules.normalize(name),
            available: object["available"] as? Bool ?? false,
            problem: (object["problem"] as? String).flatMap(NativeUsernameRules.Problem.init(rawValue:)),
            message: object["message"] as? String
        )
    }

    /// Sets it; returns the stored name and handle.
    public func save(_ name: String, for accountID: AccountID) async throws -> (username: String, handle: String) {
        let body = try JSONSerialization.data(withJSONObject: ["username": name], options: [.sortedKeys])
        let object = try await json(method: .patch, query: [], body: body, fallback: "Couldn’t change your username.", for: accountID)
        let username = object["username"] as? String ?? name
        return (username, object["handle"] as? String ?? username)
    }

    private func json(
        method: HTTPMethod,
        query: [URLQueryItem],
        body: Data?,
        fallback: String,
        for accountID: AccountID
    ) async throws -> [String: Any] {
        var headers = ["accept": "application/json"]
        if body != nil { headers["content-type"] = "application/json" }
        let response = try await sender.send(
            try NativeBearerRequest(path: Self.path, method: method, queryItems: query, headers: try HTTPHeaders(headers), body: body),
            for: accountID
        )
        let object = (try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]) ?? [:]
        guard (200...299).contains(response.statusCode) else {
            let message = (object["error"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallback
            throw NativeUsernameError(
                statusCode: response.statusCode,
                message: message,
                problem: (object["problem"] as? String).flatMap(NativeUsernameRules.Problem.init(rawValue:))
            )
        }
        return object
    }
}

/// Settings › Account › Username (`account-username.tsx`): the field's live
/// check, debounced, and the save.
///
/// The answer is one quiet line under the field (``statusText``), never a pill:
/// Available, taken, or what the rules say.
@MainActor
@Observable
public final class NativeUsernameModel {
    public enum Check: Equatable, Sendable {
        case idle
        case checking
        case available
        case current
        case taken(String)
        case invalid(String)
        case error(String)
    }

    /// The saved username; nil until one is chosen.
    public private(set) var username: String?
    /// What the profile shows: the username, or the email-derived fallback.
    public private(set) var handle: String?
    public private(set) var loaded = false
    /// What is in the field, already normalised as typed (no "@", lowercase).
    public private(set) var value = ""
    public private(set) var check: Check = .idle
    public private(set) var saving = false
    /// A save refused for a reason that is not about the name (rate limit, offline).
    public private(set) var saveError: String?

    private let client: NativeUsernameClient?
    private let accountID: AccountID
    private let debounce: Duration
    private var pending: Task<Void, Never>?

    public init(client: NativeUsernameClient?, accountID: AccountID, debounce: Duration = .milliseconds(350)) {
        self.client = client
        self.accountID = accountID
        self.debounce = debounce
    }

    public func load() async {
        guard let client else { return }
        if let current = try? await client.current(for: accountID) {
            username = current.username
            handle = current.handle
            loaded = true
        }
    }

    /// Opens the field on the current name.
    public func beginEditing() {
        saveError = nil
        value = username ?? ""
        check = username == nil ? .idle : .current
    }

    /// The field changed: normalise, answer the shape at once, and ask the
    /// server after the pause.
    public func setValue(_ raw: String) {
        var next = raw
        while next.hasPrefix("@") { next.removeFirst() }
        next = next.lowercased()
        value = next
        saveError = nil
        pending?.cancel()
        let typed = next.trimmingCharacters(in: .whitespaces)
        if typed.isEmpty {
            check = .idle
            return
        }
        let normalized = NativeUsernameRules.normalize(typed)
        let shape = NativeUsernameRules.shapeProblem(typed)
        if shape == nil, normalized == username {
            check = .current
            return
        }
        check = .checking
        let debounce = debounce
        pending = Task { [weak self] in
            if debounce > .zero { try? await Task.sleep(for: debounce) }
            guard !Task.isCancelled else { return }
            await self?.resolve(normalized, shape: shape)
        }
    }

    /// Waits for the check in flight (tests).
    public func settle() async {
        await pending?.value
    }

    private func resolve(_ name: String, shape: NativeUsernameRules.Problem?) async {
        if let shape {
            check = .invalid(NativeUsernameRules.message(shape))
            return
        }
        guard let client else {
            check = .error("Couldn’t check that name.")
            return
        }
        do {
            let answer = try await client.check(name, for: accountID)
            guard !Task.isCancelled, NativeUsernameRules.normalize(value) == name else { return }
            if answer.available {
                check = .available
            } else if answer.problem == .taken {
                check = .taken(answer.message ?? NativeUsernameRules.message(.taken))
            } else {
                check = .invalid(answer.message ?? NativeUsernameRules.message(.invalid))
            }
        } catch {
            guard !Task.isCancelled else { return }
            check = .error((error as? NativeUsernameError)?.message ?? "Couldn’t check that name.")
        }
    }

    public var canSave: Bool { check == .available && !saving }

    /// Saves an available name. True when it was stored.
    @discardableResult
    public func save() async -> Bool {
        guard canSave, let client else { return false }
        let name = NativeUsernameRules.normalize(value)
        saving = true
        defer { saving = false }
        do {
            let saved = try await client.save(name, for: accountID)
            username = saved.username
            handle = saved.handle
            value = saved.username
            check = .current
            return true
        } catch let error as NativeUsernameError {
            if error.problem == .taken {
                check = .taken(error.message)
            } else if error.statusCode == 400 {
                check = .invalid(error.message)
            } else {
                saveError = error.message
            }
        } catch {
            saveError = "Couldn’t change your username."
        }
        return false
    }

    /// The line under the field, in the web's words (`statusText`).
    public var statusText: String {
        switch check {
        case .idle: "Letters, numbers, dots, underscores and hyphens."
        case .checking: "Checking…"
        case .available: "Available"
        case .current: "This is your username."
        case .taken(let message): message
        case .invalid(let message): "Not allowed. \(message)"
        case .error(let message): message
        }
    }

    /// Taken, refused or failed: the line takes the attention ink.
    public var isProblem: Bool {
        switch check {
        case .taken, .invalid, .error: true
        default: false
        }
    }
}
