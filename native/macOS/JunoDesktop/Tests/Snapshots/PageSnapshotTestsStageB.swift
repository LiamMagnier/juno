import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import JunoSync
import JunoWorkKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// Phase 4 Stage B's pages — Memory, Connections, Skills and Assistants —
/// drawn offscreen in both appearances:
/// `$JUNO_SNAPSHOT_DIR/pages/<name>-<light|dark>.png`.
///
/// Its own suite (not `PageSnapshotTests`, which Stage A writes) so the two
/// lanes add files rather than edit one; integration may fold them together.
/// The data is the preview world's: the real clients decoding
/// ``PreviewAccountPageFixtures`` through ``PreviewSender``, and, for states
/// a fixture cannot reach (a drafted change, memory switched off, a failed
/// load), the models' own `preview` entry points.
///
/// Menus and glass cannot be drawn offscreen: the header's More and Add menus
/// are drawn closed, and a window's sidebar sits on its recessed tone.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil
            || ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Stage B page snapshots."
    ),
    .serialized
)
struct StageBPageSnapshotTests {
    private var directories: [URL] {
        let environment = ProcessInfo.processInfo.environment
        var out: [URL] = []
        if let dir = environment["JUNO_SNAPSHOT_DIR"] {
            out.append(URL(fileURLWithPath: dir).appendingPathComponent("pages", isDirectory: true))
        }
        if let dir = environment["JUNO_FINAL_SNAPSHOT_DIR"] {
            out.append(URL(fileURLWithPath: dir).appendingPathComponent("pages", isDirectory: true))
        }
        return out
    }

    @Test(arguments: StageBPageFixtures.names)
    func drawsInBothAppearances(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.shared()
        let pages = try await StageBPageWorld.shared(world)
        let fixture = try #require(StageBPageFixtures.fixture(named: name, world: world, pages: pages))
        if let prepare = fixture.prepare {
            try await prepare()
        }
        for directory in directories {
            for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                let url = try await TranscriptSnapshotRenderer.render(
                    // The settled page, not a frame of the rows' deal.
                    fixture.view().environment(\.desktopDealsRowsIn, false),
                    name: fixture.name,
                    width: fixture.width,
                    appearance: appearance,
                    into: directory
                )
                #expect(FileManager.default.fileExists(atPath: url.path))
            }
        }
    }
}

/// The Stage B models, over the preview world's sender, loaded once.
@MainActor
final class StageBPageWorld {
    let memory: NativeMemoryPageModel
    let skills: NativeSkillLibraryModel
    let assistants: NativeAssistantsModel
    let accountID: AccountID
    let sender: any NativeAuthenticatedRequestSending
    private(set) var loadedMemory: NativeMemorySnapshot?

    private static var instance: StageBPageWorld?

    static func shared(_ world: SnapshotPreviewWorld) async throws -> StageBPageWorld {
        if let instance { return instance }
        let made = StageBPageWorld(world: world)
        await made.load()
        instance = made
        return made
    }

    private init(world: SnapshotPreviewWorld) {
        sender = world.world.requestSender
        accountID = world.world.accountID
        memory = NativeMemoryPageModel(client: NativeMemoryClient(sender: sender))
        skills = NativeSkillLibraryModel(client: NativeSkillsClient(sender: sender))
        assistants = NativeAssistantsModel(client: NativeAssistantsClient(sender: sender))
    }

    private func load() async {
        memory.start(for: accountID)
        await memory.reload()
        await memory.loadSideData()
        loadedMemory = NativeMemorySnapshot(
            facts: memory.facts, summary: memory.summary, projectSummaries: memory.projectSummaries
        )
        await skills.start(for: accountID)
        assistants.start(for: accountID)
        await assistants.reload()
    }

    /// A fresh page model in a known state, so one fixture's state never
    /// leaks into the next.
    func memoryPage(
        edits: [NativeMemoryEdit] = [],
        backfillRemaining: Int? = nil,
        empty: Bool = false,
        phase: NativeMemoryPageModel.Phase = .ready
    ) -> NativeMemoryPageModel {
        let page = NativeMemoryPageModel(client: NativeMemoryClient(sender: sender))
        page.start(for: accountID)
        let snapshot = empty || loadedMemory == nil
            ? NativeMemorySnapshot(facts: [], summary: nil, projectSummaries: [])
            : loadedMemory!
        page.preview(snapshot, edits: edits, backfillRemaining: backfillRemaining, phase: phase)
        return page
    }
}

enum StageBPageFixtures {
    static let names = [
        "mcp-server",
        "memory",
        "memory-welcome",
        "memory-off",
        "memory-draft",
        "memory-project-scope",
        "memory-activity",
        "memory-import",
        "memory-error",
        "memory-narrow",
        "connections",
        "connections-empty-connected",
        "skills-list",
        "skills-empty",
        "skills-no-results",
        "skill-detail",
        "skill-detail-blocked",
        "skill-new",
        "skills-import",
        "assistants-grid",
        "assistants-empty",
        "assistant-editor",
        "window-memory",
        "window-skills",
    ]

    private typealias F = FinalSnapshotFixtures

    /// The page-only width: a detail column beside the 304pt sidebar.
    static let pageWidth: CGFloat = 936

    @MainActor
    static func fixture(named name: String, world: SnapshotPreviewWorld, pages: StageBPageWorld) -> FinalFixture? {
        let projects = { @MainActor in
            world.world.projectModel.projects.map { DesktopMemoryProject(id: $0.id, name: $0.name) }
        }
        let settings = world.world.memorySettingsModel
        func memory(
            _ page: NativeMemoryPageModel,
            height: CGFloat,
            width: CGFloat = pageWidth,
            enabled: Bool? = nil,
            scope: String? = nil
        ) -> FinalFixture {
            FinalFixture(name: name, width: width, view: {
                AnyView(
                    DesktopMemoryPage(
                        settings: settings, page: page, projects: projects,
                        initialScope: scope, enabledOverride: enabled
                    )
                    .frame(height: height)
                    .junoAccentTint()
                )
            })
        }

        switch name {
        case "mcp-server":
            return FinalFixture(name: name, width: 480, view: {
                AnyView(DesktopMCPServerSheet(model: world.world.connectorModel, editing: nil).junoAccentTint())
            })
        case "memory":
            return memory(pages.memoryPage(), height: 2060)
        case "memory-narrow":
            return memory(pages.memoryPage(), height: 1700, width: 560)
        case "memory-welcome":
            return memory(pages.memoryPage(backfillRemaining: 23, empty: true), height: 760)
        case "memory-off":
            return memory(pages.memoryPage(), height: 900, enabled: false)
        case "memory-draft":
            return memory(pages.memoryPage(edits: [draftEdit]), height: 1000)
        case "memory-project-scope":
            return memory(pages.memoryPage(), height: 900, scope: "p-thesis")
        case "memory-error":
            return memory(pages.memoryPage(empty: true, phase: .failed), height: 640)
        case "memory-activity":
            let page = pages.memoryPage(edits: [draftEdit, appliedEdit, refusedEdit])
            return FinalFixture(name: name, width: 520, view: {
                AnyView(DesktopMemoryActivitySheet(page: page, tab: .constant(.edits), scope: nil).junoAccentTint())
            })
        case "memory-import":
            let page = pages.memoryPage()
            return FinalFixture(name: name, width: 640, view: {
                AnyView(DesktopMemoryImportSheet(page: page, initialCandidates: importCandidates).junoAccentTint())
            })

        case "connections":
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: {
                    AnyView(DesktopConnectionsScreen(model: world.world.connectorModel).frame(height: 760).junoAccentTint())
                },
                prepare: {
                    world.world.connectorModel.showsConnectedOnly = false
                    await world.world.connectorModel.refresh()
                }
            )
        case "connections-empty-connected":
            let model = NativeConnectorModel(client: NativeConnectorClient(sender: UnconnectedSender()))
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: { AnyView(DesktopConnectionsScreen(model: model).frame(height: 620).junoAccentTint()) },
                prepare: {
                    await model.start(for: pages.accountID)
                    model.showsConnectedOnly = true
                }
            )

        case "skills-list":
            return FinalFixture(name: name, width: pageWidth, view: {
                AnyView(
                    NavigationStack {
                        DesktopSkillsScreen(model: pages.skills, startDraft: { _ in }, initialOpenSources: ["+src-anthropics"])
                    }
                    .frame(height: 1060)
                    .junoAccentTint()
                )
            })
        case "skills-empty":
            let empty = NativeSkillLibraryModel(client: NativeSkillsClient(sender: pages.sender))
            empty.preview(.empty)
            return FinalFixture(name: name, width: pageWidth, view: {
                AnyView(NavigationStack { DesktopSkillsScreen(model: empty, startDraft: { _ in }) }.frame(height: 620).junoAccentTint())
            })
        case "skills-no-results":
            return FinalFixture(name: name, width: pageWidth, view: {
                AnyView(
                    NavigationStack {
                        DesktopSkillsScreen(model: pages.skills, startDraft: { _ in }, initialQuery: "kubernetes")
                    }
                    .frame(height: 560)
                    .junoAccentTint()
                )
            })
        case "skill-detail":
            let model = DesktopSkillPageModel(id: "skill-invoices", library: pages.skills)
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: {
                    AnyView(NavigationStack { DesktopSkillPage(model: model, projects: projects()) }.frame(height: 1200).junoAccentTint())
                },
                prepare: {
                    await model.reload()
                    await model.reloadVersions()
                }
            )
        case "skill-detail-blocked":
            let model = DesktopSkillPageModel(preview: blockedDetail, versions: [], library: pages.skills)
            return FinalFixture(name: name, width: pageWidth, view: {
                AnyView(NavigationStack { DesktopSkillPage(model: model, projects: projects()) }.frame(height: 1080).junoAccentTint())
            })
        case "skill-new":
            return FinalFixture(name: name, width: pageWidth, view: {
                AnyView(
                    NavigationStack {
                        DesktopNewSkillPage(
                            model: pages.skills, startDraft: { _ in },
                            initialName: "File the invoices",
                            initialDescription: "Sorts incoming invoices into the right folder and renames them."
                        )
                    }
                    .frame(height: 820)
                    .junoAccentTint()
                )
            })
        case "skills-import":
            return FinalFixture(name: name, width: 600, view: {
                AnyView(DesktopSkillImportSheet(model: pages.skills, initialPreview: importPreview) { _, _ in }.junoAccentTint())
            })

        case "assistants-grid":
            return FinalFixture(name: name, width: pageWidth, view: {
                AnyView(DesktopAssistantsScreen(model: pages.assistants, models: assistantModels(world)).frame(height: 760).junoAccentTint())
            })
        case "assistants-empty":
            let empty = NativeAssistantsModel(client: NativeAssistantsClient(sender: pages.sender))
            empty.preview([])
            return FinalFixture(name: name, width: pageWidth, view: {
                AnyView(DesktopAssistantsScreen(model: empty, models: []).frame(height: 620).junoAccentTint())
            })
        case "assistant-editor":
            return FinalFixture(name: name, width: 880, view: {
                AnyView(
                    DesktopAssistantEditor(
                        model: pages.assistants,
                        assistant: pages.assistants.assistants.first,
                        models: assistantModels(world)
                    )
                    .junoAccentTint()
                )
            })

        case "window-memory":
            let page = pages.memoryPage()
            return FinalFixture(
                name: name,
                width: F.windowWidth,
                view: {
                    AnyView(FoundationFixtures.page(world: world, selection: .destination(.memory)) {
                        DesktopMemoryPage(settings: settings, page: page, projects: projects)
                    })
                },
                prepare: { world.showDraft() }
            )
        case "window-skills":
            return FinalFixture(
                name: name,
                width: F.windowWidth,
                view: {
                    AnyView(FoundationFixtures.page(world: world, selection: .destination(.skills)) {
                        DesktopSkillsScreen(model: pages.skills, startDraft: { _ in })
                    })
                },
                prepare: { world.showDraft() }
            )
        default:
            return nil
        }
    }

    @MainActor
    private static func assistantModels(_ world: SnapshotPreviewWorld) -> [DesktopAssistantModelOption] {
        world.world.conversationModel.modelCatalog
            .filter { $0.modality == "chat" && $0.id != "juno:auto" }
            .map {
                DesktopAssistantModelOption(
                    id: $0.id, name: $0.displayName,
                    provider: $0.providerName.components(separatedBy: " · ").first ?? $0.providerName
                )
            }
    }

    // MARK: Fixture data (preview data, invented)

    static let draftEdit = NativeMemoryEdit(
        id: "edit-draft",
        instruction: "I moved to Porto, and stop mentioning the thesis",
        summary: "Update where you live and forget the thesis",
        operations: [
            .update(id: "m3", before: "Works as a product designer at a small studio in Lisbon.",
                    content: "Works as a product designer at a small studio in Porto."),
            .add(content: "Is writing a thesis.", suppress: true, projectID: nil),
        ],
        status: .pending,
        createdAt: Date().addingTimeInterval(-60)
    )

    static let appliedEdit = NativeMemoryEdit(
        id: "edit-applied",
        instruction: "Use metric units",
        summary: "Switch measurements to metric",
        operations: [.update(id: "m2", before: "Uses imperial units.", content: "Writes in British English and uses metric units.")],
        inverse: [.update(id: "m2", before: "Writes in British English and uses metric units.", content: "Uses imperial units.")],
        status: .applied,
        createdAt: Date().addingTimeInterval(-3 * 86_400)
    )

    static let refusedEdit = NativeMemoryEdit(
        id: "edit-refused",
        instruction: "Remember my card number",
        note: "Juno doesn’t keep payment details in memory.",
        operations: [],
        status: .rejected,
        createdAt: Date().addingTimeInterval(-6 * 86_400)
    )

    static let importCandidates: [NativeMemoryImportCandidate] = [
        NativeMemoryImportCandidate(id: 0, content: "The user is a product designer in Lisbon.", category: "identity", sensitive: nil, status: .new, selected: true),
        NativeMemoryImportCandidate(id: 1, content: "The user prefers short answers with examples.", category: "preferences", sensitive: nil, status: .known, selected: false),
        NativeMemoryImportCandidate(id: 2, content: "The user takes medication for migraines.", category: "identity", sensitive: "health", status: .new, selected: false),
        NativeMemoryImportCandidate(id: 3, content: "The user’s API key is sk-live-…", category: "identity", sensitive: nil, status: .secret, selected: false),
        NativeMemoryImportCandidate(id: 4, content: "The user is training for a half marathon.", category: "goals", sensitive: nil, status: .new, selected: true),
    ]

    static let blockedDetail = NativeSkillDetail(
        skill: NativeSkill(
            id: "skill-deploy", slug: "deploy-preview", name: "Deploy preview",
            description: "Explains a failed preview deployment from its logs.",
            currentVersion: 2, enabled: false, trust: "untrusted", securityStatus: "blocked",
            sourceID: "src-vercel"
        ),
        version: NativeSkillVersion(
            id: "ver-deploy-2", version: 2,
            instructions: "# Deploy preview\n\nRead the build log and explain the first error.",
            contract: .object([
                "provenance": .object([
                    "source.kind": .string("github"),
                    "source.owner": .string("vercel-labs"),
                    "source.repo": .string("agent-skills"),
                    "source.commit": .string("c0ffee1234"),
                ]),
            ]),
            securityStatus: "blocked",
            findings: ["Asks to run arbitrary shell commands.", "Reads environment variables it does not declare."],
            createdAt: Date().addingTimeInterval(-4 * 86_400)
        ),
        source: NativeSkillSource(id: "src-vercel", owner: "vercel-labs", repo: "agent-skills", enabled: false)
    )

    static let importPreview = NativeSkillImportPreview(
        repository: .init(owner: "anthropics", repo: "skills", ref: "main", commit: "9a7d3e1c55", url: "https://github.com/anthropics/skills"),
        skills: [
            NativeSkillImportCandidate(
                path: "document-skills/pdf/SKILL.md", slug: "pdf", name: "PDF",
                description: "Reads, fills and merges PDF files.", license: "Apache-2.0",
                requestedTools: ["files"], installed: true
            ),
            NativeSkillImportCandidate(
                path: "document-skills/docx/SKILL.md", slug: "docx", name: "Word documents",
                description: "Creates and edits Word documents with tracked changes.",
                license: "Apache-2.0", slugTaken: true, suggestedSlug: "skills-docx"
            ),
            NativeSkillImportCandidate(
                path: "canvas-design/SKILL.md", slug: "canvas-design", name: "Canvas design",
                description: "Makes posters and visual art as PNG and PDF.", droppedTools: ["Bash(git:*)"]
            ),
            NativeSkillImportCandidate(
                path: "webapp-testing/SKILL.md", slug: "webapp-testing", name: "Web app testing",
                description: "Drives a local web app with Playwright to check it works.",
                securityStatus: "blocked"
            ),
        ],
        problems: [NativeSkillImportProblem(path: "broken/SKILL.md", message: "The front matter is not valid YAML.")]
    )
}

/// A connector list with nothing connected, for the Connected filter's empty
/// state.
private struct UnconnectedSender: NativeAuthenticatedRequestSending {
    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        let body = #"{"connectors":[{"id":"notion","kind":"oauth_app","label":"Notion","description":"Search and read pages across your workspace.","configured":true,"connected":false,"accountLabel":null}],"composioConfigured":false}"#
        return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}
