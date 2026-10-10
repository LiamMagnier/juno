import AppKit
import Foundation
import JunoChatKit
import JunoCodeCore
import JunoCodeLocal
import JunoCore
import JunoWorkCore
import JunoWorkLocal
import JunoWorkRuntime
import Observation
import SwiftUI

/// Work in a folder: the folder each chat works in, and the Mac side of every
/// folder call the chat model makes.
///
/// **A folder is made by pointing at it, never by naming it.** The only way in
/// is the macOS open panel (``choose(for:access:)``); the chat model, the
/// server and every remote surface can only ask for calls *inside* a folder
/// the person picked. What leaves this type is a display name and an access
/// mode — the server is told "Invoices, read and write", never where Invoices
/// is.
///
/// **Separate from Work's grants** (``DesktopWorkGrantStore``) on purpose. A
/// Work grant is advertised to the relay, so a phone can dispatch a task into
/// it; a folder picked for one chat must not quietly become reachable from
/// anywhere else. It belongs to its conversation and nothing more.
///
/// **Every call is confined twice.** The chat's executor
/// (``ChatFolderExecutor``) resolves each location through ``GrantAccess``,
/// which canonicalises with `realpath(3)` and refuses anything whose real
/// location — after every symlink — is outside the folder, and `..` never gets
/// that far. Commands run under the kernel sandbox Alevr Code uses
/// (``CommandSandboxProfile``): writes only inside the folder, no network, a
/// scrubbed environment, credentials unreadable.
///
/// **Destructive means asked.** Replacing or editing a file, moving to the
/// Trash, running a command and opening something each put a card in the
/// chat (``pendingApprovals``): Allow once, Always for this folder, or Deny.
@MainActor
@Observable
final class DesktopChatFolderStore: NativeLocalToolHosting {
    /// A folder as the chat sees it: a name and an access mode.
    struct Folder: Equatable, Identifiable {
        let id: String
        let name: String
        let access: ChatFolderAccess
        /// Kinds of action allowed without asking in this folder.
        let alwaysAllowed: Set<ChatFolderApprovalKind>
        /// False when the folder could not be opened (moved, deleted, on a
        /// disk that is not plugged in).
        let isReachable: Bool
    }

    /// A card waiting on the person.
    struct PendingApproval: Identifiable, Equatable {
        let request: ChatFolderApprovalRequest
        let conversationID: String
        let raisedAt: Date
        var id: String { request.id }
    }

    /// The folder the new-chat composer picked before the chat existed.
    private(set) var draft: Folder?
    private(set) var pendingApprovals: [PendingApproval] = []
    private(set) var lastError: String?

    /// How long a card waits before it answers Deny on its own: inside the
    /// server's own wait for the call (twelve minutes), so a late answer never
    /// does something the model has stopped waiting for.
    static let approvalTimeout: TimeInterval = 10 * 60

    static let storageKey = "alevr.chat.folders"

    private let defaults: UserDefaults
    private let system: any ChatFolderSystem
    private let panel: @MainActor (_ message: String) -> URL?
    private var records: [Record]
    private var draftRecord: Record?
    private var accesses: [String: GrantAccess] = [:]
    private var continuations: [String: CheckedContinuation<ChatFolderApprovalDecision, Never>] = [:]

    init(
        defaults: UserDefaults = .standard,
        system: any ChatFolderSystem = DesktopChatFolderSystem(),
        panel: @escaping @MainActor (_ message: String) -> URL? = DesktopChatFolderStore.runOpenPanel
    ) {
        self.defaults = defaults
        self.system = system
        self.panel = panel
        records = Self.load(defaults)
    }

    // MARK: Reading

    /// The folder a chat works in; nil for the new-chat composer reads the draft.
    func folder(for conversationID: String?) -> Folder? {
        guard let conversationID else { return draft }
        return records.first { $0.conversationID == conversationID }.map(describe)
    }

    func approvals(for conversationID: String?) -> [PendingApproval] {
        guard let conversationID else { return [] }
        return pendingApprovals.filter { $0.conversationID == conversationID }
    }

    // MARK: Choosing

    /// Puts the open panel up and gives the chat the folder that comes back.
    /// Closing the panel is a normal answer and changes nothing.
    @discardableResult
    func choose(for conversationID: String?, access: ChatFolderAccess = .readWrite) -> Folder? {
        guard let url = panel("Choose a folder for this chat. Alevr can work only inside it, and asks before it deletes, replaces, runs or opens anything.") else {
            return nil
        }
        return adopt(url, for: conversationID, access: access)
    }

    /// Records a folder the person just picked. Separated from the panel so
    /// everything below it is reachable from a test.
    @discardableResult
    func adopt(_ url: URL, for conversationID: String?, access: ChatFolderAccess) -> Folder? {
        do {
            let bookmark = try GrantAccess.makeBookmark(for: url)
            let record = Record(
                id: UUID().uuidString.lowercased(),
                conversationID: conversationID,
                name: url.lastPathComponent,
                access: access.rawValue,
                bookmark: bookmark,
                always: [],
                createdAt: Date()
            )
            // Opened before it is kept: a folder that cannot be opened is not
            // a folder this chat can work in.
            _ = try open(record)
            lastError = nil
            if let conversationID {
                dropRecord(for: conversationID)
                records.append(record)
                persist()
            } else {
                draftRecord = record
                draft = describe(record)
            }
            return describe(record)
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    /// Stops the chat working in its folder. Revoked first, so a call that is
    /// already running stops at its next step.
    func remove(for conversationID: String?) {
        guard let conversationID else {
            if let draftRecord { accesses.removeValue(forKey: draftRecord.id)?.revoke() }
            draftRecord = nil
            draft = nil
            return
        }
        dropRecord(for: conversationID)
        persist()
        // Anything still waiting on a card in that chat is answered no.
        for pending in pendingApprovals where pending.conversationID == conversationID {
            answer(pending.id, .deny)
        }
    }

    /// Changes read-only to read and write, or back. Re-opened, so the mode
    /// and the boundary that enforces it never disagree.
    func setAccess(_ access: ChatFolderAccess, for conversationID: String?) {
        if let conversationID, let index = records.firstIndex(where: { $0.conversationID == conversationID }) {
            records[index].access = access.rawValue
            accesses.removeValue(forKey: records[index].id)?.revoke()
            persist()
        } else if conversationID == nil, var record = draftRecord {
            record.access = access.rawValue
            accesses.removeValue(forKey: record.id)?.revoke()
            draftRecord = record
            draft = describe(record)
        }
    }

    /// The new chat was created: its draft folder becomes the chat's.
    func adoptDraft(into conversationID: String) {
        guard var record = draftRecord else { return }
        draftRecord = nil
        draft = nil
        record.conversationID = conversationID
        dropRecord(for: conversationID)
        records.append(record)
        persist()
    }

    // MARK: Approvals

    /// The person's answer to a card.
    func answer(_ id: String, _ decision: ChatFolderApprovalDecision) {
        pendingApprovals.removeAll { $0.id == id }
        continuations.removeValue(forKey: id)?.resume(returning: decision)
    }

    func turnEnded(conversationID: String) {
        cancelApprovals(for: conversationID)
    }

    /// The reply stopped: nothing is waiting for these answers any more.
    func cancelApprovals(for conversationID: String) {
        for pending in pendingApprovals where pending.conversationID == conversationID {
            answer(pending.id, .deny)
        }
    }

    private func ask(_ request: ChatFolderApprovalRequest, conversationID: String) async -> ChatFolderApprovalDecision {
        let timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.approvalTimeout))
            guard !Task.isCancelled else { return }
            self?.answer(request.id, .deny)
        }
        defer { timeout.cancel() }
        return await withCheckedContinuation { continuation in
            continuations[request.id] = continuation
            pendingApprovals.append(PendingApproval(request: request, conversationID: conversationID, raisedAt: Date()))
            // Asking from the background is still asking: the Dock bounces
            // once so a card does not sit unseen behind another app.
            if !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
        }
    }

    private func remember(_ kinds: Set<ChatFolderApprovalKind>, recordID: String) {
        guard let index = records.firstIndex(where: { $0.id == recordID }) else { return }
        records[index].always = kinds.map(\.rawValue).sorted()
        persist()
    }

    // MARK: NativeLocalToolHosting

    func folderContext(for conversationID: String) -> NativeLocalFolderContext? {
        guard let record = records.first(where: { $0.conversationID == conversationID }),
            (try? open(record)) != nil
        else { return nil }
        return NativeLocalFolderContext(
            name: record.name,
            access: record.access == ChatFolderAccess.readWrite.rawValue ? .readWrite : .read
        )
    }

    func perform(_ call: NativeLocalToolCall, conversationID: String) async -> NativeLocalToolResult {
        guard let record = records.first(where: { $0.conversationID == conversationID }) else {
            return .failed("No folder is shared with this chat any more, so nothing was done.")
        }
        let access: GrantAccess
        do {
            access = try open(record)
        } catch {
            return .failed("The folder \(record.name) can't be opened. It may have been moved or deleted.")
        }
        let recordID = record.id
        let policy = ChatFolderApprovalPolicy(
            standing: Set(record.always.compactMap(ChatFolderApprovalKind.init(rawValue:))),
            ask: { [weak self] request in
                guard let self else { return .deny }
                return await self.ask(request, conversationID: conversationID)
            },
            remember: { [weak self] kinds in
                Task { @MainActor in self?.remember(kinds, recordID: recordID) }
            }
        )
        let executor = ChatFolderExecutor(access: access, folderName: record.name, gate: policy, system: system)
        let result = await executor.perform(
            ChatFolderCall(id: call.id, tool: call.tool, arguments: call.args.compactMapValues(Self.argument))
        )
        switch result.outcome {
        case .succeeded: return NativeLocalToolResult(outcome: .succeeded, output: result.output)
        case .failed: return NativeLocalToolResult(outcome: .failed, output: result.output)
        case .denied: return NativeLocalToolResult(outcome: .denied, output: result.output)
        }
    }

    static func argument(_ value: JunoJSONValue) -> ChatFolderArgument? {
        switch value {
        case .string(let text): .string(text)
        case .number(let number): .number(number)
        case .bool(let flag): .bool(flag)
        default: nil
        }
    }

    // MARK: Internals

    /// One chat's folder. The bookmark is the capability, so this value never
    /// leaves the process.
    private struct Record: Codable {
        let id: String
        var conversationID: String?
        let name: String
        var access: String
        let bookmark: Data
        var always: [String]
        let createdAt: Date
    }

    private func describe(_ record: Record) -> Folder {
        Folder(
            id: record.id,
            name: record.name,
            access: ChatFolderAccess(rawValue: record.access) ?? .read,
            alwaysAllowed: Set(record.always.compactMap(ChatFolderApprovalKind.init(rawValue:))),
            isReachable: (try? open(record)) != nil
        )
    }

    /// The folder's access, opened once and kept: `GrantAccess` balances its
    /// security scope in `deinit`.
    private func open(_ record: Record) throws -> GrantAccess {
        if let existing = accesses[record.id] { return existing }
        let access = try GrantAccess(
            grantID: WorkGrantID(value: "chat-\(record.id)"),
            mode: (ChatFolderAccess(rawValue: record.access) ?? .read).workMode,
            bookmarkData: record.bookmark
        )
        accesses[record.id] = access
        return access
    }

    private func dropRecord(for conversationID: String) {
        for record in records where record.conversationID == conversationID {
            accesses.removeValue(forKey: record.id)?.revoke()
        }
        records.removeAll { $0.conversationID == conversationID }
    }

    private static func load(_ defaults: UserDefaults) -> [Record] {
        guard let data = defaults.data(forKey: storageKey) else { return [] }
        return (try? JSONDecoder().decode([Record].self, from: data)) ?? []
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(records) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }

    static func runOpenPanel(_ message: String) -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Work Here"
        panel.message = message
        guard panel.runModal() == .OK else { return nil }
        return panel.url
    }
}

extension EnvironmentValues {
    /// The chat folders, where the window composes them. Nil in previews and
    /// on any surface that cannot work in a folder, which hides the control.
    @Entry var desktopChatFolders: DesktopChatFolderStore? = nil
}

// MARK: - The Mac's hands

/// What the chat's folder calls need from macOS beyond the file service: a
/// contained shell, Launch Services and document text.
struct DesktopChatFolderSystem: ChatFolderSystem {
    func run(_ request: ChatFolderCommandRequest) async throws -> ChatFolderCommandOutcome {
        // Alevr Code's executor, contained: the kernel sandbox lets the command
        // write only inside the folder (and the per-user temp and toolchain
        // caches a build needs), opens no socket, and starts from a scrubbed
        // environment that carries no Alevr token or provider key.
        let executor = CommandExecutionService.contained(workspaceRootURL: request.folderRoot)
        let relative = Self.relativePath(of: request.workingDirectory, in: request.folderRoot)
        let workingDirectory = try relative.map { try WorkspacePath($0) }
        var output = ""
        var result: CommandResult?
        for try await event in executor.stream(
            request.command,
            timeoutSeconds: Double(request.timeoutSeconds),
            outputLimit: OutputLimit(maximumBytes: request.outputLimitBytes),
            workingDirectory: workingDirectory
        ) {
            switch event {
            case .stdout(let text), .stderr(let text): output += text
            case .completed(let completed): result = completed
            }
        }
        return ChatFolderCommandOutcome(
            exitCode: result?.exitCode,
            output: output,
            timedOut: result?.wasTimeout ?? false,
            truncated: result?.wasTruncated ?? false,
            contained: executor.isContained
        )
    }

    func open(_ url: URL, reveal: Bool) async -> Bool {
        await MainActor.run {
            if reveal {
                NSWorkspace.shared.activateFileViewerSelecting([url])
                return true
            }
            return NSWorkspace.shared.open(url)
        }
    }

    func extractText(from url: URL) async -> String? {
        await Task.detached(priority: .userInitiated) { ChatFolderDocumentText.extract(from: url) }.value
    }

    /// The working folder relative to the root, or nil for the root itself.
    /// Both arrive canonical (`realpath`) from the executor, so they are
    /// compared as written: Foundation's standardising drops a leading
    /// `/private` from one spelling and not the other.
    static func relativePath(of directory: URL, in root: URL) -> String? {
        func trimmed(_ url: URL) -> String {
            var path = url.path
            while path.count > 1, path.hasSuffix("/") { path.removeLast() }
            return path
        }
        let rootPath = trimmed(root)
        let path = trimmed(directory)
        guard path != rootPath else { return nil }
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard path.hasPrefix(prefix) else { return nil }
        return String(path.dropFirst(prefix.count))
    }
}
