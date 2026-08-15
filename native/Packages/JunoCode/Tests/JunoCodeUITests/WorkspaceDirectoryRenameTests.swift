import Foundation
import JunoCodeCore
import Testing
@testable import JunoCodeUI

struct WorkspaceDirectoryRenameTests {
    @Test
    func renameTrimsAndPersistsTheSavedLabelWithoutChangingThePath() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-workspace-rename-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let id = WorkspaceID(value: "workspace-rename")
        let original = WorkspaceRecord(
            descriptor: WorkspaceDescriptor(
                id: id,
                displayName: "Original",
                localPathHint: "/tmp/original-folder",
                isGitRepository: true,
                lastOpenedAt: Date(timeIntervalSince1970: 1_700_000_000)
            ),
            bookmarkData: Data([1, 2, 3])
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode([original]).write(to: root.appendingPathComponent("workspaces.json"))

        let directory = WorkspaceDirectory(directoryURL: root)
        try await directory.rename(id: id, displayName: "  Product App  ")

        let reloaded = WorkspaceDirectory(directoryURL: root)
        let saved = await reloaded.record(for: id)
        #expect(saved?.descriptor.displayName == "Product App")
        #expect(saved?.descriptor.localPathHint == "/tmp/original-folder")
        #expect(saved?.bookmarkData == Data([1, 2, 3]))
    }

    @Test
    func renameRejectsAnUnknownWorkspace() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-workspace-rename-missing-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = WorkspaceDirectory(directoryURL: root)

        await #expect(throws: WorkspaceDirectoryError.workspaceNotFound) {
            try await directory.rename(
                id: WorkspaceID(value: "missing"),
                displayName: "Renamed"
            )
        }
    }
}
