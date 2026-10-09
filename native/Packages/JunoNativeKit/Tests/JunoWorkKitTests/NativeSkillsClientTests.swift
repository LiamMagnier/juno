import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoWorkKit

/// The skills library's wire, its refusal/failure split, and the rules the
/// pages and the composer share (Phase 4 Stage B3).
final class NativeSkillsClientTests: XCTestCase {
    func testLocalFilePreviewAndImportKeepTheToolRequestWithoutGrantingTrust() async throws {
        let transport = SkillsTransport(routes: [
            "POST /api/skills/import/file": (200, #"{"skill":{"name":"review-code","description":"Review","instructions":"Read the diff.","allowedTools":["read_file"],"hostKeys":["context"],"ignoredKeys":[]}}"#),
            "POST /api/work/skills": (201, #"{"skill":{"id":"local","name":"review-code","slug":"review-code"}}"#),
        ])
        let client = NativeSkillsClient(sender: transport)
        let result = await client.previewFile(content: "fixture", for: account)
        let preview = try XCTUnwrap(result.value)
        XCTAssertEqual(preview.ignoredSettings, ["context"])
        _ = await client.create(name: preview.name, description: preview.description, instructions: preview.instructions,
            imported: true, requestedTools: preview.requestedTools, for: account)
        let requests = await transport.recorded()
        let create = try body(requests[1])
        XCTAssertEqual(create["origin"], .string("imported"))
        XCTAssertEqual(create["requestedTools"], .array([.string("read_file")]))
        XCTAssertEqual(create["autoSelect"], .bool(false))
        XCTAssertNil(create["trust"])
    }
    private let account = try! AccountID("account-skills")

    // MARK: Decoding

    func testLibraryDecodesYoursSourcesAndTruncationTolerantly() async throws {
        let transport = SkillsTransport(routes: ["GET /api/skills": (200, libraryJSON)])
        let result = await NativeSkillsClient(sender: transport).library(for: account)
        let library = try XCTUnwrap(result.value)

        XCTAssertEqual(library.yours.map(\.slug), ["file-invoices", "weekly-report"])
        XCTAssertEqual(library.sources.count, 1)
        let source = try XCTUnwrap(library.sources.first)
        XCTAssertEqual(source.label, "anthropics/skills")
        XCTAssertTrue(source.hasUpdate)
        XCTAssertTrue(source.needsAttention)
        XCTAssertEqual(source.counts.total, 3)
        XCTAssertEqual(source.skills.first?.sourceID, "src-1")
        XCTAssertEqual(library.total, 40)
        XCTAssertTrue(library.truncated)
        XCTAssertEqual(library.listedCount, 5)
    }

    func testLibraryWithoutTotalCountsWhatItListed() async throws {
        let transport = SkillsTransport(routes: ["GET /api/skills": (200, #"{"yours":[{"id":"s1","slug":"a","name":"A"}]}"#)])
        let result = await NativeSkillsClient(sender: transport).library(for: account)
        let library = try XCTUnwrap(result.value)
        XCTAssertEqual(library.total, 1)
        XCTAssertFalse(library.truncated)
        XCTAssertTrue(library.sources.isEmpty)
    }

    func testDetailReadsProvenanceFindingsAndMissingFiles() async throws {
        let transport = SkillsTransport(routes: ["GET /api/work/skills/s9": (200, detailJSON)])
        let result = await NativeSkillsClient(sender: transport).skill(id: "s9", for: account)
        let detail = try XCTUnwrap(result.value)
        XCTAssertEqual(detail.version?.provenance?.owner, "anthropics")
        XCTAssertEqual(detail.version?.findings, ["Asks to run shell commands."])
        XCTAssertEqual(detail.missingResourceCount, 1)
        XCTAssertEqual(detail.source?.enabled, false)
    }

    // MARK: Refused versus failed

    func testRefusalsAndFailuresAreKeptApart() async throws {
        let transport = SkillsTransport(routes: [
            "PATCH /api/work/skills/s1": (409, #"{"error":"skill_blocked","message":"This version was blocked by Juno’s safety check."}"#),
            "PATCH /api/work/skills/s2": (500, "<html>"),
            "GET /api/work/skills/gone": (404, #"{"error":"not_found"}"#),
            "POST /api/work/skills": (401, #"{"error":"unauthorized"}"#),
        ])
        let client = NativeSkillsClient(sender: transport)

        let refused = await client.patch(id: "s1", NativeSkillPatch(enabled: true), for: account)
        guard case .blocked(let reason, let explanation) = refused else { return XCTFail("expected a refusal") }
        XCTAssertEqual(reason, "skill_blocked")
        XCTAssertEqual(explanation, "This version was blocked by Juno’s safety check.")

        let failed = await client.patch(id: "s2", NativeSkillPatch(enabled: true), for: account)
        XCTAssertEqual(failed.message(fallback: "Couldn’t change that. The skill is as it was."),
                       "Couldn’t change that. The skill is as it was.")

        let missing = await client.skill(id: "gone", for: account)
        guard case .failed(.notFound, _) = missing else { return XCTFail("expected not found") }

        let signedOut = await client.create(name: "A", description: "", instructions: "B", for: account)
        XCTAssertEqual(signedOut.message(fallback: "x"), "Your session has ended. Sign in again to continue.")

        let hostile = await client.skill(id: "../etc", for: account)
        guard case .failed(.rejected, _) = hostile else { return XCTFail("an unsafe id never reaches the wire") }
    }

    func testOfflineIsItsOwnSentence() async throws {
        let result = await NativeSkillsClient(sender: OfflineTransport()).library(for: account)
        XCTAssertEqual(result.message(fallback: "x"), "Couldn’t reach Juno. Check your connection and try again.")
    }

    // MARK: Encoding

    func testWritesSendTheWebsBodies() async throws {
        let transport = SkillsTransport(routes: [
            "POST /api/skills/import/github": (201, #"{"imported":[{"id":"n1"}],"skipped":[],"blocked":1}"#),
            "PATCH /api/work/skills/s1": (200, #"{"skill":{"id":"s1","slug":"a","name":"A"}}"#),
            "POST /api/work/skills": (201, #"{"skill":{"id":"s2","slug":"file-the-invoices","name":"File the invoices"}}"#),
            "POST /api/work/skills/s1/versions": (201, #"{"version":{"id":"v3","version":3,"instructions":"x"}}"#),
        ])
        let client = NativeSkillsClient(sender: transport)

        let outcome = await client.install(source: "anthropics/skills", commit: "abc", paths: ["a/SKILL.md"], renames: [:], for: account)
        XCTAssertEqual(outcome.value?.blocked, 1)
        _ = await client.patch(id: "s1", NativeSkillPatch(projectID: .some(nil)), for: account)
        _ = await client.create(name: "File the invoices", description: "", instructions: "Steps", for: account)
        _ = await client.restoreVersion(id: "s1", version: 2, for: account)

        let requests = await transport.recorded()
        let install = try body(requests[0])
        XCTAssertNil(install["renames"], "an empty rename set is omitted for an older server")
        XCTAssertEqual(install["commit"], .string("abc"))
        XCTAssertEqual(try body(requests[1])["projectId"], .null)
        let create = try body(requests[2])
        XCTAssertEqual(create["origin"], .string("authored"))
        XCTAssertEqual(create["autoSelect"], .bool(false))
        XCTAssertEqual(try body(requests[3])["restoreVersion"], .number(2))
    }

    // MARK: Rules

    func testChooseableExcludesDisabledBlockedConsentAndSwitchedOffSources() throws {
        let library = NativeSkillLibrary(
            yours: [
                NativeSkill(id: "1", slug: "on", name: "On"),
                NativeSkill(id: "2", slug: "off", name: "Off", enabled: false),
                NativeSkill(id: "3", slug: "blocked", name: "Blocked", securityStatus: "blocked"),
                NativeSkill(id: "4", slug: "waiting", name: "Waiting", requiresConsent: true),
                NativeSkill(id: "5", slug: "untrusted", name: "Untrusted", trust: "untrusted"),
            ],
            sources: [
                NativeSkillSource(id: "src-on", owner: "anthropics", repo: "skills", skills: [
                    NativeSkill(id: "6", slug: "pdf", name: "PDF", sourceID: "src-on"),
                ]),
                NativeSkillSource(id: "src-off", owner: "openai", repo: "skills", enabled: false, skills: [
                    NativeSkill(id: "7", slug: "docx", name: "Docx", sourceID: "src-off"),
                ]),
            ]
        )
        let choices = NativeSkillRules.chooseable(library)
        XCTAssertEqual(choices.map(\.slug), ["on", "untrusted", "pdf"], "trust is not filtered on: the reader names it")
        XCTAssertEqual(choices.last?.sourceLabel, "anthropics/skills")
        XCTAssertTrue(choices[0].isYours)

        let typed = NativeSkillRules.invocation(in: "  /pdf summarise this", choices: choices)
        XCTAssertEqual(typed?.choice.slug, "pdf")
        XCTAssertEqual(typed?.remainder, "summarise this")
        XCTAssertNil(NativeSkillRules.invocation(in: "/Users/liam/Downloads is a mess", choices: choices))
        XCTAssertNil(NativeSkillRules.invocation(in: "/docx", choices: choices), "a switched-off skill is not offered")
    }

    func testSlugRules() throws {
        XCTAssertEqual(NativeSkillRules.slug(fromName: "File the Invoices!"), "file-the-invoices")
        XCTAssertEqual(NativeSkillRules.slug(fromName: "  --Q3 report--  "), "q3-report")
        XCTAssertNil(NativeSkillRules.slug(fromName: "日本語"))
        XCTAssertEqual(NativeSkillRules.normalizeSlug(" Weekly-Report "), "weekly-report")
        XCTAssertNil(NativeSkillRules.normalizeSlug("two--hyphens"))
        XCTAssertNil(NativeSkillRules.normalizeSlug("-leading"))
    }

    func testRenameProblems() throws {
        let skills = [
            NativeSkillImportCandidate(path: "a", slug: "pdf", name: "PDF", slugTaken: true),
            NativeSkillImportCandidate(path: "b", slug: "docx", name: "Docx", slugTaken: true),
            NativeSkillImportCandidate(path: "c", slug: "notes", name: "Notes"),
        ]
        let problems = NativeSkillRules.renameProblems(
            skills, chosen: ["a", "b", "c"], renames: ["a": "pdf", "b": "notes"]
        )
        XCTAssertEqual(problems["a"], .taken)
        XCTAssertEqual(problems["b"], .duplicate)
        XCTAssertNil(problems["c"])
        XCTAssertEqual(
            NativeSkillRules.renameProblems(skills, chosen: ["a"], renames: ["a": "Not A Slug"])["a"], .invalid
        )
    }

    func testUsagePatchAndUpdateOutcome() throws {
        let installed = NativeSkill(id: "1", slug: "a", name: "A", trust: "user_authored", autoSelect: true)
        XCTAssertEqual(NativeSkillRules.usagePatch(automatic: false, skill: installed, isInstalled: true),
                       NativeSkillPatch(autoSelect: false, trust: "untrusted"))
        XCTAssertEqual(NativeSkillRules.usagePatch(automatic: true, skill: installed, isInstalled: true),
                       NativeSkillPatch(autoSelect: true, trust: "user_authored"))
        XCTAssertEqual(NativeSkillRules.usagePatch(automatic: false, skill: installed, isInstalled: false),
                       NativeSkillPatch(autoSelect: false))

        let outcome = NativeSkillRules.updateOutcome(
            NativeSkillSourceUpdateResult(updated: 2, installed: 0, skipped: ["up_to_date"], source: nil),
            from: "anthropics/skills"
        )
        XCTAssertTrue(outcome.ok)
        XCTAssertEqual(outcome.title, "Updated 2 skills from anthropics/skills")
        XCTAssertEqual(outcome.detail, "1 skipped because it was already up to date.")
    }

    @MainActor
    func testSwitchesAnswerAtOnceAndRollBackOnRefusal() async throws {
        let transport = SkillsTransport(routes: [
            "GET /api/skills": (200, libraryJSON),
            "PATCH /api/work/skills/s-yours-1": (409, #"{"error":"blocked","message":"Blocked by Juno’s safety check."}"#),
        ])
        let model = NativeSkillLibraryModel(client: NativeSkillsClient(sender: transport))
        await model.start(for: account)
        XCTAssertEqual(model.chooseable.map(\.slug), ["file-invoices", "pdf"])
        let skill = try XCTUnwrap(model.library?.yours.first)

        let sentence = await model.setSkillEnabled(skill, false)
        XCTAssertEqual(sentence, "Blocked by Juno’s safety check.")
        XCTAssertEqual(model.library?.yours.first?.enabled, true, "a refused switch is put back")
    }

    @MainActor
    func testDeletingASkillTakesItOutOfEveryListAndARefusalLeavesIt() async throws {
        let transport = SkillsTransport(routes: [
            "GET /api/skills": (200, libraryJSON),
            "DELETE /api/work/skills/s-yours-1": (200, #"{"ok":true}"#),
            "DELETE /api/work/skills/s-src-1": (404, #"{"error":"not_found"}"#),
            "DELETE /api/work/skills/s-yours-2": (409, #"{"error":"in_use","message":"An automation still uses this skill."}"#),
        ])
        let model = NativeSkillLibraryModel(client: NativeSkillsClient(sender: transport))
        await model.start(for: account)
        let library = try XCTUnwrap(model.library)

        let gone = await model.deleteSkill(library.yours[0])
        XCTAssertNil(gone)
        XCTAssertEqual(model.library?.yours.map(\.id), ["s-yours-2"])

        let alreadyGone = await model.deleteSkill(library.sources[0].skills[0])
        XCTAssertNil(alreadyGone, "a 404 means it is already gone")
        XCTAssertEqual(model.library?.sources.first?.skills.map(\.id), ["s-src-2", "s-src-3"])

        let refused = await model.deleteSkill(library.yours[1])
        XCTAssertEqual(refused, "An automation still uses this skill.")
        XCTAssertEqual(model.library?.yours.map(\.id), ["s-yours-2"], "a refusal leaves the row")

        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.method == .delete }.map(\.path), [
            "/api/work/skills/s-yours-1", "/api/work/skills/s-src-1", "/api/work/skills/s-yours-2",
        ])
    }

    // MARK: Helpers

    private func body(_ request: NativeBearerRequest) throws -> [String: JunoJSONValue] {
        let data = try XCTUnwrap(request.body)
        guard case .object(let object) = try JSONDecoder().decode(JunoJSONValue.self, from: data) else {
            throw XCTSkip("not an object")
        }
        return object
    }
}

private actor SkillsTransport: NativeAuthenticatedRequestSending {
    private let routes: [String: (Int, String)]
    private var requests: [NativeBearerRequest] = []

    init(routes: [String: (Int, String)]) {
        self.routes = routes
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        let (status, body) = routes["\(request.method.rawValue) \(request.path)"] ?? (500, #"{"message":"missing fixture"}"#)
        return HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }

    func recorded() -> [NativeBearerRequest] { requests }
}

private struct OfflineTransport: NativeAuthenticatedRequestSending {
    func send(_: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private let libraryJSON = #"""
{
  "yours": [
    {"id":"s-yours-1","projectId":null,"slug":"file-invoices","name":"File the invoices","description":"Sorts incoming invoices.","currentVersion":2,"enabled":true,"trust":"user_authored","autoSelect":false,"securityStatus":"clear","createdAt":"2026-09-01T10:00:00Z","updatedAt":"2026-09-02T10:00:00Z","sourceId":null,"sourcePath":null,"requiresConsent":false,"somethingNew":1},
    {"id":"s-yours-2","slug":"weekly-report","name":"Weekly report","enabled":false}
  ],
  "sources": [
    {"id":"src-1","kind":"github","owner":"anthropics","repo":"skills","key":"github:anthropics/skills","ref":"main","path":"","commit":"aaaaaaa1","latestCommit":"bbbbbbb2","enabled":true,"url":"https://github.com/anthropics/skills",
     "skills":[
       {"id":"s-src-1","slug":"pdf","name":"PDF","sourceId":"src-1","sourcePath":"pdf/SKILL.md","enabled":true,"securityStatus":"clear"},
       {"id":"s-src-2","slug":"xlsx","name":"Spreadsheets","sourceId":"src-1","enabled":true,"securityStatus":"blocked"},
       {"id":"s-src-3","slug":"docx","name":"Documents","sourceId":"src-1","enabled":true,"requiresConsent":true}
     ]},
    {"kind":"github","owner":"broken"}
  ],
  "total": 40,
  "truncated": true
}
"""#

private let detailJSON = #"""
{
  "skill":{"id":"s9","slug":"pdf","name":"PDF","currentVersion":3,"enabled":true,"trust":"untrusted","securityStatus":"warning"},
  "version":{"id":"v3","skillId":"s9","version":3,"instructions":"# PDF\nRead PDFs.","contract":{"resourceAttachmentIds":["att-1","att-2"],"provenance":{"source.kind":"github","source.owner":"anthropics","source.repo":"skills","source.url":"https://github.com/anthropics/skills/blob/main/pdf/SKILL.md"}},"requestedTools":["bash"],"securityStatus":"warning","securityScan":{"findings":[{"code":"shell","severity":"warning","message":"Asks to run shell commands."}]},"requiresConsent":false,"createdAt":"2026-09-20T10:00:00Z"},
  "resources":[{"attachmentId":"att-1","fileName":"template.docx"}],
  "projectName":null,
  "source":{"id":"src-1","owner":"anthropics","repo":"skills","enabled":false}
}
"""#
