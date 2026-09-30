import Foundation
import JunoCodeCore

/// Per-session gate for the two things the agent can wait on the reader for
/// besides permission: an answer to a question (`ask_user`) and a verdict on
/// a plan (`exit_plan`).
///
/// It mirrors ``PermissionCoordinator``'s shape — the tool truly suspends on
/// a continuation, a request expires closed, and cancelling the run resolves
/// whatever is pending — but it grants nothing. An answer is information the
/// tool hands back to the model; approving a plan is recorded as a decision
/// the session acts on after the run, with the permission level the reader
/// picked. Neither touches the permission coordinator.
///
/// Every request and its resolution is appended to the session's transcript,
/// in order, before the tool resumes: that is what a phone following the
/// session reads to show the card and answer it later.
public actor QuestionCoordinator {
    public static let timeToLiveSeconds: Double = 30 * 60

    public enum Update: Sendable {
        case questionRequested(QuestionRequest)
        case questionResolved(QuestionResolvedEvent)
        case planSubmitted(PlanApprovalRequest)
        case planResolved(PlanResolvedEvent)
    }

    private let sessionID: CodeSessionID
    private let store: CodeSessionStore?
    private let timeToLive: Double
    /// Whether anything else — a permission prompt — still waits on the
    /// reader, so resolving a question does not clear a waiting state an
    /// approval card still needs.
    private let otherWaitsPending: @Sendable () async -> Bool

    private var questions: [String: QuestionRequest] = [:]
    private var questionWaiters: [String: CheckedContinuation<QuestionResolution, Never>] = [:]
    private var earlyQuestionResolutions: [String: QuestionResolution] = [:]
    private var plans: [String: PlanApprovalRequest] = [:]
    private var planWaiters: [String: CheckedContinuation<PlanDecision, Never>] = [:]
    private var earlyPlanDecisions: [String: PlanDecision] = [:]
    private var observers: [UUID: @Sendable (Update) -> Void] = [:]

    public init(
        sessionID: CodeSessionID,
        store: CodeSessionStore?,
        timeToLive: Double = QuestionCoordinator.timeToLiveSeconds,
        otherWaitsPending: @escaping @Sendable () async -> Bool = { false }
    ) {
        self.sessionID = sessionID
        self.store = store
        self.timeToLive = timeToLive
        self.otherWaitsPending = otherWaitsPending
    }

    public var pendingQuestions: [QuestionRequest] {
        questions.values.sorted { $0.requestedAt < $1.requestedAt }
    }

    public var pendingPlans: [PlanApprovalRequest] {
        plans.values.sorted { $0.requestedAt < $1.requestedAt }
    }

    @discardableResult
    public func addObserver(_ observer: @escaping @Sendable (Update) -> Void) -> UUID {
        let id = UUID()
        observers[id] = observer
        return id
    }

    public func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }

    // MARK: - Questions

    /// Asks and waits. Returns `.cancelled` at once for a run already stopped.
    public func ask(_ asked: [UserQuestion], toolCallID: String?) async -> QuestionResolution {
        guard !Task.isCancelled else { return .cancelled }
        let now = Date()
        let request = QuestionRequest(
            sessionID: sessionID,
            toolCallID: toolCallID,
            questions: asked,
            requestedAt: now,
            expiresAt: now.addingTimeInterval(timeToLive)
        )
        questions[request.id] = request
        await record(.questionRequested(request))
        notify(.questionRequested(request))
        scheduleExpiry(request.id, at: request.expiresAt) { coordinator, id in
            await coordinator.resolveQuestion(id, .expired)
        }
        let id = request.id
        let resolution = await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<QuestionResolution, Never>) in
                if let early = earlyQuestionResolutions.removeValue(forKey: id) {
                    continuation.resume(returning: early)
                } else {
                    questionWaiters[id] = continuation
                }
            }
        } onCancel: {
            Task { await self.resolveQuestion(id, .cancelled) }
        }
        return resolution
    }

    /// The reader's answers. False when nothing is waiting under that id —
    /// already answered, expired, or from an older launch.
    @discardableResult
    public func answer(requestID: String, answers: [QuestionAnswer]) async -> Bool {
        let given = answers.filter { !$0.isEmpty }
        guard !given.isEmpty else { return await resolveQuestion(requestID, .declined) }
        return await resolveQuestion(requestID, .answered(given))
    }

    @discardableResult
    public func decline(requestID: String) async -> Bool {
        await resolveQuestion(requestID, .declined)
    }

    @discardableResult
    private func resolveQuestion(_ id: String, _ resolution: QuestionResolution) async -> Bool {
        guard questions.removeValue(forKey: id) != nil else { return false }
        let event = QuestionResolvedEvent(requestID: id, resolution: resolution)
        // Recorded before the tool resumes, so the transcript never shows an
        // answer after the result that used it.
        await record(.questionResolved(event))
        notify(.questionResolved(event))
        if let waiter = questionWaiters.removeValue(forKey: id) {
            waiter.resume(returning: resolution)
        } else {
            earlyQuestionResolutions[id] = resolution
        }
        return true
    }

    // MARK: - Plans

    public func submitPlan(_ plan: String, toolCallID: String?) async -> PlanDecision {
        guard !Task.isCancelled else { return .cancelled }
        let now = Date()
        let request = PlanApprovalRequest(
            sessionID: sessionID,
            toolCallID: toolCallID,
            plan: plan,
            requestedAt: now,
            expiresAt: now.addingTimeInterval(timeToLive)
        )
        plans[request.id] = request
        await record(.planSubmitted(request))
        notify(.planSubmitted(request))
        scheduleExpiry(request.id, at: request.expiresAt) { coordinator, id in
            await coordinator.resolvePlan(id, .expired)
        }
        let id = request.id
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<PlanDecision, Never>) in
                if let early = earlyPlanDecisions.removeValue(forKey: id) {
                    continuation.resume(returning: early)
                } else {
                    planWaiters[id] = continuation
                }
            }
        } onCancel: {
            Task { await self.resolvePlan(id, .cancelled) }
        }
    }

    /// Approves with the level the reader chose on the card. The session
    /// applies it after the run ends; nothing here raises anything.
    @discardableResult
    public func approvePlan(requestID: String, permissionMode: PermissionMode) async -> Bool {
        await resolvePlan(requestID, .approved(permissionMode: permissionMode))
    }

    @discardableResult
    public func keepPlanning(requestID: String, feedback: String?) async -> Bool {
        let trimmed = feedback?.trimmingCharacters(in: .whitespacesAndNewlines)
        return await resolvePlan(requestID, .keepPlanning(feedback: trimmed?.isEmpty == false ? trimmed : nil))
    }

    @discardableResult
    private func resolvePlan(_ id: String, _ decision: PlanDecision) async -> Bool {
        guard plans.removeValue(forKey: id) != nil else { return false }
        let event = PlanResolvedEvent(requestID: id, decision: decision)
        await record(.planResolved(event))
        notify(.planResolved(event))
        if let waiter = planWaiters.removeValue(forKey: id) {
            waiter.resume(returning: decision)
        } else {
            earlyPlanDecisions[id] = decision
        }
        return true
    }

    // MARK: - Ending

    /// Resolves everything pending as cancelled: the run was stopped.
    public func cancelAll() async {
        for id in Array(questions.keys) { await resolveQuestion(id, .cancelled) }
        for id in Array(plans.keys) { await resolvePlan(id, .cancelled) }
    }

    /// Resolves what has outlived its expiry.
    public func sweepExpired(now: Date = Date()) async {
        for request in questions.values where request.expiresAt <= now {
            await resolveQuestion(request.id, .expired)
        }
        for request in plans.values where request.expiresAt <= now {
            await resolvePlan(request.id, .expired)
        }
    }

    private func scheduleExpiry(
        _ id: String,
        at date: Date,
        _ expire: @escaping @Sendable (QuestionCoordinator, String) async -> Void
    ) {
        let delay = max(0, date.timeIntervalSinceNow)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self else { return }
            await expire(self, id)
        }
    }

    // MARK: - Recording

    private var hasPending: Bool { !questions.isEmpty || !plans.isEmpty }

    private func record(_ payload: SessionEventPayload) async {
        guard let store else { return }
        _ = try? await store.appendEvent(sessionID: sessionID, payload: payload)
        let waiting = hasPending
        let others = waiting ? false : await otherWaitsPending()
        _ = try? await store.updateSession(id: sessionID) { session in
            if waiting {
                session.hasPendingApproval = true
                session.status = .waitingForApproval
            } else if !others {
                session.hasPendingApproval = false
                if session.status == .waitingForApproval {
                    session.status = .running
                }
            }
        }
    }

    private func notify(_ update: Update) {
        for observer in observers.values {
            observer(update)
        }
    }
}
