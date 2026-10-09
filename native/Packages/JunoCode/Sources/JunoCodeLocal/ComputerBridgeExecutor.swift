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
}

/// The screen-control service as the bridge needs it: the agent surface
/// plus starting and ending a session's screen control.
public protocol ScreenControlSessionHosting: ScreenControlling {
    func activate(sessionID: String, title: String, kind: ScreenControlHolder.Kind) async throws
    func deactivate(sessionID: String) async
    func isActive(sessionID: String) async -> Bool
}

extension ScreenControlService: ScreenControlSessionHosting {}

/// The reader's settings for connected agents, persisted beside the lock.
public struct ComputerUseBridgeSettings: Codable, Hashable, Sendable {
    /// "Let connected agents use apps": off until the reader turns it on.
    public var connectedAgentsEnabled: Bool
    /// Apps whose ordinary input runs without a card in Auto-edit and Auto
    /// (never the floor, never in Ask). Bundle ids, lowercased.
    public var allowlist: Set<String>

    public init(connectedAgentsEnabled: Bool = false, allowlist: Set<String> = []) {
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
    private var frames: [String: PixelSize] = [:]

    public init(
        service: any ScreenControlSessionHosting,
        approver: any ComputerBridgeApproving,
        permissions: @escaping @Sendable () -> ComputerUsePermissionStatus,
        settings: @escaping @Sendable () -> ComputerUseBridgeSettings = { ComputerUseBridgeSettings.load() },
        screenshots: ComputerScreenshotStore? = .shared,
        lockHolder: @escaping @Sendable () -> CodeV2.DesktopLockRecord? = ComputerBridgeExecutor.fileLockHolder,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
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

    public func handle(_ request: CodeV2.ComputerBridgeRequest) async -> CodeV2.ComputerBridgeResponse {
        switch request.type {
        case .status:
            return status(request)
        case .release:
            let screenID = Self.screenSessionID(request.sessionId)
            await service.deactivate(sessionID: screenID)
            frames[screenID] = nil
            return .init(id: request.id, ok: true, text: "Released.")
        case .call:
            return await call(request)
        }
    }

    // MARK: - Status

    static func missing(_ status: ComputerUsePermissionStatus) -> [String] {
        status.missing.map { $0 == .screenRecording ? "screen_recording" : "accessibility" }
    }

    static func permissionSentence(_ status: ComputerUsePermissionStatus) -> String {
        if status.accessibilityTrustLostAfterUpdate { return ComputerUsePermissionStatus.trustLostAdvice }
        let names = status.missing.map(\.title)
        let list = names.count == 2 ? "\(names[0]) and \(names[1])" : names.first ?? ""
        return "Alevr needs \(list) to use apps. Open System Settings › Privacy & Security › \(names.first ?? "Screen Recording"), turn Alevr on, then try again."
    }

    static let disabledSentence =
        "Connected agents can't use apps on this Mac yet. In Alevr, open Settings › Computer use and turn on Let connected agents use apps."

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
        do {
            try await ready(request, screenID: screenID)
            let budget: ImageBudget = args.coordinateSpace == .normalized1000 ? .portableNormalized : .portable
            await service.setImageBudget(sessionID: screenID, budget: budget)
            if let app = args.app { try await ensureGranted(app: app, screenID: screenID, title: request.title) }

            let call = PortableComputerCall(
                action: args.action.rawValue, app: args.app, x: args.x, y: args.y, toX: args.toX, toY: args.toY,
                element: args.element, query: args.query, text: args.text, direction: args.direction?.rawValue,
                amount: args.amount, seconds: args.seconds, region: args.region, path: args.path,
                coordinateSpace: args.coordinateSpace == .normalized1000 ? .normalized1000 : .pixels
            )
            let plan = try PortableComputerVocabulary.plan(call, frameConvention: budget.coordinates, frameSize: frames[screenID])
            let (result, prepared, target) = try await run(plan, mode: mode, screenID: screenID, callID: callID)
            if let size = result.frame?.size { frames[screenID] = size }
            return await success(request, callID: callID, action: args.action, started: started, result: result, prepared: prepared, target: target, screenID: screenID)
        } catch let refusal as Refusal {
            return failure(request, callID: callID, action: args.action, started: started, text: refusal.text, status: refusal.status, endsTurn: refusal.endsTurn)
        } catch let invalid as PortableComputerError {
            return failure(request, callID: callID, action: args.action, started: started, text: invalid.message, status: .failed, endsTurn: false)
        } catch let screen as ScreenControlError {
            let text = screen.errorDescription ?? "\(screen)"
            return failure(request, callID: callID, action: args.action, started: started, text: text, status: screen.endsTurn ? .interrupted : .failed, endsTurn: screen.endsTurn)
        } catch {
            let text = (error as? LocalizedError)?.errorDescription ?? "The screen action failed: \(error)"
            return failure(request, callID: callID, action: args.action, started: started, text: text, status: .failed, endsTurn: false)
        }
    }

    /// macOS grants, the reader's switch, and this session's screen control.
    private func ready(_ request: CodeV2.ComputerBridgeRequest, screenID: String) async throws {
        let grants = permissions()
        guard grants.isReady else { throw Refusal(text: Self.permissionSentence(grants), status: .failed, endsTurn: true) }
        guard settings().connectedAgentsEnabled else { throw Refusal(text: Self.disabledSentence, endsTurn: true) }
        if await service.isActive(sessionID: screenID) {
            if case let .stopped(reason) = await service.state(sessionID: screenID) {
                throw Refusal(text: reason.sentence + " Stop using the computer.", status: .interrupted, endsTurn: true)
            }
            return
        }
        let title = request.title?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "a connected agent"
        guard await approver.allowAgent(sessionID: request.sessionId, title: title) else {
            throw Refusal(text: "The reader did not let this agent use apps.", endsTurn: true)
        }
        try await service.activate(sessionID: screenID, title: title, kind: .connectedAgent)
    }

    /// An app named in the call that is not granted yet gets a grant card.
    private func ensureGranted(app: String, screenID: String, title: String?) async throws {
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
        // Grants always ask, Full access included.
        guard await approver.approve(.grants(proposal), summary: proposal.summary, sessionID: screenID) else {
            throw Refusal(text: "The reader did not grant \(app).")
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

    private func run(
        _ plan: PortableComputerPlan, mode: CodeV2.RuntimeMode, screenID: String, callID: String
    ) async throws -> (ScreenActionResult, PreparedScreenAction?, String?) {
        switch plan {
        case let .screen(action):
            let prepared = try await service.prepare(sessionID: screenID, action: action)
            try await authorize(prepared, mode: mode, screenID: screenID)
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
            let result = try await service.perform(sessionID: screenID, prepared: prepared, toolCallID: callID, attachFrame: true)
            return (result, prepared, prepared.target.element)
        case let .menu(app, path):
            let prepared = try await service.prepareMenu(sessionID: screenID, app: app, path: path)
            try await authorize(prepared, mode: mode, screenID: screenID)
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
        text: String, status: CodeV2.ItemStatus, endsTurn: Bool
    ) -> CodeV2.ComputerBridgeResponse {
        let item = ComputerActionItems.item(
            callID: callID, action: action, status: status, at: started, summary: text, error: text,
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
