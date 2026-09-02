import Foundation
import Testing
import JunoCodeCore
@testable import JunoCodeUI

/// The one piece of prose Juno writes on the reader's behalf into a place
/// other people read.
struct PullRequestDraftTests {
    private let changes = [
        TrackedChange(path: "Sources/App.swift", kind: .modified, linesAdded: 12, linesRemoved: 3, checkpointIDs: ["c1"]),
        TrackedChange(path: "Sources/New.swift", kind: .created, linesAdded: 40, linesRemoved: 0, checkpointIDs: ["c2"]),
    ]

    @Test
    func theBodyListsEveryFileAndTheVerdict() {
        let draft = PullRequestDraft.generated(
            sessionTitle: "Add attachment upload",
            summary: "Added the upload contract and its tests.",
            changes: changes,
            testsPassed: true,
            branch: "feat/attachments"
        )
        #expect(draft.title == "Add attachment upload")
        #expect(draft.body.contains("Added the upload contract and its tests."))
        #expect(draft.body.contains("2 files changed, +52 −3"))
        #expect(draft.body.contains("`Sources/App.swift`"))
        #expect(draft.body.contains("`Sources/New.swift`"))
        #expect(draft.body.contains("Tests passed"))
        #expect(draft.body.contains("`feat/attachments`"))
        #expect(draft.canSubmit)
    }

    @Test
    func anUntitledSessionGetsAnHonestTitle() {
        let draft = PullRequestDraft.generated(
            sessionTitle: "New session",
            summary: nil,
            changes: [],
            testsPassed: nil,
            branch: nil
        )
        #expect(draft.title == "Changes from Juno Code")
        #expect(draft.body.contains("No test run was recorded"))
        #expect(!draft.body.contains("## Changes"))
    }

    @Test
    func aLongTitleIsTrimmedForGitHub() {
        let long = String(repeating: "word ", count: 30)
        let draft = PullRequestDraft.generated(sessionTitle: long, summary: nil, changes: [], testsPassed: nil, branch: nil)
        #expect(draft.title.count <= 72)
        #expect(draft.title.hasSuffix("…"))
    }

    @Test
    func theArgumentsMatchWhatGHExpects() {
        var draft = PullRequestDraft(title: "T", body: "B")
        #expect(draft.arguments == ["pr", "create", "--title", "T", "--body", "B"])
        draft.baseBranch = " main "
        draft.isDraft = true
        #expect(draft.arguments == ["pr", "create", "--title", "T", "--body", "B", "--base", "main", "--draft"])
        draft.title = "   "
        #expect(!draft.canSubmit)
    }
}
