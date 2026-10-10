import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoWorkRuntime
import SwiftUI
import Testing

@testable import JunoDesktop

/// Work in a folder, light and dark: the composer with a folder chosen, a
/// running turn's folder rows, and the approval card —
/// `$JUNO_SNAPSHOT_DIR/folder-*-<light|dark>.png`.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Work in a folder snapshots."
    ),
    .serialized
)
struct ChatFolderSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
    }

    @Test
    func composerWithAFolderChosen() async throws {
        let world = try await SnapshotPreviewWorld.shared()
        world.showConversation()
        let store = try ChatFolderSnapshotFixtures.store(conversationID: "conv-1", access: .readWrite)
        try await render(
            ChatFolderSnapshotFixtures.composer(world: world, prompt: "Turn every invoice in here into one summary spreadsheet.")
                .environment(\.desktopChatFolders, store)
                .padding(.vertical, JunoSpace.section)
                .junoAccentTint(),
            name: "folder-composer"
        )
    }

    @Test
    func composerBeforeAFolderAndReadOnly() async throws {
        let world = try await SnapshotPreviewWorld.shared()
        world.showConversation()
        let empty = try ChatFolderSnapshotFixtures.store(conversationID: nil, access: .readWrite)
        try await render(
            ChatFolderSnapshotFixtures.composer(world: world, prompt: nil)
                .environment(\.desktopChatFolders, empty)
                .padding(.vertical, JunoSpace.section)
                .junoAccentTint(),
            name: "folder-composer-empty"
        )
        let readOnly = try ChatFolderSnapshotFixtures.store(conversationID: "conv-1", access: .read)
        try await render(
            ChatFolderSnapshotFixtures.composer(world: world, prompt: nil)
                .environment(\.desktopChatFolders, readOnly)
                .padding(.vertical, JunoSpace.section)
                .junoAccentTint(),
            name: "folder-composer-read-only"
        )
    }

    @Test
    func aRunningTaskShowsItsFolderRows() async throws {
        try await render(
            TranscriptSnapshotFixtures.column {
                TranscriptSnapshotFixtures.row(ChatFolderSnapshotFixtures.question)
                TranscriptSnapshotFixtures.row(ChatFolderSnapshotFixtures.workingReply, newest: true, generating: true)
            }
            .environment(\.junoSnapshotRunExpanded, true)
            .environment(\.junoSnapshotRunElapsed, 38),
            name: "folder-running"
        )
    }

    @Test
    func anApprovalCardAboveTheAnswer() async throws {
        try await render(
            TranscriptSnapshotFixtures.column {
                TranscriptSnapshotFixtures.row(ChatFolderSnapshotFixtures.question)
                TranscriptSnapshotFixtures.row(
                    ChatFolderSnapshotFixtures.waitingReply,
                    newest: true,
                    generating: true,
                    approvals: MessageRowApprovals(folder: [ChatFolderSnapshotFixtures.commandApproval])
                )
            }
            .environment(\.junoSnapshotRunElapsed, 52),
            name: "folder-approval"
        )
        try await render(
            TranscriptSnapshotFixtures.column {
                ChatFolderApprovalCard(
                    request: ChatFolderSnapshotFixtures.deleteApproval.request,
                    raisedAt: ChatFolderSnapshotFixtures.deleteApproval.raisedAt,
                    decide: { _ in }
                )
            },
            name: "folder-approval-delete"
        )
    }

    private func render<V: View>(_ view: V, name: String) async throws {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                view, name: name, width: TranscriptSnapshotRenderer.columnWidth, appearance: appearance, into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

@MainActor
enum ChatFolderSnapshotFixtures {
    private typealias T = TranscriptSnapshotFixtures

    /// The docked composer as the chat draws it, with no run to steer.
    static func composer(world: SnapshotPreviewWorld, prompt: String?) -> some View {
        ChatComposerDock(
            lift: ChatComposerLift.resting,
            gutter: DesktopChatMeasure.gutter(forColumnWidth: TranscriptSnapshotRenderer.columnWidth)
        ) {
            EmptyView()
        } composer: {
            ChatComposer(
                model: world.world.conversationModel,
                attachmentModel: nil,
                libraryModel: nil,
                projectModel: world.world.projectModel,
                workspaceModel: nil,
                documentIndex: nil,
                connectorModel: nil,
                memorySettings: nil,
                draftProjectID: .constant(nil),
                draftPrompt: .constant(prompt),
                openVoiceMode: { _ in }
            )
            .environment(\.junoSnapshotOpaqueGlass, true)
        } footer: {
            EmptyView()
        }
        .padding(.top, JunoSpace.cozy)
    }

    /// A store with a real folder named "Q3 Invoices" chosen for the chat.
    static func store(conversationID: String?, access: ChatFolderAccess) throws -> DesktopChatFolderStore {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("folder-snapshot-\(UUID().uuidString)", isDirectory: true)
        let folder = root.appendingPathComponent("Q3 Invoices", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let store = DesktopChatFolderStore(
            defaults: UserDefaults(suiteName: "folder-snapshot-\(UUID().uuidString)")!,
            system: DesktopChatFolderSystem(),
            panel: { _ in nil }
        )
        if let conversationID { store.adopt(folder, for: conversationID, access: access) }
        return store
    }

    static let question = T.message(
        "q-folder", .user,
        "Go through the invoices in this folder, total them by vendor, and save a summary spreadsheet next to them."
    )

    private static func folderCall(
        _ id: String, seq: Int, at offset: TimeInterval, status: NativeToolCall.Status, args: [String: String],
        durationMs: Int? = nil, figure: NativeToolCall.Figure? = nil
    ) -> NativeChatActivity {
        T.typed(id, .tool, "Using Folder on your Mac", seq: seq, at: offset, call: NativeToolCall(
            callID: "call-\(id)", tool: "local_folder", status: status, round: seq / 2,
            startedAt: T.at(offset), endedAt: status == .running ? nil : T.at(offset + 0.4),
            durationMs: durationMs, args: args, figure: figure
        ))
    }

    /// Looked, read, wrote, and a conversion still running.
    static let workingReply = T.placeholder(nil).with {
        $0.id = "a-folder-working"
        $0.model = "anthropic:claude-sonnet-4-6"
        $0.runStartedAt = Date().addingTimeInterval(-38)
        $0.lastEventAt = Date()
        $0.activity = [
            T.typed("s1", .reasoning, "Thinking", seq: 1, at: 0, segment: NativeReasoningSegment(round: 0, offset: 0)),
            folderCall("list", seq: 2, at: 1, status: .succeeded, args: ["action": "list"], durationMs: 40),
            folderCall("search", seq: 3, at: 2, status: .succeeded, args: ["action": "search", "query": "Total due"], durationMs: 210),
            folderCall("read1", seq: 4, at: 4, status: .succeeded, args: ["action": "read", "path": "2026/Q3/acme-0912.pdf"], durationMs: 380),
            folderCall("read2", seq: 5, at: 6, status: .succeeded, args: ["action": "read", "path": "2026/Q3/northwind-0918.pdf"], durationMs: 300),
            folderCall("write", seq: 6, at: 9, status: .succeeded, args: ["action": "write", "path": "Q3 summary.csv"], durationMs: 20),
            folderCall("run", seq: 7, at: 11, status: .running, args: ["action": "run", "command": "python3 -c \"import csv\" && textutil -convert docx 'Q3 summary.html'"]),
        ]
        $0.reasoning = "**Totalling by vendor**\n\nEleven invoices across four vendors. Acme appears five times."
    }

    /// Waiting on the command card.
    static let waitingReply = workingReply.with {
        $0.id = "a-folder-waiting"
        $0.activity = Array(workingReply.activity.dropLast()) + [
            folderCall("run-wait", seq: 7, at: 11, status: .running, args: ["action": "run", "command": "pandoc 'Q3 summary.md' -o 'Q3 summary.docx'"]),
        ]
    }

    static let commandApproval = DesktopChatFolderStore.PendingApproval(
        request: ChatFolderApprovalRequest(
            id: "lft_snapshot-command",
            kind: .command,
            folderName: "Q3 Invoices",
            title: "Run this command?",
            detail: "$ pandoc 'Q3 summary.md' -o 'Q3 summary.docx'\nin Q3 Invoices",
            explanation: "It runs on this Mac, starting in Q3 Invoices. It can change files only inside this folder, can't reach the internet, and stops after 60 seconds."
        ),
        conversationID: "conv-1",
        raisedAt: Date()
    )

    static let deleteApproval = DesktopChatFolderStore.PendingApproval(
        request: ChatFolderApprovalRequest(
            id: "lft_snapshot-delete",
            kind: .delete,
            folderName: "Q3 Invoices",
            title: "Move acme-0912 (duplicate).pdf to the Trash?",
            detail: "2026/Q3/acme-0912 (duplicate).pdf",
            explanation: "It leaves the folder. You can put it back from the Trash in Finder."
        ),
        conversationID: "conv-1",
        raisedAt: Date()
    )
}
