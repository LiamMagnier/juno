import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoScreenControl
import JunoSimulator
import Observation

/// A session's screen control: the presence row with Stop and Take over,
/// the live thumbnail, the step thumbnails and the services its tools use
/// (CODE_AGENT_SPEC §3.7). Owned by Lane C; `SessionController` holds one per
/// session.
///
/// Memory only. Frames and thumbnails exist so the reader can see what the
/// agent saw while it worked, and go when screen control stops (D-022).
@MainActor
@Observable
public final class ScreenControlModel {
    /// Who holds the screen across the app, and in what mode.
    public private(set) var presence: ScreenPresenceState = .idle
    /// The last step in this session, for the live thumbnail.
    public private(set) var latestStep: ScreenStepVisual?

    @ObservationIgnored private(set) var sessionID: CodeSessionID?
    @ObservationIgnored private var coordinator: ComputerUseCoordinator?
    @ObservationIgnored private var store: CodeSessionStore?
    @ObservationIgnored private var storeObserver: UUID?
    @ObservationIgnored private var streams: [Task<Void, Never>] = []
    @ObservationIgnored private var permissions: PermissionCoordinator?
    @ObservationIgnored private var trackerFeed: AsyncStream<SessionEvent>.Continuation?
    @ObservationIgnored private var grantChoiceUpdates: Task<Void, Never>?
    @ObservationIgnored private var simulatorAgent: SimulatorAgentService?
    /// Card details for previews and snapshots, which have no coordinator.
    @ObservationIgnored private var previewDetails: [String: ScreenApprovalDetail] = [:]
    /// Calls of one model turn, for the toolset's stop-at-first-failure rule.
    @ObservationIgnored public let turnTracker = ScreenTurnTracker()
    /// Simulator device consent, once per device per session.
    @ObservationIgnored public let simulatorConsents = SimulatorConsentBook()

    public init() {}

    /// Whether this session holds the screen now.
    public var isThisSessionActive: Bool {
        guard let sessionID, let holder = presence.holder else { return false }
        return holder.id == sessionID.value
    }

    /// "Juno is using Safari" — the row's sentence.
    public var sentence: String? {
        guard isThisSessionActive, let holder = presence.holder else { return nil }
        if presence.paused { return "You took over. Alevr is waiting." }
        let app = holder.appName.map { "Alevr is using \($0)" } ?? "Alevr can use the apps you grant"
        return presence.mode == .takeover ? app + " and has the whole screen" : app
    }

    // MARK: - Wiring

    /// Connects the model to its session. Idempotent per session.
    ///
    /// - Parameter permissions: the session's coordinator, so a screen
    ///   approval still on screen when screen control stops is answered
    ///   no instead of waiting on an action that can no longer run.
    public func bind(
        sessionID: CodeSessionID,
        coordinator: ComputerUseCoordinator?,
        store: CodeSessionStore,
        permissions: PermissionCoordinator? = nil
    ) {
        if self.sessionID == sessionID, self.coordinator === coordinator, self.store === store { return }
        unbind()
        self.sessionID = sessionID
        self.coordinator = coordinator
        self.store = store
        self.permissions = permissions
        let tracker = turnTracker
        let session = sessionID
        // One ordered feed: the tracker groups a turn's proposals by their
        // order, which a task per event does not keep.
        let (feed, continuation) = AsyncStream<SessionEvent>.makeStream()
        trackerFeed = continuation
        streams.append(Task {
            for await event in feed {
                await tracker.observe(event)
            }
        })
        Task { [weak self] in
            let token = await store.addObserver { update in
                guard case let .eventAppended(event) = update, event.sessionID == session else { return }
                continuation.yield(event)
            }
            let kept = await MainActor.run { () -> Bool in
                guard let self, self.store === store, self.sessionID == session else { return false }
                self.storeObserver = token
                return true
            }
            // Unbound while the observer was being added: take it back off.
            if !kept { await store.removeObserver(token) }
        }
        guard let coordinator else { return }
        streams.append(Task { [weak self] in
            let service = await coordinator.screenControlService
            for await state in await service.presence() {
                await MainActor.run { self?.receive(state) }
            }
        })
        streams.append(Task { [weak self] in
            let service = await coordinator.screenControlService
            for await step in await service.activity() where step.sessionID == session.value {
                await MainActor.run { self?.receive(step) }
            }
        })
    }

    public func unbind() {
        trackerFeed?.finish()
        trackerFeed = nil
        for task in streams { task.cancel() }
        streams = []
        permissions = nil
        if let storeObserver, let store {
            Task { await store.removeObserver(storeObserver) }
        }
        storeObserver = nil
        coordinator = nil
        store = nil
        sessionID = nil
        presence = .idle
        latestStep = nil
    }

    private func receive(_ state: ScreenPresenceState) {
        let wasActive = isThisSessionActive
        presence = state
        // Thumbnails fade with the grant.
        if wasActive, !isThisSessionActive {
            latestStep = nil
            ScreenStepThumbnails.shared.clear(session: sessionID?.value)
            denyPendingScreenApprovals()
        }
    }

    /// Screen control ended (Esc, Stop, the menu bar, switched off): a card
    /// for a screen action still waiting is answered no, so the turn is not
    /// left waiting on a click that can no longer happen. The tool reads the
    /// stop and ends the turn.
    private func denyPendingScreenApprovals() {
        guard let permissions else { return }
        Task {
            for request in await permissions.pendingApprovals
                where ComputerUseToolName.input.contains(request.toolName) && request.toolName != ComputerUseToolName.simulator
            {
                await permissions.resolve(approvalID: request.id, decision: .denied)
            }
        }
    }

    private func receive(_ step: ScreenActivity) {
        let visual = ScreenStepVisual(step)
        latestStep = visual
        if let callID = step.toolCallID {
            ScreenStepThumbnails.shared.store(visual, callID: callID, session: step.sessionID)
        }
    }

    /// The services the screen tools get for one turn contract.
    public func toolServices(
        context: WorkspaceContext,
        modelID: String,
        computerUseEnabled: Bool,
        workspaceRevision: @escaping @Sendable () async -> Int = { 0 }
    ) -> ScreenToolServices {
        if simulatorAgent == nil { simulatorAgent = SimulatorAgentService() }
        return ScreenToolServices(
            computer: context.computerUse,
            simulator: simulatorAgent,
            editorReader: AccessibilityEditorBufferReader.shared,
            imageBudget: ComputerUseRoutes.imageBudget(forModelID: modelID),
            computerUseEnabled: computerUseEnabled,
            turnTracker: turnTracker,
            simulatorConsents: simulatorConsents,
            workspaceRevision: workspaceRevision
        )
    }

    // MARK: - The reader's controls

    /// Stop: everything, everywhere, and the next screen call ends the turn.
    public func stop() async {
        await coordinator?.emergencyStop()
    }

    /// Take over: Juno waits until Resume.
    public func takeOver() async {
        guard let coordinator, let sessionID else { return }
        await coordinator.screenControlService.pause(sessionID: sessionID.value)
    }

    public func resume() async {
        guard let coordinator, let sessionID else { return }
        await coordinator.screenControlService.resume(sessionID: sessionID.value)
    }

    /// What a screen tool's approval card shows.
    public func approvalDetail(digest: String) async -> ScreenApprovalDetail? {
        if let preview = previewDetails[digest] { return preview }
        return await coordinator?.approvalDetail(digest: digest)
    }

    /// What a preview's card shows for an approval digest.
    func setPreviewApprovalDetail(_ detail: ScreenApprovalDetail, digest: String) {
        previewDetails[digest] = detail
    }

    /// A preview's presence, for snapshots of the row.
    func setPreviewPresence(_ state: ScreenPresenceState, sessionID: CodeSessionID, latest: ScreenStepVisual?) {
        self.sessionID = sessionID
        presence = state
        latestStep = latest
    }

    /// The reader's choices on a grant sheet, before Allow.
    ///
    /// Synchronous and chained, so the order of the reader's clicks is the
    /// order the service sees them, and ``settleGrantChoices()`` — awaited by
    /// Allow — cannot finish before the last untick has landed. Sent from a
    /// fresh task each, an app the reader unticked just before Allow could
    /// reach the service after the grant and be granted anyway.
    public func updateGrantChoices(proposalID: String, offers: [AppGrantOffer]) {
        let previous = grantChoiceUpdates
        let coordinator = self.coordinator
        grantChoiceUpdates = Task {
            await previous?.value
            await coordinator?.updateGrantChoices(proposalID: proposalID, offers: offers)
        }
    }

    /// Waits until every choice made on a grant sheet has reached the
    /// service. Allow calls it before answering the card.
    public func settleGrantChoices() async {
        await grantChoiceUpdates?.value
    }
}

/// One step as the reader sees it: what happened, and the after-frame with
/// the point marked.
public struct ScreenStepVisual: Equatable, Sendable {
    public var summary: String
    public var appName: String?
    public var thumbnail: Data?
    public var markedPoint: [Double]?
    public var succeeded: Bool
    public var at: Date

    public init(summary: String, appName: String?, thumbnail: Data?, markedPoint: [Double]?, succeeded: Bool, at: Date) {
        self.summary = summary
        self.appName = appName
        self.thumbnail = thumbnail
        self.markedPoint = markedPoint
        self.succeeded = succeeded
        self.at = at
    }

    init(_ step: ScreenActivity) {
        self.init(
            summary: step.summary,
            appName: step.appName,
            thumbnail: step.thumbnail,
            markedPoint: step.markedPoint,
            succeeded: step.succeeded,
            at: step.at
        )
    }
}

/// After-frame thumbnails by tool call, for the thread's step rows, which are
/// built from events and cannot reach a session's model. Memory only, and
/// cleared when the session's screen control ends.
@MainActor
@Observable
public final class ScreenStepThumbnails {
    public static let shared = ScreenStepThumbnails()

    private var byCall: [String: ScreenStepVisual] = [:]
    @ObservationIgnored private var sessionOfCall: [String: String] = [:]

    public func visual(for callID: String) -> ScreenStepVisual? {
        byCall[callID]
    }

    func store(_ visual: ScreenStepVisual, callID: String, session: String) {
        byCall[callID] = visual
        sessionOfCall[callID] = session
        if byCall.count > 300, let oldest = byCall.min(by: { $0.value.at < $1.value.at })?.key {
            byCall[oldest] = nil
            sessionOfCall[oldest] = nil
        }
    }

    func clear(session: String?) {
        guard let session else { return }
        for (call, owner) in sessionOfCall where owner == session {
            byCall[call] = nil
            sessionOfCall[call] = nil
        }
    }
}
