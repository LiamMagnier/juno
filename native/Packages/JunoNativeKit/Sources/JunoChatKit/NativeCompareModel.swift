import Foundation
import JunoCore
import JunoSync
import Observation

/// One prompt, several models, answering at once — the Swift half of
/// `src/components/compare/use-compare.ts`.
///
/// Each pane runs the SAME `/api/chat` route in private (ephemeral) mode: the
/// transport incognito already uses. Nothing is persisted, while spend, quota and
/// moderation are recorded server-side exactly as they are for a private
/// message. One request per pane, all in flight together, each cancellable on its
/// own through `/api/chat/cancel`.
///
/// **Why the run token.** A pane can be restarted — the reader changes its model,
/// or retries — while its previous stream is still delivering frames. Without a
/// per-pane token, the dying run's last delta lands in the new run's content and
/// the pane shows two answers spliced together. Every write is therefore gated on
/// the token that was current when the run started; a superseded run's writes are
/// dropped rather than applied.
///
/// **Why stop is not just cancellation.** Cancelling the local task abandons the
/// stream but the generation keeps running — and billing — on the server. So Stop
/// calls the cancel endpoint first and only falls back to a local abort, which is
/// what makes the partial answer and the correct spend both real.
@MainActor
@Observable
public final class NativeCompareModel {

    /// One column of the comparison. The id is the pane's, not the model's: two
    /// panes may hold the same model, and a pane keeps its identity when its
    /// model changes.
    public struct Pane: Identifiable, Equatable, Sendable {
        public let id: String
        public var modelID: String

        public init(id: String, modelID: String) {
            self.id = id
            self.modelID = modelID
        }
    }

    public struct Run: Equatable, Sendable {
        public enum Status: Equatable, Sendable {
            case idle, submitting, thinking, writing, done, error

            public var isStreaming: Bool {
                self == .submitting || self == .thinking || self == .writing
            }
        }

        /// The single recovery that fits the failure. Two buttons on an error is
        /// the reader being asked to diagnose it.
        public enum Recovery: Equatable, Sendable {
            case upgrade
            case retry
        }

        public var status: Status = .idle
        public var content: String = ""
        public var reasoning: String = ""
        /// A human sentence naming the cause, in the house error voice.
        public var errorMessage: String?
        public var errorAction: Recovery?
        public var startedAt: Date?
        /// Wall-clock time of the finished run.
        public var elapsed: TimeInterval?
        public var promptTokens: Int?
        public var completionTokens: Int?
        /// What this answer actually cost. The server's figure when it sent one;
        /// otherwise estimated from the streamed token counts and the manifest's
        /// published prices — which is why the UI prefixes it with a tilde.
        public var costUsd: Double?
        public var finishReason: NativeChatFinishReason?

        public init() {}

        public var isStreaming: Bool { status.isStreaming }
    }

    public private(set) var panes: [Pane]
    public private(set) var runs: [String: Run] = [:]
    /// True between pressing Stop and the last pane settling. The button is
    /// disabled through it, because a second Stop does nothing and a control that
    /// does nothing reads as broken.
    public private(set) var stopping = false
    /// The prompt currently on the board, or nil before the first run.
    public private(set) var prompt: String?

    public var anyStreaming: Bool { runs.values.contains(where: \.isStreaming) }

    private let client: any NativeCompareSending
    private let pricing: @MainActor @Sendable (String) -> NativeModelPricing?
    private var accountID: AccountID?
    private var tasks: [String: Task<Void, Never>] = [:]
    private var generations: [String: String] = [:]

    /// The server-side generation a pane is currently streaming, or nil when it
    /// is not streaming.
    ///
    /// Exposed because a test that wants to drive *one* pane's stream otherwise
    /// has to guess which recorded request belongs to it — and the panes are
    /// dispatched concurrently, so request order does not match pane order.
    /// Guessing produced a test that emitted a frame at the wrong pane and
    /// failed intermittently on the right one.
    public func generationID(forPane paneID: String) -> String? {
        generations[paneID]
    }
    private var tokens: [String: Int] = [:]
    private var sequence = 0
    private var paneSequence = 0
    private var stopFallback: Task<Void, Never>?

    public static let minimumPanes = 2
    public static let maximumPanes = 3

    /// - Parameter pricing: the manifest's published prices for a model id, used
    ///   only when the server sends no cost. Supplying nothing simply means a run
    ///   with no server figure shows tokens and no price, which is honest.
    public init(
        client: any NativeCompareSending,
        pricing: @escaping @MainActor @Sendable (String) -> NativeModelPricing? = { _ in nil }
    ) {
        self.client = client
        self.pricing = pricing
        self.panes = []
    }

    // MARK: - Session

    public func start(for accountID: AccountID, models: [String]) {
        if self.accountID != accountID { reset() }
        self.accountID = accountID
        if panes.isEmpty {
            panes = models.prefix(Self.maximumPanes).map { Pane(id: nextPaneID(), modelID: $0) }
        }
    }

    /// Drops every run and every in-flight request. Called on sign-out and on
    /// leaving the screen — a comparison is not saved, so there is nothing to
    /// come back to.
    public func reset() {
        for (paneID, task) in tasks {
            cancelServerSide(paneID)
            task.cancel()
        }
        tasks = [:]
        generations = [:]
        tokens = [:]
        runs = [:]
        prompt = nil
        stopping = false
        stopFallback?.cancel()
        stopFallback = nil
    }

    // MARK: - Panes

    public var canAddPane: Bool { panes.count < Self.maximumPanes && !anyStreaming }
    public var canRemovePane: Bool { panes.count > Self.minimumPanes }

    public func addPane(modelID: String) {
        guard canAddPane else { return }
        let pane = Pane(id: nextPaneID(), modelID: modelID)
        panes.append(pane)
        // Join the race late: the new pane answers the prompt already on the
        // board, so the column is not an empty slot next to two answers.
        if let prompt { run(paneID: pane.id, modelID: modelID, prompt: prompt) }
    }

    public func removePane(_ paneID: String) {
        guard canRemovePane else { return }
        discard(paneID)
        panes.removeAll { $0.id == paneID }
    }

    public func setModel(_ modelID: String, for paneID: String) {
        guard let index = panes.firstIndex(where: { $0.id == paneID }),
            panes[index].modelID != modelID
        else { return }
        panes[index].modelID = modelID
        // Same prompt, new mind. Rerunning is what stops the pane showing one
        // model's answer under another model's name.
        if let prompt {
            run(paneID: paneID, modelID: modelID, prompt: prompt)
        } else {
            resetPane(paneID)
        }
    }

    // MARK: - Running

    public func submit(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !anyStreaming else { return }
        prompt = trimmed
        for pane in panes { run(paneID: pane.id, modelID: pane.modelID, prompt: trimmed) }
    }

    public func retry(_ paneID: String) {
        guard let prompt, let pane = panes.first(where: { $0.id == paneID }) else { return }
        run(paneID: paneID, modelID: pane.modelID, prompt: prompt)
    }

    /// Stops every in-flight pane.
    ///
    /// The cancel endpoint is preferred — the server closes the stream with the
    /// partial answer and the correct spend. The local abort is the fallback for
    /// a cancel that could not be confirmed, and a five-second deadline covers
    /// the case where the endpoint neither confirms nor fails.
    public func stopAll() {
        guard !tasks.isEmpty else { return }
        stopping = true
        for paneID in tasks.keys { cancelServerSide(paneID, abortIfUnconfirmed: true) }
        stopFallback?.cancel()
        stopFallback = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard let self, !Task.isCancelled else { return }
            for task in self.tasks.values { task.cancel() }
        }
    }

    private func run(paneID: String, modelID: String, prompt: String) {
        guard let accountID else { return }
        sequence += 1
        let token = sequence
        tokens[paneID] = token

        tasks[paneID]?.cancel()
        let generationID = UUID().uuidString.lowercased()
        generations[paneID] = generationID

        var starting = Run()
        starting.status = .submitting
        starting.startedAt = Date()
        runs[paneID] = starting

        let request = NativeChatPrivateGenerationRequest(
            modelID: modelID,
            reasoningEffort: nil,
            generationID: generationID,
            // The private branch carries the whole conversation; a comparison is
            // exactly one turn, so this is the prompt and nothing else.
            history: [NativeChatPrivateTurn(role: .user, content: prompt)]
        )

        tasks[paneID] = Task { [weak self] in
            await self?.consume(request, paneID: paneID, modelID: modelID, token: token, accountID: accountID)
        }
    }

    private func consume(
        _ request: NativeChatPrivateGenerationRequest,
        paneID: String,
        modelID: String,
        token: Int,
        accountID: AccountID
    ) async {
        let startedAt = Date()
        var sawTerminal = false
        do {
            let events = try await client.privateGenerationEvents(request, for: accountID)
            for try await event in events {
                if Task.isCancelled { break }
                if apply(event, paneID: paneID, modelID: modelID, token: token, startedAt: startedAt) {
                    sawTerminal = true
                }
            }
            if !sawTerminal, !Task.isCancelled {
                fail(
                    paneID: paneID,
                    token: token,
                    message: "The connection dropped before this model finished. Run it again.",
                    action: .retry,
                    startedAt: startedAt
                )
            }
        } catch is CancellationError {
            settleStopped(paneID: paneID, token: token, startedAt: startedAt)
        } catch {
            if Task.isCancelled {
                settleStopped(paneID: paneID, token: token, startedAt: startedAt)
            } else {
                fail(
                    paneID: paneID,
                    token: token,
                    message: NativeFailureMessage.presentable(error),
                    action: recovery(for: error),
                    startedAt: startedAt
                )
            }
        }
        if tokens[paneID] == token { tasks[paneID] = nil }
        if !anyStreaming {
            stopping = false
            stopFallback?.cancel()
            stopFallback = nil
        }
    }

    /// - Returns: whether this was a terminal frame.
    @discardableResult
    private func apply(
        _ event: NativeChatServerEvent,
        paneID: String,
        modelID: String,
        token: Int,
        startedAt: Date
    ) -> Bool {
        guard tokens[paneID] == token, var run = runs[paneID] else { return false }
        switch event {
        case .activity(let activity):
            switch activity.kind {
            case .reasoning:
                if run.status != .writing { run.status = .thinking }
            case .write:
                run.status = .writing
            default:
                if run.status == .submitting { run.status = .thinking }
            }
        case .reasoningDelta(let text):
            if run.status != .writing { run.status = .thinking }
            run.reasoning += text
        case .textDelta(let text):
            run.status = .writing
            run.content += text
        case .completed(let message):
            run.status = .done
            if !message.content.isEmpty { run.content = message.content }
            if let reasoning = message.reasoning { run.reasoning = reasoning }
            run.elapsed = Date().timeIntervalSince(startedAt)
            run.promptTokens = message.promptTokens
            run.completionTokens = message.completionTokens
            run.costUsd = message.costUsd ?? estimatedCost(
                modelID: modelID,
                input: message.promptTokens,
                output: message.completionTokens
            )
            run.finishReason = message.finishReason
            runs[paneID] = run
            return true
        case .failed(let message, let reason, _, _):
            run.status = .error
            run.errorMessage = message
            run.errorAction = .retry
            run.elapsed = Date().timeIntervalSince(startedAt)
            run.finishReason = reason
            runs[paneID] = run
            return true
        default:
            break
        }
        runs[paneID] = run
        return false
    }

    private func fail(
        paneID: String,
        token: Int,
        message: String,
        action: Run.Recovery,
        startedAt: Date
    ) {
        guard tokens[paneID] == token, var run = runs[paneID] else { return }
        run.status = .error
        run.errorMessage = message
        run.errorAction = action
        run.elapsed = Date().timeIntervalSince(startedAt)
        runs[paneID] = run
    }

    /// Stopped locally after the cancel endpoint could not confirm. Whatever
    /// streamed is kept and the pane is closed out honestly — an answer the
    /// reader watched arrive must not vanish because they pressed Stop.
    private func settleStopped(paneID: String, token: Int, startedAt: Date) {
        guard tokens[paneID] == token, var run = runs[paneID] else { return }
        if run.content.isEmpty {
            run.status = .error
            run.errorMessage = "Stopped before the model answered."
            run.errorAction = .retry
        } else {
            run.status = .done
        }
        run.elapsed = Date().timeIntervalSince(startedAt)
        run.finishReason = .userStopped
        runs[paneID] = run
    }

    private func resetPane(_ paneID: String) {
        tasks[paneID]?.cancel()
        tasks[paneID] = nil
        sequence += 1
        tokens[paneID] = sequence
        runs[paneID] = Run()
    }

    /// Drops a pane's run entirely — used when the pane itself goes away. The
    /// server-side generation is cancelled too: an abandoned private stream would
    /// otherwise run, and bill, to completion for a column nobody is looking at.
    private func discard(_ paneID: String) {
        cancelServerSide(paneID)
        tasks[paneID]?.cancel()
        tasks[paneID] = nil
        generations[paneID] = nil
        sequence += 1
        tokens[paneID] = sequence
        runs[paneID] = nil
    }

    private func cancelServerSide(_ paneID: String, abortIfUnconfirmed: Bool = false) {
        guard let generationID = generations[paneID], let accountID else { return }
        Task { [weak self, client] in
            let cancelled = (try? await client.cancelGeneration(id: generationID, for: accountID)) ?? false
            guard abortIfUnconfirmed, !cancelled else { return }
            await MainActor.run { self?.tasks[paneID]?.cancel() }
        }
    }

    /// The web's client-side fallback, using the manifest's published prices.
    /// Returns nil when either the usage or the price is missing, because a cost
    /// computed from a zero is a cost of zero, and free is a claim.
    private func estimatedCost(modelID: String, input: Int?, output: Int?) -> Double? {
        guard let pricing = pricing(modelID), input != nil || output != nil else { return nil }
        let cost = Double(input ?? 0) / 1_000_000 * pricing.inputPerMillion
            + Double(output ?? 0) / 1_000_000 * pricing.outputPerMillion
        return cost > 0 ? cost : nil
    }

    private func recovery(for error: any Error) -> Run.Recovery {
        // 402 is the plan wall, and the only failure whose fix is not "try
        // again". Everything else retries.
        if case .server(let status, _, _, _) = error as? NativeChatAPIError ?? .malformedResponse,
            status == 402
        { return .upgrade }
        return .retry
    }

    private func nextPaneID() -> String {
        paneSequence += 1
        return "pane-\(paneSequence)"
    }
}

/// What a comparison needs from the transport: start a private turn, and stop
/// one. A protocol rather than the concrete client so the model is testable with
/// no network, and so nothing here can reach a persisting endpoint by accident.
public protocol NativeCompareSending: NativePrivateChatSending {
    func cancelGeneration(id: String, for accountID: AccountID) async throws -> Bool
}

extension NativeChatAPIClient: NativeCompareSending {}
