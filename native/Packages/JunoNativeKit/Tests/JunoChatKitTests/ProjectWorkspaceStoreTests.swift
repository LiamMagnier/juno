import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest
@testable import JunoChatKit

/// The local half of a custom assistant: what survives a round trip to disk, and
/// what the tool whitelist actually stops.
final class ProjectWorkspaceStoreTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")

    // MARK: Serialization

    func testAWorkspaceSurvivesARoundTripIntact() async throws {
        let repository = InMemoryTransactionalStore()
        let store = ProjectWorkspaceStore(repository: repository)
        let written = ProjectWorkspaceConfiguration(
            projectID: "project-a",
            personaName: "Release Notes Editor",
            instructionsOverride: "Write in the past tense. Never use exclamation marks.",
            toolAccess: .restricted([.webSearch, .canvas]),
            allowedConnectorIDs: ["github"],
            knowledgeFileIDs: ["file-2", "file-1"],
            preferredModelID: "anthropic:claude-sonnet-4-6",
            updatedAt: Date(timeIntervalSince1970: 1_770_000_000)
        )

        try await store.save(written, accountID: accountA)
        let snapshot = try await store.load(accountID: accountA)

        let read = try XCTUnwrap(snapshot.workspaces["project-a"])
        XCTAssertEqual(read.personaName, "Release Notes Editor")
        XCTAssertEqual(
            read.instructionsOverride,
            "Write in the past tense. Never use exclamation marks."
        )
        XCTAssertEqual(read.toolAccess, .restricted([.webSearch, .canvas]))
        XCTAssertEqual(read.allowedConnectorIDs, ["github"])
        XCTAssertEqual(read.knowledgeFileIDs, ["file-2", "file-1"], "the reader's order is kept")
        XCTAssertEqual(read.preferredModelID, "anthropic:claude-sonnet-4-6")
        XCTAssertEqual(read.updatedAt.timeIntervalSince1970, 1_770_000_000, accuracy: 0.001)
    }

    /// The distinction the whole tri-state rests on. If these two came back the
    /// same, an assistant nobody had configured would silently lose every tool.
    func testInheritingAndRestrictingToNothingAreDifferentAfterARoundTrip()
        async throws
    {
        let repository = InMemoryTransactionalStore()
        let store = ProjectWorkspaceStore(repository: repository)
        try await store.save(
            ProjectWorkspaceConfiguration(projectID: "inherits"),
            accountID: accountA
        )
        try await store.save(
            ProjectWorkspaceConfiguration(projectID: "locked", toolAccess: .restricted([])),
            accountID: accountA
        )

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(
            snapshot.workspaces["inherits"]?.toolAccess, .inheritsAccountDefaults
        )
        XCTAssertEqual(snapshot.workspaces["locked"]?.toolAccess, .restricted([]))
        XCTAssertFalse(snapshot.workspaces["inherits"]?.toolAccess.isRestricted ?? true)
        XCTAssertTrue(snapshot.workspaces["locked"]?.toolAccess.isRestricted ?? false)
    }

    /// Nil instructions defer to the project's synced ones; `""` is a deliberate
    /// override that says this assistant has none.
    func testAnEmptyInstructionOverrideIsNotTheSameAsNoOverride() async throws {
        let repository = InMemoryTransactionalStore()
        let store = ProjectWorkspaceStore(repository: repository)
        try await store.save(
            ProjectWorkspaceConfiguration(projectID: "deferring"),
            accountID: accountA
        )
        try await store.save(
            ProjectWorkspaceConfiguration(projectID: "silenced", instructionsOverride: ""),
            accountID: accountA
        )
        let project = Self.project(id: "any", instructions: "Answer in French.")

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(
            snapshot.workspaces["deferring"]?.resolvedInstructions(project: project),
            "Answer in French."
        )
        XCTAssertEqual(
            snapshot.workspaces["silenced"]?.resolvedInstructions(project: project),
            ""
        )
    }

    /// A newer build's tool must not take the whole restriction down with it —
    /// upgrade, configure, downgrade has to leave the reader's whitelist mostly
    /// intact rather than reverting them to unrestricted.
    func testAnUnknownToolIsDroppedWithoutDiscardingTheRestriction() async throws {
        let repository = InMemoryTransactionalStore()
        let payload = """
        {"projectId":"project-a","allowedTools":["webSearch","timeTravel"],\
        "updatedAt":"2026-07-21T10:00:00.000Z"}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [.upsert(StoredRecord(
                accountID: accountA,
                key: ProjectWorkspaceStore<InMemoryTransactionalStore>.key(
                    projectID: "project-a"
                ),
                revision: 3,
                updatedAt: Date(),
                payload: Data(payload.utf8)
            ))]
        ))
        let store = ProjectWorkspaceStore(repository: repository)

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(snapshot.workspaces["project-a"]?.toolAccess, .restricted([.webSearch]))
    }

    func testARecordWhoseIdentityDisagreesWithItsKeyIsCorrupt() async throws {
        let repository = InMemoryTransactionalStore()
        let payload = #"{"projectId":"somebody-else","updatedAt":"2026-07-21T10:00:00.000Z"}"#
        _ = try await repository.apply(StorageTransaction(
            accountID: accountA,
            operations: [.upsert(StoredRecord(
                accountID: accountA,
                key: ProjectWorkspaceStore<InMemoryTransactionalStore>.key(
                    projectID: "project-a"
                ),
                revision: 1,
                updatedAt: Date(),
                payload: Data(payload.utf8)
            ))]
        ))
        let store = ProjectWorkspaceStore(repository: repository)

        do {
            _ = try await store.load(accountID: accountA)
            XCTFail("a mismatched record must not be projected")
        } catch let error as ProjectWorkspaceStoreError {
            XCTAssertEqual(
                error,
                .corruptRecord(
                    ProjectWorkspaceStore<InMemoryTransactionalStore>.key(projectID: "project-a")
                )
            )
        }
    }

    func testWorkspacesRemainAccountScoped() async throws {
        let repository = InMemoryTransactionalStore()
        let store = ProjectWorkspaceStore(repository: repository)
        try await store.save(
            ProjectWorkspaceConfiguration(projectID: "project-a", personaName: "A"),
            accountID: accountA
        )
        try await store.save(
            ProjectWorkspaceConfiguration(projectID: "project-b", personaName: "B"),
            accountID: accountB
        )

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertEqual(Set(snapshot.workspaces.keys), ["project-a"])
    }

    /// A project missing locally may have been deleted, or may simply not have
    /// synced yet. Reporting the orphan is honest; deleting the reader's
    /// whitelist on the guess is not.
    func testAWorkspaceWhoseProjectIsMissingIsReportedAndNotDeleted() async throws {
        let repository = InMemoryTransactionalStore()
        let store = ProjectWorkspaceStore(repository: repository)
        try await store.save(
            ProjectWorkspaceConfiguration(projectID: "project-gone"),
            accountID: accountA
        )

        let snapshot = try await store.load(
            accountID: accountA, knownProjectIDs: ["project-here"]
        )

        XCTAssertEqual(snapshot.orphanedProjectIDs, ["project-gone"])
        XCTAssertNotNil(snapshot.workspaces["project-gone"], "still readable, still editable")
    }

    /// An empty `knownProjectIDs` means "the project list has not loaded", which
    /// must not be read as "no projects exist" — that would report every
    /// workspace on the account as orphaned on first launch.
    func testAnUnknownProjectListReportsNoOrphans() async throws {
        let repository = InMemoryTransactionalStore()
        let store = ProjectWorkspaceStore(repository: repository)
        try await store.save(
            ProjectWorkspaceConfiguration(projectID: "project-a"),
            accountID: accountA
        )

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertTrue(snapshot.orphanedProjectIDs.isEmpty)
    }

    func testDeletingAWorkspaceLeavesNothingBehind() async throws {
        let repository = InMemoryTransactionalStore()
        let store = ProjectWorkspaceStore(repository: repository)
        try await store.save(
            ProjectWorkspaceConfiguration(projectID: "project-a"),
            accountID: accountA
        )

        try await store.delete(projectID: "project-a", accountID: accountA)

        let snapshot = try await store.load(accountID: accountA)
        XCTAssertTrue(snapshot.workspaces.isEmpty)
    }

    /// Saving twice must bump the revision rather than colliding with itself.
    func testRepeatedSavesAdvanceTheRecordRevision() async throws {
        let repository = InMemoryTransactionalStore()
        let store = ProjectWorkspaceStore(repository: repository)
        let key = ProjectWorkspaceStore<InMemoryTransactionalStore>.key(projectID: "project-a")

        for name in ["First", "Second", "Third"] {
            try await store.save(
                ProjectWorkspaceConfiguration(projectID: "project-a", personaName: name),
                accountID: accountA
            )
        }

        let raw = try await repository.snapshot(for: accountA)
        XCTAssertEqual(raw.records[key]?.revision, 3)
        let snapshot = try await store.load(accountID: accountA)
        XCTAssertEqual(snapshot.workspaces["project-a"]?.personaName, "Third")
    }

    func testAnOverlongInstructionOverrideIsRefusedRatherThanTruncated() async throws {
        let repository = InMemoryTransactionalStore()
        let store = ProjectWorkspaceStore(repository: repository)
        let workspace = ProjectWorkspaceConfiguration(
            projectID: "project-a",
            instructionsOverride: String(
                repeating: "a",
                count: ProjectWorkspaceConfiguration.maximumInstructionCharacters + 1
            )
        )

        do {
            try await store.save(workspace, accountID: accountA)
            XCTFail("an over-long override must not be silently cut")
        } catch let error as ProjectWorkspaceStoreError {
            XCTAssertEqual(error, .invalidInstructions)
        }
    }

    // MARK: The preferred model, as a precedence rule

    private static let catalog = [
        "anthropic:claude-sonnet-4-6",
        "openai:gpt-5.6",
        "google:gemini-3-pro",
    ]

    func testAPreferredModelIsUsedWhenTheReaderHasNotChosenOne() {
        XCTAssertEqual(
            ProjectPreferredModel.resolve(
                preferredModelID: "openai:gpt-5.6",
                readerChoseExplicitly: false,
                selectableModelIDs: Self.catalog
            ),
            "openai:gpt-5.6"
        )
    }

    /// The rung that matters most. A reader who opened the picker said something
    /// specific about this conversation; a preference saved on a Projects page is
    /// a standing default, and the standing one must never quietly win.
    func testAnExplicitPickOutranksTheProjectsPreference() {
        XCTAssertNil(
            ProjectPreferredModel.resolve(
                preferredModelID: "openai:gpt-5.6",
                readerChoseExplicitly: true,
                selectableModelIDs: Self.catalog
            )
        )
    }

    /// Preferences are stored locally and never revalidated, so a plan change or
    /// a retired model leaves a stale id behind. Falling through beats sending a
    /// model id the route will refuse — that would make the whole project
    /// unsendable until somebody found this setting.
    func testAPreferenceNamingAModelTheAccountCannotSelectIsIgnored() {
        XCTAssertNil(
            ProjectPreferredModel.resolve(
                preferredModelID: "openai:gpt-4o-retired",
                readerChoseExplicitly: false,
                selectableModelIDs: Self.catalog
            )
        )
    }

    /// Absent is not "": neither says anything, and neither may be sent.
    func testNoPreferenceAndABlankPreferenceBothSayNothing() {
        for value in [nil, "", "   "] as [String?] {
            XCTAssertNil(
                ProjectPreferredModel.resolve(
                    preferredModelID: value,
                    readerChoseExplicitly: false,
                    selectableModelIDs: Self.catalog
                )
            )
        }
    }

    // MARK: The whitelist as a gate

    /// The point of a whitelist is that the *client* stops sending the flag.
    func testARestrictedWorkspaceStripsTheToolsItDoesNotAllow() {
        let workspace = ProjectWorkspaceConfiguration(
            projectID: "project-a",
            toolAccess: .restricted([.webSearch])
        )
        let requested = ProjectWorkspaceTurnPermissions(
            webSearch: true,
            deepResearch: true,
            canvasEnabled: nil,
            connectorIDs: ["github", "gmail"],
            mediaGeneration: true,
            memoryRecall: true
        )

        let permitted = workspace.permitting(requested)

        XCTAssertTrue(permitted.webSearch)
        XCTAssertFalse(permitted.deepResearch)
        XCTAssertFalse(permitted.mediaGeneration)
        XCTAssertFalse(permitted.memoryRecall)
        XCTAssertTrue(permitted.connectorIDs.isEmpty)
    }

    /// **The inverted field.** `canvasEnabled: nil` means the server turns canvas
    /// on, so a whitelist that excludes canvas has to send an explicit `false`.
    /// Leaving it nil would be a whitelist that allows the thing it excludes.
    func testDenyingCanvasSendsAnExplicitFalseRatherThanLeavingItAbsent() {
        let workspace = ProjectWorkspaceConfiguration(
            projectID: "project-a",
            toolAccess: .restricted([])
        )

        let permitted = workspace.permitting(ProjectWorkspaceTurnPermissions())

        XCTAssertEqual(permitted.canvasEnabled, false)
    }

    /// And allowing it leaves the server's default alone, rather than asserting
    /// a `true` the plan might not support.
    func testAllowingCanvasLeavesTheServerDefaultUntouched() {
        let workspace = ProjectWorkspaceConfiguration(
            projectID: "project-a",
            toolAccess: .restricted([.canvas])
        )

        let permitted = workspace.permitting(ProjectWorkspaceTurnPermissions())

        XCTAssertNil(permitted.canvasEnabled)
    }

    /// A persona can take a capability away and can never add one — otherwise a
    /// local preference file would be a privilege escalation.
    func testAWorkspaceCannotGrantATurnSomethingItDidNotAskFor() {
        let workspace = ProjectWorkspaceConfiguration(
            projectID: "project-a",
            toolAccess: .restricted(Set(ProjectWorkspaceTool.allCases))
        )

        let permitted = workspace.permitting(
            ProjectWorkspaceTurnPermissions(webSearch: false, deepResearch: false)
        )

        XCTAssertFalse(permitted.webSearch)
        XCTAssertFalse(permitted.deepResearch)
    }

    func testConnectorsAreFilteredToTheAllowedListWhenOneIsSet() {
        let workspace = ProjectWorkspaceConfiguration(
            projectID: "project-a",
            toolAccess: .restricted([.connectors]),
            allowedConnectorIDs: ["github"]
        )

        let permitted = workspace.permitting(
            ProjectWorkspaceTurnPermissions(connectorIDs: ["github", "gmail"])
        )

        XCTAssertEqual(permitted.connectorIDs, ["github"])
    }

    /// Nil is "no opinion", not "none".
    func testAnAbsentConnectorListLeavesTheRequestedConnectorsAlone() {
        let workspace = ProjectWorkspaceConfiguration(
            projectID: "project-a",
            toolAccess: .restricted([.connectors])
        )

        let permitted = workspace.permitting(
            ProjectWorkspaceTurnPermissions(connectorIDs: ["github", "gmail"])
        )

        XCTAssertEqual(permitted.connectorIDs, ["github", "gmail"])
    }

    func testAnUnconfiguredWorkspaceVetoesNothing() {
        let workspace = ProjectWorkspaceConfiguration(projectID: "project-a")
        let requested = ProjectWorkspaceTurnPermissions(
            webSearch: true, deepResearch: true, connectorIDs: ["github"],
            mediaGeneration: true, memoryRecall: true
        )

        XCTAssertEqual(workspace.permitting(requested), requested)
    }

    // MARK: Composed prompt

    func testTheSystemPromptPutsInstructionsFirstAndMemoryLast() {
        let workspace = ProjectWorkspaceConfiguration(
            projectID: "project-a",
            instructionsOverride: "You are a release-notes editor."
        )

        let prompt = ProjectWorkspacePrompt.systemPrompt(
            workspace: workspace,
            project: Self.project(id: "project-a", instructions: "ignored"),
            knowledgeFileNames: ["style-guide.md"],
            memories: [Self.memory(id: "m1", content: "prefers the past tense")]
        )

        let instructionIndex = try? XCTUnwrap(prompt.range(of: "release-notes editor"))
        XCTAssertNotNil(instructionIndex)
        XCTAssertTrue(prompt.contains("style-guide.md"))
        XCTAssertTrue(prompt.contains("prefers the past tense"))
        let instructions = prompt.range(of: "release-notes editor")!.lowerBound
        let knowledge = prompt.range(of: "style-guide.md")!.lowerBound
        let memory = prompt.range(of: "prefers the past tense")!.lowerBound
        XCTAssertLessThan(instructions, knowledge)
        XCTAssertLessThan(knowledge, memory)
    }

    /// An assistant whose whitelist excludes memory is not told what the account
    /// remembers, even though the memories exist and are perfectly readable.
    func testAWorkspaceThatExcludesMemoryGetsNoMemoryBlock() {
        let workspace = ProjectWorkspaceConfiguration(
            projectID: "project-a",
            instructionsOverride: "Work assistant.",
            toolAccess: .restricted([.webSearch])
        )

        let prompt = ProjectWorkspacePrompt.systemPrompt(
            workspace: workspace,
            project: nil,
            knowledgeFileNames: [],
            memories: [Self.memory(id: "m1", content: "is vegetarian")]
        )

        XCTAssertFalse(prompt.contains("is vegetarian"))
        XCTAssertFalse(prompt.contains(MemoryInjection.header))
        XCTAssertTrue(prompt.contains("Work assistant."))
    }

    /// Plain Juno — no persona at all — is a real state, and memory is allowed
    /// in it.
    func testPlainJunoStillReceivesMemory() {
        let prompt = ProjectWorkspacePrompt.systemPrompt(
            workspace: nil,
            project: nil,
            knowledgeFileNames: [],
            memories: [Self.memory(id: "m1", content: "is vegetarian")]
        )

        XCTAssertTrue(prompt.contains("is vegetarian"))
    }

    // MARK: Fixtures

    private static func project(id: String, instructions: String) -> NativeProject {
        NativeProject(
            id: id,
            name: "Project",
            instructions: instructions,
            starred: false,
            createdAt: Date(timeIntervalSince1970: 1_760_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_760_000_000),
            revision: 1
        )
    }

    private static func memory(id: String, content: String) -> NativeMemoryEntry {
        NativeMemoryEntry(
            id: id,
            content: content,
            source: .automatic,
            kind: .fact,
            sourceReference: "conversation-a",
            createdAt: Date(timeIntervalSince1970: 1_760_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_760_000_000),
            revision: 1
        )
    }
}
