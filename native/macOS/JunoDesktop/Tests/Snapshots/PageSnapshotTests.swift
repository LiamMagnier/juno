import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI
import Testing

@testable import JunoDesktop

/// Phase 4's pages, drawn offscreen in both appearances:
/// `$JUNO_SNAPSHOT_DIR/pages/<name>-<light|dark>.png`.
///
/// Page data is preview data: fixed, plausible, and never from a server
/// (`NativeLibraryPageModel.fixture`, and rows built here). Menus, popovers
/// and glass cannot be drawn offscreen; the toast host is drawn with its
/// Reduce Transparency recipe, as the foundations are.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the page snapshots."
    ),
    .serialized
)
struct PageSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("pages", isDirectory: true)
    }

    @Test(arguments: PageFixtures.names)
    func drawsInBothAppearances(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.shared()
        let fixture = try #require(PageFixtures.fixture(named: name, world: world))
        if let prepare = fixture.prepare {
            try await prepare()
        }
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                fixture.view(),
                name: fixture.name,
                width: fixture.width,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

enum PageFixtures {
    static let names = [
        "library-list",
        "library-grid",
        "library-deleted",
        "library-empty",
        "library-error",
        "library-loading",
        "library-selection",
        "library-uploading",
        "library-narrow",
        "library-versions",
        "projects-grid",
        "projects-empty",
        "projects-new-sheet",
        "project-overview",
        "project-overview-narrow",
        "project-sources",
        "project-settings",
        "artifacts-list",
        "artifacts-grid",
        "artifacts-designs",
        "artifacts-empty",
        "artifacts-no-results",
        "artifact-page-html",
        "artifact-page-design-older",
        "window-projects",
        "window-artifacts",
        "inline-design-poster",
    ]

    static let pageWidth: CGFloat = 936
    static let narrowWidth: CGFloat = 560

    private typealias F = FinalSnapshotFixtures

    @MainActor
    static func fixture(named name: String, world: SnapshotPreviewWorld) -> FinalFixture? {
        switch name {
        case "library-list":
            return page(name, height: 760) { library(libraryModel(), view: "list") }
        case "library-grid":
            return page(name, height: 860) { library(libraryModel(), view: "grid") }
        case "library-deleted":
            return page(name, height: 620) {
                library(libraryModel(items: deletedFiles, query: NativeLibraryQuery(deleted: true)), view: "list")
            }
        case "library-empty":
            return page(name, height: 620) {
                library(.fixture(items: [], counts: NativeLibraryCounts(all: 0, images: 0, files: 0), storage: storage(used: 0)), view: "list")
            }
        case "library-error":
            return page(name, height: 560) { library(.fixture(items: nil, failed: true), view: "list") }
        case "library-loading":
            // No items yet and nothing failed: the skeleton, with the header's
            // Upload and storage caption withheld until there is a list.
            return page(name, height: 560) { library(.fixture(items: nil, storage: storage(used: 1_240_000_000)), view: "list") }
        case "library-selection":
            return page(name, height: 760) {
                library(libraryModel(), view: "list", selection: [files[0].id, files[2].id])
                    .junoToastHost(JunoToastCenter())
                    .environment(\.junoSnapshotOpaqueGlass, true)
            }
        case "library-uploading":
            return page(name, height: 760) {
                library(
                    libraryModel(uploads: [
                        NativeLibraryUpload(fileName: "Site photos.zip", size: 18_400_000, isImage: false),
                        NativeLibraryUpload(
                            fileName: "Contract scan.tiff",
                            size: 61_000_000,
                            isImage: true,
                            status: .failed("This file is larger than 50 MB.", retryable: false)
                        ),
                        NativeLibraryUpload(
                            fileName: "Kickoff notes.docx",
                            size: 48_000,
                            isImage: false,
                            status: .failed("Alevr couldn’t reach the server.", retryable: true)
                        ),
                    ]),
                    view: "list"
                )
            }
        case "library-narrow":
            return page(name, width: narrowWidth, height: 900) { library(libraryModel(), view: "list") }
        case "library-versions":
            return FinalFixture(name: name, width: 480, view: {
                AnyView(
                    VStack(alignment: .leading, spacing: JunoSpace.regular) {
                        Text("Versions").junoType(.heading)
                        DesktopLibraryVersionsList(
                            versions: [
                                NativeLibraryVersion(version: 3, current: true, fileName: "Pricing model.xlsx", size: 88_300, createdAt: ago(hours: 3)),
                                NativeLibraryVersion(version: 2, current: false, fileName: "Pricing model.xlsx", size: 84_100, createdAt: ago(days: 2)),
                                NativeLibraryVersion(version: 1, current: false, fileName: "Pricing model.xlsx", size: 79_900, createdAt: ago(days: 9)),
                            ],
                            failed: false,
                            restoring: nil,
                            restore: { _ in }
                        )
                        Text("Restoring an earlier version keeps the current one.")
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                        DesktopLibraryVersionsList(versions: [
                            NativeLibraryVersion(version: 1, current: true, fileName: "Logo.png", size: 12_000, createdAt: ago(days: 1)),
                        ], failed: false, restoring: nil, restore: { _ in })
                    }
                    .padding(JunoSpace.section)
                )
            })
        case "projects-grid":
            return page(name, height: 620) {
                DesktopProjectsScreen(model: world.world.projectModel)
            }
        case "projects-empty":
            return FinalFixture(name: name, width: pageWidth, view: {
                AnyView(
                    NavigationStack { DesktopProjectsScreen(model: EmptyWorld.shared!.projectModel) }
                        .frame(height: 560)
                        .junoAccentTint()
                )
            }, prepare: { try await EmptyWorld.prepare() })
        case "projects-new-sheet":
            return FinalFixture(name: name, width: 440, view: {
                AnyView(
                    DesktopNewProjectSheetBody(
                        name: .constant(""),
                        failure: nil,
                        canCreate: true,
                        creating: false,
                        cancel: {},
                        create: {}
                    )
                    .junoAccentTint()
                )
            })
        case "project-overview":
            return page(name, height: 760) { projectPage(world, tab: .overview) }
        case "project-overview-narrow":
            return page(name, width: narrowWidth, height: 1_180) { projectPage(world, tab: .overview) }
        case "project-sources":
            return page(name, height: 760) { projectPage(world, tab: .sources) }
        case "project-settings":
            return page(name, height: 1_320) { projectPage(world, tab: .settings) }
        case "artifacts-list":
            return page(name, height: 560) { artifacts(world, view: "list") }
        case "artifacts-grid":
            return page(name, height: 720, prepare: prepareThumbnails) { artifacts(world, view: "grid") }
        case "artifacts-designs":
            return page(name, height: 620) { artifacts(world, view: "list", filter: "DESIGN") }
        case "artifacts-empty":
            return FinalFixture(name: name, width: pageWidth, view: {
                AnyView(
                    NavigationStack {
                        DesktopArtifactsScreen(model: EmptyWorld.shared!.artifactModel, newChat: {}, initialFilter: "ALL")
                    }
                    .frame(height: 620)
                    .junoAccentTint()
                )
            }, prepare: { try await EmptyWorld.prepare() })
        case "artifacts-no-results":
            return page(name, height: 520) { artifacts(world, view: "list", query: "invoice") }
        case "artifact-page-html":
            return page(name, height: 620, prepare: {
                // At the body's own size, so the still is not scaled.
                try await SnapshotStillCache.shared.prepare(
                    document: NativeArtifactRuntimeDocument.build(kind: .html, content: htmlVersion2, language: nil),
                    size: CGSize(width: pageWidth, height: 576)
                )
            }) {
                ArtifactPage(artifactID: "art-1", model: world.world.artifactModel)
                    .environment(\.junoWebPreviewStill, SnapshotStillCache.shared.webStills)
            }
        case "artifact-page-design-older":
            return page(name, height: 620) {
                VStack(spacing: 0) {
                    ArtifactPageTopRow(
                        artifact: olderDesign,
                        version: 2,
                        select: { _ in },
                        openInChat: {},
                        more: { EmptyView() }
                    )
                    Rectangle().fill(Color.junoBorder).frame(height: 1)
                    ArtifactOlderDesign(artifactID: olderDesign.id, version: 2, isCurrent: false)
                }
                .environment(\.junoDesignPreviews, SnapshotDesignProvider())
            }
        case "window-projects":
            return FinalFixture(name: name, width: F.windowWidth, view: {
                AnyView(FoundationFixtures.page(world: world, selection: .destination(.projects)) {
                    DesktopProjectsScreen(model: world.world.projectModel)
                })
            }, prepare: { world.showDraft() })
        case "window-artifacts":
            return FinalFixture(name: name, width: F.windowWidth, view: {
                AnyView(FoundationFixtures.page(world: world, selection: .destination(.artifacts)) {
                    artifacts(world, view: "list")
                })
            }, prepare: { world.showDraft() })
        case "inline-design-poster":
            return FinalFixture(name: name, view: {
                AnyView(TranscriptSnapshotFixtures.column(resolver: TranscriptSnapshotFixtures.designResolver) {
                    TranscriptSnapshotFixtures.row(TranscriptSnapshotFixtures.message("q-design", .user, "Design a sign-in screen for the phone."))
                    TranscriptSnapshotFixtures.row(TranscriptSnapshotFixtures.designReply, newest: true)
                })
            }, prepare: {
                try await SnapshotStillCache.shared.prepareDesign(svg: PreviewFixtures.designSVG)
            })
        default:
            return nil
        }
    }

    // MARK: Projects and artifacts

    @MainActor
    static func projectPage(_ world: SnapshotPreviewWorld, tab: DesktopProjectTab) -> some View {
        DesktopProjectPage(
            projectID: "proj-1",
            model: world.world.projectModel,
            conversationModel: world.world.conversationModel,
            workspaceModel: world.world.projectWorkspaceModel,
            artifactModel: world.world.artifactModel,
            openConversation: { _ in },
            startConversation: { _ in },
            openMemory: {},
            initialTab: tab
        )
    }

    @MainActor
    static func artifacts(
        _ world: SnapshotPreviewWorld,
        view: String,
        filter: String = "ALL",
        query: String? = nil
    ) -> some View {
        DesktopArtifactsScreen(
            model: world.world.artifactModel,
            newChat: {},
            initialFilter: filter,
            initialView: view,
            initialQuery: query
        )
        .environment(\.junoDesignPreviews, SnapshotDesignProvider())
        .environment(\.junoWebPreviewStill, SnapshotStillCache.shared.webStills)
    }

    static let htmlVersion2 = "<html><body><h1>Brightness by epoch</h1><p>Updated.</p></body></html>"

    @MainActor
    static func prepareThumbnails() async throws {
        try await SnapshotStillCache.shared.prepare(
            document: NativeArtifactSandbox.document(kind: .html, content: htmlVersion2, policy: .thumbnail),
            // The tile's 4:3 preview, so the still is not scaled.
            size: CGSize(width: 272, height: 204)
        )
    }

    /// A design three versions in, opened at v2.
    static let olderDesign = NativeArtifact(
        id: "art-design",
        conversationID: "conv-1",
        conversationTitle: "Sign-in flow",
        messageID: "msg-6",
        identifier: "signin-screen",
        title: "Sign-in screen",
        kind: .design,
        language: nil,
        currentVersion: 3,
        versions: (1...3).map {
            NativeArtifactVersion(id: "v\($0)", version: $0, content: "{}", origin: nil, createdAt: ago(days: Double(4 - $0)))
        },
        createdAt: ago(days: 4),
        updatedAt: ago(hours: 2),
        revision: 3
    )

    // MARK: Composition

    /// A page alone, at the detail column's width, in a stack as the window
    /// routes it, with the accent tint the window applies.
    @MainActor
    static func page(
        _ name: String,
        width: CGFloat = pageWidth,
        height: CGFloat,
        prepare: (@MainActor () async throws -> Void)? = nil,
        @ViewBuilder content: @escaping () -> some View
    ) -> FinalFixture {
        FinalFixture(name: name, width: width, view: {
            AnyView(
                NavigationStack { content() }
                    .frame(height: height)
                    .junoAccentTint()
            )
        }, prepare: prepare)
    }

    @MainActor
    static func library(_ model: NativeLibraryPageModel, view: String, selection: Set<String> = []) -> some View {
        UserDefaults.standard.set(view, forKey: "juno.desktop.library.view")
        return DesktopLibraryScreen(model: model, openConversation: { _ in }, initialSelection: selection)
    }

    // MARK: Preview data (plausible, fixed, never from a server)

    static func ago(hours: Double = 0, days: Double = 0) -> Date {
        Date().addingTimeInterval(-(hours * 3_600 + days * 86_400))
    }

    static func storage(used: Int) -> NativeLibraryStorage {
        NativeLibraryStorage(usedBytes: used, quotaBytes: 5_000_000_000, remainingBytes: 5_000_000_000 - used)
    }

    static let files: [NativeLibraryItem] = [
        NativeLibraryItem(id: "f1", fileName: "Q3 board update.pdf", mimeType: "application/pdf", size: 2_480_000, kind: "FILE", createdAt: ago(hours: 2), conversationID: "c1", knowledge: NativeLibraryKnowledge(state: "ready")),
        NativeLibraryItem(id: "f2", fileName: "Storefront at dusk.jpg", mimeType: "image/jpeg", size: 1_150_000, kind: "IMAGE", createdAt: ago(hours: 5), conversationID: "c2", inUse: .chat),
        NativeLibraryItem(id: "f3", fileName: "Pricing model.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 88_300, kind: "FILE", createdAt: ago(days: 1), versionCount: 3, knowledge: NativeLibraryKnowledge(state: "processing")),
        NativeLibraryItem(id: "f4", fileName: "Interview transcript, Mara.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 64_200, kind: "FILE", createdAt: ago(days: 3), knowledge: NativeLibraryKnowledge(state: "partial")),
        NativeLibraryItem(id: "f5", fileName: "Floor plan v2.png", mimeType: "image/png", size: 640_000, kind: "IMAGE", createdAt: ago(days: 6)),
        NativeLibraryItem(id: "f6", fileName: "invoice-0412.pdf", mimeType: "application/pdf", size: 96_000, kind: "FILE", createdAt: ago(days: 12), knowledge: NativeLibraryKnowledge(state: "failed")),
        NativeLibraryItem(id: "f7", fileName: "api-client.ts", mimeType: "text/plain", size: 7_400, kind: "FILE", createdAt: ago(days: 20), conversationID: "c3"),
        NativeLibraryItem(id: "f8", fileName: "Team offsite.heic", mimeType: "image/heic", size: 3_100_000, kind: "IMAGE", createdAt: ago(days: 34)),
    ]

    static let deletedFiles: [NativeLibraryItem] = [
        NativeLibraryItem(id: "d1", fileName: "Old logo.svg", mimeType: "image/svg+xml", size: 12_000, kind: "IMAGE", createdAt: ago(days: 40), deletedAt: ago(days: 1)),
        NativeLibraryItem(id: "d2", fileName: "Draft proposal.pdf", mimeType: "application/pdf", size: 420_000, kind: "FILE", createdAt: ago(days: 22), deletedAt: ago(hours: 6), keptIn: .project),
        NativeLibraryItem(id: "d3", fileName: "notes.md", mimeType: "text/markdown", size: 2_100, kind: "FILE", createdAt: ago(days: 8), deletedAt: ago(hours: 1), keptIn: .chat),
    ]

    @MainActor
    static func libraryModel(
        items: [NativeLibraryItem] = files,
        query: NativeLibraryQuery = NativeLibraryQuery(),
        uploads: [NativeLibraryUpload] = []
    ) -> NativeLibraryPageModel {
        .fixture(
            items: items,
            counts: NativeLibraryCounts(
                all: items.count,
                images: items.filter(\.isImage).count,
                files: items.filter { !$0.isImage }.count
            ),
            storage: storage(used: 1_240_000_000),
            query: query,
            uploads: uploads
        )
    }
}

/// The empty scenario's models, for the pages' first-run states.
@MainActor
enum EmptyWorld {
    static var shared: PreviewWorld?

    static func prepare() async throws {
        guard shared == nil else { return }
        let world = try PreviewWorld(scenario: .empty)
        await world.activate()
        shared = world
    }
}
