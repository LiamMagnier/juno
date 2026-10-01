import Foundation
import Testing
import JunoCodeCore
@testable import JunoCodeUI

/// "Start a Juno Code task" (CODE_AGENT_SPEC §5.18 a, D-025): the project it
/// names, and a mode never above the reader's remote ceiling.
struct CodeTaskIntentTests {
    private func record(_ name: String) -> WorkspaceRecord {
        let id = WorkspaceID()
        return WorkspaceRecord(
            descriptor: WorkspaceDescriptor(id: id, displayName: name, localPathHint: "/tmp/\(name)", isGitRepository: true, lastOpenedAt: Date()),
            bookmarkData: Data()
        )
    }

    @Test
    func theModeIsCappedByTheRemoteCeiling() {
        let full = CodeTaskIntentRequest(projectName: "juno", prompt: "fix it", mode: .fullAccess)
        #expect(full.effectiveMode(ceiling: .workspaceWrite) == .autoEdit)
        #expect(full.effectiveMode(ceiling: .askBeforeChanges) == .askBeforeEdits)
        #expect(full.effectiveMode(ceiling: .fullAccess) == .fullAccess)
        let plan = CodeTaskIntentRequest(projectName: "juno", prompt: "think", mode: .plan)
        #expect(plan.effectiveMode(ceiling: .fullAccess) == .plan, "asking for less gets less")
        let ask = CodeTaskIntentRequest(projectName: "juno", prompt: "x", mode: .askBeforeEdits)
        #expect(ask.effectiveMode(ceiling: .readOnly) == .plan)
    }

    @Test
    func theProjectIsFoundByName() {
        let records = [record("juno"), record("juno-web"), record("atlas")]
        #expect(CodeTaskIntentRequest(projectName: "Juno", prompt: "x").project(in: records)?.descriptor.displayName == "juno")
        #expect(CodeTaskIntentRequest(projectName: "atl", prompt: "x").project(in: records)?.descriptor.displayName == "atlas")
        #expect(CodeTaskIntentRequest(projectName: "jun", prompt: "x").project(in: records) == nil, "ambiguous prefix")
        #expect(CodeTaskIntentRequest(projectName: nil, prompt: "x").project(in: records) == nil)
        #expect(CodeTaskIntentRequest(projectName: nil, prompt: "x").project(in: [record("only")])?.descriptor.displayName == "only")
    }

    @Test
    func problemsAreSaidInWords() {
        let records = [record("juno"), record("atlas")]
        #expect(CodeTaskIntentRequest(projectName: "juno", prompt: "  ").problem(in: records) == "Say what Juno should do.")
        #expect(CodeTaskIntentRequest(projectName: "zed", prompt: "x").problem(in: records) == "No project is called zed.")
        #expect(CodeTaskIntentRequest(projectName: nil, prompt: "x").problem(in: records) == "Name the project: Juno Code has more than one.")
        #expect(CodeTaskIntentRequest(projectName: nil, prompt: "x").problem(in: []) == "Add a project to Juno Code first.")
        #expect(CodeTaskIntentRequest(projectName: "juno", prompt: "", goal: "tests pass").problem(in: records) == nil)
        #expect(CodeTaskIntentRequest(projectName: "juno", prompt: "x", goal: "   ").goal == nil)
    }
}
