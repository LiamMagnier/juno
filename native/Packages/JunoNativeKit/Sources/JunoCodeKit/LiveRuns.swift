import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

// MARK: - Wire types

/// Which run a Stop or an answer is about. A Code session on a paired Mac is
/// named by its device and session; a Work attempt by its run id.
public enum LiveRunRef: Hashable, Sendable {
    case code(deviceID: String, sessionID: String)
    case work(runID: String)

    var json: JunoJSONValue {
        switch self {
        case .code(let deviceID, let sessionID):
            .object(["kind": .string("code"), "deviceId": .string(deviceID), "sessionId": .string(sessionID)])
        case .work(let runID):
            .object(["kind": .string("work"), "runId": .string(runID)])
        }
    }
}

public enum LiveRunStatus: String, Sendable, Equatable {
    case queued
    case running
    case waitingApproval = "waiting_approval"
    case waitingInput = "waiting_input"
    case paused
}

/// Risk words a tap may answer. Everything else needs the device owner,
/// including a word this build has never seen: unknown is treated as high.
public enum LiveRunRisk {
    static let routine: Set<String> = ["safe", "low", "neutral", "read", "edit", "info", "none", ""]

    public static func isHigh(_ risk: String) -> Bool {
        !routine.contains(risk.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }
}

public struct LiveRunApproval: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let summary: String
    public let detail: String?
    public let risk: String
    public let highRisk: Bool
    /// Work only: the digest a decision must echo. Nil for Code.
    public let actionDigest: String?
    public let requestedAt: Date
    public let expiresAt: Date?

    public init(
        id: String, summary: String, detail: String? = nil, risk: String, highRisk: Bool,
        actionDigest: String? = nil, requestedAt: Date, expiresAt: Date? = nil
    ) {
        self.id = id
        self.summary = summary
        self.detail = detail
        self.risk = risk
        self.highRisk = highRisk
        self.actionDigest = actionDigest
        self.requestedAt = requestedAt
        self.expiresAt = expiresAt
    }

    /// Whether approving needs Face ID, Touch ID or the passcode first. The
    /// server's verdict and this build's own reading both count, so neither
    /// side can talk the other out of asking.
    public var requiresOwnerToApprove: Bool { highRisk || LiveRunRisk.isHigh(risk) }
}

/// One live agent run, as `/api/runs/live` describes it.
public struct LiveRun: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable { case code, work }
    public enum Target: String, Sendable { case mac, cloud }

    public let key: String
    public let ref: LiveRunRef
    public let kind: Kind
    public let title: String
    public let hostName: String?
    public let target: Target
    public let status: LiveRunStatus
    public let rawStatus: String
    public let steps: Int
    public let currentAction: String?
    public let usesComputer: Bool
    public let startedAt: Date
    public let updatedAt: Date
    public let costUSD: Double?
    public let hostOnline: Bool
    public let canStop: Bool
    public let approvals: [LiveRunApproval]

    public var id: String { key }
    public var needsYou: Bool { !approvals.isEmpty || status == .waitingApproval || status == .waitingInput }

    public init(
        key: String, ref: LiveRunRef, kind: Kind, title: String, hostName: String?,
        target: Target, status: LiveRunStatus, rawStatus: String, steps: Int,
        currentAction: String?, usesComputer: Bool, startedAt: Date, updatedAt: Date,
        costUSD: Double?, hostOnline: Bool, canStop: Bool, approvals: [LiveRunApproval]
    ) {
        self.key = key
        self.ref = ref
        self.kind = kind
        self.title = title
        self.hostName = hostName
        self.target = target
        self.status = status
        self.rawStatus = rawStatus
        self.steps = steps
        self.currentAction = currentAction
        self.usesComputer = usesComputer
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.costUSD = costUSD
        self.hostOnline = hostOnline
        self.canStop = canStop
        self.approvals = approvals
    }
}

/// What a Stop came to.
public enum LiveRunStopOutcome: String, Sendable, Equatable {
    /// Queued for the Mac, or a second press that found one already queued.
    case requested
    /// The run is over, by this Stop or anything else.
    case stopped
}

public enum LiveRunsError: Error, Equatable, LocalizedError, Sendable {
    case malformedResponse
    case streamUnavailable
    case invalidStream
    /// The server answered and refused. `code` is its machine-readable reason
    /// (`already_decided`, `approval_not_pending`, `mode_forbids`, …).
    case server(statusCode: Int, code: String?, message: String)

    public var errorDescription: String? {
        switch self {
        case .malformedResponse: "Alevr returned run data this build cannot read."
        case .streamUnavailable: "This Alevr build cannot follow runs live."
        case .invalidStream: "The live run feed was interrupted."
        case .server(_, _, let message): message
        }
    }

    /// Whether trying again could help: a 5xx or a rate limit.
    public var isRetryable: Bool {
        if case .server(let status, _, _) = self { return status >= 500 || status == 429 }
        return self == .invalidStream
    }
}

// MARK: - Client

/// The phone's side of `/api/runs/*`, behind a protocol so the model is tested
/// without a network.
public protocol LiveRunsServing: Sendable {
    func snapshot(for accountID: AccountID) async throws -> [LiveRun]
    func stream(for accountID: AccountID) async throws -> AsyncThrowingStream<[LiveRun], any Error>
    func stop(_ ref: LiveRunRef, for accountID: AccountID) async throws -> LiveRunStopOutcome
    func decide(
        _ ref: LiveRunRef, approval: LiveRunApproval, approve: Bool, for accountID: AccountID
    ) async throws
}

public struct NativeLiveRunsClient: LiveRunsServing {
    static let livePath = "/api/runs/live"
    static let stopPath = "/api/runs/stop"
    static let approvalPath = "/api/runs/approval"

    private let sender: any NativeAuthenticatedRequestSending
    private let streamer: (any NativeAuthenticatedByteStreaming)?

    public init(
        sender: any NativeAuthenticatedRequestSending,
        streamer: (any NativeAuthenticatedByteStreaming)? = nil
    ) {
        self.sender = sender
        self.streamer = streamer
    }

    public func snapshot(for accountID: AccountID) async throws -> [LiveRun] {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: Self.livePath,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        let root = try Self.require2xx(statusCode: response.statusCode, body: response.body)
        return try Self.decodeRuns(root)
    }

    /// The same SSE shape as the relay's session feed: `event: runs` frames,
    /// each a whole snapshot, heartbeat comments between, and a deliberate
    /// rotation after a few minutes that the caller answers by reconnecting.
    public func stream(for accountID: AccountID) async throws -> AsyncThrowingStream<[LiveRun], any Error> {
        guard let streamer else { throw LiveRunsError.streamUnavailable }
        let response = try await streamer.stream(
            try NativeBearerRequest(
                path: Self.livePath,
                headers: try HTTPHeaders(["accept": "text/event-stream"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            var body = Data()
            for try await byte in response.bytes {
                guard body.count < 64 * 1_024 else { break }
                body.append(byte)
            }
            _ = try Self.require2xx(statusCode: response.statusCode, body: body)
            throw LiveRunsError.malformedResponse
        }
        guard response.headers["content-type"]?.lowercased().hasPrefix("text/event-stream") == true else {
            throw LiveRunsError.invalidStream
        }
        return AsyncThrowingStream { continuation in
            let relay = Task {
                do {
                    var parser = CodeRemoteSSEParser()
                    for try await byte in response.bytes {
                        for frame in try parser.consume(byte) {
                            if let runs = try Self.decodeFrame(frame) { continuation.yield(runs) }
                        }
                    }
                    for frame in try parser.finish() {
                        if let runs = try Self.decodeFrame(frame) { continuation.yield(runs) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in relay.cancel() }
        }
    }

    public func stop(_ ref: LiveRunRef, for accountID: AccountID) async throws -> LiveRunStopOutcome {
        let root = try await post(Self.stopPath, body: .object(["run": ref.json]), for: accountID)
        switch root["outcome"]?.stringValue {
        case "already_stopped", "stopped": return .stopped
        case "stop_requested", "already_stopping": return .requested
        default: throw LiveRunsError.malformedResponse
        }
    }

    public func decide(
        _ ref: LiveRunRef, approval: LiveRunApproval, approve: Bool, for accountID: AccountID
    ) async throws {
        var body: [String: JunoJSONValue] = [
            "run": ref.json,
            "approvalId": .string(approval.id),
            "approve": .bool(approve),
        ]
        if let digest = approval.actionDigest { body["actionDigest"] = .string(digest) }
        _ = try await post(Self.approvalPath, body: .object(body), for: accountID)
    }

    private func post(
        _ path: String, body: JunoJSONValue, for accountID: AccountID
    ) async throws -> [String: JunoJSONValue] {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        return try Self.require2xx(statusCode: response.statusCode, body: response.body)
    }

    // MARK: Decoding

    static func require2xx(statusCode: Int, body: Data) throws -> [String: JunoJSONValue] {
        let root: [String: JunoJSONValue]? = {
            guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: body),
                case .object(let object) = value
            else { return nil }
            return object
        }()
        guard (200...299).contains(statusCode) else {
            throw LiveRunsError.server(
                statusCode: statusCode,
                code: root?["error"]?.stringValue,
                message: root?["message"]?.stringValue
                    ?? "Alevr could not reach that run (\(statusCode))."
            )
        }
        guard let root else { throw LiveRunsError.malformedResponse }
        return root
    }

    static func decodeFrame(_ frame: CodeRemoteSSEParser.Frame) throws -> [LiveRun]? {
        guard frame.name == "runs" else { return nil }
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: Data(frame.data.utf8)),
            case .object(let root) = value, root["type"]?.stringValue == "runs"
        else { throw LiveRunsError.invalidStream }
        return try decodeRuns(root)
    }

    static func decodeRuns(_ root: [String: JunoJSONValue]) throws -> [LiveRun] {
        guard case .array(let items)? = root["runs"] else { throw LiveRunsError.malformedResponse }
        // A run this build cannot read is skipped rather than failing the
        // list: one odd row must not blank the supervisor's whole screen.
        return items.compactMap(decodeRun)
    }

    static func decodeRun(_ value: JunoJSONValue) -> LiveRun? {
        guard case .object(let object) = value,
            let key = object["key"]?.stringValue,
            case .object(let refObject)? = object["ref"],
            let title = object["title"]?.stringValue,
            let startedAt = object["startedAt"]?.date,
            let updatedAt = object["updatedAt"]?.date
        else { return nil }
        let ref: LiveRunRef
        switch refObject["kind"]?.stringValue {
        case "code":
            guard let deviceID = refObject["deviceId"]?.stringValue,
                let sessionID = refObject["sessionId"]?.stringValue
            else { return nil }
            ref = .code(deviceID: deviceID, sessionID: sessionID)
        case "work":
            guard let runID = refObject["runId"]?.stringValue else { return nil }
            ref = .work(runID: runID)
        default:
            return nil
        }
        var approvals: [LiveRunApproval] = []
        if case .array(let raw)? = object["approvals"] {
            approvals = raw.compactMap { item in
                guard case .object(let a) = item,
                    let id = a["id"]?.stringValue,
                    let summary = a["summary"]?.stringValue
                else { return nil }
                let risk = a["risk"]?.stringValue ?? ""
                return LiveRunApproval(
                    id: id,
                    summary: summary,
                    detail: a["detail"]?.stringValue,
                    risk: risk,
                    // Absent means the server did not say: read the word.
                    highRisk: a["highRisk"]?.boolValue ?? LiveRunRisk.isHigh(risk),
                    actionDigest: a["actionDigest"]?.stringValue,
                    requestedAt: a["requestedAt"]?.date ?? startedAt,
                    expiresAt: a["expiresAt"]?.date
                )
            }
        }
        let kind: LiveRun.Kind = if case .code = ref { .code } else { .work }
        let rawStatus = object["rawStatus"]?.stringValue ?? object["status"]?.stringValue ?? "running"
        return LiveRun(
            key: key,
            ref: ref,
            kind: kind,
            title: title,
            hostName: object["hostName"]?.stringValue,
            target: LiveRun.Target(rawValue: object["target"]?.stringValue ?? "") ?? .mac,
            status: LiveRunStatus(rawValue: object["status"]?.stringValue ?? "") ?? .running,
            rawStatus: rawStatus,
            steps: Int(object["steps"]?.numberValue ?? 0),
            currentAction: object["currentAction"]?.stringValue,
            usesComputer: object["usesComputer"]?.boolValue ?? false,
            startedAt: startedAt,
            updatedAt: updatedAt,
            costUSD: object["costUsd"]?.numberValue,
            hostOnline: object["hostOnline"]?.boolValue ?? true,
            canStop: object["canStop"]?.boolValue ?? true,
            approvals: approvals
        )
    }
}

// MARK: - Live Activity summary

/// What a Live Activity and the Dynamic Island show for one run, derived here
/// so the words and numbers are tested once and the widget only draws them.
public struct LiveRunActivitySummary: Equatable, Sendable {
    public let runKey: String
    public let title: String
    public let statusLine: String
    public let steps: Int
    public let currentAction: String?
    public let startedAt: Date
    public let costUSD: Double?
    public let pendingApprovals: Int
    public let needsYou: Bool
    public let usesComputer: Bool

    public init(_ run: LiveRun) {
        runKey = run.key
        title = run.title
        steps = run.steps
        currentAction = run.currentAction
        startedAt = run.startedAt
        costUSD = run.costUSD
        pendingApprovals = run.approvals.count
        needsYou = run.needsYou
        usesComputer = run.usesComputer
        statusLine = Self.statusLine(for: run)
    }

    static func statusLine(for run: LiveRun) -> String {
        if !run.approvals.isEmpty {
            return run.approvals.count == 1 ? "Needs your approval" : "\(run.approvals.count) approvals waiting"
        }
        switch run.status {
        case .waitingApproval: return "Needs your approval"
        case .waitingInput: return "Waiting for your answer"
        case .paused: return "Paused"
        case .queued: return "Queued"
        case .running:
            guard run.hostOnline else { return "Mac is offline" }
            return run.usesComputer ? "Using the computer" : "Working"
        }
    }
}

/// Which Live Activities to start, update and end, given the last list and
/// this one. A run that leaves the list has finished (or was stopped), so its
/// activity ends; a new run past `limit` waits until one ends.
public struct LiveRunActivityPlan: Equatable, Sendable {
    public var start: [LiveRunActivitySummary] = []
    public var update: [LiveRunActivitySummary] = []
    public var end: [String] = []

    public static func plan(
        active: Set<String>, runs: [LiveRun], limit: Int = 2
    ) -> LiveRunActivityPlan {
        var result = LiveRunActivityPlan()
        let current = Dictionary(runs.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        result.end = active.filter { current[$0] == nil }.sorted()
        var running = active.count - result.end.count
        for run in runs {
            if active.contains(run.key) {
                result.update.append(LiveRunActivitySummary(run))
            } else if running < limit {
                result.start.append(LiveRunActivitySummary(run))
                running += 1
            }
        }
        return result
    }
}

// MARK: - Model

/// The phone's supervisor seat: every live run on the account, followed live,
/// with Stop and Approve / Deny.
///
/// It holds no authority. Every action is a request the server re-checks
/// (ownership, the remote-control pair, the run's own permission mode and,
/// for Work, the digest), and the list only changes when the server's list
/// does — which is also what the web and the Mac read, so an answer given here
/// shows there, and one given there disappears here.
@MainActor
@Observable
public final class LiveRunsModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case connecting
        case live
        /// The feed dropped; it is being re-opened.
        case reconnecting
        /// The server refused; retrying will not help until something changes.
        case failed(String)
    }

    public enum StopState: Equatable, Sendable {
        case idle
        case stopping
        /// Queued for the run's host; the run leaves the list when it stops.
        case requested
        case stopped
        case failed(String)
    }

    public enum ApprovalState: Equatable, Sendable {
        case idle
        /// Waiting for Face ID, Touch ID or the passcode.
        case confirming
        case sending
        case sent
        /// The server said no (already answered, gone, or the mode forbids it).
        case refused(String)
        case failed(String)
    }

    public private(set) var runs: [LiveRun] = []
    public private(set) var phase: Phase = .idle
    public private(set) var stopStates: [String: StopState] = [:]
    public private(set) var approvalStates: [String: ApprovalState] = [:]
    public private(set) var lastUpdated: Date?

    /// Called with the previous and the new list whenever the list changes:
    /// the Live Activities and the local notifications hang off this.
    public var onChange: (@MainActor (_ previous: [LiveRun], _ current: [LiveRun]) -> Void)?

    private let client: any LiveRunsServing
    private let pause: @Sendable (Duration) async throws -> Void
    private var accountID: AccountID?

    public init(
        client: any LiveRunsServing,
        pause: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.client = client
        self.pause = pause
    }

    public var isStarted: Bool { accountID != nil }

    public var pendingApprovalCount: Int { runs.reduce(0) { $0 + $1.approvals.count } }

    public func run(withKey key: String) -> LiveRun? { runs.first { $0.key == key } }

    public func start(for accountID: AccountID) {
        self.accountID = accountID
    }

    /// Forgets the account: nothing of its runs may outlive a sign-out.
    public func stop() {
        accountID = nil
        let previous = runs
        runs = []
        stopStates = [:]
        approvalStates = [:]
        phase = .idle
        lastUpdated = nil
        if !previous.isEmpty { onChange?(previous, []) }
    }

    /// One snapshot. Pull-to-refresh, the background refresh task, and the
    /// fallback when the feed cannot be opened.
    public func refresh() async {
        guard let accountID else { return }
        do {
            apply(try await client.snapshot(for: accountID))
            if phase != .live { phase = .live }
        } catch {
            record(error)
        }
    }

    /// Follows the feed until the surrounding task is cancelled, re-opening it
    /// after each rotation or drop with a short, growing pause. Scope it to the
    /// app being in the foreground (or inside background execution time).
    public func watch() async {
        var failures = 0
        while !Task.isCancelled, let accountID {
            phase = failures == 0 && runs.isEmpty ? .connecting : (phase == .live ? .live : .reconnecting)
            do {
                let stream = try await client.stream(for: accountID)
                for try await snapshot in stream {
                    try Task.checkCancellation()
                    guard self.accountID == accountID else { return }
                    apply(snapshot)
                    phase = .live
                    failures = 0
                }
                // A deliberate rotation: reopen at once.
            } catch is CancellationError {
                return
            } catch {
                if let error = error as? LiveRunsError, case .server(let status, _, _) = error,
                    !error.isRetryable
                {
                    record(error)
                    if status == 401 || status == 403 { return }
                }
                failures += 1
                phase = .reconnecting
                // The feed is the live path; a snapshot keeps the list honest
                // while it is down.
                await refresh()
                let seconds = min(30.0, pow(2.0, Double(min(failures, 5))))
                do { try await pause(.seconds(seconds)) } catch { return }
            }
        }
    }

    /// Stops a run. A second press while one is in flight does nothing; a
    /// press after the server queued a stop asks again, which the server
    /// answers idempotently.
    public func stop(_ run: LiveRun) async {
        guard let accountID, run.canStop else { return }
        if stopStates[run.key] == .stopping { return }
        stopStates[run.key] = .stopping
        do {
            let outcome = try await client.stop(run.ref, for: accountID)
            stopStates[run.key] = outcome == .stopped ? .stopped : .requested
        } catch {
            stopStates[run.key] = .failed(Self.message(error))
        }
    }

    /// Answers one approval.
    ///
    /// Approving a high-risk request asks `confirmOwner` first (the app passes
    /// Face ID, Touch ID or the passcode) and sends nothing unless it says yes.
    /// Denying is the safe direction and is sent on the tap. Returns whether a
    /// decision was sent and accepted.
    @discardableResult
    public func decide(
        _ approval: LiveRunApproval,
        on run: LiveRun,
        approve: Bool,
        confirmOwner: @MainActor () async -> Bool
    ) async -> Bool {
        guard let accountID else { return false }
        switch approvalStates[approval.id] {
        case .confirming?, .sending?, .sent?: return false
        default: break
        }
        if approve && approval.requiresOwnerToApprove {
            approvalStates[approval.id] = .confirming
            guard await confirmOwner() else {
                approvalStates[approval.id] = .idle
                return false
            }
        }
        approvalStates[approval.id] = .sending
        do {
            try await client.decide(run.ref, approval: approval, approve: approve, for: accountID)
            approvalStates[approval.id] = .sent
            return true
        } catch let error as LiveRunsError {
            if case .server(let status, _, let message) = error, (400...499).contains(status), status != 429 {
                approvalStates[approval.id] = .refused(message)
            } else {
                approvalStates[approval.id] = .failed(Self.message(error))
            }
            return false
        } catch {
            approvalStates[approval.id] = .failed(Self.message(error))
            return false
        }
    }

    /// Approvals that are in `current` and were not in `previous`: one local
    /// notification each.
    public static func newlyPendingApprovals(
        previous: [LiveRun], current: [LiveRun]
    ) -> [(run: LiveRun, approval: LiveRunApproval)] {
        let known = Set(previous.flatMap { $0.approvals.map(\.id) })
        return current.flatMap { run in
            run.approvals.filter { !known.contains($0.id) }.map { (run: run, approval: $0) }
        }
    }

    // MARK: Internals

    func apply(_ snapshot: [LiveRun]) {
        lastUpdated = Date()
        let previous = runs
        guard snapshot != previous else { return }
        runs = snapshot
        // States for runs and approvals that have left the list are spent.
        let liveKeys = Set(snapshot.map(\.key))
        stopStates = stopStates.filter { liveKeys.contains($0.key) }
        let liveApprovals = Set(snapshot.flatMap { $0.approvals.map(\.id) })
        approvalStates = approvalStates.filter { liveApprovals.contains($0.key) }
        onChange?(previous, snapshot)
    }

    /// A transport failure is an outage worth retrying, and says so; a
    /// refusal from the server is not.
    private func record(_ error: any Error) {
        let retryable = NativeFailureClassification.isConnectivityFailure(error)
            || (error as? LiveRunsError)?.isRetryable == true
        phase = retryable ? .reconnecting : .failed(Self.message(error))
    }

    private static func message(_ error: any Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? NativeFailureMessage.presentable(error)
    }
}
