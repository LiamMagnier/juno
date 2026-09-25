import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// The shared foundations both Phase 3 (overlays) and Phase 4 (pages) build
/// on, drawn offscreen in both appearances:
/// `$JUNO_SNAPSHOT_DIR/foundations/<name>-<light|dark>.png`.
///
/// Glass is composited by the window server and cannot be drawn offscreen, so
/// the toast host is shown with its Reduce Transparency recipe
/// (``SwiftUI/EnvironmentValues/junoSnapshotOpaqueGlass``), as the composer is
/// in the final set.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the foundation snapshots."
    ),
    .serialized
)
struct FoundationSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("foundations", isDirectory: true)
    }

    @Test(arguments: FoundationFixtures.names)
    func drawsInBothAppearances(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.shared()
        let fixture = try #require(FoundationFixtures.fixture(named: name, world: world))
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

enum FoundationFixtures {
    static let names = [
        "segmented",
        "toasts",
        "toast-selection",
        "toast-host-placement",
        "page-template",
        "page-template-narrow",
        "empty-states",
        "prominent-buttons",
        "inline-rename",
        "window-library",
        "window-connections",
        "window-search",
    ]

    private typealias F = FinalSnapshotFixtures

    @MainActor
    static func fixture(named name: String, world: SnapshotPreviewWorld) -> FinalFixture? {
        switch name {
        case "segmented":
            return FinalFixture(name: name, width: 560, view: { AnyView(SegmentedSheet()) })
        case "toasts":
            return FinalFixture(name: name, width: 560, view: { AnyView(ToastSheet()) })
        case "toast-selection":
            return FinalFixture(name: name, width: 560, view: {
                AnyView(
                    VStack(spacing: JunoSpace.section) {
                        JunoToastSelectionBar(selection: JunoToastSelection(
                            count: 3,
                            actions: [
                                JunoToast.Action("Copy 3 Names", icon: .copy) {},
                                JunoToast.Action("Delete", icon: .trash, role: .destructive) {},
                            ],
                            clear: {}
                        ))
                        JunoToastSelectionBar(selection: JunoToastSelection(
                            count: 1,
                            actions: [JunoToast.Action("Rename", icon: .edit) {}],
                            clear: {}
                        ))
                    }
                    .padding(JunoSpace.region)
                    .environment(\.junoSnapshotOpaqueGlass, true)
                )
            })
        case "toast-host-placement":
            return FinalFixture(name: name, width: 832, view: { AnyView(ToastPlacementSheet()) })
        case "page-template":
            return FinalFixture(name: name, width: F.detailWidth, view: {
                AnyView(PageTemplateSheet().frame(height: 560).junoAccentTint())
            })
        case "page-template-narrow":
            return FinalFixture(name: name, width: 560, view: {
                AnyView(PageTemplateSheet().frame(height: 620).junoAccentTint())
            })
        case "empty-states":
            return FinalFixture(name: name, width: 832, view: { AnyView(EmptyStateSheet()) })
        case "prominent-buttons":
            return FinalFixture(name: name, width: 640, view: { AnyView(ProminentSheet()) })
        case "inline-rename":
            return FinalFixture(name: name, width: 320, view: { AnyView(RenameSheet()) })
        case "window-library":
            return FinalFixture(
                name: name,
                width: F.windowWidth,
                view: {
                    AnyView(page(world: world, selection: .destination(.library)) {
                        DesktopLibraryScreen(model: PageFixtures.libraryModel())
                    })
                },
                prepare: {
                    world.showDraft()
                }
            )
        case "window-connections":
            return FinalFixture(
                name: name,
                width: F.windowWidth,
                view: {
                    AnyView(page(world: world, selection: .destination(.connections)) {
                        DesktopConnectionsScreen(model: world.world.connectorModel)
                    })
                },
                prepare: {
                    world.showDraft()
                    await world.world.connectorModel.refresh()
                }
            )
        case "window-search":
            return FinalFixture(
                name: name,
                width: F.windowWidth,
                view: {
                    AnyView(page(world: world, selection: nil) {
                        DesktopSearchScreen(model: world.world.searchModel, openConversation: { _ in })
                    })
                },
                prepare: {
                    world.showDraft()
                    world.world.searchModel.setQuery("", debounced: false)
                }
            )
        default:
            return nil
        }
    }

    /// A page as the Chat window routes it: inside the detail column's
    /// `NavigationStack`, beside the sidebar, with the window's toast host.
    @MainActor
    @ViewBuilder
    static func page<Page: View>(
        world: SnapshotPreviewWorld,
        selection: DesktopSidebarItem?,
        @ViewBuilder page: () -> Page
    ) -> some View {
        let toasts = JunoToastCenter()
        F.window(world: world, fixedHeight: F.windowHeight, selection: selection) {
            NavigationStack {
                page()
            }
            .junoToastHost(toasts)
            .frame(height: F.windowHeight - F.toolbarHeight)
        }
    }
}

// MARK: - Sheets

private struct SegmentedSheet: View {
    enum Kind: Hashable { case all, images, files }
    enum View2: Hashable { case list, grid }
    enum Tab: Hashable { case overview, tasks, sources, settings }

    @State private var kind = Kind.images
    @State private var view = View2.grid
    @State private var tab = Tab.overview
    @State private var scope = Kind.all

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            label("Filter with counts")
            JunoSegmented(
                options: [
                    JunoSegmented<Kind>.Option(.all, "All", count: 12),
                    JunoSegmented<Kind>.Option(.images, "Images", count: 5),
                    JunoSegmented<Kind>.Option(.files, "Files", count: 7),
                ],
                selection: $kind,
                accessibilityLabel: "Filter by type"
            )
            label("View switch with marks")
            JunoSegmented(
                options: [
                    JunoSegmented<View2>.Option(.list, "List", icon: .list),
                    JunoSegmented<View2>.Option(.grid, "Grid", icon: .grid),
                ],
                selection: $view,
                accessibilityLabel: "View"
            )
            label("Tabs with a badge and a disabled segment")
            JunoSegmented(
                options: [
                    JunoSegmented<Tab>.Option(.overview, "Overview"),
                    JunoSegmented<Tab>.Option(.tasks, "Tasks", badge: 2),
                    JunoSegmented<Tab>.Option(.sources, "Sources"),
                    JunoSegmented<Tab>.Option(.settings, "Settings", isDisabled: true),
                ],
                selection: $tab,
                accessibilityLabel: "Project"
            )
            label("Filling its column")
            JunoSegmented(
                options: [
                    JunoSegmented<Kind>.Option(.all, "All"),
                    JunoSegmented<Kind>.Option(.images, "Images"),
                    JunoSegmented<Kind>.Option(.files, "Files"),
                ],
                selection: $scope,
                accessibilityLabel: "Scope",
                fills: true
            )
            .frame(width: 360)
        }
        .padding(JunoSpace.region)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .junoType(.caption)
            .foregroundStyle(Color.junoSecondaryInk)
    }
}

private struct ToastSheet: View {
    var body: some View {
        VStack(spacing: JunoSpace.cozy) {
            JunoToastCard(toast: .success("Chat archived.", action: JunoToast.Action("Undo") {})) {}
            JunoToastCard(toast: .error(
                "Couldn’t load your files",
                detail: "Check your connection and try again.",
                action: JunoToast.Action("Retry") {}
            )) {}
            JunoToastCard(toast: JunoToast(
                tone: .warning,
                title: "A project changed on another device.",
                action: JunoToast.Action("Keep mine") {},
                cancel: JunoToast.Action("Use server version") {},
                duration: nil
            )) {}
            JunoToastCard(toast: .info("Link copied.")) {}
            JunoToastCard(toast: JunoToast(tone: .loading, title: "Reading Contract.pdf…")) {}
            JunoToastCard(toast: JunoToast(title: "Saved to your library.")) {}
        }
        .padding(JunoSpace.region)
        .environment(\.junoSnapshotOpaqueGlass, true)
    }
}

/// The host's two placements: 12pt above a docked composer, and 24pt above
/// the bottom where there is none.
private struct ToastPlacementSheet: View {
    @State private var overComposer = JunoToastCenter()
    @State private var onPage = JunoToastCenter()

    var body: some View {
        HStack(spacing: JunoSpace.regular) {
            column(title: "Chat", center: overComposer) {
                RoundedRectangle(cornerRadius: JunoRadius.composer, style: .continuous)
                    .fill(Color.junoCard)
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.composer, style: .continuous)
                            .strokeBorder(Color.junoBorder, lineWidth: 1)
                    )
                    .overlay(alignment: .topLeading) {
                        Text("Composer")
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .padding(JunoSpace.regular)
                    }
                    .frame(height: 112)
                    .padding(.horizontal, JunoSpace.section)
                    .padding(.bottom, JunoSpace.regular)
                    .junoToastAnchor()
            }
            column(title: "Page", center: onPage) { EmptyView() }
        }
        .padding(JunoSpace.regular)
        .environment(\.junoSnapshotOpaqueGlass, true)
        .onAppear {
            overComposer.post(.success("Chat archived.", action: JunoToast.Action("Undo") {}))
            onPage.post(.error("Couldn’t load your files", action: JunoToast.Action("Retry") {}))
        }
    }

    private func column<Bottom: View>(
        title: String,
        center: JunoToastCenter,
        @ViewBuilder bottom: () -> Bottom
    ) -> some View {
        VStack(spacing: 0) {
            Text(title)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .padding(.top, JunoSpace.regular)
            Spacer(minLength: 0)
            bottom()
        }
        .frame(maxWidth: .infinity)
        .frame(height: 420)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        )
        .junoToastHost(center)
    }
}

private struct PageTemplateSheet: View {
    enum Kind: Hashable { case all, images, files }
    enum Sort: Hashable { case newest, oldest, name, largest }
    enum Presentation: Hashable { case list, grid }

    @State private var query = ""
    @State private var kind = Kind.all
    @State private var sort = Sort.newest
    @State private var presentation = Presentation.grid

    var body: some View {
        JunoPage(measure: .wide) {
            JunoPageHeader("Library", lede: "Everything you upload or share in chats.") {
                Text("12 items · 30.4 KB")
                    .junoCaption()
                    .monospacedDigit()
                Button("Recently deleted") {}
                    .buttonStyle(.bordered)
                    .tint(nil)
                Button {} label: { Label("Upload", icon: .upload) }
                    .buttonStyle(.junoProminent)
            }
        } controls: {
            JunoPageControls {
                JunoPageSearchField(text: $query, prompt: "Search files")
                JunoSegmented(
                    options: [
                        JunoSegmented<Kind>.Option(.all, "All", count: 12),
                        JunoSegmented<Kind>.Option(.images, "Images", count: 5),
                        JunoSegmented<Kind>.Option(.files, "Files", count: 7),
                    ],
                    selection: $kind,
                    accessibilityLabel: "Filter by type"
                )
                JunoPageMenu(
                    options: [
                        JunoPageMenuOption(Sort.newest, "Newest first", menuTitle: "Newest First"),
                        JunoPageMenuOption(Sort.oldest, "Oldest first", menuTitle: "Oldest First"),
                        JunoPageMenuOption(Sort.name, "Name"),
                        JunoPageMenuOption(Sort.largest, "Largest first", menuTitle: "Largest First"),
                    ],
                    selection: $sort,
                    accessibilityLabel: "Sort files"
                )
            } trailing: {
                JunoSegmented(
                    options: [
                        JunoSegmented<Presentation>.Option(.list, "List", icon: .list),
                        JunoSegmented<Presentation>.Option(.grid, "Grid", icon: .grid),
                    ],
                    selection: $presentation,
                    accessibilityLabel: "View"
                )
            }
        } content: {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 168), spacing: JunoSpace.regular)],
                spacing: JunoSpace.regular
            ) {
                ForEach(0..<8, id: \.self) { index in
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                            .fill(Color.junoSecondary)
                            .aspectRatio(4 / 3, contentMode: .fit)
                        Text("Invoice-\(index + 1).pdf")
                            .junoType(JunoType.ui.weight(.medium))
                        Text("88 KB · 2 days ago")
                            .junoType(.micro)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                    .padding(JunoSpace.snug)
                    .junoCard(cornerRadius: JunoRadius.card)
                }
            }
        }
    }
}

private struct EmptyStateSheet: View {
    var body: some View {
        VStack(spacing: JunoSpace.section) {
            HStack(alignment: .top, spacing: JunoSpace.section) {
                JunoEmptyState(
                    title: "Your library is empty",
                    message: "Files and images you share with Juno appear here automatically.",
                    icon: .library,
                    actionLabel: "Refresh",
                    action: {}
                )
                JunoEmptyState(
                    title: "Couldn’t load your files",
                    message: "Check your connection and try again.",
                    icon: .error,
                    actionLabel: "Try Again",
                    action: {}
                )
            }
            .frame(height: 340)
            HStack(alignment: .top, spacing: JunoSpace.section) {
                JunoEmptyState(
                    title: "No sources yet",
                    message: "Add a file or a link and every chat in this project can use it.",
                    icon: .files,
                    actionLabel: "Add Source",
                    action: {},
                    size: .panel
                )
                JunoEmptyState(
                    title: "Sources unavailable",
                    message: "Juno couldn’t read this project’s sources.",
                    icon: .triangleAlert,
                    size: .panel
                )
            }
        }
        .padding(JunoSpace.region)
        .junoAccentTint()
    }
}

/// The accent reaches a prominent button with no tint around it: the approval
/// card's verb, drawn outside the chat column, is the case that was blue.
private struct ProminentSheet: View {
    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            HStack(spacing: JunoSpace.cozy) {
                Button("Create Project") {}
                    .buttonStyle(.junoProminent)
                Button("Cancel") {}
                    .buttonStyle(.bordered)
                Button("Save") {}
                    .buttonStyle(.junoProminent)
                    .disabled(true)
            }
            ChatWorkApprovalCard(
                approval: WorkApprovalRequest(
                    approvalID: "a1", runID: "run_1", action: "send_email",
                    risk: "sensitive",
                    summary: "Send 3 emails asking Acme, Birch & Co and Corvid for PO numbers",
                    detail: [:], actionDigest: "d1",
                    expiresAt: Date().addingTimeInterval(20 * 60), decision: "pending"
                ),
                decide: { _ in }
            )
        }
        .padding(JunoSpace.region)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A list row mid-rename, beside its neighbours.
private struct RenameSheet: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row(Text("Planning the quarterly review"))
            row(
                JunoInlineRenameField("Draft reply to the landlord", accessibilityLabel: "Rename chat") { _ in } end: {}
            )
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(Color.junoSelected)
            )
            row(Text("Recipes for a small kitchen"))
        }
        .junoType(.ui)
        .padding(JunoSpace.regular)
        .background(Color.junoSidebar)
    }

    private func row<Content: View>(_ content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 32)
    }
}
