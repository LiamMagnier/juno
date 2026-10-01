import Foundation
import JunoCodeCore
import JunoScreenControl
#if os(macOS)
import ApplicationServices
import CoreGraphics
#endif

/// Read-only screen-control state for presentation. It carries no driver
/// and cannot act; the UI still goes through the service's checks.
public struct ComputerUseSnapshot: Sendable {
    public let isActive: Bool
    /// The Code session holding the app-wide lock, if one does.
    public let activeSessionID: CodeSessionID?
    public let screenCapturePermission: ComputerUsePermissionState
    public let accessibilityPermission: ComputerUsePermissionState
    public let displayBounds: CGRect?
    public let journal: [ComputerUseJournalEntry]
    /// The frame the active session's agent was last sent; nil when it has
    /// been sent none since screen control started.
    public let latestCapture: ComputerUseCapture?

    public init(
        isActive: Bool,
        activeSessionID: CodeSessionID?,
        screenCapturePermission: ComputerUsePermissionState,
        accessibilityPermission: ComputerUsePermissionState,
        displayBounds: CGRect?,
        journal: [ComputerUseJournalEntry],
        latestCapture: ComputerUseCapture? = nil
    ) {
        self.isActive = isActive
        self.activeSessionID = activeSessionID
        self.screenCapturePermission = screenCapturePermission
        self.accessibilityPermission = accessibilityPermission
        self.displayBounds = displayBounds
        self.journal = journal
        self.latestCapture = latestCapture
    }

    public var permissions: ComputerUsePermissionStatus {
        ComputerUsePermissionStatus(
            screenRecording: screenCapturePermission,
            accessibility: accessibilityPermission
        )
    }
}

/// Juno Code's adapter onto the app-wide screen-control service
/// (CODE_AGENT_SPEC §3.2).
///
/// It keeps the part only Code has: the explicit per-session consent — never
/// activated without the reader's Start, both TCC grants checked first —
/// and the session snapshot the window reads. Capture, input, grants, the
/// floor, the lock and the stop are the service's, shared with Juno Work;
/// the service re-proves the session's grant after every suspension point.
public actor ComputerUseCoordinator: ScreenControlling {
    private let service: ScreenControlService
    private let permissions: any ComputerUsePermissionChecking
    private var journal: [ComputerUseJournalEntry] = []
    private var journalTask: Task<Void, Never>?

    public init(
        service: ScreenControlService,
        permissions: any ComputerUsePermissionChecking
    ) {
        self.service = service
        self.permissions = permissions
    }

    #if os(macOS)
    /// The app's coordinator onto the shared service and the real TCC state.
    public init() {
        self.init(service: .shared, permissions: SystemComputerUsePermissions())
    }
    #endif

    deinit { journalTask?.cancel() }

    public var screenControlService: ScreenControlService { service }

    // MARK: - Lifecycle

    /// Starts screen control for one session. `userConsented` must be the
    /// reader's explicit Start in this session; false is always an error.
    /// Never called automatically.
    public func activate(sessionID: CodeSessionID, userConsented: Bool, title: String? = nil) async throws {
        guard userConsented else { throw ComputerUseError.consentRequired }
        guard permissions.requestScreenCapturePermission() == .granted else {
            throw ComputerUseError.screenCapturePermissionMissing
        }
        guard permissions.requestAccessibilityPermission() == .granted else {
            throw ComputerUseError.accessibilityPermissionMissing
        }
        do {
            try await service.activate(sessionID: sessionID.value, title: title ?? "", kind: .codeSession)
        } catch let ScreenControlError.lockHeld(holder) {
            throw ComputerUseError.heldElsewhere(holder)
        }
        startJournalIfNeeded()
    }

    public func deactivate(sessionID: CodeSessionID) async {
        await service.deactivate(sessionID: sessionID.value)
    }

    /// The kill switch: every session, every Work task, at once.
    public func emergencyStop() async {
        await service.stopAll(reason: .stopButton)
    }

    /// Grants lapse, screen control stays on: a model change.
    public func revokeGrants(sessionID: CodeSessionID) async {
        await service.revokeGrants(sessionID: sessionID.value)
    }

    public func isActive(sessionID: CodeSessionID) async -> Bool {
        await service.isActive(sessionID: sessionID.value)
    }

    /// Current TCC and session state, without prompting or capturing.
    public func snapshot() async -> ComputerUseSnapshot {
        let holder = await service.lock.currentHolder
        let active = holder?.kind == .codeSession ? holder.map { CodeSessionID(value: $0.id) } : nil
        var capture: ComputerUseCapture?
        if let active, let frame = await service.latestFrame(sessionID: active.value) {
            capture = ComputerUseCapture(sessionID: active, imageData: frame.data, capturedAt: frame.at, appName: frame.appName)
        }
        return ComputerUseSnapshot(
            isActive: active != nil,
            activeSessionID: active,
            screenCapturePermission: permissions.screenCapturePermission(),
            accessibilityPermission: permissions.accessibilityPermission(),
            displayBounds: Self.mainDisplayBounds(),
            journal: journal,
            latestCapture: capture
        )
    }

    public var actionJournal: [ComputerUseJournalEntry] { journal }

    private static func mainDisplayBounds() -> CGRect? {
        #if os(macOS)
        CGDisplayBounds(CGMainDisplayID())
        #else
        nil
        #endif
    }

    private func startJournalIfNeeded() {
        guard journalTask == nil else { return }
        let service = self.service
        journalTask = Task { [weak self] in
            let stream = await service.activity()
            for await step in stream {
                await self?.record(step)
            }
        }
    }

    private func record(_ step: ScreenActivity) {
        journal.append(ComputerUseJournalEntry(
            sessionID: CodeSessionID(value: step.sessionID),
            summary: step.summary,
            timestamp: step.at,
            succeeded: step.succeeded
        ))
        if journal.count > 1_000 { journal.removeFirst(journal.count - 1_000) }
    }

    // MARK: - ScreenControlling

    public func state(sessionID: String) async -> ScreenSessionState {
        await service.state(sessionID: sessionID)
    }

    public func listApps(sessionID: String) async -> [ScreenAppListing] {
        await service.listApps(sessionID: sessionID)
    }

    public func proposeGrants(
        sessionID: String,
        apps: [String],
        reason: String?,
        clipboardRead: Bool,
        clipboardWrite: Bool
    ) async throws -> GrantProposal {
        try await service.proposeGrants(
            sessionID: sessionID, apps: apps, reason: reason,
            clipboardRead: clipboardRead, clipboardWrite: clipboardWrite
        )
    }

    public func applyGrants(sessionID: String, proposalID: String) async throws -> [AppGrant] {
        try await service.applyGrants(sessionID: sessionID, proposalID: proposalID)
    }

    public func grants(sessionID: String) async -> [AppGrant] {
        await service.grants(sessionID: sessionID)
    }

    public func release(sessionID: String, apps: [String]) async -> [String] {
        await service.release(sessionID: sessionID, apps: apps)
    }

    public func open(sessionID: String, app: String) async throws -> ScreenActionResult {
        try await service.open(sessionID: sessionID, app: app)
    }

    public func prepare(sessionID: String, action: ScreenAction) async throws -> PreparedScreenAction {
        try await service.prepare(sessionID: sessionID, action: action)
    }

    public func perform(
        sessionID: String,
        prepared: PreparedScreenAction,
        toolCallID: String?,
        attachFrame: Bool
    ) async throws -> ScreenActionResult {
        try await service.perform(sessionID: sessionID, prepared: prepared, toolCallID: toolCallID, attachFrame: attachFrame)
    }

    public func settledFrame(sessionID: String) async throws -> ScreenActionResult {
        try await service.settledFrame(sessionID: sessionID)
    }

    public func accessibility(
        sessionID: String,
        app: String?,
        query: String?,
        filter: AXSnapshot.Filter,
        depth: Int
    ) async throws -> String {
        try await service.accessibility(sessionID: sessionID, app: app, query: query, filter: filter, depth: depth)
    }

    public func prepareMenu(sessionID: String, app: String?, path: [String]) async throws -> PreparedScreenAction {
        try await service.prepareMenu(sessionID: sessionID, app: app, path: path)
    }

    public func performMenu(
        sessionID: String,
        prepared: PreparedScreenAction,
        path: [String],
        toolCallID: String?
    ) async throws -> ScreenActionResult {
        try await service.performMenu(sessionID: sessionID, prepared: prepared, path: path, toolCallID: toolCallID)
    }

    public func displays(sessionID: String) async -> [DisplayInfo] {
        await service.displays(sessionID: sessionID)
    }

    public func requestTakeover(sessionID: String, displayID: UInt32?) async throws -> ScreenApprovalDetail {
        try await service.requestTakeover(sessionID: sessionID, displayID: displayID)
    }

    public func beginTakeover(sessionID: String, displayID: UInt32?) async throws -> String {
        try await service.beginTakeover(sessionID: sessionID, displayID: displayID)
    }

    public func endTakeover(sessionID: String) async -> String {
        await service.endTakeover(sessionID: sessionID)
    }

    public func publishApprovalDetail(_ detail: ScreenApprovalDetail, digest: String) async {
        await service.publishApprovalDetail(detail, digest: digest)
    }

    public func clearApprovalDetail(digest: String) async {
        await service.clearApprovalDetail(digest: digest)
    }

    public func approvalDetail(digest: String) async -> ScreenApprovalDetail? {
        await service.approvalDetail(digest: digest)
    }

    public func updateGrantChoices(proposalID: String, offers: [AppGrantOffer]) async {
        await service.updateGrantChoices(proposalID: proposalID, offers: offers)
    }

    public func isGranted(sessionID: String, bundleID: String) async -> Bool {
        await service.isGranted(sessionID: sessionID, bundleID: bundleID)
    }

    public func setImageBudget(sessionID: String, budget: ImageBudget) async {
        await service.setImageBudget(sessionID: sessionID, budget: budget)
    }
}

#if os(macOS)

/// The real TCC reads. Preflight never prompts; the request pair prompts
/// and is reached only from the reader's Start.
public struct SystemComputerUsePermissions: ComputerUsePermissionChecking {
    public init() {}

    public func screenCapturePermission() -> ComputerUsePermissionState {
        CGPreflightScreenCaptureAccess() ? .granted : .denied
    }

    public func accessibilityPermission() -> ComputerUsePermissionState {
        AXIsProcessTrusted() ? .granted : .denied
    }

    public func requestScreenCapturePermission() -> ComputerUsePermissionState {
        if CGPreflightScreenCaptureAccess() { return .granted }
        return CGRequestScreenCaptureAccess() ? .granted : .denied
    }

    public func requestAccessibilityPermission() -> ComputerUsePermissionState {
        if AXIsProcessTrusted() { return .granted }
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options) ? .granted : .denied
    }
}

#endif
