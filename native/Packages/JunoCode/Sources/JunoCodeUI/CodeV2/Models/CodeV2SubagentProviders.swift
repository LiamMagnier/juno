import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeBridge
import JunoCodeRuntime

/// Where an Orchestrate role runs when the Mac's Swift engine is the parent
/// (Code v2 SPEC §3.3): the `ModelSelection.instanceId` names the provider
/// instance, and this turns it into a client the delegate tool can drive.
///
/// - `alevr`: Alevr's own backend proxy, billed to the plan, at the chosen
///   context tier.
/// - `byok:<lab>`: the same proxy on the user's stored key for that lab
///   (`x-alevr-billing: byok`), not billed to Alevr.
/// - a subscription (`claude-agent:*`, `codex:*`, `acp:*`): the vendor's own
///   agent through the local env server; the child's task is one turn of a
///   fresh env-server session in the thread's folder, and its closing message
///   is the child's answer.
///
/// An instance that is not ready resolves to nil, so the routing falls back
/// to the parent's model and says so.
public struct CodeV2SubagentProviders: Sendable {
    /// Builds a backend client for a billing source and context tier.
    public typealias BackendClientFactory = @Sendable (_ billing: CodeV2SubagentBilling, _ contextTokens: Int?) -> (any AgentModelClient)?
    public typealias EnvConnector = @Sendable () async throws -> EnvServerConnection

    public var instances: [CodeV2.ProviderInstance]
    public var backend: BackendClientFactory?
    public var env: EnvConnector?
    /// The thread's folder: where a subscription child works.
    public var cwd: String?
    /// The approval mode a subscription child runs under.
    public var runtimeMode: CodeV2.RuntimeMode
    /// Approvals a subscription child asks for, shown to the reader.
    public var approvals: CodeV2ConnectedApprovalSink?

    public init(
        instances: [CodeV2.ProviderInstance],
        backend: BackendClientFactory?,
        env: EnvConnector?,
        cwd: String?,
        runtimeMode: CodeV2.RuntimeMode = .autoEdit,
        approvals: CodeV2ConnectedApprovalSink? = nil
    ) {
        self.instances = instances
        self.backend = backend
        self.env = env
        self.cwd = cwd
        self.runtimeMode = runtimeMode
        self.approvals = approvals
    }

    /// What the delegate tool asks for each routed child.
    public var resolver: SubagentProviderResolver {
        let providers = self
        return { selection in providers.resolve(selection) }
    }

    /// A short, stable description of what this resolver can serve, so the
    /// session's turn contract rebuilds when a provider comes or goes.
    public var fingerprint: String {
        let ready = instances.filter(Self.isUsable).map(\.id).sorted().joined(separator: ",")
        return [ready, cwd ?? "", runtimeMode.rawValue, backend == nil ? "-" : "b", env == nil ? "-" : "e"]
            .joined(separator: "|")
    }

    static func isUsable(_ instance: CodeV2.ProviderInstance) -> Bool {
        instance.kind == .alevr || instance.status == .ready
    }

    public func resolve(_ selection: CodeV2.ModelSelection) -> ResolvedSubagentProvider? {
        guard !selection.model.isEmpty, let kind = CodeV2.instanceKind(of: selection.instanceId) else { return nil }
        let instance = instances.first { $0.id == selection.instanceId }
        if let instance, !Self.isUsable(instance) { return nil }
        let tier = Self.tier(for: selection, in: instance)
        switch kind {
        case .alevr:
            guard let client = backend?(.alevr, selection.contextTokens) else { return nil }
            return ResolvedSubagentProvider(client: client, modelID: selection.model, tier: tier, billable: true)
        case .byok:
            guard instance != nil,
                  let lab = selection.instanceId.split(separator: ":").last.flatMap({ CodeV2.ByokProvider(rawValue: String($0)) }),
                  let client = backend?(.byok, selection.contextTokens)
            else { return nil }
            return ResolvedSubagentProvider(
                client: client, modelID: Self.canonical(selection.model, lab: lab), tier: tier, billable: false
            )
        case .claudeAgent, .codex, .acp:
            guard instance != nil, let env, let cwd else { return nil }
            let client = EnvServerSubagentClient(
                selection: selection, cwd: cwd, runtimeMode: runtimeMode, connect: env, approvals: approvals
            )
            return ResolvedSubagentProvider(client: client, modelID: selection.model, tier: nil, billable: false)
        }
    }

    /// The backend proxy client for routed children, from the session's own
    /// client (nil when it is not the backend's: tests, signed out).
    public static func backendFactory(from client: any AgentModelClient) -> BackendClientFactory? {
        guard let backend = client as? BackendCodeModelClient else { return nil }
        return { billing, contextTokens in
            backend.routed(billing: billing == .byok ? .byok : .alevr, contextTokens: contextTokens)
        }
    }

    /// `claude-sonnet-5` on an Anthropic key → `anthropic:claude-sonnet-5`.
    static func canonical(_ model: String, lab: CodeV2.ByokProvider) -> String {
        model.contains(":") || model.contains("/") ? model : "\(lab.rawValue):\(model)"
    }

    /// The selected tier's prices (for the run budget), or the model's
    /// smallest tier when the selection names none.
    static func tier(for selection: CodeV2.ModelSelection, in instance: CodeV2.ProviderInstance?) -> CodeV2.ContextTier? {
        guard let tiers = instance?.models?.first(where: { $0.id == selection.model })?.contextTiers, !tiers.isEmpty else {
            return nil
        }
        let sorted = CodeV2ContextMath.sorted(tiers)
        if let tokens = selection.contextTokens, let match = sorted.first(where: { $0.tokens == tokens }) { return match }
        return sorted.first
    }
}

/// Whose key pays for a routed child's calls through the backend proxy.
public enum CodeV2SubagentBilling: String, Sendable {
    case alevr
    case byok
}

// MARK: - A subscription child

/// An `AgentModelClient` whose "model" is a vendor agent on the env server.
///
/// The child's newest user message becomes a turn of its own env-server
/// session (opened on the first call, in the thread's folder); the vendor
/// agent does the work with its own tools, and the turn's closing message
/// comes back as the reply, with no tool calls, so the child finishes with
/// it. A follow-up (a completion check asking for more) is the next turn of
/// the same session. Stopping the child interrupts the vendor turn.
public final class EnvServerSubagentClient: AgentModelClient, @unchecked Sendable {
    public let selection: CodeV2.ModelSelection
    public let cwd: String
    private let runtimeMode: CodeV2.RuntimeMode
    private let connect: CodeV2SubagentProviders.EnvConnector
    private let approvals: CodeV2ConnectedApprovalSink?
    private let state = EnvSubagentState()

    public init(
        selection: CodeV2.ModelSelection,
        cwd: String,
        runtimeMode: CodeV2.RuntimeMode,
        connect: @escaping CodeV2SubagentProviders.EnvConnector,
        approvals: CodeV2ConnectedApprovalSink? = nil
    ) {
        self.selection = selection
        self.cwd = cwd
        self.runtimeMode = runtimeMode
        self.connect = connect
        self.approvals = approvals
    }

    /// The env-server session this child runs in, once opened.
    public var sessionId: String? {
        get async { await state.sessionId }
    }

    public func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await self.run(request, continuation: continuation)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { termination in
                guard case .cancelled = termination else { return }
                task.cancel()
            }
        }
    }

    static func prompt(from messages: [ModelMessage]) -> String? {
        for message in messages.reversed() {
            switch message {
            case let .user(text), let .userWithImages(text, _):
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            default:
                continue
            }
        }
        return nil
    }

    private func run(_ request: ModelTurnRequest, continuation: AsyncThrowingStream<ModelStreamEvent, Error>.Continuation) async throws {
        guard let prompt = Self.prompt(from: request.messages) else {
            continuation.yield(.turnCompleted(.endTurn))
            return
        }
        let connection: EnvServerConnection
        do {
            connection = try await connect()
        } catch {
            throw AgentModelClientError.unavailable(message: "The local environment server is not running, so \(selection.instanceId) cannot take this task.")
        }
        // Subscribe before anything is sent, so no event of this turn is missed.
        let events = await connection.events()
        let sessionId: String
        if let existing = await state.sessionId {
            sessionId = existing
        } else {
            sessionId = try await connection.sessionOpen(sessionId: nil, cwd: cwd, selection: selection)
            await state.setSession(sessionId)
        }
        let turnId = try await connection.turnStart(
            sessionId: sessionId, input: CodeV2.UserInput(text: prompt), selection: selection,
            routing: nil, runtimeMode: runtimeMode, interactionMode: .default
        )
        var collector = EnvSubagentTurnCollector(sessionId: sessionId, turnId: turnId)
        do {
            for await envelope in events {
                try Task.checkCancellation()
                guard envelope.sessionId == sessionId else { continue }
                for request in collector.apply(envelope.event) {
                    let sink = approvals
                    let label = selection.model
                    Task {
                        let decision = await sink?.ask(request, agentLabel: label) ?? .decline
                        try? await connection.approvalRespond(sessionId: sessionId, requestId: request.requestId, decision: decision)
                    }
                }
                if let finished = collector.finished {
                    let previous = await state.recordUsage(finished.usage)
                    if let usage = finished.usage {
                        continuation.yield(.usage(
                            inputTokens: max(0, usage.inputTokens - previous.input),
                            outputTokens: max(0, usage.outputTokens - previous.output)
                        ))
                    }
                    switch finished.outcome {
                    case .completed, .interrupted:
                        if !collector.text.isEmpty { continuation.yield(.textDelta(collector.text)) }
                        continuation.yield(.turnCompleted(.endTurn))
                        return
                    case .limited:
                        throw AgentModelClientError.quotaExhausted(
                            message: collector.stateMessage ?? "\(selection.instanceId) reached its plan limit."
                        )
                    case .failed:
                        throw AgentModelClientError.invalidResponse(
                            message: collector.stateMessage ?? "\(selection.instanceId) could not finish the task."
                        )
                    }
                }
            }
            throw AgentModelClientError.transport(message: "The local environment server disconnected.")
        } catch is CancellationError {
            try? await connection.turnInterrupt(sessionId: sessionId, turnId: turnId)
            throw CancellationError()
        }
    }
}

private actor EnvSubagentState {
    var sessionId: String?
    private var input = 0
    private var output = 0

    func setSession(_ id: String) { sessionId = id }

    /// The session's totals before this turn, then remembers the new ones.
    func recordUsage(_ usage: CodeV2.SessionUsage?) -> (input: Int, output: Int) {
        let previous = (input, output)
        if let usage {
            input = max(input, usage.inputTokens)
            output = max(output, usage.outputTokens)
        }
        return previous
    }
}

/// Follows one turn of an env-server session: its closing text, its
/// approval requests, and how it ended. Pure, so it is tested on its own.
struct EnvSubagentTurnCollector {
    struct Finished: Equatable {
        let outcome: CodeV2.TurnOutcome
        let usage: CodeV2.SessionUsage?
    }

    let sessionId: String
    let turnId: String
    private(set) var finished: Finished?
    private(set) var stateMessage: String?
    private var messages: [String: String] = [:]
    private var order: [String] = []
    private var asked: Set<String> = []

    init(sessionId: String, turnId: String) {
        self.sessionId = sessionId
        self.turnId = turnId
    }

    /// The turn's last top-level assistant message: the child's answer.
    var text: String {
        order.last.flatMap { messages[$0] }?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// Applies an event; answers the approval requests seen for the first time.
    mutating func apply(_ event: CodeV2.ServerEvent) -> [CodeV2.ApprovalRequest] {
        switch event {
        case let .itemAdded(item), let .itemUpdated(item):
            return take(item)
        case let .itemDelta(itemId, field, append):
            if field == "text", messages[itemId] != nil { messages[itemId, default: ""] += append }
            return []
        case let .sessionSnapshot(_, session):
            return session.items.flatMap { take($0) }
        case let .sessionState(_, _, message):
            if let message { stateMessage = message }
            return []
        case let .turnCompleted(id, outcome, usage) where id == turnId:
            finished = Finished(outcome: outcome, usage: usage)
            return []
        default:
            return []
        }
    }

    private mutating func take(_ item: CodeV2.TurnItem) -> [CodeV2.ApprovalRequest] {
        switch item {
        case let .assistantMessage(message) where message.turnId == turnId && message.agentId == nil:
            if messages[message.id] == nil { order.append(message.id) }
            messages[message.id] = message.text
            return []
        case let .approvalRequest(request) where !asked.contains(request.requestId):
            guard request.status == .pending, request.turnId == nil || request.turnId == turnId else { return [] }
            asked.insert(request.requestId)
            return [request]
        default:
            return []
        }
    }
}
