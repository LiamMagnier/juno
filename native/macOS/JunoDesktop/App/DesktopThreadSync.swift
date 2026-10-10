import Foundation
import JunoAuth
import JunoCodeUI
import JunoCore
import JunoSync
import Observation
import SwiftUI

// Per-thread state that follows the reader between the Mac, the iPhone and
// the web (docs/code-v2/REMOTE-CONTROL.md §5): the unsent draft, the Code
// composer's choices, and read. Drafts go up debounced and come down only
// when they are newer, not this Mac's own echo, and not over typing here
// that has not been sent.

/// The sync routes, as this controller uses them. A protocol so tests can
/// play the backend.
protocol DesktopThreadSyncService: Sendable {
    func thread(_ key: String) async throws -> ThreadSyncState?
    func write(_ key: String, _ update: ThreadSyncUpdate) async throws
    func changes(after cursor: String?, waitMs: Int, keys: [String]) async throws -> (threads: [ThreadSyncState], cursor: String?)
}

struct DesktopLiveThreadSyncService: DesktopThreadSyncService {
    let client: ThreadSyncClient
    let accountID: AccountID

    func thread(_ key: String) async throws -> ThreadSyncState? {
        try await client.thread(key, for: accountID)
    }

    func write(_ key: String, _ update: ThreadSyncUpdate) async throws {
        try await client.write(key, update, for: accountID)
    }

    func changes(after cursor: String?, waitMs: Int, keys: [String]) async throws -> (threads: [ThreadSyncState], cursor: String?) {
        let page = try await client.changes(after: cursor, waitMs: waitMs, keys: keys, for: accountID)
        return (page.threads, page.cursor)
    }
}

/// One controller for the app, configured while signed in. Every open
/// thread (a chat, a Code session) registers with it while it is on screen.
@MainActor
final class DesktopThreadSync {
    static let shared = DesktopThreadSync()

    /// How this Mac names itself in `draftBy`, so its own echo is known.
    static let device = "mac"
    /// Typing this recent holds remote drafts off: the reader is mid-thought.
    static let typingQuiet: TimeInterval = 2.5
    /// After a thread opens, the composer settling on it (its skills, its
    /// model) is not the reader choosing; prefs changes this soon are not sent.
    static let prefsSettle: TimeInterval = 1.5

    struct OpenThread {
        var currentDraft: @MainActor () -> String
        var applyDraft: @MainActor (String) -> Void
        var applyPrefs: (@MainActor (ThreadSyncPrefs) -> Void)?
        var openedAt: Date
        var watcher: Task<Void, Never>?
    }

    private(set) var service: (any DesktopThreadSyncService)?
    private var syncer: ThreadDraftSyncer?
    private(set) var openThreads: [String: OpenThread] = [:]
    /// The last draft this Mac put into a field from another device, so the
    /// field's change that follows is not written back.
    private var appliedDraft: [String: String] = [:]
    private var appliedPrefs: [String: ThreadSyncPrefs] = [:]
    private var lastLocalEdit: [String: Date] = [:]
    /// The newest prefs time seen or written per thread.
    private var prefsAt: [String: Date] = [:]
    private var prefsWrites: [String: Task<Void, Never>] = [:]
    var now: () -> Date = Date.init
    var pollWaitMs = 20_000
    var prefsDelay: Duration = .milliseconds(500)

    init() {}

    /// Signed in (or a test's backend): drafts and prefs start flowing.
    func configure(service: (any DesktopThreadSyncService)?, draftDelay: Duration = .milliseconds(700)) {
        reset()
        self.service = service
        guard let service else { return }
        syncer = ThreadDraftSyncer(device: Self.device, delay: draftDelay) { key, update in
            try await service.write(key, update)
        }
    }

    func configure(client: ThreadSyncClient?, accountID: AccountID?) {
        if let client, let accountID {
            configure(service: DesktopLiveThreadSyncService(client: client, accountID: accountID))
        } else {
            configure(service: nil)
        }
    }

    /// Signed out: every watcher stops and nothing more is written.
    func reset() {
        for (_, thread) in openThreads { thread.watcher?.cancel() }
        for (_, task) in prefsWrites { task.cancel() }
        openThreads = [:]
        prefsWrites = [:]
        appliedDraft = [:]
        appliedPrefs = [:]
        lastLocalEdit = [:]
        prefsAt = [:]
        syncer = nil
        service = nil
    }

    // MARK: A thread on screen

    /// The thread is on screen: mark it read, fill an empty field with a
    /// newer draft from another device, and listen for more until ``close(_:)``.
    func open(
        _ key: String,
        currentDraft: @escaping @MainActor () -> String,
        applyDraft: @escaping @MainActor (String) -> Void,
        applyPrefs: (@MainActor (ThreadSyncPrefs) -> Void)? = nil
    ) {
        guard let service else { return }
        if let existing = openThreads[key] { existing.watcher?.cancel() }
        var thread = OpenThread(
            currentDraft: currentDraft, applyDraft: applyDraft, applyPrefs: applyPrefs, openedAt: now()
        )
        thread.watcher = Task { [weak self] in
            // Read wherever it is, at once: the unread mark and needs-you clear
            // on every device.
            try? await service.write(key, ThreadSyncUpdate(read: true, device: Self.device))
            if let state = try? await service.thread(key), !Task.isCancelled {
                await self?.receive(state, opening: true)
            }
            await self?.watch(key, service: service)
        }
        openThreads[key] = thread
    }

    /// The thread left the screen: its draft goes up now, and listening stops.
    func close(_ key: String) {
        guard let thread = openThreads.removeValue(forKey: key) else { return }
        thread.watcher?.cancel()
        if let syncer { Task { await syncer.flush(key) } }
        prefsWrites[key]?.cancel()
        prefsWrites[key] = nil
    }

    /// The field changed. A field emptied (a message sent, or everything
    /// deleted) clears the draft everywhere at once; typing is debounced.
    func draftChanged(_ key: String, text: String) {
        guard let syncer, openThreads[key] != nil else { return }
        if let applied = appliedDraft.removeValue(forKey: key), applied == text { return }
        let at = now()
        lastLocalEdit[key] = at
        if text.isEmpty {
            Task { await syncer.cleared(key, at: at) }
        } else {
            Task { await syncer.draftChanged(key, text: text, at: at) }
        }
    }

    /// The Code composer's choices changed: written half a second after the
    /// last change, unless it is the composer settling on a thread just
    /// opened or another device's choice being applied here.
    func prefsChanged(_ key: String, prefs: ThreadSyncPrefs) {
        guard let service, let thread = openThreads[key] else { return }
        if appliedPrefs[key] == prefs { return }
        guard now().timeIntervalSince(thread.openedAt) >= Self.prefsSettle else { return }
        let at = now()
        prefsAt[key] = at
        prefsWrites[key]?.cancel()
        let delay = prefsDelay
        prefsWrites[key] = Task {
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            try? await service.write(key, ThreadSyncUpdate(prefs: prefs, prefsUpdatedAt: at, device: Self.device))
        }
    }

    // MARK: Another device's writes

    /// Applies a row another device wrote, if it should be.
    func receive(_ state: ThreadSyncState, opening: Bool = false) async {
        guard let thread = openThreads[state.key] else { return }
        if let prefs = Self.newerPrefs(state, than: prefsAt[state.key]), let applyPrefs = thread.applyPrefs {
            prefsAt[state.key] = state.prefsUpdatedAt
            appliedPrefs[state.key] = prefs
            applyPrefs(prefs)
        }
        let syncerAllows = await syncer?.shouldApply(state) ?? false
        // The field may have closed while the syncer answered.
        guard let thread = openThreads[state.key] else { return }
        let local = thread.currentDraft()
        let apply = Self.shouldApplyDraft(
            state, local: local, lastLocalEdit: lastLocalEdit[state.key], now: now(),
            syncerAllows: syncerAllows, opening: opening
        )
        guard apply else { return }
        appliedDraft[state.key] = state.draft
        thread.applyDraft(state.draft)
    }

    /// Whether a remote draft replaces what the field holds.
    ///
    /// Opening a thread fills only an empty field. While it is open, a newer
    /// draft from another device replaces the field unless this Mac typed in
    /// the last few seconds or has typing the syncer has not sent.
    static func shouldApplyDraft(
        _ state: ThreadSyncState, local: String, lastLocalEdit: Date?, now: Date, syncerAllows: Bool, opening: Bool
    ) -> Bool {
        guard syncerAllows, state.draftBy != device, state.draft != local else { return false }
        if opening { return local.isEmpty && !state.draft.isEmpty }
        if let lastLocalEdit {
            if now.timeIntervalSince(lastLocalEdit) < typingQuiet { return false }
            guard let remoteAt = state.draftUpdatedAt, remoteAt > lastLocalEdit else { return false }
        }
        return true
    }

    /// Prefs another device wrote after the newest this Mac knows of.
    static func newerPrefs(_ state: ThreadSyncState, than known: Date?) -> ThreadSyncPrefs? {
        guard !state.prefs.isEmpty, let at = state.prefsUpdatedAt else { return nil }
        if let known, at <= known { return nil }
        return state.prefs
    }

    private func watch(_ key: String, service: any DesktopThreadSyncService) async {
        var cursor: String?
        var failures = 0
        // The first page has no wait: it only finds where "now" is.
        var wait = 0
        while !Task.isCancelled {
            do {
                let page = try await service.changes(after: cursor, waitMs: wait, keys: [key])
                guard !Task.isCancelled else { return }
                if cursor != nil {
                    for state in page.threads where state.key == key { await receive(state) }
                }
                cursor = page.cursor ?? cursor
                wait = pollWaitMs
                failures = 0
            } catch {
                guard !Task.isCancelled else { return }
                failures += 1
                try? await Task.sleep(for: .seconds(min(30, 2 * failures)))
            }
        }
    }
}

// MARK: - Code v2

/// The Code v2 thread's seam (``CodeV2ThreadContinuity``), keyed
/// `code:<this Mac>:<env session>`.
@MainActor
final class DesktopCodeThreadContinuity: CodeV2ThreadContinuity {
    let sync: DesktopThreadSync
    let deviceID: String

    init(sync: DesktopThreadSync = .shared, deviceID: String) {
        self.sync = sync
        self.deviceID = deviceID
    }

    /// One per device id, so the environment value keeps its identity
    /// across renders.
    static func shared(deviceID: String) -> DesktopCodeThreadContinuity {
        if let cached, cached.deviceID == deviceID { return cached }
        let made = DesktopCodeThreadContinuity(deviceID: deviceID)
        cached = made
        return made
    }

    private static var cached: DesktopCodeThreadContinuity?

    func key(_ sessionID: String) -> String { ThreadSyncKey.code(deviceID: deviceID, sessionID: sessionID) }

    func open(
        sessionID: String,
        currentDraft: @escaping @MainActor () -> String,
        receive: @escaping @MainActor (CodeV2RemoteThreadUpdate) -> Void
    ) {
        sync.open(
            key(sessionID),
            currentDraft: currentDraft,
            applyDraft: { receive(CodeV2RemoteThreadUpdate(draft: $0)) },
            applyPrefs: { receive(CodeV2RemoteThreadUpdate(prefs: Self.prefs($0))) }
        )
    }

    func draftChanged(sessionID: String, text: String) {
        sync.draftChanged(key(sessionID), text: text)
    }

    func prefsChanged(sessionID: String, prefs: CodeV2SyncedPrefs) {
        sync.prefsChanged(key(sessionID), prefs: Self.prefs(prefs))
    }

    func close(sessionID: String) {
        sync.close(key(sessionID))
    }

    static func prefs(_ prefs: CodeV2SyncedPrefs) -> ThreadSyncPrefs {
        ThreadSyncPrefs(
            model: prefs.model, effort: prefs.effort, mode: prefs.mode,
            interactionMode: prefs.interactionMode, team: prefs.team, skills: prefs.skills
        )
    }

    static func prefs(_ prefs: ThreadSyncPrefs) -> CodeV2SyncedPrefs {
        CodeV2SyncedPrefs(
            model: prefs.model, effort: prefs.effort, mode: prefs.mode,
            interactionMode: prefs.interactionMode, team: prefs.team, skills: prefs.skills
        )
    }
}

// MARK: - Chat

/// Syncs a chat composer's draft for the conversation on screen.
struct DesktopChatDraftSync: ViewModifier {
    /// The conversation, or nil for a draft, a private chat or a project's
    /// composer, none of which has a thread to sync.
    let conversationID: String?
    @Binding var text: String

    func body(content: Content) -> some View {
        content
            .onChange(of: conversationID, initial: true) { old, new in
                let sync = DesktopThreadSync.shared
                if old != new, let old { sync.close(ThreadSyncKey.chat(old)) }
                guard let new else { return }
                let text = $text
                sync.open(
                    ThreadSyncKey.chat(new),
                    currentDraft: { text.wrappedValue },
                    applyDraft: { text.wrappedValue = $0 }
                )
            }
            .onChange(of: text) { _, value in
                guard let conversationID else { return }
                DesktopThreadSync.shared.draftChanged(ThreadSyncKey.chat(conversationID), text: value)
            }
            .onDisappear {
                guard let conversationID else { return }
                DesktopThreadSync.shared.close(ThreadSyncKey.chat(conversationID))
            }
    }
}
