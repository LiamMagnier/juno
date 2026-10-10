import Foundation
import JunoChatKit
import JunoCore
import JunoWorkRuntime
import Testing

@testable import JunoDesktop

/// Work in a folder, on the Mac: the folder a chat works in, the cards its
/// destructive calls raise, and the contained shell its commands run in.
@MainActor
struct DesktopChatFolderTests {
    private final class Fixture {
        let root: URL
        let folder: URL
        let defaults: UserDefaults
        let suite: String

        init() throws {
            // In /private/tmp, not the per-user temp folder: the command
            // sandbox leaves the per-user temp writable for toolchains, so a
            // write "outside" a folder there would prove nothing.
            root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
                .appendingPathComponent("desktop-chat-folder-\(UUID().uuidString)", isDirectory: true)
            folder = root.appendingPathComponent("Invoices", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data("date,amount\n2026-03-01,12".utf8).write(to: folder.appendingPathComponent("march.csv"))
            suite = "desktop-chat-folder-\(UUID().uuidString)"
            defaults = UserDefaults(suiteName: suite)!
        }

        deinit {
            try? FileManager.default.removeItem(at: root)
            UserDefaults().removePersistentDomain(forName: suite)
        }

        @MainActor func store(panel: URL? = nil) -> DesktopChatFolderStore {
            DesktopChatFolderStore(defaults: defaults, system: DesktopChatFolderSystem(), panel: { _ in panel })
        }
    }

    private func call(_ tool: String, _ args: [String: JunoJSONValue]) -> NativeLocalToolCall {
        NativeLocalToolCall(id: "lft_\(UUID().uuidString.lowercased())", tool: tool, args: args)
    }

    @Test
    func aDraftFolderBecomesTheChatsAndSurvivesARelaunch() throws {
        let fixture = try Fixture()
        let store = fixture.store(panel: fixture.folder)
        #expect(store.folder(for: nil) == nil)
        let chosen = try #require(store.choose(for: nil))
        #expect(chosen.name == "Invoices")
        #expect(chosen.access == .readWrite)
        #expect(store.folder(for: nil)?.name == "Invoices", "the new-chat composer shows its draft")
        #expect(store.folderContext(for: "conv-1") == nil, "a draft names no conversation's folder")

        store.adoptDraft(into: "conv-1")
        #expect(store.folder(for: nil) == nil)
        #expect(store.folderContext(for: "conv-1") == NativeLocalFolderContext(name: "Invoices", access: .readWrite))

        let relaunched = fixture.store()
        #expect(relaunched.folder(for: "conv-1")?.name == "Invoices")
        #expect(relaunched.folder(for: "conv-2") == nil, "a folder belongs to its chat and no other")
    }

    @Test
    func closingThePanelChangesNothing() throws {
        let fixture = try Fixture()
        let store = fixture.store(panel: nil)
        #expect(store.choose(for: "conv-1") == nil)
        #expect(store.folder(for: "conv-1") == nil)
    }

    @Test
    func theServerIsToldANameAndAnAccessNeverAPath() throws {
        let fixture = try Fixture()
        let store = fixture.store()
        store.adopt(fixture.folder, for: "conv-1", access: .read)
        let context = try #require(store.folderContext(for: "conv-1"))
        #expect(context.name == "Invoices")
        #expect(context.access == .read)
        let encoded = String(decoding: try JSONEncoder().encode(context), as: UTF8.self)
        #expect(!encoded.contains(fixture.root.path), "no path leaves the Mac")
    }

    @Test
    func aCallRunsInsideTheChatsFolder() async throws {
        let fixture = try Fixture()
        let store = fixture.store()
        store.adopt(fixture.folder, for: "conv-1", access: .readWrite)
        let read = await store.perform(call("folder_read_file", ["path": .string("march.csv")]), conversationID: "conv-1")
        #expect(read.outcome == .succeeded)
        #expect(read.output == "date,amount\n2026-03-01,12")
        let escape = await store.perform(call("folder_read_file", ["path": .string("../../etc/hosts")]), conversationID: "conv-1")
        #expect(escape.outcome == .failed)
        let elsewhere = await store.perform(call("folder_read_file", ["path": .string("march.csv")]), conversationID: "conv-2")
        #expect(elsewhere.outcome == .failed, "a chat with no folder runs nothing")
    }

    @Test
    func aDestructiveCallWaitsForTheCardAndAlwaysIsRemembered() async throws {
        let fixture = try Fixture()
        let store = fixture.store()
        store.adopt(fixture.folder, for: "conv-1", access: .readWrite)
        try Data("v1".utf8).write(to: fixture.folder.appendingPathComponent("notes.md"))

        let first = Task { await store.perform(call("folder_write_file", ["path": .string("notes.md"), "content": .string("v2")]), conversationID: "conv-1") }
        let pending = try await waitForCard(store, conversationID: "conv-1")
        #expect(pending.request.kind == .replace)
        #expect(pending.request.title == "Replace notes.md?")
        #expect(store.approvals(for: "conv-2").isEmpty, "a card shows only in its own chat")
        store.answer(pending.id, .allowAlways)
        #expect(await first.value.outcome == .succeeded)
        #expect(store.folder(for: "conv-1")?.alwaysAllowed == [.replace])

        let second = await store.perform(call("folder_write_file", ["path": .string("notes.md"), "content": .string("v3")]), conversationID: "conv-1")
        #expect(second.outcome == .succeeded, "replacing no longer asks in this folder")
        #expect(store.pendingApprovals.isEmpty)
        #expect(try String(contentsOf: fixture.folder.appendingPathComponent("notes.md"), encoding: .utf8) == "v3")
    }

    @Test
    func aStoppedTurnAnswersItsCardsNo() async throws {
        let fixture = try Fixture()
        let store = fixture.store()
        store.adopt(fixture.folder, for: "conv-1", access: .readWrite)
        let waiting = Task { await store.perform(call("folder_delete", ["path": .string("march.csv")]), conversationID: "conv-1") }
        _ = try await waitForCard(store, conversationID: "conv-1")
        store.turnEnded(conversationID: "conv-1")
        #expect(await waiting.value.outcome == .denied)
        #expect(FileManager.default.fileExists(atPath: fixture.folder.appendingPathComponent("march.csv").path))
    }

    @Test
    func removingTheFolderStopsTheChat() async throws {
        let fixture = try Fixture()
        let store = fixture.store()
        store.adopt(fixture.folder, for: "conv-1", access: .readWrite)
        store.remove(for: "conv-1")
        #expect(store.folder(for: "conv-1") == nil)
        #expect(store.folderContext(for: "conv-1") == nil)
        let after = await store.perform(call("folder_list_dir", [:]), conversationID: "conv-1")
        #expect(after.outcome == .failed)
    }

    @Test
    func commandsRunContainedInTheFolder() async throws {
        let fixture = try Fixture()
        let root = URL(fileURLWithPath: realpath(fixture.folder.path, nil).map { pointer in
            defer { free(pointer) }
            return String(cString: pointer)
        } ?? fixture.folder.path)
        let system = DesktopChatFolderSystem()
        let made = try await system.run(ChatFolderCommandRequest(
            command: "printf hello > made.txt && cat made.txt && pwd",
            workingDirectory: root, folderRoot: root, timeoutSeconds: 20, outputLimitBytes: 4_096
        ))
        #expect(made.exitCode == 0)
        #expect(made.output.hasPrefix("hello"))
        #expect(made.output.contains("Invoices"))
        #expect(FileManager.default.fileExists(atPath: fixture.folder.appendingPathComponent("made.txt").path))

        if made.contained {
            let escape = try await system.run(ChatFolderCommandRequest(
                command: "touch ../escaped.txt",
                workingDirectory: root, folderRoot: root, timeoutSeconds: 20, outputLimitBytes: 4_096
            ))
            #expect(escape.exitCode != 0, "the sandbox refuses a write outside the folder")
            #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("escaped.txt").path))
        }
        #expect(DesktopChatFolderSystem.relativePath(of: root.appendingPathComponent("src"), in: root) == "src")
        #expect(DesktopChatFolderSystem.relativePath(of: root, in: root) == nil)
    }

    private func waitForCard(_ store: DesktopChatFolderStore, conversationID: String) async throws -> DesktopChatFolderStore.PendingApproval {
        for _ in 0..<200 {
            if let pending = store.approvals(for: conversationID).first { return pending }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw CancellationError()
    }
}
