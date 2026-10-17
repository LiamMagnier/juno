import Foundation
import JunoCodeCore
import JunoScreenControl

/// The reader's say on what connected agents do (Code v2 SPEC §3.12). The app
/// shows these as cards; every answer is the reader's, never the agent's.
public protocol ComputerBridgeApproving: Sendable {
    /// The first screen call of a connected agent's session: may it use apps
    /// on this Mac at all? (Starts screen control for that session.)
    func allowAgent(sessionID: String, title: String) async -> Bool
    /// One card: a grant proposal, or an input action with its target.
    func approve(_ detail: ScreenApprovalDetail, summary: String, sessionID: String) async -> Bool
    /// A call was refused because macOS has not given Alevr a grant. Not a
    /// question: the app shows the fix beside the thread and nothing waits.
    func permissionsMissing(_ status: ComputerUsePermissionStatus, sessionID: String) async
}

public extension ComputerBridgeApproving {
    func permissionsMissing(_ status: ComputerUsePermissionStatus, sessionID: String) async {}
}

/// The screen-control service as the bridge needs it: the agent surface
/// plus starting and ending a session's screen control.
public protocol ScreenControlSessionHosting: ScreenControlling {
    func activate(sessionID: String, title: String, kind: ScreenControlHolder.Kind, threadID: String?) async throws
    func deactivate(sessionID: String) async
    func isActive(sessionID: String) async -> Bool
    /// A bridged call is in flight: the session's hold is never reclaimed as idle meanwhile.
    func beginCall(sessionID: String) async
    func endCall(sessionID: String) async
}

extension ScreenControlService: ScreenControlSessionHosting {}

/// The reader's settings for connected agents, persisted beside the lock.
public struct ComputerUseBridgeSettings: Codable, Hashable, Sendable {
    /// Tools are discoverable by default; session and app consent still ask.
    public var connectedAgentsEnabled: Bool
    /// Apps whose ordinary input runs without a card in Auto-edit and Auto
    /// (never the floor, never in Ask). Bundle ids, lowercased.
    public var allowlist: Set<String>

    public init(connectedAgentsEnabled: Bool = true, allowlist: Set<String> = []) {
        self.connectedAgentsEnabled = connectedAgentsEnabled
        self.allowlist = Set(allowlist.map { $0.lowercased() })
    }

    public func allows(bundleID: String) -> Bool { allowlist.contains(bundleID.lowercased()) }

    public static var defaultURL: URL { DesktopLockFile.defaultDirectory.appendingPathComponent("settings.json") }

    public static func load(from url: URL = defaultURL) -> ComputerUseBridgeSettings {
        guard let data = try? Data(contentsOf: url),
              let settings = try? JSONDecoder().decode(ComputerUseBridgeSettings.self, from: data)
        else { return ComputerUseBridgeSettings() }
        return settings
    }

    public func save(to url: URL = defaultURL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        try encoder.encode(self).write(to: url, options: .atomic)
    }
}

/// Runs connected agents' `computer_use` calls on this Mac (Code v2 SPEC
/// §3.12): the same service, grants, floor, overlay and stop as the app's
/// own sessions, with the session's v2 runtime mode deciding what asks
/// (``ComputerUseAccessPolicy``).
public actor ComputerBridgeExecutor: ComputerBridgeHandling {
    private let service: any ScreenControlSessionHosting
    private let approver: any ComputerBridgeApproving
    private let permissions: @Sendable () -> ComputerUsePermissionStatus
    private let settings: @Sendable () -> ComputerUseBridgeSettings
    private let screenshots: ComputerScreenshotStore?
    private let lockHolder: @Sendable () -> CodeV2.DesktopLockRecord?
    private let now: @Sendable () -> Date
    /// How long a call waits for another conversation to finish with its
    /// app before it is refused, naming that conversation.
    private let busyWait: Duration
    private let busyPoll: Duration
    private var frames: [String: PixelSize] = [:]
    /// The coordinate convention each latest frame was captured under. The
    /// service maps a point through the frame it has, so a call in another
    /// convention than that frame's is converted to the frame's, not to its own.
    private var frameConventions: [String: CoordinateConvention] = [:]
    private var startedSessions: Set<String> = []
    private var allowedSessions: Set<String> = []
    /// When a stopped session last called (it was refused).
    private var stoppedCalls: [String: Date] = [:]

    public init(
        service: any ScreenControlSessionHosting,
        approver: any ComputerBridgeApproving,
        permissions: @escaping @Sendable () -> ComputerUsePermissionStatus,
        settings: @escaping @Sendable () -> ComputerUseBridgeSettings = { ComputerUseBridgeSettings.load() },
        screenshots: ComputerScreenshotStore? = .shared,
        lockHolder: @escaping @Sendable () -> CodeV2.DesktopLockRecord? = ComputerBridgeExecutor.fileLockHolder,
        now: @escaping @Sendable () -> Date = { Date() },
        busyWait: Duration = .seconds(12),
        busyPoll: Duration = .milliseconds(400)
    ) {
        self.busyWait = busyWait
        self.busyPoll = busyPoll
        self.service = service
        self.approver = approver
        self.permissions = permissions
        self.settings = settings
        self.screenshots = screenshots
        self.lockHolder = lockHolder
        self.now = now
    }

    @Sendable public static func fileLockHolder() -> CodeV2.DesktopLockRecord? {
        guard let record = DesktopLockFile().holder() else { return nil }
        return CodeV2.DesktopLockRecord(
            holderId: record.holderId,
            kind: CodeV2.DesktopLockRecord.Kind(rawValue: record.kind.rawValue) ?? .codeSession,
            title: record.title, pid: record.pid, app: record.app,
            acquiredAt: record.acquiredAt, heartbeatAt: record.heartbeatAt
        )
    }

    /// The service's session id for a connected agent's session.
    public static func screenSessionID(_ sessionID: String) -> String { "agent:\(sessionID)" }

    /// The conversation a bridged session belongs to: a subagent
    /// (`<thread>:agent:<id>`) belongs to its thread.
    public static func conversationID(_ sessionID: String) -> String {
        guard let range = sessionID.range(of: ":agent:") else { return sessionID }
        return String(sessionID[..<range.lowerBound])
    }

    public func handle(_ request: CodeV2.ComputerBridgeRequest) async -> CodeV2.ComputerBridgeResponse {
        switch request.type {
        case .status:
            return status(request)
        case .release:
            await forget(Self.screenSessionID(request.sessionId))
            return .init(id: request.id, ok: true, text: "Released.")
        case .call:
            return await call(request)
        }
    }

    /// How long a stopped session must go without calls before it is let go
    /// without the env server's turn-end release.
    static let stoppedQuietSpell: TimeInterval = 60

    /// Everything this executor keeps for a session: its hold, grants,
    /// consent, frames and stop.
    private func forget(_ screenID: String) async {
        await service.deactivate(sessionID: screenID)
        startedSessions.remove(screenID)
        allowedSessions.remove(screenID)
        stoppedCalls[screenID] = nil
        frames[screenID] = nil
        frameConventions[screenID] = nil
    }

    // MARK: - Status

    static func missing(_ status: ComputerUsePermissionStatus) -> [String] {
        status.missing.map { $0 == .screenRecording ? "screen_recording" : "accessibility" }
    }

    /// The exact grant, the exact Settings page and the stale-switch fix:
    /// the agent relays this sentence, so it has to be the whole answer.
    static func permissionSentence(_ status: ComputerUsePermissionStatus) -> String {
        let advice = status.advice()
        if status.accessibilityTrustLostAfterUpdate { return ComputerUsePermissionStatus.trustLostAdvice + " " + advice }
        return advice + " Alevr shows the same steps above the message box, with a button that opens the page."
    }

    static let disabledSentence =
        "Computer use is disabled for connected agents. In Alevr, open Settings › Permissions › Screen control and turn on Let connected agents use apps."

    private func status(_ request: CodeV2.ComputerBridgeRequest) -> CodeV2.ComputerBridgeResponse {
        let grants = permissions()
        let missing = Self.missing(grants)
        let enabled = settings().connectedAgentsEnabled
        let text = !missing.isEmpty ? Self.permissionSentence(grants) : (enabled ? "Screen control is ready." : Self.disabledSentence)
        return .init(id: request.id, ok: missing.isEmpty && enabled, text: text, missingPermissions: missing, holder: lockHolder())
    }

    // MARK: - Calls

    private struct Refusal: Error {
        let text: String
        var status: CodeV2.ItemStatus = .declined
        var endsTurn = false
    }

    private func call(_ request: CodeV2.ComputerBridgeRequest) async -> CodeV2.ComputerBridgeResponse {
        let callID = request.callId ?? "call_\(UUID().uuidString.prefix(8).lowercased())"
        guard let args = request.args else {
            return .init(id: request.id, ok: false, text: "computer.call needs args.")
        }
        let started = now()
        let screenID = Self.screenSessionID(request.sessionId)
        let mode = request.runtimeMode ?? .ask
        await service.beginCall(sessionID: screenID)
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: busyWait)
        var answer = await attempt(request, args: args, callID: callID, started: started, screenID: screenID, mode: mode)
        // Another conversation is in this app: wait a little for it, as a
        // queue would, then say who it is.
        while answer.busy, clock.now < deadline, !Task.isCancelled {
            try? await Task.sleep(for: busyPoll)
            answer = await attempt(request, args: args, callID: callID, started: started, screenID: screenID, mode: mode)
        }
        await service.endCall(sessionID: screenID)
        return answer.response
    }

    private func attempt(
        _ request: CodeV2.ComputerBridgeRequest, args: CodeV2.ComputerToolArgs, callID: String, started: Date,
        screenID: String, mode: CodeV2.RuntimeMode
    ) async -> (response: CodeV2.ComputerBridgeResponse, busy: Bool) {
        do {
            try await ready(request, screenID: screenID, mode: mode)
            let budget: ImageBudget = args.coordinateSpace == .normalized1000 ? .portableNormalized : .portable
            await service.setImageBudget(sessionID: screenID, budget: budget)
            if let app = args.app { try await ensureGranted(app: app, screenID: screenID, title: request.title, mode: mode) }

            let call = PortableComputerCall(
                action: args.action.rawValue, app: args.app, x: args.x, y: args.y, toX: args.toX, toY: args.toY,
                element: args.element, query: args.query, text: args.text, direction: args.direction?.rawValue,
                amount: args.amount, seconds: args.seconds, region: args.region, path: args.path,
                coordinateSpace: args.coordinateSpace == .normalized1000 ? .normalized1000 : .pixels
            )
            let plan = try PortableComputerVocabulary.plan(
                call, frameConvention: frameConventions[screenID] ?? budget.coordinates, frameSize: frames[screenID]
            )
            let (result, prepared, target) = try await run(plan, mode: mode, screenID: screenID, callID: callID)
            if let size = result.frame?.size {
                frames[screenID] = size
                frameConventions[screenID] = budget.coordinates
            }
            return (await success(request, callID: callID, action: args.action, started: started, result: result, prepared: prepared, target: target, screenID: screenID), false)
        } catch let refusal as Refusal {
            return (failure(request, callID: callID, action: args.action, started: started, text: refusal.text, status: refusal.status, endsTurn: refusal.endsTurn, app: args.app), false)
        } catch let invalid as PortableComputerError {
            return (failure(request, callID: callID, action: args.action, started: started, text: invalid.message, status: .failed, endsTurn: false, app: args.app), false)
        } catch let screen as ScreenControlError {
            let text = screen.errorDescription ?? "\(screen)"
            let busy: Bool = switch screen {
            case .appBusy, .lockHeld: true
            default: false
            }
            return (failure(
                request, callID: callID, action: args.action, started: started, text: text,
                status: busy ? .declined : (screen.endsTurn ? .interrupted : .failed), endsTurn: screen.endsTurn, app: args.app
            ), busy)
        } catch {
            let text = (error as? LocalizedError)?.errorDescription ?? "The screen action failed: \(error)"
            return (failure(request, callID: callID, action: args.action, started: started, text: text, status: .failed, endsTurn: false, app: args.app), false)
        }
    }

    /// macOS grants, the reader's switch, and this session's screen control.
    private func ready(_ request: CodeV2.ComputerBridgeRequest, screenID: String, mode: CodeV2.RuntimeMode) async throws {
        let grants = permissions()
        guard grants.isReady else {
            await approver.permissionsMissing(grants, sessionID: request.sessionId)
            throw Refusal(text: Self.permissionSentence(grants), status: .failed, endsTurn: true)
        }
        guard settings().connectedAgentsEnabled else { throw Refusal(text: Self.disabledSentence, endsTurn: true) }
        // A stopped session stays stopped while its agent keeps calling (the
        // turn the reader stopped), and lets go after a quiet spell even if
        // the env server never said the turn ended: the next call then asks
        // the reader again, so a stop is never undone without them and never
        // becomes a hold that outlives its turn.
        if startedSessions.contains(screenID), let last = stoppedCalls[screenID],
           now().timeIntervalSince(last) > Self.stoppedQuietSpell
        {
            await forget(screenID)
        }
        if startedSessions.contains(screenID), case let .stopped(reason) = await service.state(sessionID: screenID) {
            stoppedCalls[screenID] = now()
            throw Refusal(text: reason.sentence + " Stop using the computer.", status: .interrupted, endsTurn: true)
        }
        if await service.isActive(sessionID: screenID) { return }
        guard !startedSessions.contains(screenID) else {
            stoppedCalls[screenID] = now()
            throw Refusal(text: "Screen control stopped. Stop using the computer until the reader starts a new task.", status: .interrupted, endsTurn: true)
        }
        let title = request.title?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "a connected agent"
        // Asked once per turn: a call that waits for a busy app does not ask again.
        if !allowedSessions.contains(screenID) {
            if mode != .full {
                guard await approver.allowAgent(sessionID: request.sessionId, title: title) else {
                    throw Refusal(text: "The reader did not let this agent use apps.", endsTurn: true)
                }
            }
            allowedSessions.insert(screenID)
        }
        // The thread's own id names the conversation: one hold per thread,
        // re-entrant across its turns, never mistaken for "another session".
        try await service.activate(sessionID: screenID, title: title, kind: .connectedAgent, threadID: Self.conversationID(request.sessionId))
        startedSessions.insert(screenID)
    }

    /// An app named in the call that is not granted yet gets a grant card.
    private func ensureGranted(app: String, screenID: String, title: String?, mode: CodeV2.RuntimeMode) async throws {
        let listings = await service.listApps(sessionID: screenID)
        let lowered = app.lowercased()
        let listing = listings.first { $0.bundleID.lowercased() == lowered || $0.name.lowercased() == lowered }
        if let listing, await service.isGranted(sessionID: screenID, bundleID: listing.bundleID) { return }
        let proposal = try await service.proposeGrants(
            sessionID: screenID, apps: [app], reason: title.map { "For ‘\($0)’" },
            clipboardRead: false, clipboardWrite: false
        )
        guard proposal.hasOffer else {
            throw Refusal(text: (["Nothing here can be granted:"] + proposal.offers.map(\.line)).joined(separator: " "), status: .failed)
        }
        // Full Access is standing app consent; the service still enforces caps.
        if mode != .full {
            guard await approver.approve(.grants(proposal), summary: proposal.summary, sessionID: screenID) else {
                throw Refusal(text: "The reader did not grant \(app).")
            }
        }
        let granted = try await service.applyGrants(sessionID: screenID, proposalID: proposal.id)
        guard !granted.isEmpty else { throw Refusal(text: "The reader allowed none of these apps.") }
    }

    /// The mode's ladder, the floor and the allowlist, then one card when it asks.
    private func authorize(_ prepared: PreparedScreenAction, mode: CodeV2.RuntimeMode, screenID: String) async throws {
        let decision = ComputerUseAccessPolicy.decide(
            mode: mode,
            isInput: prepared.isInput,
            hitsFloor: prepared.floor != nil,
            appAllowlisted: settings().allows(bundleID: prepared.target.bundleID)
        )
        switch decision {
        case .allow:
            return
        case let .deny(sentence):
            await service.discard(sessionID: screenID, preparedID: prepared.id)
            throw Refusal(text: sentence)
        case .ask:
            let digest = UUID().uuidString
            await service.publishApprovalDetail(.action(prepared), digest: digest)
            let yes = await approver.approve(.action(prepared), summary: prepared.summary, sessionID: screenID)
            await service.clearApprovalDetail(digest: digest)
            if !yes {
                await service.discard(sessionID: screenID, preparedID: prepared.id)
                if case .stopped = await service.state(sessionID: screenID) { throw ScreenControlError.stoppedByReader }
                throw Refusal(text: "The reader said no: \(prepared.summary).")
            }
        }
    }

    /// The agent gave up on this call (the env server hung up, so the bridge
    /// cancelled it) while its card waited: a late Yes must not run it.
    private func abandonIfCancelled(_ prepared: PreparedScreenAction, screenID: String) async throws {
        guard Task.isCancelled else { return }
        await service.discard(sessionID: screenID, preparedID: prepared.id)
        throw Refusal(text: "The agent cancelled this action before it ran, so it was not done.", status: .interrupted)
    }

    private func run(
        _ plan: PortableComputerPlan, mode: CodeV2.RuntimeMode, screenID: String, callID: String
    ) async throws -> (ScreenActionResult, PreparedScreenAction?, String?) {
        switch plan {
        case let .screen(action):
            let prepared = try await service.prepare(sessionID: screenID, action: action)
            try await authorize(prepared, mode: mode, screenID: screenID)
            try await abandonIfCancelled(prepared, screenID: screenID)
            let result = try await service.perform(sessionID: screenID, prepared: prepared, toolCallID: callID, attachFrame: true)
            return (result, prepared, prepared.target.element)
        case let .openApp(app):
            try await ensureGranted(app: app, screenID: screenID, title: nil)
            return (try await service.open(sessionID: screenID, app: app), nil, app)
        case let .axFind(app, query):
            let text = try await service.accessibility(sessionID: screenID, app: app, query: query, filter: .interactive, depth: 12)
            return (ScreenActionResult(summary: text), nil, query.map { "“\($0)”" })
        case let .axPress(app, element, query):
            var id = element
            if id == nil, let query {
                let listing = try await service.accessibility(sessionID: screenID, app: app, query: query, filter: .interactive, depth: 12)
                guard let match = PortableComputerVocabulary.uniqueMatch(for: query, in: listing) else {
                    throw Refusal(
                        text: "More than one control (or none) matches “\(query)”. Call ax_press again with one element id:\n" + listing,
                        status: .failed
                    )
                }
                id = match
            }
            let prepared = try await service.prepare(sessionID: screenID, action: ScreenAction(kind: .leftClick, app: app, element: id))
            try await authorize(prepared, mode: mode, screenID: screenID)
            try await abandonIfCancelled(prepared, screenID: screenID)
            let result = try await service.perform(sessionID: screenID, prepared: prepared, toolCallID: callID, attachFrame: true)
            return (result, prepared, prepared.target.element)
        case let .menu(app, path):
            let prepared = try await service.prepareMenu(sessionID: screenID, app: app, path: path)
            try await authorize(prepared, mode: mode, screenID: screenID)
            try await abandonIfCancelled(prepared, screenID: screenID)
            let result = try await service.performMenu(sessionID: screenID, prepared: prepared, path: path, toolCallID: callID)
            return (result, prepared, path.joined(separator: " › "))
        }
    }

    // MARK: - Answers

    private func success(
        _ request: CodeV2.ComputerBridgeRequest, callID: String, action: CodeV2.ComputerActionKind, started: Date,
        result: ScreenActionResult, prepared: PreparedScreenAction?, target: String?, screenID: String
    ) async -> CodeV2.ComputerBridgeResponse {
        var ref: String?
        var image: CodeV2.ComputerBridgeImage?
        if let frame = result.frame {
            ref = await screenshots?.store(sessionID: request.sessionId, callID: callID, frame: frame)
            image = CodeV2.ComputerBridgeImage(mediaType: frame.mediaType, data: frame.data.base64EncodedString())
        }
        let ended = now()
        let item = ComputerActionItems.item(
            callID: callID, action: action, status: .completed, at: started,
            app: prepared?.target.appName, target: target, summary: action == .axFind ? nil : result.summary,
            screenshotRef: ref, framePoint: prepared?.framePoint,
            frameSize: result.frame.map { ($0.size.width, $0.size.height) },
            durationMs: max(0, ended.timeIntervalSince(started) * 1_000)
        )
        return .init(id: request.id, ok: true, text: result.text, image: image, item: item)
    }

    private func failure(
        _ request: CodeV2.ComputerBridgeRequest, callID: String, action: CodeV2.ComputerActionKind, started: Date,
        text: String, status: CodeV2.ItemStatus, endsTurn: Bool, app: String? = nil
    ) -> CodeV2.ComputerBridgeResponse {
        let item = ComputerActionItems.item(
            callID: callID, action: action, status: status, at: started, app: app, summary: text, error: text,
            durationMs: max(0, now().timeIntervalSince(started) * 1_000)
        )
        return .init(
            id: request.id, ok: false, text: text, item: item,
            missingPermissions: endsTurn ? Self.missing(permissions()) : nil,
            endsTurn: endsTurn ? true : nil
        )
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
