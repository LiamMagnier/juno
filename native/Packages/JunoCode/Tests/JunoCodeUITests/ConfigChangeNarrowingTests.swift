import Foundation
import Testing
import JunoCodeCore
@testable import JunoCodeUI

/// A `ConfigChange` hook may keep a change that widens what Juno may do from
/// happening, never one that takes a permission away (CODE_AGENT_SPEC §5.9):
/// a project's hook keeping an allow rule the reader is removing would hold
/// Juno's permissions wider than the reader wants them.
struct ConfigChangeNarrowingTests {
    @Test
    func takingAPermissionAwayIsNarrowing() throws {
        let rule = try #require(PermissionRule(parsing: "Bash(npm run test *)"))
        typealias Change = StudioPermissionsSheet.Change
        #expect(Change.add("Bash(rm *)", .deny).isNarrowing)
        #expect(Change.add("Bash(git push *)", .ask).isNarrowing)
        #expect(Change.remove(rule, .allow).isNarrowing)

        #expect(!Change.add("Bash(npm run test *)", .allow).isNarrowing)
        #expect(!Change.remove(rule, .deny).isNarrowing)
        #expect(!Change.remove(rule, .ask).isNarrowing)
    }
}
