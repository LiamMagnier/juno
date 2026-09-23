import Foundation
import Testing
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeUI

/// The Settings window's Approve button approves what the window shows, and
/// nothing the file came to hold after the window read it.
@MainActor
struct CodeSettingsApprovalTests {
    private let base: URL
    private let project: URL
    private let store: CodeSettingsStore

    init() throws {
        base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-settings-model-\(UUID().uuidString)")
        project = base.appendingPathComponent("project")
        try FileManager.default.createDirectory(
            at: project.appendingPathComponent(".juno"),
            withIntermediateDirectories: true
        )
        store = CodeSettingsStore(
            userDirectory: base.appendingPathComponent("user"),
            approvals: CodeSettingsApprovalStore(directory: base.appendingPathComponent("approvals"))
        )
    }

    private func writeProjectFile(_ text: String) throws {
        try text.write(
            to: project.appendingPathComponent(".juno/settings.json"),
            atomically: true,
            encoding: .utf8
        )
    }

    /// The reported hole: the window loaded one version, a `git pull` landed,
    /// and Approve hashed the new version, whose allow rules then applied on
    /// the next run without the reader having seen them.
    @Test func approveRefusesAFileThatChangedSinceTheWindowReadIt() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        try writeProjectFile(#"{"permissions":{"allow":["Bash(npm test *)"]}}"#)
        let model = CodeSettingsModel(store: store)
        model.selectProject(project)
        #expect(model.awaitingApproval == [.project])
        #expect(model.project.permissions?.allow == [PermissionRule(tool: "Bash", specifier: "npm test *")])

        try writeProjectFile(#"{"permissions":{"allow":["Bash"]}}"#)
        model.approve(.project)

        #expect(!store.isApproved(.project, projectRoot: project))
        #expect(store.resolved(projectRoot: project).rules.allow.isEmpty)
        #expect(model.problems.contains { $0.contains("changed since you opened it") })
        // The window now shows what the file says, still awaiting approval.
        #expect(model.project.permissions?.allow == [PermissionRule(tool: "Bash")])
        #expect(model.awaitingApproval == [.project])

        // Approving what is shown works.
        model.approve(.project)
        #expect(store.isApproved(.project, projectRoot: project))
        #expect(model.awaitingApproval.isEmpty)
        #expect(store.resolved(projectRoot: project).rules.allow == [PermissionRule(tool: "Bash")])
    }

    @Test func reloadingShowsTheFileAsItNowReads() throws {
        defer { try? FileManager.default.removeItem(at: base) }
        try writeProjectFile(#"{"env":{"FEATURE":"1"}}"#)
        let model = CodeSettingsModel(store: store)
        model.selectProject(project)
        let first = model.displayedDigests[.project]

        try writeProjectFile(#"{"env":{"FEATURE":"2"}}"#)
        model.reload()
        #expect(model.displayedDigests[.project] != first)
        #expect(model.project.env == ["FEATURE": "2"])
    }
}
