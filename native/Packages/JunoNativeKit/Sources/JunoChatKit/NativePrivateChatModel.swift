import Foundation
import JunoCore
import JunoSync
import Observation

/// An incognito conversation, held entirely in memory.
///
/// **Why this is a separate model and not a flag on `NativeConversationModel`.**
/// That model's whole job is to keep a local SQLite mirror and an outbox in step
/// with the server: `sendMessage` requires an existing conversation row, appends
/// the user turn through `/api/conversations/{id}/messages` *before* generating,
/// and enqueues mutations for sync. Every one of those steps is a write, and an
/// incognito chat's defining property is that none of them happen. Threading a
/// `private` boolean through that path would have meant auditing each write for
/// "unless private" — and the first one missed is a chat the reader was promised
/// would not be saved, saved.
///
/// So nothing here persists. The transcript lives in this object, the request
/// carries the whole history each turn (the server keeps none), and closing the
/// session drops it. There is no row, no outbox entry, no sync, and no way to
/// reopen it — which is what incognito means.
///
/// What is *not* different: quota, spend and moderation still run server-side, as
/// they do on the web. Incognito is not a way around the account's limits.
@MainActor
@Observable
public final class NativePrivateChatModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case streaming
        case failed(String)
    }

    /// One turn as the reader sees it. Deliberately not `NativeChatMessage`: that
    /// type carries `revision`, `isPending` and a `conversationID`, all of which
    /// describe a stored row and none of which exist here.
    public struct Turn: Identifiable, Equatable, Sendable {
        public let id: String
        public let role: NativeChatPrivateTurn.Role
        public var content: String
        public var reasoning: String?
        public var model: String?

        public init(
            id: String = UUID().uuidString.lowercased(),
            role: NativeChatPrivateTurn.Role,
            content: String,
            reasoning: String? = nil,
            model: String? = nil
        ) {
            self.id = id
            self.role = role
            self.content = content
            self.reasoning = reasoning
            self.model = model
        }
    }

    public private(set) var turns: [Turn] = []
    public private(set) var phase: Phase = .idle
    public private(set) var lastErrorDescription: String?

    public var isStreaming: Bool { phase == .streaming }
    /// True while there is nothing to lose by closing.
    public var isEmpty: Bool { turns.isEmpty }

    private let client: any NativePrivateChatSending
    private var accountID: AccountID?
    private var generation: Task<Void, Never>?

    public init(client: any NativePrivateChatSending) {
        self.client = client
    }

    public func start(for accountID: AccountID) {
        guard self.accountID != accountID else { return }
        reset()
        self.accountID = accountID
    }

    public func stop() {
        reset()
        accountID = nil
    }

    /// Drops the transcript. Called on close, on sign-out, and on account change —
    /// the three moments an incognito chat must stop existing.
    public func reset() {
        generation?.cancel()
        generation = nil
        turns = []
        phase = .idle
        lastErrorDescription = nil
    }

    public func send(
        prompt: String,
        modelID: String,
        reasoningEffort: NativeReasoningEffort?
    ) {
        let content = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, let accountID, phase != .streaming else { return }

        turns.append(Turn(role: .user, content: content))
        let assistant = Turn(role: .assistant, content: "", model: modelID)
        turns.append(assistant)
        phase = .streaming
        lastErrorDescription = nil

        // The history sent is every turn EXCEPT the empty assistant placeholder we
        // just appended for the UI to stream into — sending a blank assistant turn
        // makes the model answer its own silence.
        let history = turns.dropLast().map {
            NativeChatPrivateTurn(role: $0.role, content: $0.content)
        }
        let request = NativeChatPrivateGenerationRequest(
            modelID: modelID,
            reasoningEffort: reasoningEffort,
            generationID: UUID().uuidString.lowercased(),
            history: Array(history)
        )

        generation = Task { [weak self] in
            await self?.consume(request, accountID: accountID, assistantID: assistant.id)
        }
    }

    public func stopGeneration() {
        generation?.cancel()
        generation = nil
        if phase == .streaming { phase = .idle }
    }

    private func consume(
        _ request: NativeChatPrivateGenerationRequest,
        accountID: AccountID,
        assistantID: String
    ) async {
        do {
            let events = try await client.privateGenerationEvents(request, for: accountID)
            for try await event in events {
                guard !Task.isCancelled else { break }
                apply(event, to: assistantID)
            }
            if phase == .streaming { phase = .idle }
        } catch is CancellationError {
            if phase == .streaming { phase = .idle }
        } catch {
            let message = NativeFailureMessage.presentable(error)
            lastErrorDescription = message
            phase = .failed(message)
        }
    }

    private func apply(_ event: NativeChatServerEvent, to assistantID: String) {
        guard let index = turns.firstIndex(where: { $0.id == assistantID }) else { return }
        switch event {
        case .textDelta(let text):
            turns[index].content.append(text)
        case .reasoningDelta(let text):
            turns[index].reasoning = (turns[index].reasoning ?? "") + text
        case .completed(let message):
            // The server's own final text wins over the accumulated deltas, exactly
            // as the persisted path does — a reconnect can duplicate a delta.
            if !message.content.isEmpty { turns[index].content = message.content }
            if let reasoning = message.reasoning { turns[index].reasoning = reasoning }
            if let model = message.model { turns[index].model = model }
            phase = .idle
        case .failed(let message, _, _, _):
            lastErrorDescription = message
            phase = .failed(message)
        default:
            break
        }
    }
}

/// The one capability an incognito session needs from the transport.
///
/// A protocol rather than the concrete client so the model is testable without a
/// network, and so nothing here can reach the persisting endpoints by accident.
public protocol NativePrivateChatSending: Sendable {
    func privateGenerationEvents(
        _ request: NativeChatPrivateGenerationRequest,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<NativeChatServerEvent, any Error>
}
