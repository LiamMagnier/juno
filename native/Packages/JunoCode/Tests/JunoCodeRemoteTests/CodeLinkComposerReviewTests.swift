import JunoCodeCore
import JunoSync
import XCTest
@testable import JunoCodeRemote

final class CodeLinkComposerReviewTests: XCTestCase {
    // MARK: Composer → turn.start

    func testCatalogueKeepsReadySubscriptionsAndDropsSignedOut() {
        let catalogue = CodeLinkComposerState.catalogue(Fixture.providers)
        XCTAssertEqual(catalogue.map(\.id), ["alevr", "claude-agent:default"])
        XCTAssertTrue(catalogue[1].isSubscription)
        XCTAssertEqual(catalogue[1].note, "Counts against your Claude plan on the Mac.")
    }

    func testSubscriptionFullAccessTeamAndSkillsMakeTheTurn() throws {
        let catalogue = CodeLinkComposerState.catalogue(Fixture.providers)
        var composer = CodeLinkComposerState()
        composer.fillDefault(from: catalogue)
        XCTAssertEqual(composer.selection?.instanceId, "alevr")
        composer.choose(instance: catalogue[1].instance, model: catalogue[1].models[0])
        XCTAssertEqual(composer.selection, CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: .high))
        composer.setEffort(.max)
        composer.runtimeMode = .full
        composer.interactionMode = .plan
        composer.team = .planBuildVerify
        composer.skills = ["review", "missing"]
        let skills = [CodeV2.LocalSkillSummary(name: "review", description: "Reviews", source: .user, origin: .claude, path: "/Users/me/.claude/skills/review/SKILL.md")]

        let params = try XCTUnwrap(composer.turnStart(sessionId: "s1", text: "Ship it", skills: skills))
        XCTAssertEqual(params.selection.instanceId, "claude-agent:default")
        XCTAssertEqual(params.selection.effort, .max)
        XCTAssertEqual(params.runtimeMode, .full)
        XCTAssertEqual(params.interactionMode, .plan)
        XCTAssertEqual(params.routing?.preset, .planBuildVerify)
        XCTAssertEqual(params.routing?.workers?.count, 2)
        XCTAssertEqual(params.routing?.architect?.model, "claude-opus-5-5")
        XCTAssertEqual(params.input.skills, [CodeV2.SkillActivation(name: "review", source: .user, path: "/Users/me/.claude/skills/review/SKILL.md")])

        // On the wire, the contract's spelling.
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(params)) as? [String: Any])
        XCTAssertEqual(json["runtimeMode"] as? String, "full")
        XCTAssertEqual((json["routing"] as? [String: Any])?["preset"] as? String, "plan-build-verify")
    }

    func testSoloSendsNoRoutingAndKeepsEffortOnlyWhenOffered() {
        let catalogue = CodeLinkComposerState.catalogue(Fixture.providers)
        var composer = CodeLinkComposerState(selection: CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: .max))
        XCTAssertNil(composer.routing)
        composer.choose(instance: catalogue[0].instance, model: catalogue[0].models[0])
        XCTAssertNil(composer.selection?.effort, "Max is not one of Alevr Sonnet's levels")
        XCTAssertEqual(composer.effortLevels(in: catalogue), [.low, .medium, .high])
        XCTAssertNil(composer.turnStart(sessionId: "s", text: "x")?.input.skills)
    }

    func testPrefsRoundTripThroughThreadSync() {
        let catalogue = CodeLinkComposerState.catalogue(Fixture.providers)
        var mine = CodeLinkComposerState()
        mine.choose(instance: catalogue[1].instance, model: catalogue[1].models[0])
        mine.runtimeMode = .autoEdit
        mine.team = .bestOfN
        mine.skills = ["review"]
        let prefs = mine.prefs
        XCTAssertEqual(prefs.model, "claude-agent:default:claude-opus-5-5")
        XCTAssertEqual(prefs.mode, "auto-edit")
        XCTAssertEqual(prefs.team, "best-of-n")
        var theirs = CodeLinkComposerState()
        theirs.apply(prefs, catalogue: catalogue)
        XCTAssertEqual(theirs, mine)
    }

    func testAdoptReadsTheThreadsOwnSettings() {
        var snapshot = Fixture.snapshot()
        snapshot.runtimeMode = .readOnly
        snapshot.routing = CodeV2.RoleRouting(orchestrator: Fixture.sonnet, workers: [Fixture.sonnet], preset: .leadWorkers)
        snapshot.skills = [CodeV2.SkillActivation(name: "a", source: .user), CodeV2.SkillActivation(name: "once", source: .user, once: true)]
        var composer = CodeLinkComposerState()
        composer.adopt(snapshot)
        XCTAssertEqual(composer.runtimeMode, .readOnly)
        XCTAssertEqual(composer.team, .planBuildVerify)
        XCTAssertEqual(composer.skills, ["a"])
        XCTAssertEqual(composer.modelLabel(in: CodeLinkComposerState.catalogue(Fixture.providers)), "Claude Sonnet 5.5 · Medium")
    }

    // MARK: Per-hunk revert

    private let diff = """
    diff --git a/src/cart/total.ts b/src/cart/total.ts
    --- a/src/cart/total.ts
    +++ b/src/cart/total.ts
    @@ -1,3 +1,3 @@
     export function total(items) {
    -  return items.reduce((a, b) => a + b.price, 0)
    +  return items.reduce((a, b) => a + b.price * b.qty, 0)
     }
    @@ -10,2 +10,3 @@
     const tax = 0.2
    +const shipping = 4
     export { tax }
    diff --git a/src/new.ts b/src/new.ts
    new file mode 100644
    --- /dev/null
    +++ b/src/new.ts
    @@ -0,0 +1,2 @@
    +export const a = 1
    +export const b = 2
    """

    func testHunkPatchIsAStandaloneUnifiedDiff() throws {
        let files = CodeV2UnifiedDiff.parse(diff)
        XCTAssertEqual(files.count, 2)
        let patch = CodeLinkHunkRevert.patch(for: files[0].hunks[1], in: files[0])
        XCTAssertEqual(patch, """
        diff --git a/src/cart/total.ts b/src/cart/total.ts
        --- a/src/cart/total.ts
        +++ b/src/cart/total.ts
        @@ -10,2 +10,3 @@
         const tax = 0.2
        +const shipping = 4
         export { tax }

        """)
        // The patch parses back to exactly that hunk.
        XCTAssertEqual(CodeV2UnifiedDiff.parse(patch).first?.hunks, [files[0].hunks[1]])
    }

    func testRevertingANewFilesOnlyHunkRemovesTheFile() {
        let files = CodeV2UnifiedDiff.parse(diff)
        let patch = CodeLinkHunkRevert.patch(for: files[1].hunks[0], in: files[1])
        XCTAssertTrue(patch.contains("--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@"))
        let left = CodeLinkHunkRevert.removing(files[1].hunks[0], from: files, path: "src/new.ts")
        XCTAssertEqual(left.map(\.path), ["src/cart/total.ts"])
        let fewer = CodeLinkHunkRevert.removing(files[0].hunks[0], from: files, path: "src/cart/total.ts")
        XCTAssertEqual(fewer[0].hunks.count, 1)
    }

    // MARK: Folder browser

    func testBrowserStaysInsideSharedFolders() {
        var browser = CodeLinkFolderBrowser(sharedFolders: ["/Users/me/code/", "/Users/me/Work"])
        XCTAssertTrue(browser.isAtRoot)
        XCTAssertEqual(browser.rows.map(\.name), ["code", "Work"])
        XCTAssertNil(browser.parent)

        browser.show(CodeV2.FsListing(path: "/Users/me/code", entries: [
            CodeV2.FsEntry(name: "zeta", path: "/Users/me/code/zeta", kind: .dir),
            CodeV2.FsEntry(name: "notes.md", path: "/Users/me/code/notes.md", kind: .file),
            CodeV2.FsEntry(name: "shop", path: "/Users/me/code/shop", kind: .dir, isRepo: true),
            CodeV2.FsEntry(name: "alpha", path: "/Users/me/code/alpha", kind: .dir),
        ]))
        XCTAssertEqual(browser.title, "code")
        XCTAssertEqual(browser.rows.map(\.name), ["shop", "alpha", "zeta"], "repositories first, folders only")
        XCTAssertTrue(browser.parent.map { $0 == nil } ?? false, "up from a shared folder is the root")

        browser.show(CodeV2.FsListing(path: "/Users/me/code/shop/src", entries: []))
        XCTAssertEqual(browser.parent.flatMap { $0 }, "/Users/me/code/shop")

        browser.show(CodeV2.FsListing(path: "/etc", entries: []))
        XCTAssertEqual(browser.path, "/Users/me/code/shop/src", "outside the shared folders is ignored")
        XCTAssertFalse(browser.allows("/Users/me/codex"))
        XCTAssertTrue(browser.allows("/Users/me/Work/site"))

        browser.goToRoot()
        XCTAssertTrue(browser.isAtRoot)
    }
}
