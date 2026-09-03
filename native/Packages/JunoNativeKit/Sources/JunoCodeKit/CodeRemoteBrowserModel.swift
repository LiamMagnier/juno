import Foundation
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// A host as the phone sees it.
public struct CodeRemoteHostSummary: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let platform: String
    /// Workspace names only. The relay no longer returns paths at all, and this
    /// type has nowhere to put one if it did.
    public let workspaceNames: [String]
    public let online: Bool
    public let lastSeenAt: Date

    public init(
        id: String, name: String, platform: String,
        workspaceNames: [String], online: Bool, lastSeenAt: Date
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.workspaceNames = workspaceNames
        self.online = online
        self.lastSeenAt = lastSeenAt
    }
}

/// Drives the phone's Remote surfaces: which hosts exist, which sessions they
/// hold, and the event stream for the session being watched.
@MainActor
@Observable
public final class CodeRemoteBrowserModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        /// Could not reach the relay. Retrying is the right response.
        case offline
        /// The relay answered and refused. Retrying cannot help.
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var hosts: [CodeRemoteHostSummary] = []
    public private(set) var sessions: [CodeRemoteSessionSummary] = []
    public private(set) var events: [CodeRemoteSessionEvent] = []
    public private(set) var lastErrorDescription: String?
    /// Set while a command is in flight, so the UI can disable Stop and Approve
    /// rather than letting them be pressed twice.
    public private(set) var isSendingCommand = false
    /// Session lists per host, kept so switching hosts shows the last known
    /// list instantly rather than a blank screen and a spinner.
    public private(set) var sessionsByDevice: [String: [CodeRemoteSessionSummary]] = [:]
    /// The host whose sessions are showing. Nil until the first host loads.
    public var selectedDeviceID: String?
    /// The session whose events are being followed, if any.
    public private(set) var openSessionID: String?
    /// Prompts sent from this phone that the host has not echoed back into the
    /// journal yet. A follow-up to a running session is *queued* — the host
    /// reads it when it next checks in — and the thread shows it as such
    /// instead of refusing to accept it.
    public private(set) var queuedPrompts: [String] = []
    /// Session ids that were awaiting approval the last time the list loaded,
    /// so a caller can tell which approvals are new.
    public private(set) var knownAwaitingSessionIDs: Set<String> = []

    /// The open session's journal, folded for display.
    public var thread: CodeRemoteThread {
        CodeRemoteThread.reduce(events, queuedPrompts: queuedPrompts)
    }

    public var selectedHost: CodeRemoteHostSummary? {
        hosts.first { $0.id == selectedDeviceID }
    }

    public var openSession: CodeRemoteSessionSummary? {
        guard let openSessionID else { return nil }
        return sessions.first { $0.sessionID == openSessionID }
            ?? sessionsByDevice.values.joined().first { $0.sessionID == openSessionID }
    }

    /// The highest event sequence applied. Reconnecting resumes from here
    /// instead of refetching a transcript, and a replayed page is recognised by
    /// sequence rather than by comparing content.
    public private(set) var cursor = 0

    private let client: NativeCodeRemoteClient
    private var accountID: AccountID?
    private let newIdempotencyKey: @Sendable () -> String

    public init(
        client: NativeCodeRemoteClient,
        newIdempotencyKey: @escaping @Sendable () -> String = { UUID().uuidString }
    ) {
        self.client = client
        self.newIdempotencyKey = newIdempotencyKey
    }

    public func start(for accountID: AccountID) {
        self.accountID = accountID
    }

    /// Adapts the already-authenticated Code device inventory into the remote
    /// session browser. A device's local workspace path is intentionally
    /// discarded here: mobile may name a granted workspace but never learns
    /// where it lives on the host.
    public func updateHosts(from devices: [NativeCodeDevice]) {
        hosts = devices.map { device in
            CodeRemoteHostSummary(
                id: device.id,
                name: device.name,
                platform: device.platform,
                workspaceNames: device.workspaces.map(\.name),
                online: device.online,
                lastSeenAt: device.lastSeenAt
            )
        }.sorted { lhs, rhs in
            lhs.online != rhs.online ? lhs.online && !rhs.online : lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
        // Keep a selection valid across a refresh, and pick the first online
        // host when nothing is selected yet.
        if selectedDeviceID == nil || !hosts.contains(where: { $0.id == selectedDeviceID }) {
            selectedDeviceID = hosts.first?.id
        }
    }

    public func stop() {
        accountID = nil
        hosts = []
        sessions = []
        sessionsByDevice = [:]
        events = []
        cursor = 0
        phase = .idle
        lastErrorDescription = nil
        selectedDeviceID = nil
        openSessionID = nil
        queuedPrompts = []
        knownAwaitingSessionIDs = []
    }

    public func loadSessions(deviceID: String) async {
        guard let accountID else { return }
        // Only announce a load when there is nothing to show meanwhile.
        if sessionsByDevice[deviceID] == nil { phase = .loading }
        do {
            let loaded = try await client.sessions(deviceID: deviceID, for: accountID)
            sessionsByDevice[deviceID] = loaded
            if deviceID == selectedDeviceID || selectedDeviceID == nil {
                sessions = loaded
            }
            knownAwaitingSessionIDs.formUnion(loaded.filter(\.isAwaitingApproval).map(\.sessionID))
            lastErrorDescription = nil
            phase = .ready
        } catch {
            record(error)
        }
    }

    /// Shows a host's sessions, from the cache when there is one and from the
    /// relay always.
    public func selectHost(_ deviceID: String) async {
        selectedDeviceID = deviceID
        sessions = sessionsByDevice[deviceID] ?? []
        await loadSessions(deviceID: deviceID)
    }

    /// The host a revoke is in flight for, so the UI can hold its row rather
    /// than letting it be tapped twice.
    public private(set) var revokingHostID: String?

    /// Reloads every host's sessions — the pull-to-refresh action, and what the
    /// background fetch calls to learn about new approvals.
    public func refreshAllSessions() async {
        for host in hosts {
            await loadSessions(deviceID: host.id)
        }
    }

    /// Revokes one paired computer and drops it from every list this model keeps.
    ///
    /// The server delete is authoritative: the host's sessions cascade away
    /// with the row, so the cached per-host lists go too rather than lingering
    /// as threads that open onto a computer that no longer exists. A failure
    /// leaves everything in place and reports only itself — a revoke the relay
    /// refused must not look revoked, and it must not fail the session list
    /// alongside it.
    public func revokeHost(id deviceID: String) async {
        guard let accountID, revokingHostID == nil else { return }
        revokingHostID = deviceID
        defer { revokingHostID = nil }
        do {
            try await client.revokeDevice(deviceID: deviceID, for: accountID)
            hosts.removeAll { $0.id == deviceID }
            sessionsByDevice.removeValue(forKey: deviceID)
            sessions.removeAll { $0.deviceID == deviceID }
            if selectedDeviceID == deviceID {
                selectedDeviceID = hosts.first?.id
                sessions = selectedDeviceID.flatMap { sessionsByDevice[$0] } ?? []
            }
            if openSessionID != nil, openSession == nil { closeSession() }
            lastErrorDescription = nil
        } catch {
            lastErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    /// Sessions across every host that are blocked on a yes, and were not the
    /// last time this was asked. Used to raise a notification per new one.
    public func newlyAwaitingSessions(before previous: Set<String>) -> [CodeRemoteSessionSummary] {
        sessionsByDevice.values.joined()
            .filter { $0.isAwaitingApproval && !previous.contains($0.sessionID) }
    }

    /// Pulls everything after the cursor and advances it.
    ///
    /// Out-of-order or duplicate pages are handled by ignoring anything at or
    /// below the cursor, so a retried request cannot double-apply an event.
    public func pollEvents(deviceID: String, sessionID: String) async {
        guard let accountID else { return }
        do {
            let page = try await client.events(
                deviceID: deviceID, sessionID: sessionID,
                afterSequence: cursor, for: accountID
            )
            try apply(page)
            lastErrorDescription = nil
            phase = .ready
        } catch {
            record(error)
        }
    }

    /// Follows the authenticated relay SSE feed until cancellation or its
    /// deliberate server-side connection rotation. The enclosing SwiftUI task
    /// is selection-scoped, so moving to another session cancels the stream
    /// before any of its events can be applied to the new transcript.
    public func watchEvents(deviceID: String, sessionID: String) async {
        guard let accountID else { return }
        do {
            let stream = try await client.eventStream(
                deviceID: deviceID, sessionID: sessionID,
                afterSequence: cursor, for: accountID
            )
            for try await page in stream {
                try Task.checkCancellation()
                try apply(page)
                lastErrorDescription = nil
                phase = .ready
            }
        } catch is CancellationError {
            // Selection changes and sign-out are normal stream terminations.
        } catch {
            record(error)
        }
    }

    /// Resets the transcript for a different session. Forgetting this is how a
    /// previous session's events end up under the wrong title.
    public func openSession(_ sessionID: String) {
        events = []
        cursor = 0
        lastErrorDescription = nil
        openSessionID = sessionID
        queuedPrompts = []
    }

    public func closeSession() {
        openSessionID = nil
        events = []
        cursor = 0
        queuedPrompts = []
    }

    /// Sends a prompt. While the session is running this is a *steer*: the
    /// relay queues it and the host picks it up between turns, so the phone
    /// keeps it in `queuedPrompts` until the journal echoes it back.
    public func send(
        deviceID: String, sessionID: String, text: String
    ) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        queuedPrompts.append(trimmed)
        await command(
            deviceID: deviceID, sessionID: sessionID,
            kind: "message", payload: ["text": .string(trimmed), "prompt": .string(trimmed)]
        )
        if lastErrorDescription != nil, let index = queuedPrompts.lastIndex(of: trimmed) {
            queuedPrompts.remove(at: index)
        }
    }

    /// Changes the model, effort or permission mode of a session that runs on
    /// the host's local runtime. Each is optional; only the named fields move.
    public func patchSession(
        deviceID: String, sessionID: String,
        modelID: String? = nil, reasoningEffort: String? = nil, permissionMode: String? = nil
    ) async {
        var payload: [String: JunoJSONValue] = [:]
        if let modelID { payload["modelID"] = .string(modelID) }
        if let reasoningEffort { payload["reasoningEffort"] = .string(reasoningEffort) }
        if let permissionMode { payload["permissionMode"] = .string(permissionMode) }
        guard !payload.isEmpty else { return }
        await command(deviceID: deviceID, sessionID: sessionID, kind: "patch", payload: payload)
    }

    /// Starts a new session on a host, in one of its shared workspaces, with a
    /// first prompt. The session id is minted here so the phone can open the
    /// thread immediately and follow its events from sequence zero.
    @discardableResult
    public func createSession(
        deviceID: String, workspaceKey: String?, workspaceName: String?, prompt: String,
        modelID: String? = nil, permissionMode: String? = nil
    ) async -> String? {
        let sessionID = "remote-\(newIdempotencyKey().lowercased())"
        var payload: [String: JunoJSONValue] = [
            "prompt": .string(prompt),
            "text": .string(prompt),
            "title": .string(String(prompt.prefix(80))),
        ]
        if let workspaceKey { payload["workspaceKey"] = .string(workspaceKey) }
        if let workspaceName { payload["workspaceName"] = .string(workspaceName) }
        if let modelID { payload["modelID"] = .string(modelID) }
        if let permissionMode { payload["permissionMode"] = .string(permissionMode) }
        await command(deviceID: deviceID, sessionID: sessionID, kind: "create_session", payload: payload)
        guard lastErrorDescription == nil else { return nil }
        await loadSessions(deviceID: deviceID)
        return sessionID
    }

    public func stopGeneration(deviceID: String, sessionID: String) async {
        await command(deviceID: deviceID, sessionID: sessionID, kind: "stop", payload: [:])
    }

    /// Approve or deny a pending tool request.
    ///
    /// The `requestID` is carried through rather than reconstructed, because an
    /// approval that does not name the exact request it answers is an approval
    /// that could be replayed against a later one.
    public func respondToApproval(
        deviceID: String, sessionID: String, requestID: String, approved: Bool
    ) async {
        await command(
            deviceID: deviceID, sessionID: sessionID, kind: "approval",
            payload: ["requestId": .string(requestID), "approved": .bool(approved)]
        )
    }

    private func command(
        deviceID: String, sessionID: String,
        kind: String, payload: [String: JunoJSONValue]
    ) async {
        guard let accountID, !isSendingCommand else { return }
        isSendingCommand = true
        defer { isSendingCommand = false }
        do {
            _ = try await client.enqueueCommand(
                deviceID: deviceID, sessionID: sessionID, kind: kind,
                payload: payload,
                // One key per action. Reusing a key across two actions would
                // make the relay silently drop the second.
                idempotencyKey: newIdempotencyKey(),
                for: accountID
            )
            lastErrorDescription = nil
        } catch {
            record(error)
        }
    }

    private func apply(_ page: [CodeRemoteSessionEvent]) throws {
        let fresh = page.filter { $0.seq > cursor }.sorted { $0.seq < $1.seq }
        guard !fresh.isEmpty else { return }
        var expected = cursor + 1
        for event in fresh {
            // A missing event is not an aesthetic issue: it can separate an
            // approval from the tool action it authorises. Refuse to advance
            // across a hole; the caller can reload a durable detail snapshot
            // instead of rendering fiction.
            guard event.seq == expected else { throw CodeRemoteError.malformedResponse }
            expected += 1
        }
        events.append(contentsOf: fresh)
        cursor = events.last?.seq ?? cursor
    }

    private func record(_ error: any Error) {
        lastErrorDescription = NativeFailureMessage.presentable(error)
        // Same split as everywhere else: a transport failure is an outage worth
        // retrying, a refusal from the relay is not.
        let connectivity = NativeFailureClassification.isConnectivityFailure(error)
            || (error as? CodeRemoteError)?.isRetryable == true
        phase = connectivity ? .offline : .failed
    }
}
