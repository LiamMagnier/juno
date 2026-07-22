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

    public func stop() {
        accountID = nil
        hosts = []
        sessions = []
        events = []
        cursor = 0
        phase = .idle
        lastErrorDescription = nil
    }

    public func loadSessions(deviceID: String) async {
        guard let accountID else { return }
        phase = .loading
        do {
            sessions = try await client.sessions(deviceID: deviceID, for: accountID)
            lastErrorDescription = nil
            phase = .ready
        } catch {
            record(error)
        }
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
            let fresh = page.filter { $0.seq > cursor }
            guard !fresh.isEmpty else { return }
            events.append(contentsOf: fresh.sorted { $0.seq < $1.seq })
            cursor = events.last?.seq ?? cursor
            lastErrorDescription = nil
            phase = .ready
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
    }

    public func send(
        deviceID: String, sessionID: String, text: String
    ) async {
        await command(
            deviceID: deviceID, sessionID: sessionID,
            kind: "message", payload: ["text": .string(text)]
        )
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

    private func record(_ error: any Error) {
        lastErrorDescription = NativeFailureMessage.presentable(error)
        // Same split as everywhere else: a transport failure is an outage worth
        // retrying, a refusal from the relay is not.
        let connectivity = NativeFailureClassification.isConnectivityFailure(error)
            || (error as? CodeRemoteError)?.isRetryable == true
        phase = connectivity ? .offline : .failed
    }
}
