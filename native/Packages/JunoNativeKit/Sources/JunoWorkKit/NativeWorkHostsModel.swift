import Foundation
import JunoCore
import JunoSync
import Observation

/// The account's Macs for the Permissions pages: the list, one Mac's detail,
/// and the three things a person does to one — change a switch, revoke it,
/// restore it.
///
/// Its own model rather than `NativeWorkModel`'s host list, because that list
/// swallows a failed read (it is a routing input, and a routing input that is
/// stale is still the best guess). This page has to say "the latest check
/// failed" over the last answers, which needs the failure kept.
///
/// It does not poll by itself. The web polls every `WORK_POLL_MS` only while
/// the page is visible, and the Mac's pages do the same from their own task,
/// so a Mac nobody is looking at is not re-read every thirty seconds.
@MainActor
@Observable
public final class NativeWorkHostsModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed
    }

    /// The web's `WORK_POLL_MS`.
    public static let pollInterval: Duration = .seconds(30)

    public private(set) var phase: Phase = .idle
    public private(set) var hosts: [WorkHostSummary] = []
    /// The latest read of the list failed while rows from an earlier one are
    /// still showing.
    public private(set) var lastRefreshFailed = false
    public private(set) var details: [String: NativeWorkHostDetail] = [:]
    /// Hosts whose latest detail read failed.
    public private(set) var failedDetailIDs: Set<String> = []
    /// Hosts the server no longer knows.
    public private(set) var missingIDs: Set<String> = []
    /// Hosts with a change or a revocation in flight. A poll does not
    /// overwrite a host while it is here.
    public private(set) var busyIDs: Set<String> = []

    private let client: NativeWorkClient
    private var accountID: AccountID?

    public init(client: NativeWorkClient) {
        self.client = client
    }

    public func start(for accountID: AccountID) async {
        if self.accountID != accountID {
            stop()
            self.accountID = accountID
            phase = .loading
        }
        await refresh()
    }

    public func stop() {
        accountID = nil
        phase = .idle
        hosts = []
        lastRefreshFailed = false
        details = [:]
        failedDetailIDs = []
        missingIDs = []
        busyIDs = []
    }

    public func refresh() async {
        guard let accountID else { return }
        do {
            let values = try await client.hosts(for: accountID)
            guard self.accountID == accountID else { return }
            hosts = values
            lastRefreshFailed = false
            phase = .ready
        } catch {
            guard self.accountID == accountID else { return }
            lastRefreshFailed = true
            if phase != .ready { phase = .failed }
        }
    }

    /// The list in the Mac's order: this Mac first, then the others as the
    /// server sent them, then the revoked ones (the web's `ordered`).
    public func ordered(thisMac: String?) -> [WorkHostSummary] {
        Self.ordered(hosts, thisMac: thisMac)
    }

    nonisolated public static func ordered(_ hosts: [WorkHostSummary], thisMac: String?) -> [WorkHostSummary] {
        let live = hosts.filter { $0.revokedAt == nil }
        let revoked = hosts.filter { $0.revokedAt != nil }
        let mine = live.filter { $0.hostID == thisMac }
        let others = live.filter { $0.hostID != thisMac }
        return mine + others + revoked
    }

    /// One host, from its detail when it has been read, the list otherwise.
    public func host(id: String) -> WorkHostSummary? {
        details[id]?.host ?? hosts.first { $0.hostID == id }
    }

    public func loadHost(id: String) async {
        guard let accountID, !busyIDs.contains(id) else { return }
        do {
            let detail = try await client.host(id: id, for: accountID)
            guard self.accountID == accountID, !busyIDs.contains(id) else { return }
            details[id] = detail
            replace(detail.host)
            failedDetailIDs.remove(id)
            missingIDs.remove(id)
        } catch {
            guard self.accountID == accountID else { return }
            if case .server(404, _, _)? = error as? WorkRemoteError {
                missingIDs.insert(id)
            } else {
                failedDetailIDs.insert(id)
            }
        }
    }

    /// What a change came to, for the page's toast.
    public enum Outcome: Equatable, Sendable {
        case done
        /// Switches the Mac has not offered, which stayed off.
        case refused([NativeWorkHostToggle])
        /// The server's own sentence for a refusal.
        case declined(String)
        case missing
        case failed
    }

    public func update(id: String, _ patch: NativeWorkHostPatch) async -> Outcome {
        guard let accountID else { return .failed }
        busyIDs.insert(id)
        defer { busyIDs.remove(id) }
        do {
            let result = try await client.updateHost(id: id, patch, for: accountID)
            guard self.accountID == accountID else { return .failed }
            store(result.host)
            return result.refused.isEmpty ? .done : .refused(result.refused)
        } catch {
            guard self.accountID == accountID else { return .failed }
            return failure(error, id: id)
        }
    }

    /// Revokes, returning how many instructions were cancelled on success.
    public func revoke(id: String) async -> (outcome: Outcome, cancelledCommands: Int) {
        guard let accountID else { return (.failed, 0) }
        busyIDs.insert(id)
        defer { busyIDs.remove(id) }
        do {
            let result = try await client.revokeHost(id: id, for: accountID)
            guard self.accountID == accountID else { return (.failed, 0) }
            store(result.host)
            return (.done, result.cancelledCommands)
        } catch {
            guard self.accountID == accountID else { return (.failed, 0) }
            return (failure(error, id: id), 0)
        }
    }

    private func failure(_ error: any Error, id: String) -> Outcome {
        if case .server(404, _, _)? = error as? WorkRemoteError {
            missingIDs.insert(id)
            return .missing
        }
        if let sentence = NativeWorkServerSentence.refusal(error) { return .declined(sentence) }
        return .failed
    }

    private func store(_ host: WorkHostSummary) {
        replace(host)
        if let detail = details[host.hostID] {
            details[host.hostID] = NativeWorkHostDetail(
                host: host,
                grants: detail.grants,
                pendingCommands: host.revokedAt == nil ? detail.pendingCommands : 0,
                routableCapabilities: detail.routableCapabilities
            )
        }
    }

    private func replace(_ host: WorkHostSummary) {
        if let index = hosts.firstIndex(where: { $0.hostID == host.hostID }) {
            hosts[index] = host
        }
    }
}
