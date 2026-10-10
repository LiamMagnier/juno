import Foundation
import JunoWorkCore
import JunoWorkLocal
import XCTest

@testable import JunoWorkRuntime

/// Work in a folder, from chat: containment (symlinks and `..`), the approval
/// flow, and each tool against a real folder on disk.
final class ChatFolderExecutorTests: XCTestCase {
    // MARK: Fixtures

    private struct Folder {
        let grant: URL
        let outside: URL

        @discardableResult
        func write(_ relative: String, _ text: String) throws -> URL {
            let url = grant.appendingPathComponent(relative)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: url)
            return url
        }

        func text(_ relative: String) -> String? {
            try? String(contentsOf: grant.appendingPathComponent(relative), encoding: .utf8)
        }

        func exists(_ relative: String) -> Bool {
            FileManager.default.fileExists(atPath: grant.appendingPathComponent(relative).path)
        }
    }

    /// Records every card it is shown and answers with `answer`.
    private final class RecordingGate: ChatFolderApprovalGate, @unchecked Sendable {
        private let lock = NSLock()
        private var asked: [ChatFolderApprovalRequest] = []
        let answer: ChatFolderApprovalDecision

        init(_ answer: ChatFolderApprovalDecision) { self.answer = answer }

        var requests: [ChatFolderApprovalRequest] {
            lock.lock()
            defer { lock.unlock() }
            return asked
        }

        func decide(_ request: ChatFolderApprovalRequest) async -> ChatFolderApprovalDecision {
            lock.withLock { asked.append(request) }
            return answer
        }
    }

    private final class FakeSystem: ChatFolderSystem, @unchecked Sendable {
        private let lock = NSLock()
        private(set) var commands: [ChatFolderCommandRequest] = []
        private(set) var opened: [(URL, Bool)] = []
        var commandOutcome = ChatFolderCommandOutcome(exitCode: 0, output: "hello", timedOut: false, truncated: false, contained: true)

        func run(_ request: ChatFolderCommandRequest) async throws -> ChatFolderCommandOutcome {
            lock.withLock { commands.append(request) }
            return commandOutcome
        }

        func open(_ url: URL, reveal: Bool) async -> Bool {
            lock.withLock { opened.append((url, reveal)) }
            return true
        }

        func extractText(from url: URL) async -> String? {
            #if os(macOS)
                ChatFolderDocumentText.extract(from: url)
            #else
                nil
            #endif
        }
    }

    private func makeFolder() throws -> Folder {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-folder-\(UUID().uuidString)", isDirectory: true)
        let grant = root.appendingPathComponent("Invoices", isDirectory: true)
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: grant, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return Folder(grant: grant, outside: outside)
    }

    private func executor(
        _ folder: Folder,
        access: ChatFolderAccess = .readWrite,
        gate: any ChatFolderApprovalGate = RecordingGate(.allowOnce),
        system: any ChatFolderSystem = FakeSystem()
    ) throws -> ChatFolderExecutor {
        let grant = try GrantAccess(grantID: WorkGrantID(value: "chat-1"), mode: access.workMode, grantedURL: folder.grant)
        return ChatFolderExecutor(access: grant, folderName: "Invoices", gate: gate, system: system)
    }

    private func call(_ tool: ChatFolderTool, _ arguments: [String: ChatFolderArgument] = [:]) -> ChatFolderCall {
        ChatFolderCall(id: "lft_\(UUID().uuidString.lowercased())", tool: tool.rawValue, arguments: arguments)
    }

    // MARK: Containment

    func testDotDotAndAbsolutePathsAreRefused() async throws {
        let folder = try makeFolder()
        try Data("secret".utf8).write(to: folder.outside.appendingPathComponent("secret.txt"))
        let run = try executor(folder)
        for path in ["../outside/secret.txt", "a/../../outside/secret.txt", "/etc/hosts", "~/.ssh/id_rsa"] {
            let result = await run.perform(call(.readFile, ["path": .string(path)]))
            XCTAssertEqual(result.outcome, .failed, path)
            XCTAssertFalse(result.output.contains("secret"), path)
        }
        let write = await run.perform(call(.writeFile, ["path": .string("../outside/new.txt"), "content": .string("x")]))
        XCTAssertEqual(write.outcome, .failed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.outside.appendingPathComponent("new.txt").path))
    }

    func testSymlinkOutOfTheFolderIsNeitherReadNorWrittenThrough() async throws {
        let folder = try makeFolder()
        try Data("secret".utf8).write(to: folder.outside.appendingPathComponent("secret.txt"))
        try FileManager.default.createSymbolicLink(
            at: folder.grant.appendingPathComponent("escape"),
            withDestinationURL: folder.outside
        )
        try FileManager.default.createSymbolicLink(
            at: folder.grant.appendingPathComponent("leak.txt"),
            withDestinationURL: folder.outside.appendingPathComponent("secret.txt")
        )
        let run = try executor(folder)

        let viaFolderLink = await run.perform(call(.readFile, ["path": .string("escape/secret.txt")]))
        XCTAssertEqual(viaFolderLink.outcome, .failed)
        XCTAssertFalse(viaFolderLink.output.contains("secret\n"))
        let viaFileLink = await run.perform(call(.readFile, ["path": .string("leak.txt")]))
        XCTAssertEqual(viaFileLink.outcome, .failed)
        XCTAssertNotEqual(viaFileLink.output, "secret")

        let writeThrough = await run.perform(call(.writeFile, ["path": .string("escape/planted.txt"), "content": .string("x")]))
        XCTAssertEqual(writeThrough.outcome, .failed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.outside.appendingPathComponent("planted.txt").path))

        let commandThrough = await run.perform(call(.runCommand, ["command": .string("ls"), "cwd": .string("escape")]))
        XCTAssertEqual(commandThrough.outcome, .failed, "a command cannot start in a linked folder outside")

        let search = await run.perform(call(.search, ["text": .string("secret")]))
        XCTAssertFalse(search.output.contains("escape/"), "a search never walks a link out of the folder")
    }

    // MARK: The approval flow

    func testAlwaysForThisFolderStopsAskingForThatKindOnly() async throws {
        let asked = AskCounter()
        let remembered = RememberedKinds()
        let policy = ChatFolderApprovalPolicy(
            standing: [],
            ask: { request in
                await asked.note(request.kind)
                return request.kind == .delete ? .allowAlways : .allowOnce
            },
            remember: { kinds in remembered.set(kinds) }
        )
        let request = { (kind: ChatFolderApprovalKind) in
            ChatFolderApprovalRequest(id: UUID().uuidString, kind: kind, folderName: "Invoices", title: "", detail: "", explanation: "")
        }
        let first = await policy.decide(request(.delete))
        let second = await policy.decide(request(.delete))
        let third = await policy.decide(request(.command))
        let fourth = await policy.decide(request(.command))
        XCTAssertEqual(first, .allowAlways)
        XCTAssertEqual(second, .allowOnce, "remembered: no second card")
        XCTAssertEqual(third, .allowOnce)
        XCTAssertEqual(fourth, .allowOnce)
        let counts = await asked.counts
        XCTAssertEqual(counts[.delete], 1)
        XCTAssertEqual(counts[.command], 2, "allowing once keeps asking")
        XCTAssertEqual(remembered.value, [.delete])
        XCTAssertEqual(policy.alwaysAllowed, [.delete])
    }

    func testDenyLeavesTheFolderAsItWas() async throws {
        let folder = try makeFolder()
        try folder.write("report.md", "v1")
        let gate = RecordingGate(.deny)
        let system = FakeSystem()
        let run = try executor(folder, gate: gate, system: system)

        let replace = await run.perform(call(.writeFile, ["path": .string("report.md"), "content": .string("v2")]))
        XCTAssertEqual(replace.outcome, .denied)
        XCTAssertEqual(folder.text("report.md"), "v1")

        let delete = await run.perform(call(.delete, ["path": .string("report.md")]))
        XCTAssertEqual(delete.outcome, .denied)
        XCTAssertTrue(folder.exists("report.md"))

        let command = await run.perform(call(.runCommand, ["command": .string("rm -rf .")]))
        XCTAssertEqual(command.outcome, .denied)
        XCTAssertTrue(system.commands.isEmpty, "a declined command never runs")

        let open = await run.perform(call(.open, ["path": .string("report.md")]))
        XCTAssertEqual(open.outcome, .denied)
        XCTAssertTrue(system.opened.isEmpty)

        XCTAssertEqual(gate.requests.map(\.kind), [.replace, .delete, .command, .open])
        XCTAssertEqual(gate.requests.first?.title, "Replace report.md?")
        XCTAssertEqual(gate.requests[2].detail, "$ rm -rf .\nin Invoices")
    }

    func testNewFilesAndLookingNeverAsk() async throws {
        let folder = try makeFolder()
        try folder.write("a.txt", "alpha")
        let gate = RecordingGate(.deny)
        let run = try executor(folder, gate: gate)
        _ = await run.perform(call(.listDir))
        _ = await run.perform(call(.readFile, ["path": .string("a.txt")]))
        _ = await run.perform(call(.search, ["name": .string("a")]))
        let created = await run.perform(call(.writeFile, ["path": .string("new/b.txt"), "content": .string("beta")]))
        _ = await run.perform(call(.makeDir, ["path": .string("archive")]))
        _ = await run.perform(call(.move, ["from": .string("a.txt"), "to": .string("archive/a.txt")]))
        XCTAssertEqual(created.outcome, .succeeded)
        XCTAssertTrue(gate.requests.isEmpty, "nothing destructive, nothing asked")
        XCTAssertEqual(folder.text("new/b.txt"), "beta")
        XCTAssertEqual(folder.text("archive/a.txt"), "alpha")
    }

    func testReadOnlyFolderRefusesChangesWithoutAsking() async throws {
        let folder = try makeFolder()
        try folder.write("a.txt", "alpha")
        let gate = RecordingGate(.allowOnce)
        let system = FakeSystem()
        let run = try executor(folder, access: .read, gate: gate, system: system)
        for change in [
            call(.writeFile, ["path": .string("b.txt"), "content": .string("x")]),
            call(.editFile, ["path": .string("a.txt"), "old_text": .string("alpha"), "new_text": .string("x")]),
            call(.move, ["from": .string("a.txt"), "to": .string("c.txt")]),
            call(.makeDir, ["path": .string("d")]),
            call(.delete, ["path": .string("a.txt")]),
            call(.runCommand, ["command": .string("touch e")]),
        ] {
            let result = await run.perform(change)
            XCTAssertEqual(result.outcome, .failed, change.tool)
        }
        XCTAssertTrue(gate.requests.isEmpty, "a read-only folder never shows a card for something it would refuse")
        XCTAssertTrue(system.commands.isEmpty)
        XCTAssertEqual(folder.text("a.txt"), "alpha")
        let read = await run.perform(call(.readFile, ["path": .string("a.txt")]))
        XCTAssertEqual(read.output, "alpha")
    }

    // MARK: Each tool

    func testListShowsFoldersFirstWithRelativePaths() async throws {
        let folder = try makeFolder()
        try folder.write("2026/march.csv", "x")
        try folder.write("notes.md", "hello")
        let run = try executor(folder)
        let root = await run.perform(call(.listDir))
        XCTAssertEqual(root.outcome, .succeeded)
        let lines = root.output.components(separatedBy: "\n")
        XCTAssertEqual(lines.first, "2 items in the folder's root:")
        XCTAssertEqual(lines[1], "2026/")
        XCTAssertTrue(lines[2].hasPrefix("notes.md  5 bytes"))
        let inner = await run.perform(call(.listDir, ["path": .string("./2026/")]))
        XCTAssertTrue(inner.output.contains("2026/march.csv"))
        XCTAssertFalse(root.output.contains(folder.grant.path), "never a path on the disk")
    }

    func testReadTextBinaryAndDocuments() async throws {
        let folder = try makeFolder()
        try folder.write("a.csv", "date,amount\n2026-03-01,12")
        try Data([0x00, 0x01, 0x02]).write(to: folder.grant.appendingPathComponent("blob.bin"))
        let run = try executor(folder)
        let text = await run.perform(call(.readFile, ["path": .string("a.csv")]))
        XCTAssertEqual(text.output, "date,amount\n2026-03-01,12")
        let binary = await run.perform(call(.readFile, ["path": .string("blob.bin")]))
        XCTAssertEqual(binary.outcome, .failed)
        XCTAssertTrue(binary.output.contains("binary"))
        let missing = await run.perform(call(.readFile, ["path": .string("nope.txt")]))
        XCTAssertEqual(missing.outcome, .failed)

        #if os(macOS)
            let rtf = NSAttributedString(string: "Quarterly totals: 4,210")
            let data = try rtf.data(
                from: NSRange(location: 0, length: rtf.length),
                documentAttributes: [.documentType: NSAttributedString.DocumentType.officeOpenXML]
            )
            try data.write(to: folder.grant.appendingPathComponent("summary.docx"))
            let docx = await run.perform(call(.readFile, ["path": .string("summary.docx")]))
            XCTAssertEqual(docx.outcome, .succeeded)
            XCTAssertTrue(docx.output.contains("Quarterly totals: 4,210"))
        #endif
    }

    func testSearchByNameAndByContent() async throws {
        let folder = try makeFolder()
        try folder.write("2026/march.csv", "rent,1200\nfood,300")
        try folder.write("notes.md", "Remember the rent")
        let run = try executor(folder)
        let byName = await run.perform(call(.search, ["name": .string("MARCH")]))
        XCTAssertTrue(byName.output.contains("2026/march.csv"))
        let byText = await run.perform(call(.search, ["text": .string("rent")]))
        XCTAssertTrue(byText.output.contains("2026/march.csv:1: rent,1200"))
        XCTAssertTrue(byText.output.contains("notes.md:1: Remember the rent"))
        let none = await run.perform(call(.search, ["text": .string("zebra")]))
        XCTAssertEqual(none.output, "Nothing in the folder matched.")
    }

    func testWriteCreatesAndReplacingAsks() async throws {
        let folder = try makeFolder()
        let gate = RecordingGate(.allowOnce)
        let run = try executor(folder, gate: gate)
        let created = await run.perform(call(.writeFile, ["path": .string("out/summary.md"), "content": .string("# Hi")]))
        XCTAssertEqual(created.outcome, .succeeded)
        XCTAssertTrue(created.output.hasPrefix("Created out/summary.md"))
        XCTAssertTrue(gate.requests.isEmpty)
        let replaced = await run.perform(call(.writeFile, ["path": .string("out/summary.md"), "content": .string("# Bye")]))
        XCTAssertTrue(replaced.output.hasPrefix("Replaced"))
        XCTAssertEqual(gate.requests.map(\.kind), [.replace])
        XCTAssertEqual(folder.text("out/summary.md"), "# Bye")
    }

    func testEditReplacesExactlyOnePassage() async throws {
        let folder = try makeFolder()
        try folder.write("plan.md", "one\ntwo\ntwo\nthree")
        let gate = RecordingGate(.allowOnce)
        let run = try executor(folder, gate: gate)
        let ambiguous = await run.perform(call(.editFile, ["path": .string("plan.md"), "old_text": .string("two"), "new_text": .string("2")]))
        XCTAssertEqual(ambiguous.outcome, .failed)
        XCTAssertTrue(ambiguous.output.contains("appears 2 times"))
        let missing = await run.perform(call(.editFile, ["path": .string("plan.md"), "old_text": .string("four"), "new_text": .string("4")]))
        XCTAssertEqual(missing.outcome, .failed)
        XCTAssertTrue(gate.requests.isEmpty, "a call that cannot apply asks nothing")
        let edited = await run.perform(call(.editFile, ["path": .string("plan.md"), "old_text": .string("three"), "new_text": .string("3")]))
        XCTAssertEqual(edited.outcome, .succeeded)
        XCTAssertEqual(folder.text("plan.md"), "one\ntwo\ntwo\n3")
        XCTAssertEqual(gate.requests.first?.title, "Edit plan.md?")
        XCTAssertEqual(gate.requests.first?.detail, "plan.md\n− three\n+ 3")
    }

    func testMoveRefusesToOverwriteAndMakeDirIsIdempotent() async throws {
        let folder = try makeFolder()
        try folder.write("a.txt", "a")
        try folder.write("b.txt", "b")
        let run = try executor(folder)
        let clash = await run.perform(call(.move, ["from": .string("a.txt"), "to": .string("b.txt")]))
        XCTAssertEqual(clash.outcome, .failed)
        XCTAssertEqual(folder.text("b.txt"), "b")
        let made = await run.perform(call(.makeDir, ["path": .string("x/y")]))
        XCTAssertEqual(made.output, "Made the folder x/y.")
        let again = await run.perform(call(.makeDir, ["path": .string("x/y")]))
        XCTAssertEqual(again.output, "x/y already existed.")
        let renamed = await run.perform(call(.move, ["from": .string("a.txt"), "to": .string("x/y/a-renamed.txt")]))
        XCTAssertEqual(renamed.outcome, .succeeded)
        XCTAssertEqual(folder.text("x/y/a-renamed.txt"), "a")
        let inside = await run.perform(call(.move, ["from": .string("x"), "to": .string("x/y/x")]))
        XCTAssertEqual(inside.outcome, .failed)
    }

    func testDeleteMovesToTheTrash() async throws {
        let folder = try makeFolder()
        let name = "chat-folder-trash-\(UUID().uuidString).txt"
        try folder.write(name, "bye")
        let gate = RecordingGate(.allowOnce)
        let run = try executor(folder, gate: gate)
        let result = await run.perform(call(.delete, ["path": .string(name)]))
        XCTAssertEqual(result.outcome, .succeeded)
        XCTAssertFalse(folder.exists(name))
        XCTAssertEqual(gate.requests.map(\.kind), [.delete])
        // Leave the person's Trash as it was.
        if let trash = try? FileManager.default.url(for: .trashDirectory, in: .userDomainMask, appropriateFor: nil, create: false) {
            try? FileManager.default.removeItem(at: trash.appendingPathComponent(name))
        }
    }

    func testRunCommandStartsInTheFolderWithBounds() async throws {
        let folder = try makeFolder()
        try FileManager.default.createDirectory(at: folder.grant.appendingPathComponent("src"), withIntermediateDirectories: true)
        let system = FakeSystem()
        let run = try executor(folder, system: system)
        let result = await run.perform(call(.runCommand, ["command": .string("ls"), "cwd": .string("src"), "timeout_seconds": .number(9_999)]))
        XCTAssertEqual(result.outcome, .succeeded)
        XCTAssertEqual(result.output, "Exit code 0.\nhello")
        let request = try XCTUnwrap(system.commands.first)
        XCTAssertEqual(request.timeoutSeconds, 300, "clamped")
        XCTAssertEqual(request.workingDirectory.lastPathComponent, "src")
        XCTAssertEqual(request.folderRoot.path, GrantAccess.canonicalPath(folder.grant.path))
        XCTAssertEqual(request.outputLimitBytes, ChatFolderExecutor.commandOutputLimitBytes)

        system.commandOutcome = ChatFolderCommandOutcome(exitCode: nil, output: "", timedOut: true, truncated: false, contained: true)
        let slow = await run.perform(call(.runCommand, ["command": .string("sleep 999")]))
        XCTAssertEqual(slow.outcome, .failed)
        XCTAssertTrue(slow.output.hasPrefix("Stopped after 60 seconds."))
    }

    func testOpenRevealsOrOpensInsideTheFolder() async throws {
        let folder = try makeFolder()
        try folder.write("deck.key", "x")
        let system = FakeSystem()
        let run = try executor(folder, access: .read, system: system)
        let result = await run.perform(call(.open, ["path": .string("deck.key"), "reveal": .bool(true)]))
        XCTAssertEqual(result.outcome, .succeeded)
        XCTAssertEqual(system.opened.first?.0.lastPathComponent, "deck.key")
        XCTAssertEqual(system.opened.first?.1, true)
        let escape = await run.perform(call(.open, ["path": .string("../outside")]))
        XCTAssertEqual(escape.outcome, .failed)
        XCTAssertEqual(system.opened.count, 1)
    }

    func testUnknownToolAndRevokedFolder() async throws {
        let folder = try makeFolder()
        try folder.write("a.txt", "a")
        let unknown = await (try executor(folder)).perform(ChatFolderCall(id: "x", tool: "folder_format_disk", arguments: [:]))
        XCTAssertEqual(unknown.outcome, .failed)
        let grant = try GrantAccess(grantID: WorkGrantID(value: "chat-2"), mode: .readWrite, grantedURL: folder.grant)
        let run = ChatFolderExecutor(access: grant, folderName: "Invoices", gate: RecordingGate(.allowOnce), system: FakeSystem())
        grant.revoke(at: Date().addingTimeInterval(-1))
        let after = await run.perform(call(.readFile, ["path": .string("a.txt")]))
        XCTAssertEqual(after.outcome, .failed, "a removed folder stops at the next call")
    }
}

private final class RememberedKinds: @unchecked Sendable {
    private let lock = NSLock()
    private var kinds: Set<ChatFolderApprovalKind> = []
    var value: Set<ChatFolderApprovalKind> {
        lock.lock()
        defer { lock.unlock() }
        return kinds
    }
    func set(_ new: Set<ChatFolderApprovalKind>) {
        lock.lock()
        kinds = new
        lock.unlock()
    }
}

private actor AskCounter {
    private(set) var counts: [ChatFolderApprovalKind: Int] = [:]
    func note(_ kind: ChatFolderApprovalKind) { counts[kind, default: 0] += 1 }
}
