import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// The two transports a Juno Work client needs.
///
/// Unary requests carry everything that changes state; a byte stream carries
/// the open session's log. Composed into one protocol so the app can hand over
/// a single `NativeAuthRuntime`, exactly as `NativeChatRequestSending` does for
/// chat, while the two halves stay separately injectable — a test that
/// exercises decoding has no business standing up a stream.
public protocol NativeWorkTransport: NativeAuthenticatedRequestSending,
    NativeAuthenticatedByteStreaming {}

extension NativeAuthRuntime: NativeWorkTransport {}

// MARK: - Client-facing shapes

/// Everything the session screen needs on open, in one read.
///
/// Fetched rather than waited for on the stream, because a proxy that refuses
/// `text/event-stream` would otherwise leave the screen permanently empty
/// instead of merely not live.
public struct WorkSessionDetail: Equatable, Sendable {
    public let session: WorkSessionSummary
    public let run: WorkRunSummary?
    public let events: [WorkEvent]
    public let approvals: [WorkApprovalRequest]

    public init(
        session: WorkSessionSummary,
        run: WorkRunSummary?,
        events: [WorkEvent],
        approvals: [WorkApprovalRequest]
    ) {
        self.session = session
        self.run = run
        self.events = events
        self.approvals = approvals
    }
}

/// One decoded frame from the session event stream.
///
/// All three cases carry the same payload because all three are answers to the
/// same question — what is true now, and what has happened since the cursor.
/// The distinction that matters to a reader is only whether more is coming.
public struct WorkStreamUpdate: Equatable, Sendable {
    public let session: WorkSessionSummary?
    public let run: WorkRunSummary?
    public let events: [WorkEvent]
    public let approvals: [WorkApprovalRequest]

    public init(
        session: WorkSessionSummary?,
        run: WorkRunSummary?,
        events: [WorkEvent],
        approvals: [WorkApprovalRequest]
    ) {
        self.session = session
        self.run = run
        self.events = events
        self.approvals = approvals
    }
}

public enum WorkStreamFrame: Equatable, Sendable {
    /// The first frame of a connection: where the session stands right now.
    case snapshot(WorkStreamUpdate)
    /// Everything that happened since the last frame.
    case events(WorkStreamUpdate)
    /// The server closed the window on purpose. Reconnecting from the cursor is
    /// the correct response, not an error — the route caps a stream at a few
    /// minutes so no proxy holds one open forever.
    case done(WorkStreamUpdate)
}

/// A question the run has stopped to ask, lifted out of the event stream.
///
/// The identifier travels with the text because the answer has to name which
/// question it answers: a run that asked twice would otherwise apply the reply
/// to whichever question the executor happened to be holding.
public struct WorkQuestionPrompt: Equatable, Sendable, Identifiable {
    public let questionID: String
    public let text: String

    public var id: String { questionID }

    public init(questionID: String, text: String) {
        self.questionID = questionID
        self.text = text
    }
}

/// The fields a client may change on a session, each absent unless it is being
/// changed.
///
/// Optionals rather than plain values because PATCH is a partial update and the
/// difference is load-bearing: a struct with a non-optional `archived` would
/// send `archived: false` every time somebody pinned a session, silently
/// restoring everything they had put away.
public struct WorkSessionEdit: Equatable, Sendable {
    public var title: String?
    public var pinned: Bool?
    public var archived: Bool?

    public init(title: String? = nil, pinned: Bool? = nil, archived: Bool? = nil) {
        self.title = title
        self.pinned = pinned
        self.archived = archived
    }
}

// MARK: - Client

/// The Juno Work REST and SSE client, shared by the Mac app and the phone.
///
/// Every method returns a `WorkContracts` value or throws a `WorkRemoteError`
/// whose `errorDescription` is a sentence, because these failures are shown to
/// a person: a Work session is something they asked for and are waiting on, and
/// "The operation couldn't be completed" tells them nothing about whether to
/// wait, retry, or go and switch their Mac on.
public struct NativeWorkClient: Sendable {
    /// The instructions a client may aim at a run that is already in flight.
    ///
    /// A subset of `JunoWorkCommandKind` rather than the whole enum: the rest
    /// are host-plane instructions the relay mints itself, and sending one from
    /// a phone is a request the server will refuse. Refusing it here makes that
    /// a local, immediate failure rather than an opaque 400 after a round trip.
    public static let controlKinds: Set<JunoWorkCommandKind> = [.pause, .resume, .stop]

    /// The decisions a person can actually make.
    ///
    /// `pending` is the absence of a decision, and `expired` and `superseded`
    /// are things that happen to an approval rather than answers to it. A
    /// client that could send them would be claiming to have decided something
    /// nobody decided.
    public static let sendableDecisions: Set<JunoWorkApprovalDecision> = [
        .allowed, .allowedAlways, .denied,
    ]

    /// Line and event ceilings for the SSE parser.
    ///
    /// Bounded because the parser buffers until a newline: without a cap, a
    /// server that never sends one — or a proxy injecting a very long line —
    /// grows a `Data` until the app is killed by the watchdog for memory.
    static let maximumStreamLineBytes = 1 * 1_024 * 1_024
    static let maximumStreamEventBytes = 4 * 1_024 * 1_024

    /// How much of a non-2xx stream body to read before giving up on finding a
    /// message in it. An error page from a proxy can be arbitrarily long and
    /// none of it is worth showing.
    static let maximumStreamErrorBytes = 64 * 1_024

    private let sender: any NativeAuthenticatedRequestSending
    private let streamer: any NativeAuthenticatedByteStreaming

    public init(
        sender: any NativeAuthenticatedRequestSending,
        streamer: any NativeAuthenticatedByteStreaming
    ) {
        self.sender = sender
        self.streamer = streamer
    }

    public init(transport: any NativeWorkTransport) {
        self.init(sender: transport, streamer: transport)
    }

    // MARK: - Hosts

    /// The Macs signed in to Juno Work for this account.
    ///
    /// Read before anything is dispatched locally, and re-read on a timer,
    /// because a host's reachability is a heartbeat fact rather than a pushed
    /// one and a stale list is how work gets queued at a Mac that is asleep.
    public func hosts(for accountID: AccountID) async throws -> [WorkHostSummary] {
        let response = try await get("/api/work/hosts", for: accountID)
        guard let root = try decodeObject(response), case .array(let items)? = root["hosts"]
        else { throw WorkRemoteError.malformedResponse }
        return try items.map(decodeHost)
    }

    // MARK: - Sessions

    public func sessions(
        includingArchived: Bool = false,
        limit: Int = 50,
        for accountID: AccountID
    ) async throws -> [WorkSessionSummary] {
        var query = [URLQueryItem(name: "limit", value: String(max(1, min(limit, 200))))]
        if includingArchived { query.append(URLQueryItem(name: "archived", value: "true")) }
        let response = try await get("/api/work/sessions", query: query, for: accountID)
        guard let root = try decodeObject(response), case .array(let items)? = root["sessions"]
        else { throw WorkRemoteError.malformedResponse }
        return try items.map(decodeSession)
    }

    /// Composes a session. It is created in `draft` and costs nothing until a
    /// run is started against it.
    ///
    /// `idempotencyKey` belongs to the *composition*, not the request: a phone
    /// on a bad connection retries, and the server's unique index turns the
    /// retry into a lookup instead of a second session in the list. A caller
    /// must mint one per composition and reuse it only when retrying that one.
    public func createSession(
        goal: String,
        title: String? = nil,
        target: JunoWorkTarget = .automatic,
        preferredHostID: String? = nil,
        idempotencyKey: String,
        for accountID: AccountID
    ) async throws -> WorkSessionSummary {
        if let preferredHostID { try validate(preferredHostID) }
        var body: [String: JunoJSONValue] = [
            "goal": .string(goal),
            "requestedTarget": .string(target.rawValue),
            "idempotencyKey": .string(idempotencyKey),
        ]
        if let title { body["title"] = .string(title) }
        if let preferredHostID { body["preferredHostId"] = .string(preferredHostID) }
        let response = try await send(
            .post, "/api/work/sessions", body: .object(body), for: accountID
        )
        return try decodeSession(try require(response, named: "session"))
    }

    public func session(id: String, for accountID: AccountID) async throws -> WorkSessionDetail {
        try validate(id)
        let response = try await get("/api/work/sessions/\(id)", for: accountID)
        guard let root = try decodeObject(response) else { throw WorkRemoteError.malformedResponse }
        return WorkSessionDetail(
            session: try decodeSession(try unwrap(root, named: "session")),
            run: try decodeOptionalRun(root["run"]),
            events: try decodeEventList(root["events"]),
            approvals: try decodeApprovalList(root["approvals"])
        )
    }

    public func updateSession(
        id: String,
        _ edit: WorkSessionEdit,
        for accountID: AccountID
    ) async throws -> WorkSessionSummary {
        try validate(id)
        var body: [String: JunoJSONValue] = [:]
        if let title = edit.title { body["title"] = .string(title) }
        if let pinned = edit.pinned { body["pinned"] = .bool(pinned) }
        if let archived = edit.archived { body["archived"] = .bool(archived) }
        let response = try await send(
            .patch, "/api/work/sessions/\(id)", body: .object(body), for: accountID
        )
        return try decodeSession(try require(response, named: "session"))
    }

    public func deleteSession(id: String, for accountID: AccountID) async throws {
        try validate(id)
        _ = try await send(.delete, "/api/work/sessions/\(id)", body: nil, for: accountID)
    }

    // MARK: - Runs

    /// Dispatches a new attempt at a session.
    ///
    /// The target is a *request*: the server picks the effective one from the
    /// capabilities the plan needs and the hosts that are actually reachable,
    /// and reports any difference as a degradation on the run. A client that
    /// treated the requested target as the outcome would tell the user their
    /// task ran on their Mac when it ran in the cloud without their files.
    public func startRun(
        sessionID: String,
        target: JunoWorkTarget? = nil,
        idempotencyKey: String,
        for accountID: AccountID
    ) async throws -> WorkRunSummary {
        try validate(sessionID)
        var body: [String: JunoJSONValue] = ["idempotencyKey": .string(idempotencyKey)]
        if let target { body["requestedTarget"] = .string(target.rawValue) }
        let response = try await send(
            .post, "/api/work/sessions/\(sessionID)/runs", body: .object(body), for: accountID
        )
        return try decodeRun(try require(response, named: "run"))
    }

    public func control(
        runID: String,
        _ kind: JunoWorkCommandKind,
        reason: String? = nil,
        idempotencyKey: String,
        for accountID: AccountID
    ) async throws -> WorkRunSummary {
        try validate(runID)
        guard Self.controlKinds.contains(kind) else {
            throw WorkRemoteError.unsupportedCommand(kind.rawValue)
        }
        var body: [String: JunoJSONValue] = [
            "action": .string(kind.rawValue),
            "idempotencyKey": .string(idempotencyKey),
        ]
        if let reason { body["reason"] = .string(reason) }
        let response = try await send(
            .post, "/api/work/runs/\(runID)/control", body: .object(body), for: accountID
        )
        return try decodeRun(try require(response, named: "run"))
    }

    // MARK: - Approvals and answers

    /// Answers one approval request.
    ///
    /// The whole request is taken rather than an identifier, and that is the
    /// point. Two things have to travel with the answer for it to mean
    /// anything: the digest of the exact action that was on screen, so the
    /// executor can refuse if what it is about to do has changed, and the
    /// expiry, checked here so a card left open on a locked phone since this
    /// morning cannot authorise a send this evening. Neither is available from
    /// an identifier alone.
    public func decide(
        on approval: WorkApprovalRequest,
        decision: JunoWorkApprovalDecision,
        reason: String? = nil,
        at now: Date = Date(),
        for accountID: AccountID
    ) async throws -> WorkApprovalRequest {
        try validate(approval.approvalID)
        guard Self.sendableDecisions.contains(decision) else {
            throw WorkRemoteError.unsupportedCommand(decision.rawValue)
        }
        guard approval.isAnswerable(at: now) else { throw WorkRemoteError.approvalExpired }
        var body: [String: JunoJSONValue] = [
            "decision": .string(decision.rawValue),
            "actionDigest": .string(approval.actionDigest),
        ]
        if let reason { body["reason"] = .string(reason) }
        let response = try await send(
            .post, "/api/work/approvals/\(approval.approvalID)/decision",
            body: .object(body), for: accountID
        )
        let decided = try decodeApproval(try require(response, named: "approval"))
        // The server echoes the row it actually wrote. If its digest is not the
        // one that was on screen then the request was superseded between render
        // and tap, and treating the response as a success would show the user a
        // decided card for an action they were never shown.
        guard decided.actionDigest == approval.actionDigest else {
            throw WorkRemoteError.approvalDigestMismatch
        }
        return decided
    }

    /// Delivers the user's reply to a question a run stopped to ask.
    public func answer(
        sessionID: String,
        questionID: String,
        text: String,
        for accountID: AccountID
    ) async throws {
        try validate(sessionID)
        try validate(questionID)
        let body: [String: JunoJSONValue] = [
            "questionId": .string(questionID),
            "text": .string(text),
        ]
        _ = try await send(
            .post, "/api/work/sessions/\(sessionID)/answer", body: .object(body), for: accountID
        )
    }

    // MARK: - Event stream

    /// Follows a session's log from a cursor.
    ///
    /// Strictly after `afterSeq`, which is what makes reconnecting cheap and
    /// correct: a phone that loses signal resumes from the last sequence it
    /// applied rather than refetching a transcript, and a replayed page is
    /// recognised as already-applied by sequence rather than by content.
    public func streamEvents(
        sessionID: String,
        afterSeq: Int,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<WorkStreamFrame, any Error> {
        try validate(sessionID)
        let response = try await streamer.stream(
            try NativeBearerRequest(
                path: "/api/work/sessions/\(sessionID)/events",
                queryItems: [URLQueryItem(name: "after", value: String(max(0, afterSeq)))],
                headers: try HTTPHeaders(["accept": "text/event-stream"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw try await streamError(response)
        }
        // A proxy that answered with HTML — a captive portal, an expired
        // gateway — produces a 200 whose body is not a stream at all. Without
        // this check the parser would grind through a login page and report
        // "malformed event" for something that is not an event.
        guard response.headers["content-type"]?.lowercased()
            .hasPrefix("text/event-stream") == true
        else { throw WorkRemoteError.malformedResponse }

        return AsyncThrowingStream { continuation in
            let relay = Task {
                do {
                    var parser = WorkSSEParser()
                    for try await byte in response.bytes {
                        for payload in try parser.consume(byte) {
                            continuation.yield(try decodeFrame(payload))
                        }
                    }
                    for payload in try parser.finish() {
                        continuation.yield(try decodeFrame(payload))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in relay.cancel() }
        }
    }

    // MARK: - Transport

    private func get(
        _ path: String,
        query: [URLQueryItem] = [],
        for accountID: AccountID
    ) async throws -> HTTPResponse {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                queryItems: query,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        return response
    }

    private func send(
        _ method: HTTPMethod,
        _ path: String,
        body: JunoJSONValue?,
        for accountID: AccountID
    ) async throws -> HTTPResponse {
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
        try requireSuccess(response)
        return response
    }

    /// Identifiers are interpolated straight into a URL path, so anything that
    /// could change the path's meaning is refused before it gets there. A `..`
    /// segment or an encoded slash addresses a different route entirely, and on
    /// this API the neighbouring routes are the ones that stop runs and answer
    /// approvals.
    private func validate(_ identifier: String) throws {
        guard !identifier.isEmpty, identifier.count <= 200,
            !identifier.contains("/"), !identifier.contains("\\"),
            !identifier.contains(".."), !identifier.contains("%"),
            !identifier.contains("?"), !identifier.contains("#"),
            identifier.allSatisfy({ !$0.isWhitespace && !$0.isNewline })
        else { throw WorkRemoteError.invalidIdentifier }
    }

    // MARK: - Errors

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        throw workError(statusCode: response.statusCode, body: try? decodeObject(response))
    }

    private func streamError(_ response: HTTPByteStreamResponse) async throws -> WorkRemoteError {
        var body = Data()
        for try await byte in response.bytes {
            guard body.count < Self.maximumStreamErrorBytes else { break }
            body.append(byte)
        }
        var object: [String: JunoJSONValue]?
        if let value = try? JSONDecoder().decode(JunoJSONValue.self, from: body),
            case .object(let root) = value
        {
            object = root
        }
        return workError(statusCode: response.statusCode, body: object)
    }

    /// Turns a refusal into the most specific error the body supports.
    ///
    /// The named cases exist so a screen can say something true and final —
    /// "this Mac's access has been revoked" is not a network problem and must
    /// not be presented with a Retry button. Anything the server does not
    /// classify falls back to a generic server error whose retryability follows
    /// the status class, because a 4xx will stay wrong however many times it is
    /// sent and a 5xx is worth another attempt.
    private func workError(
        statusCode: Int, body: [String: JunoJSONValue]?
    ) -> WorkRemoteError {
        let detail: [String: JunoJSONValue]? = {
            guard case .object(let nested)? = body?["error"] else { return nil }
            return nested
        }()
        let code = detail?["code"]?.stringValue ?? body?["code"]?.stringValue
        let message = detail?["message"]?.stringValue
            ?? body?["error"]?.stringValue
            ?? body?["message"]?.stringValue

        switch code {
        case "work_host_revoked":
            return .hostRevoked
        case "work_host_not_enabled":
            return .hostNotEnabled
        case "work_capability_not_granted":
            // Only when the server names the capability. A sentence with an
            // empty noun in it — "This Mac has not been granted ." — is worse
            // than the generic message it would have replaced.
            if let capability = detail?["capability"]?.stringValue
                ?? body?["capability"]?.stringValue
            {
                return .capabilityNotGranted(capability)
            }
        case "work_approval_digest_mismatch":
            return .approvalDigestMismatch
        case "work_approval_expired":
            return .approvalExpired
        default:
            break
        }

        return .server(
            statusCode: statusCode,
            message: message ?? "Juno could not reach your Work session (\(statusCode)).",
            retryable: detail?["retryable"]?.boolValue ?? (500...599).contains(statusCode)
        )
    }

    // MARK: - Decoding

    private func decodeObject(_ response: HTTPResponse) throws -> [String: JunoJSONValue]? {
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body),
            case .object(let object) = value
        else { return nil }
        return object
    }

    private func require(
        _ response: HTTPResponse, named key: String
    ) throws -> JunoJSONValue {
        guard let root = try decodeObject(response) else { throw WorkRemoteError.malformedResponse }
        return try unwrap(root, named: key)
    }

    /// The named member, or the root itself when the root *is* the resource.
    ///
    /// Both shapes are accepted because the alternative is a client that
    /// decodes nothing at all when a route author picks the other convention,
    /// and there is no ambiguity to resolve: an envelope has the resource under
    /// a name, and a bare resource has its own `id`.
    private func unwrap(
        _ root: [String: JunoJSONValue], named key: String
    ) throws -> JunoJSONValue {
        if case .object(let nested)? = root[key] { return .object(nested) }
        guard root["id"]?.stringValue != nil else { throw WorkRemoteError.malformedResponse }
        return .object(root)
    }

    private func decodeHost(_ value: JunoJSONValue) throws -> WorkHostSummary {
        guard case .object(let object) = value,
            case .string(let hostID)? = object["id"],
            case .string(let deviceID)? = object["deviceId"],
            case .string(let displayName)? = object["displayName"],
            case .string(let state)? = object["state"],
            let lastSeenAt = object["lastSeenAt"]?.date
        else { throw WorkRemoteError.malformedResponse }
        var capabilities: [String] = []
        if case .array(let raw)? = object["capabilities"] {
            capabilities = raw.compactMap(\.stringValue)
        }
        return WorkHostSummary(
            hostID: hostID,
            deviceID: deviceID,
            displayName: displayName,
            state: state,
            // A host whose `enabled` flag is missing is treated as switched
            // off, matching the server's own default: the cost of being wrong
            // that way is a Mac the user has to re-enable, and the other way is
            // work queued at a machine that will never claim it.
            enabled: object["enabled"]?.boolValue ?? false,
            capabilities: capabilities,
            activeRunCount: integer(object["activeRunCount"]),
            queuedRunCount: integer(object["queuedRunCount"]),
            lastSeenAt: lastSeenAt,
            revokedAt: object["revokedAt"]?.date
        )
    }

    /// A session summary, assembled from the session row plus the fields the
    /// route joins in from the current run and the owning host.
    ///
    /// The joined fields are optional here on purpose: a list route that has
    /// not joined a host still produces a usable row, whereas requiring them
    /// would fail the decode of the whole list because one session has never
    /// run.
    private func decodeSession(_ value: JunoJSONValue) throws -> WorkSessionSummary {
        guard case .object(let object) = value,
            case .string(let sessionID)? = object["id"],
            case .string(let title)? = object["title"],
            case .string(let status)? = object["status"],
            let lastActivityAt = object["lastActivityAt"]?.date
        else { throw WorkRemoteError.malformedResponse }
        return WorkSessionSummary(
            sessionID: sessionID,
            title: title,
            goal: object["goal"]?.stringValue ?? "",
            status: status,
            // Stored server-side rather than derived, so every client agrees on
            // what "needs attention" means. Absent means no.
            needsAttention: object["needsAttention"]?.boolValue ?? false,
            requestedTarget: object["requestedTarget"]?.stringValue
                ?? JunoWorkTarget.automatic.rawValue,
            effectiveTarget: object["effectiveTarget"]?.stringValue,
            hostID: object["hostId"]?.stringValue ?? object["preferredHostId"]?.stringValue,
            hostDisplayName: object["hostDisplayName"]?.stringValue,
            pinned: object["pinned"]?.boolValue ?? false,
            archived: object["archived"]?.boolValue ?? false,
            lastActivityAt: lastActivityAt,
            currentRunID: object["currentRunId"]?.stringValue,
            lastSeq: integer(object["lastSeq"])
        )
    }

    private func decodeOptionalSession(_ value: JunoJSONValue?) throws -> WorkSessionSummary? {
        guard case .object(let object)? = value else { return nil }
        return try decodeSession(.object(object))
    }

    private func decodeRun(_ value: JunoJSONValue) throws -> WorkRunSummary {
        guard case .object(let object) = value,
            case .string(let runID)? = object["id"],
            case .string(let sessionID)? = object["sessionId"],
            case .string(let status)? = object["status"]
        else { throw WorkRemoteError.malformedResponse }
        var budget: [String: JunoJSONValue] = [:]
        if case .object(let raw)? = object["budget"] { budget = raw }
        var usage: [String: JunoJSONValue] = [:]
        if case .object(let raw)? = object["usage"] { usage = raw }
        return WorkRunSummary(
            runID: runID,
            sessionID: sessionID,
            attempt: integer(object["attempt"]),
            status: status,
            terminalReason: object["terminalReason"]?.stringValue,
            requestedTarget: object["requestedTarget"]?.stringValue
                ?? JunoWorkTarget.automatic.rawValue,
            effectiveTarget: object["effectiveTarget"]?.stringValue,
            hostID: object["hostId"]?.stringValue,
            effectiveModel: object["effectiveModel"]?.stringValue,
            degradation: decodeDegradations(object["degradation"]),
            costMicroUsd: integer(usage["costMicroUsd"]),
            maxCostMicroUsd: integer(budget["maxCostMicroUsd"]),
            lastSeq: integer(object["lastSeq"]),
            startedAt: object["startedAt"]?.date,
            finishedAt: object["finishedAt"]?.date
        )
    }

    private func decodeOptionalRun(_ value: JunoJSONValue?) throws -> WorkRunSummary? {
        guard case .object(let object)? = value else { return nil }
        return try decodeRun(.object(object))
    }

    /// Degradations, with any entry that cannot explain itself dropped.
    ///
    /// A degradation the UI cannot put a sentence beside renders as a warning
    /// with nothing next to it, which tells the user something went wrong and
    /// nothing about what — worse than silence, because it cannot be acted on.
    /// This mirrors `degradationList` in the server's serialiser exactly.
    private func decodeDegradations(_ value: JunoJSONValue?) -> [WorkDegradation] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap { item in
            guard case .object(let object) = item,
                let kind = object["kind"]?.stringValue,
                let explanation = object["explanation"]?.stringValue,
                !explanation.isEmpty
            else { return nil }
            return WorkDegradation(
                kind: kind, explanation: explanation, subject: object["subject"]?.stringValue
            )
        }
    }

    private func decodeEvent(_ value: JunoJSONValue) throws -> WorkEvent {
        guard case .object(let object) = value,
            // Required rather than defaulted: an event with no sequence cannot
            // be ordered against the cursor, and appending it at zero would
            // silently rewrite the transcript's beginning.
            object["seq"]?.numberValue != nil,
            case .string(let kind)? = object["kind"],
            let createdAt = object["createdAt"]?.date
        else { throw WorkRemoteError.malformedResponse }
        var payload: [String: JunoJSONValue] = [:]
        if case .object(let raw)? = object["payload"] { payload = raw }
        return WorkEvent(
            seq: integer(object["seq"]), kind: kind, payload: payload,
            agentID: object["agentId"]?.stringValue, createdAt: createdAt
        )
    }

    private func decodeEventList(_ value: JunoJSONValue?) throws -> [WorkEvent] {
        guard case .array(let items)? = value else { return [] }
        return try items.map(decodeEvent)
    }

    private func decodeApproval(_ value: JunoJSONValue) throws -> WorkApprovalRequest {
        guard case .object(let object) = value,
            case .string(let approvalID)? = object["id"],
            case .string(let runID)? = object["runId"],
            case .string(let action)? = object["action"],
            case .string(let summary)? = object["summary"],
            case .string(let actionDigest)? = object["actionDigest"],
            let expiresAt = object["expiresAt"]?.date
        else { throw WorkRemoteError.malformedResponse }
        var detail: [String: JunoJSONValue] = [:]
        if case .object(let raw)? = object["detail"] { detail = raw }
        return WorkApprovalRequest(
            approvalID: approvalID,
            runID: runID,
            action: action,
            // An unnamed risk level is treated as the highest, so a client that
            // cannot classify an action still asks rather than quietly
            // proceeding. The server's serialiser falls back the same way.
            risk: object["risk"]?.stringValue ?? JunoWorkRiskLevel.irreversible.rawValue,
            summary: summary,
            detail: detail,
            actionDigest: actionDigest,
            expiresAt: expiresAt,
            decision: object["decision"]?.stringValue
                ?? JunoWorkApprovalDecision.pending.rawValue
        )
    }

    private func decodeApprovalList(_ value: JunoJSONValue?) throws -> [WorkApprovalRequest] {
        guard case .array(let items)? = value else { return [] }
        return try items.map(decodeApproval)
    }

    private func decodeFrame(_ payload: Data) throws -> WorkStreamFrame {
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: payload),
            case .object(let object) = value,
            case .string(let type)? = object["type"]
        else { throw WorkRemoteError.malformedResponse }
        let update = WorkStreamUpdate(
            session: try decodeOptionalSession(object["session"]),
            run: try decodeOptionalRun(object["run"]),
            events: try decodeEventList(object["events"]),
            approvals: try decodeApprovalList(object["approvals"])
        )
        switch type {
        case "snapshot": return .snapshot(update)
        case "events": return .events(update)
        case "done": return .done(update)
        default:
            // An unknown frame type is refused rather than ignored. Silently
            // dropping it would leave a reader watching a log that has quietly
            // stopped telling them things this build does not understand.
            throw WorkRemoteError.malformedResponse
        }
    }

    /// A JSON number as an `Int`, defaulting to zero.
    ///
    /// Clamped rather than converted straight through, because `Int(Double)`
    /// traps outside the representable range: a cost field that came back as
    /// `1e30` — from a bug, a migration, or a hostile relay — would take the
    /// whole app down instead of rendering an implausible number.
    private func integer(_ value: JunoJSONValue?) -> Int {
        guard let number = value?.numberValue, number.isFinite else { return 0 }
        if number >= Double(Int.max) { return .max }
        if number <= Double(Int.min) { return .min }
        return Int(number)
    }
}

// MARK: - SSE

/// A byte-wise `text/event-stream` reader.
///
/// Byte-wise rather than line-buffered by the transport because the transport
/// hands back bytes: `HTTPByteStreamResponse` is deliberately the lowest useful
/// level, so every consumer decides its own bounds instead of inheriting a
/// buffer size chosen for somebody else's payloads.
///
/// `event:` names are ignored and only `data:` is collected, so a route that
/// heartbeats with a `:` comment or names its frames costs nothing here — the
/// discriminator lives inside the JSON, where it survives a proxy that strips
/// unfamiliar fields.
///
/// Every failure here is `malformedResponse`, because that is what all of them
/// are from the reader's side: a stream that stopped making sense. The specific
/// cause — an oversized line, an empty frame — belongs in a log, not in a
/// sentence shown to somebody waiting on a task.
struct WorkSSEParser {
    private var line = Data()
    private var dataLines: [Data] = []
    private var eventBytes = 0

    mutating func consume(_ byte: UInt8) throws -> [Data] {
        guard byte == 0x0A else {
            guard line.count < NativeWorkClient.maximumStreamLineBytes else {
                throw WorkRemoteError.malformedResponse
            }
            line.append(byte)
            return []
        }
        return try finishLine()
    }

    mutating func finish() throws -> [Data] {
        var events: [Data] = []
        if !line.isEmpty { events.append(contentsOf: try finishLine()) }
        if !dataLines.isEmpty { events.append(try dispatch()) }
        return events
    }

    private mutating func finishLine() throws -> [Data] {
        if line.last == 0x0D { line.removeLast() }
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty { return dataLines.isEmpty ? [] : [try dispatch()] }
        // A leading colon is a comment, which is how the route keeps the
        // connection warm through an idle proxy.
        if line.first == 0x3A { return [] }
        let separator = line.firstIndex(of: 0x3A)
        let field = separator.map { line[..<$0] } ?? line[...]
        guard field.elementsEqual(Data("data".utf8)) else { return [] }
        var value = separator.map { Data(line[line.index(after: $0)...]) } ?? Data()
        if value.first == 0x20 { value.removeFirst() }
        eventBytes += value.count
        guard eventBytes <= NativeWorkClient.maximumStreamEventBytes else {
            throw WorkRemoteError.malformedResponse
        }
        dataLines.append(value)
        return []
    }

    private mutating func dispatch() throws -> Data {
        guard !dataLines.isEmpty else { throw WorkRemoteError.malformedResponse }
        var payload = Data()
        for (index, value) in dataLines.enumerated() {
            if index > 0 { payload.append(0x0A) }
            payload.append(value)
        }
        dataLines.removeAll(keepingCapacity: true)
        eventBytes = 0
        guard !payload.isEmpty else { throw WorkRemoteError.malformedResponse }
        return payload
    }
}
