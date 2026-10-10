import Foundation
import JunoCodeCore

// The home's view of every paired Mac at once (owner, Oct 11, after Codex's
// remote home): each Mac's sessions with their state, which Mac is working,
// and Stop from the list.

public extension CodeLinkRemoteModel {
    /// A Mac's sessions: live for the selected Mac, its last list otherwise.
    func sessions(on deviceID: String) -> [CodeV2.SessionSummary] {
        if deviceID == selectedDeviceID, !remote.sessions.isEmpty || sessionsByMac[deviceID] == nil {
            return Array(remote.sessions.values)
        }
        return sessionsByMac[deviceID] ?? []
    }

    /// A session's state in words: the live thread's for the selected Mac.
    func status(of session: CodeV2.SessionSummary, on deviceID: String) -> CodeLinkSessionStatus {
        if deviceID == selectedDeviceID { return remote.status(of: session.id) }
        return CodeLinkSessionStatus(state: session.state)
    }

    /// Something on this Mac is working or waiting on you.
    func isWorking(_ deviceID: String) -> Bool {
        sessions(on: deviceID).contains { status(of: $0, on: deviceID).isLive }
    }

    /// Asks every reachable paired Mac for its sessions (the home's All).
    func refreshAllSessions() async {
        guard let client else { return }
        if macs.isEmpty { await refreshMacs() }
        let ids = macs.filter {
            if case .notPaired = $0.reachability { return false }
            return true
        }.map(\.id)
        await withTaskGroup(of: (String, [CodeV2.SessionSummary]?).self) { group in
            for id in ids {
                group.addTask { (id, try? await client.sessionList(id, limit: 50)) }
            }
            for await (id, list) in group {
                if let list { sessionsByMac[id] = list }
            }
        }
        if let id = selectedDeviceID, let list = sessionsByMac[id] {
            remote.setSessions(list)
        }
    }

    /// Stops a session's running turn from the list: opened through the link
    /// first (the Mac only takes turn commands for sessions opened that way).
    func stop(_ session: CodeV2.SessionSummary, on deviceID: String) async {
        guard let client else { return }
        do {
            try await client.sessionOpen(deviceID, sessionId: session.id, cwd: session.cwd, afterSequence: nil)
            try await client.turnInterrupt(deviceID, sessionId: session.id, turnId: nil)
            lastError = nil
        } catch {
            note(error, deviceID: deviceID)
        }
    }
}
