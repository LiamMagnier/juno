import Foundation
import JunoCodeCore
import JunoSync

/// Where a new session will run, while its empty thread is on screen.
public struct CodeLinkNewSession: Equatable, Sendable {
    /// The folder on the Mac, nil until one is known or chosen.
    public var cwd: String?
    /// Its own worktree beside the checkout.
    public var worktree: Bool
    /// The person picked the folder (a default never overrides it).
    public var chosen: Bool

    public init(cwd: String? = nil, worktree: Bool = false, chosen: Bool = false) {
        self.cwd = cwd
        self.worktree = worktree
        self.chosen = chosen
    }
}

/// The last Mac, folder per Mac, and model, effort and mode a session was
/// started with from this iPhone. Nil defaults remember nothing (tests, previews).
@MainActor
struct CodeLinkMemory {
    let defaults: UserDefaults?
    static let prefix = "alevr.code.link."

    var lastMac: String? {
        get { defaults?.string(forKey: Self.prefix + "lastMac") }
        nonmutating set { defaults?.set(newValue, forKey: Self.prefix + "lastMac") }
    }

    func folder(for deviceID: String) -> String? {
        defaults?.string(forKey: Self.prefix + "folder." + deviceID)
    }

    func setFolder(_ path: String, for deviceID: String) {
        defaults?.set(path, forKey: Self.prefix + "folder." + deviceID)
    }

    /// Model, effort and mode only: plan, team and skills are per thread.
    var prefs: ThreadSyncPrefs? {
        get {
            guard let data = defaults?.data(forKey: Self.prefix + "prefs") else { return nil }
            return try? JSONDecoder().decode(ThreadSyncPrefs.self, from: data)
        }
        nonmutating set {
            guard let newValue, let data = try? JSONEncoder().encode(newValue) else {
                defaults?.removeObject(forKey: Self.prefix + "prefs")
                return
            }
            defaults?.set(data, forKey: Self.prefix + "prefs")
        }
    }
}

public extension CodeLinkRemoteModel {
    /// The thread screen is up: a live session, or a new one being written.
    var showsThread: Bool { openSessionID != nil || newSession != nil }

    /// The empty thread: pickers above the composer, nothing sent yet.
    var isDraftingNewSession: Bool { newSession != nil && openSessionID == nil && startingPrompt == nil }

    /// The first message is on its way and the Mac has not made the session yet.
    var isStartingNewSession: Bool { newSession != nil && openSessionID == nil && startingPrompt != nil }

    /// The first message, shown in the thread until the Mac's own copy arrives.
    var pendingFirstMessage: String? {
        guard let text = startingPrompt else { return nil }
        guard let id = openSessionID else { return newSession != nil ? text : nil }
        guard startingSessionID == nil || id == startingSessionID else { return nil }
        let arrived = openSnapshot?.items.contains { item in
            if case .userMessage = item { return true }
            return false
        } ?? false
        return arrived ? nil : text
    }

    /// Folders this Mac's recent sessions ran in, newest first, inside what it shares.
    var recentFolders: [String] {
        let browser = CodeLinkFolderBrowser(sharedFolders: selectedMac?.info?.sharedFolders ?? [])
        var seen = Set<String>()
        var out: [String] = []
        let byDate = remote.sessions.values.sorted {
            CodeLinkRemoteState.date($0.updatedAt) > CodeLinkRemoteState.date($1.updatedAt)
        }
        for session in byDate {
            let path = CodeLinkFolderBrowser.normalized(session.cwd)
            guard browser.allows(path), seen.insert(path).inserted else { continue }
            out.append(path)
            if out.count == 4 { break }
        }
        return out
    }

    /// Opens a projectless draft, retaining only the last model, effort and mode.
    func beginNewSession(keepingAttachments: Bool = false) {
        let kept = keepingAttachments ? draftAttachments : []
        if openSessionID != nil { close() }
        draftAttachments = kept
        startingPrompt = nil
        startingSessionID = nil
        lastError = nil
        threadDiff = []
        turnDiff = []
        browser = CodeLinkFolderBrowser(sharedFolders: selectedMac?.info?.sharedFolders ?? [])
        newSession = CodeLinkNewSession()
        applyingRemote = true
        if let prefs = memory.prefs {
            composer.apply(prefs, catalogue: catalogue)
        }
        composer.interactionMode = .default
        composer.team = .solo
        composer.skills = []
        composer.fillDefault(from: catalogue)
        applyingRemote = false
    }

    /// Leaves the empty thread without starting anything.
    func cancelNewSession() {
        guard openSessionID == nil else { return }
        newSession = nil
        startingPrompt = nil
        startingSessionID = nil
        browser = nil
    }

    /// Another Mac for the new session: its folders, models and skills.
    func chooseNewSessionMac(_ deviceID: String) async {
        guard newSession != nil, deviceID != selectedDeviceID else { return }
        newSession = CodeLinkNewSession()
        await select(deviceID)
        browser = CodeLinkFolderBrowser(sharedFolders: selectedMac?.info?.sharedFolders ?? [])

    }

    /// A folder for the new session; only inside what the Mac shares.
    func chooseNewSessionFolder(_ path: String) {
        let browser = self.browser ?? CodeLinkFolderBrowser(sharedFolders: selectedMac?.info?.sharedFolders ?? [])
        guard browser.allows(path) else { return }
        newSession?.cwd = CodeLinkFolderBrowser.normalized(path)
        newSession?.chosen = true
    }

    func setNewSessionWorktree(_ on: Bool) {
        newSession?.worktree = on
    }

    /// Sends the first message: the thread shows it at once, the Mac makes
    /// the session and starts the turn, and this screen becomes that thread.
    /// On failure the words go back in the composer.
    @discardableResult
    func startNewSession(_ text: String) async -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let draft = newSession, startingPrompt == nil else { return nil }
        guard let cwd = draft.cwd else {
            lastError = "Choose a project first."
            return nil
        }
        guard let deviceID = selectedDeviceID else { return nil }
        startingPrompt = trimmed
        applyingRemote = true
        self.draft = ""
        applyingRemote = false
        let id = await createSession(cwd: cwd, worktree: draft.worktree, prompt: trimmed)
        guard let id else {
            if let made = openSessionID {
                // The Mac made the session but refused the turn: stay in it,
                // with the words back in the composer to send again.
                startingSessionID = made
                newSession = nil
            }
            startingPrompt = nil
            applyingRemote = true
            self.draft = trimmed
            applyingRemote = false
            return nil
        }
        startingSessionID = id
        newSession = nil
        memory.lastMac = deviceID
        memory.setFolder(cwd, for: deviceID)
        let prefs = composer.prefs
        memory.prefs = ThreadSyncPrefs(model: prefs.model, effort: prefs.effort, mode: prefs.mode)
        return id
    }

    /// The default folder: the one last used on this Mac, else its newest session's.
    internal func defaultFolder() -> String? {
        let browser = CodeLinkFolderBrowser(sharedFolders: selectedMac?.info?.sharedFolders ?? [])
        if let id = selectedDeviceID, let remembered = memory.folder(for: id), browser.allows(remembered) {
            return remembered
        }
        return recentFolders.first
    }

    /// Host info or the session list arrived: fill what the person has not chosen.
    internal func newSessionSourcesChanged() {
        guard newSession != nil, openSessionID == nil else { return }
        let shared = selectedMac?.info?.sharedFolders ?? []
        if browser == nil || browser?.sharedFolders != shared.map(CodeLinkFolderBrowser.normalized), browser?.isAtRoot != false {
            browser = CodeLinkFolderBrowser(sharedFolders: shared)
        }
    }
}
