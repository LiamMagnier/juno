import Foundation
import JunoWorkCore
import JunoWorkLocal

/// Decides whether a call that has to ask may go ahead.
public protocol ChatFolderApprovalGate: Sendable {
    func decide(_ request: ChatFolderApprovalRequest) async -> ChatFolderApprovalDecision
}

/// The approval gate with "Always for this folder" in it.
///
/// A kind the person allowed always is let through without a card; anything
/// else asks. Remembering is by kind (``ChatFolderApprovalKind``), held per
/// folder by whoever owns the folder's record, and handed back through
/// `remember` so it survives a relaunch.
public final class ChatFolderApprovalPolicy: ChatFolderApprovalGate, @unchecked Sendable {
    private let lock = NSLock()
    private var standing: Set<ChatFolderApprovalKind>
    private let ask: @Sendable (ChatFolderApprovalRequest) async -> ChatFolderApprovalDecision
    private let remember: @Sendable (Set<ChatFolderApprovalKind>) -> Void

    public init(
        standing: Set<ChatFolderApprovalKind>,
        ask: @escaping @Sendable (ChatFolderApprovalRequest) async -> ChatFolderApprovalDecision,
        remember: @escaping @Sendable (Set<ChatFolderApprovalKind>) -> Void = { _ in }
    ) {
        self.standing = standing
        self.ask = ask
        self.remember = remember
    }

    public var alwaysAllowed: Set<ChatFolderApprovalKind> {
        lock.lock()
        defer { lock.unlock() }
        return standing
    }

    public func decide(_ request: ChatFolderApprovalRequest) async -> ChatFolderApprovalDecision {
        if alwaysAllowed.contains(request.kind) { return .allowOnce }
        let decision = await ask(request)
        if decision == .allowAlways { remember(insert(request.kind)) }
        return decision
    }

    private func insert(_ kind: ChatFolderApprovalKind) -> Set<ChatFolderApprovalKind> {
        lock.withLock {
            standing.insert(kind)
            return standing
        }
    }
}

/// Runs the chat's folder calls against one granted folder.
///
/// Every location goes through ``GrantedPath`` (no absolute paths, no `..`,
/// no control characters) and then through the grant's ``GrantAccessing``
/// immediately before the disk is touched, which resolves every symlink and
/// refuses anything whose real location is outside the folder. The file work
/// itself is ``WorkFileService``'s — atomic writes, the Trash and never a
/// permanent delete, the grant's mode checked before anything opens — so the
/// chat and Work cannot disagree about what "inside the folder" means.
///
/// What it adds is the chat's own rule: a call that replaces or edits an
/// existing file, moves something to the Trash, runs a command or opens
/// something on the Mac asks first (``ChatFolderApprovalGate``), and is
/// checked against the folder's mode *before* it asks, so a read-only folder
/// never shows a card for something it would refuse anyway.
public final class ChatFolderExecutor: Sendable {
    /// What one read hands the model, at most.
    public static let maximumTextCharacters = 50_000
    /// What one listing or search hands the model, at most.
    public static let maximumEntries = 400
    public static let defaultCommandTimeout = 60
    public static let maximumCommandTimeout = 300
    public static let commandOutputLimitBytes = 48 * 1_024

    /// Extensions read through ``ChatFolderSystem/extractText(from:)``.
    static let documentExtensions: Set<String> = ["pdf", "docx", "doc", "rtf", "rtfd", "odt"]

    public let folderName: String
    private let access: any GrantAccessing
    private let service: WorkFileService
    private let gate: any ChatFolderApprovalGate
    private let system: any ChatFolderSystem

    public init(
        access: any GrantAccessing,
        folderName: String,
        gate: any ChatFolderApprovalGate,
        system: any ChatFolderSystem
    ) {
        self.access = access
        self.folderName = folderName
        self.service = WorkFileService(access: access)
        self.gate = gate
        self.system = system
    }

    /// Runs one call. Never throws: every way it can end is a result the
    /// model reads.
    public func perform(_ call: ChatFolderCall) async -> ChatFolderResult {
        guard let tool = ChatFolderTool(rawValue: call.tool) else {
            return .failed("\(call.tool) is not a folder tool this Mac knows.")
        }
        do {
            switch tool {
            case .listDir: return try await list(call)
            case .readFile: return try await read(call)
            case .search: return try await search(call)
            case .writeFile: return try await write(call)
            case .editFile: return try await edit(call)
            case .move: return try await move(call)
            case .makeDir: return try await makeDir(call)
            case .delete: return try await delete(call)
            case .runCommand: return try await run(call)
            case .open: return try await open(call)
            }
        } catch let refusal as ChatFolderRefusal {
            return refusal.result
        } catch {
            return .failed(Self.describe(error))
        }
    }

    // MARK: Looking

    private func list(_ call: ChatFolderCall) async throws -> ChatFolderResult {
        let path = try Self.location(call.string("path"))
        let entries = try await service.list(path)
        let heading = path.map { "\($0.value)/" } ?? "the folder's root"
        guard !entries.isEmpty else { return .succeeded("\(heading) is empty.") }
        var lines = ["\(entries.count) item\(entries.count == 1 ? "" : "s") in \(heading):"]
        for entry in entries.prefix(Self.maximumEntries) {
            lines.append(Self.describe(entry))
        }
        if entries.count > Self.maximumEntries {
            lines.append("… and \(entries.count - Self.maximumEntries) more not shown.")
        }
        return .succeeded(lines.joined(separator: "\n"))
    }

    private func read(_ call: ChatFolderCall) async throws -> ChatFolderResult {
        let path = try Self.required(call.string("path"), "path")
        let metadata = try await service.metadata(of: path)
        guard !metadata.isDirectory else {
            return .failed("\(path.value) is a folder. Use folder_list_dir to see what is in it.")
        }
        if let ext = path.fileExtension?.lowercased(), Self.documentExtensions.contains(ext) {
            let url = try access.resolveForReading(path)
            guard let text = await system.extractText(from: url), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .failed("No text could be taken out of \(path.value). It may be scanned images, or protected.")
            }
            return .succeeded(Self.capped(text, total: text.count))
        }
        let read = try await service.read(path, maximumBytes: 512 * 1_024)
        if read.data.contains(0) {
            return .failed(
                "\(path.value) is a binary file (\(Self.size(read.totalByteCount))), so it can't be read as text. "
                    + "A command such as file, sips or unzip -l can inspect it."
            )
        }
        let text = String(data: read.data, encoding: .utf8) ?? String(decoding: read.data, as: UTF8.self)
        let capped = Self.capped(text, total: nil)
        if read.wasTruncated {
            return .succeeded(capped + "\n\n[Only the first \(Self.size(read.data.count)) of \(Self.size(read.totalByteCount)) were read.]")
        }
        return .succeeded(capped)
    }

    private func search(_ call: ChatFolderCall) async throws -> ChatFolderResult {
        let name = call.string("name").flatMap { $0.isEmpty ? nil : $0 }
        let text = call.string("text").flatMap { $0.isEmpty ? nil : $0 }
        guard name != nil || text != nil else { return .failed("Give a name or a text to search for.") }
        let results = try await service.search(
            WorkSearchQuery(nameContains: name, contentContains: text, limit: Self.maximumEntries)
        )
        guard !results.isEmpty else { return .succeeded("Nothing in the folder matched.") }
        var lines = ["\(results.count) match\(results.count == 1 ? "" : "es"):"]
        for result in results {
            if let line = result.matchedLine, let number = result.lineNumber {
                lines.append("\(result.entry.path.value):\(number): \(line.trimmingCharacters(in: .whitespaces))")
            } else {
                lines.append(Self.describe(result.entry))
            }
        }
        return .succeeded(lines.joined(separator: "\n"))
    }

    // MARK: Changing

    private func write(_ call: ChatFolderCall) async throws -> ChatFolderResult {
        let path = try Self.required(call.string("path"), "path")
        guard let content = call.string("content") else { throw ChatFolderRefusal.failed("content is required.") }
        try access.requireMode(for: .write, path: path)
        let target = try access.resolveForMutation(path)
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: target.path, isDirectory: &isDirectory)
        if exists, isDirectory.boolValue {
            return .failed("\(path.value) is a folder, so a file can't be written there.")
        }
        if exists {
            try await ask(
                call, .replace,
                title: "Replace \(path.displayName)?",
                detail: "\(path.value)\n\(content.count) characters of new content",
                explanation: "The file that is there now is replaced with what Alevr wrote. Its current contents are not kept."
            )
        }
        try await service.write(path, data: Data(content.utf8))
        return .succeeded("\(exists ? "Replaced" : "Created") \(path.value) (\(Self.size(content.utf8.count))).")
    }

    private func edit(_ call: ChatFolderCall) async throws -> ChatFolderResult {
        let path = try Self.required(call.string("path"), "path")
        guard let old = call.string("old_text"), !old.isEmpty else { throw ChatFolderRefusal.failed("old_text is required.") }
        let new = call.string("new_text") ?? ""
        try access.requireMode(for: .write, path: path)
        let read = try await service.read(path, maximumBytes: 4 * 1_024 * 1_024)
        guard !read.wasTruncated, let fingerprint = read.fingerprint else {
            return .failed("\(path.value) is too large to edit in place. Write a new file instead.")
        }
        guard !read.data.contains(0), let text = String(data: read.data, encoding: .utf8) else {
            return .failed("\(path.value) is not a text file, so it can't be edited as text.")
        }
        let occurrences = text.components(separatedBy: old).count - 1
        guard occurrences > 0 else {
            return .failed("old_text was not found in \(path.value). Read the file again and copy the passage exactly.")
        }
        guard occurrences == 1 else {
            return .failed("old_text appears \(occurrences) times in \(path.value). Include more of the surrounding text so it matches once.")
        }
        try await ask(
            call, .replace,
            title: "Edit \(path.displayName)?",
            detail: "\(path.value)\n− \(Self.excerpt(old))\n+ \(Self.excerpt(new))",
            explanation: "One passage of the file is replaced. The rest of it stays as it is."
        )
        let updated = text.replacingOccurrences(of: old, with: new)
        try await service.write(path, data: Data(updated.utf8), expectedBase: fingerprint)
        return .succeeded("Edited \(path.value): replaced \(old.count) characters with \(new.count).")
    }

    private func move(_ call: ChatFolderCall) async throws -> ChatFolderResult {
        let from = try Self.required(call.string("from"), "from")
        let to = try Self.required(call.string("to"), "to")
        guard from != to else { return .failed("from and to are the same place.") }
        guard !to.isDescendant(of: from) else { return .failed("A folder can't be moved inside itself.") }
        try access.requireMode(for: .move, path: to)
        try await service.move(from: from, to: to)
        return .succeeded("Moved \(from.value) to \(to.value).")
    }

    private func makeDir(_ call: ChatFolderCall) async throws -> ChatFolderResult {
        let path = try Self.required(call.string("path"), "path")
        try access.requireMode(for: .createFolder, path: path)
        let created = try await service.createFolder(at: path)
        return .succeeded(created ? "Made the folder \(path.value)." : "\(path.value) already existed.")
    }

    private func delete(_ call: ChatFolderCall) async throws -> ChatFolderResult {
        let path = try Self.required(call.string("path"), "path")
        try access.requireMode(for: .trash, path: path)
        guard service.exists(path) else { throw WorkFileServiceError.notFound(path: path.value) }
        try await ask(
            call, .delete,
            title: "Move \(path.displayName) to the Trash?",
            detail: path.value,
            explanation: "It leaves the folder. You can put it back from the Trash in Finder."
        )
        _ = try await service.trash(path)
        return .succeeded("Moved \(path.value) to the Trash.")
    }

    // MARK: Acting on the Mac

    private func run(_ call: ChatFolderCall) async throws -> ChatFolderResult {
        guard access.mode.allowsWrite else {
            return .failed("This folder was shared read only, so commands can't run in it.")
        }
        guard let command = call.string("command")?.trimmingCharacters(in: .whitespacesAndNewlines), !command.isEmpty else {
            return .failed("command is empty.")
        }
        let root = try rootURL()
        let cwdPath = try Self.location(call.string("cwd"))
        let directory: URL
        if let cwdPath {
            directory = try access.resolveForReading(cwdPath)
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                return .failed("\(cwdPath.value) is not a folder.")
            }
        } else {
            directory = root
        }
        let timeout = min(max(call.integer("timeout_seconds") ?? Self.defaultCommandTimeout, 1), Self.maximumCommandTimeout)
        let place = cwdPath.map { "\(folderName)/\($0.value)" } ?? folderName
        try await ask(
            call, .command,
            title: "Run this command?",
            detail: "$ \(command)\nin \(place)",
            explanation: "It runs on this Mac, starting in \(place). It can change files only inside this folder, can't reach the internet, and stops after \(timeout) seconds."
        )
        let outcome = try await system.run(
            ChatFolderCommandRequest(
                command: command,
                workingDirectory: directory,
                folderRoot: root,
                timeoutSeconds: timeout,
                outputLimitBytes: Self.commandOutputLimitBytes
            )
        )
        var lines: [String] = []
        if outcome.timedOut {
            lines.append("Stopped after \(timeout) seconds.")
        } else if let code = outcome.exitCode {
            lines.append("Exit code \(code).")
        }
        if !outcome.contained {
            lines.append("(This Mac could not sandbox the command; it ran with the user's own permissions.)")
        }
        let output = outcome.output.trimmingCharacters(in: .whitespacesAndNewlines)
        lines.append(output.isEmpty ? "(no output)" : output)
        if outcome.truncated { lines.append("[Output was cut at \(Self.size(Self.commandOutputLimitBytes)).]") }
        let text = lines.joined(separator: "\n")
        return outcome.exitCode == 0 && !outcome.timedOut ? .succeeded(text) : .failed(text)
    }

    private func open(_ call: ChatFolderCall) async throws -> ChatFolderResult {
        let path = try Self.location(call.string("path"))
        let reveal = call.flag("reveal")
        let url = try path.map { try access.resolveForReading($0) } ?? rootURL()
        let name = path?.displayName ?? folderName
        try await ask(
            call, .open,
            title: reveal ? "Show \(name) in Finder?" : "Open \(name)?",
            detail: path?.value ?? folderName,
            explanation: reveal
                ? "A Finder window opens with it selected."
                : "It opens in its default app on this Mac, which may run whatever the file asks that app to do."
        )
        guard await system.open(url, reveal: reveal) else {
            return .failed("macOS could not open \(path?.value ?? folderName).")
        }
        return .succeeded(reveal ? "Showed \(path?.value ?? folderName) in Finder." : "Opened \(path?.value ?? folderName) on the Mac.")
    }

    // MARK: Asking

    private func ask(
        _ call: ChatFolderCall,
        _ kind: ChatFolderApprovalKind,
        title: String,
        detail: String,
        explanation: String
    ) async throws {
        let decision = await gate.decide(
            ChatFolderApprovalRequest(
                id: call.id,
                kind: kind,
                folderName: folderName,
                title: title,
                detail: detail,
                explanation: explanation
            )
        )
        if decision == .deny { throw ChatFolderRefusal.denied }
    }

    // MARK: Helpers

    private func rootURL() throws -> URL {
        // Read through the grant so a revoked folder refuses here too.
        if let revocable = access as? GrantAccess { try revocable.requireActiveGrant() }
        return URL(fileURLWithPath: GrantAccess.canonicalPath(access.rootURL.path), isDirectory: true)
    }

    /// A folder-relative location, or nil for the folder itself. `./`, a
    /// trailing `/` and `.` are forgiven; anything ``GrantedPath`` refuses —
    /// absolute, `~`, `..`, control characters — is refused.
    static func location(_ raw: String?) throws -> GrantedPath? {
        guard var value = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        while value.hasPrefix("./") { value.removeFirst(2) }
        while value.count > 1, value.hasSuffix("/") { value.removeLast() }
        if value == "." || value.isEmpty { return nil }
        return try GrantedPath(value)
    }

    static func required(_ raw: String?, _ key: String) throws -> GrantedPath {
        guard let path = try location(raw) else { throw ChatFolderRefusal.failed("\(key) is required.") }
        return path
    }

    static func describe(_ entry: WorkDirectoryEntry) -> String {
        if entry.isDirectory { return "\(entry.path.value)/" }
        var parts = [entry.path.value]
        if let bytes = entry.byteCount { parts.append(size(bytes)) }
        if let modified = entry.modifiedAt { parts.append("modified \(Self.dateFormatter.string(from: modified))") }
        return parts.joined(separator: "  ")
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    static func capped(_ text: String, total: Int?) -> String {
        guard text.count > maximumTextCharacters else { return text }
        return String(text.prefix(maximumTextCharacters))
            + "\n\n[Only the first \(maximumTextCharacters) of \(total ?? text.count) characters are shown.]"
    }

    static func excerpt(_ text: String) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: "⏎ ")
        return flat.count > 240 ? String(flat.prefix(239)) + "…" : flat
    }

    // Only ever read after it is built; DateFormatter is thread-safe for formatting.
    nonisolated(unsafe) private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter
    }()

    /// Errors in the words the model can act on. The shared error copy still
    /// names the product's old name; the chat says Alevr.
    static func describe(_ error: any Error) -> String {
        let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        return text.replacingOccurrences(of: "Juno", with: "Alevr")
    }
}

/// How a call stops early: refused with a reason, or declined by the person.
enum ChatFolderRefusal: Error {
    case failed(String)
    case denied

    var result: ChatFolderResult {
        switch self {
        case .failed(let reason): .failed(reason)
        case .denied: ChatFolderResult(outcome: .denied, output: "The user chose not to allow this.")
        }
    }
}
