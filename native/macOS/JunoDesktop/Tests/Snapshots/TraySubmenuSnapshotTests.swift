import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// The composer tray's lists (owner, Oct 10: "rework completely the UI and UX
/// of submenus on the macOS app. For example, skills uh, select a project it
/// doesn't look great"), light and dark, at rest and searching:
/// `$JUNO_SNAPSHOT_DIR/tray-submenus/tray-<name>-<light|dark>.png`.
///
/// A popover is the window server's to draw (Liquid Glass on macOS 26), so
/// each list is photographed in the model picker's stand-in for one: the
/// popover's fill, its corner, a hairline and its shadow.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the tray list snapshots."
    ),
    .serialized
)
struct TraySubmenuSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
            .appendingPathComponent("tray-submenus", isDirectory: true)
    }

    /// A fixed "now", so the projects' second lines never drift.
    static let now = Date(timeIntervalSince1970: 1_791_000_000)

    static func ago(days: Double) -> Date { now.addingTimeInterval(-days * 86_400) }

    static let projectItems: [NativeComposerTrayProject] = [
        .init(id: "p1", name: "Field Notes 2.0", updatedAt: ago(days: 0.1), starred: true),
        .init(id: "p2", name: "Pricing lineup", updatedAt: ago(days: 2), starred: true),
        .init(id: "p3", name: "Alevr homepage", updatedAt: ago(days: 1)),
        .init(id: "p4", name: "Q4 research digest", updatedAt: ago(days: 4), parentName: "Research"),
        .init(id: "p5", name: "Hiring loop", updatedAt: ago(days: 6)),
        .init(id: "p6", name: "Trip to Lisbon", updatedAt: ago(days: 9)),
        .init(id: "p7", name: "Thesis chapter 3", updatedAt: ago(days: 14), parentName: "School"),
        .init(id: "p8", name: "Garden plan", updatedAt: ago(days: 30)),
        .init(id: "p9", name: "Field recordings", updatedAt: ago(days: 45)),
    ]

    static func projects(selected: String?) -> NativeComposerTrayProjects {
        NativeComposerTrayProjects(items: projectItems, selectedID: selected, select: { _ in }, create: {})
    }

    static let skillItems: [NativeComposerTraySkill] = [
        .init(slug: "brief", name: "Brief", description: "Turns notes into a one-page brief with a clear ask."),
        .init(slug: "tone-check", name: "Tone check", description: "Reads a draft for warmth, clarity and length."),
        .init(slug: "weekly-update", name: "Weekly update", description: "Your Friday update, in your own format."),
        .init(slug: "pdf", name: "PDF", description: "Reads, fills and merges PDF files.", origin: .installed, source: "anthropics/skills"),
        .init(slug: "xlsx", name: "Spreadsheets", description: "Builds and edits spreadsheets with formulas.", origin: .installed, source: "anthropics/skills"),
        .init(slug: "brand-guidelines", name: "Brand guidelines", description: "Applies a brand's colours and type to anything.", origin: .installed, source: "anthropics/skills"),
        .init(slug: "changelog", name: "Changelog", description: "", origin: .installed, source: "acme/release-tools"),
    ]

    static func skills(armed: String?) -> NativeComposerTraySkills {
        NativeComposerTraySkills(items: skillItems, armed: armed, arm: { _ in }, browse: {})
    }

    static func connector(_ id: String, _ label: String, account: String? = nil) -> NativeConnector {
        NativeConnector(id: id, source: .native, kind: "oauth_app", label: label, detail: "", connected: true, accountLabel: account)
    }

    static let connectors: [NativeConnector] = [
        connector("github", "GitHub", account: "liammagnier"),
        connector("notion", "Notion", account: "Alevr workspace"),
        connector("slack", "Slack", account: "alevr.slack.com"),
        connector("linear", "Linear"),
        connector("figma", "Figma", account: "liam@liams.dev"),
        connector("apple-calendar", "Calendar"),
        connector("apple-mail", "Mail"),
        connector("apple-notes", "Notes"),
        connector("apple-reminders", "Reminders"),
    ]

    static func apps(_ connectors: [NativeConnector], on: Set<String>) -> NativeComposerTrayApps {
        NativeComposerTrayApps(connectors: connectors, enabled: on, toggle: { _ in }, manage: {}, limit: 5)
    }

    // MARK: Project

    @Test
    func theProjectList() async throws {
        try await render(name: "project") {
            NativeComposerTrayPickers.projects(Self.projects(selected: "p2"), now: Self.now, close: {})
        }
        try await render(name: "project-search") {
            NativeComposerTrayPickers.projects(Self.projects(selected: "p2"), now: Self.now, query: "field", cursor: "p9", close: {})
        }
        try await render(name: "project-none") {
            NativeComposerTrayPickers.projects(
                NativeComposerTrayProjects(items: Array(Self.projectItems.prefix(3)).map {
                    NativeComposerTrayProject(id: $0.id, name: $0.name, updatedAt: $0.updatedAt)
                }, selectedID: nil, select: { _ in }, create: {}),
                now: Self.now,
                cursor: "p3",
                close: {}
            )
        }
    }

    // MARK: Skills

    @Test
    func theSkillList() async throws {
        try await render(name: "skills") {
            NativeComposerTrayPickers.skills(Self.skills(armed: "tone-check"), cursor: "pdf", close: {})
        }
        try await render(name: "skills-search") {
            NativeComposerTrayPickers.skills(Self.skills(armed: nil), query: "brand", close: {})
        }
        try await render(name: "skills-empty") {
            NativeComposerTrayPickers.skills(
                NativeComposerTraySkills(items: [], armed: nil, arm: { _ in }, browse: {}),
                close: {}
            )
        }
    }

    // MARK: Apps

    @Test
    func theAppList() async throws {
        try await render(name: "apps") {
            NativeComposerTrayPickers.apps(Self.apps(Array(Self.connectors.prefix(6)), on: ["github", "linear"]), cursor: "notion", close: {})
        }
        try await render(name: "apps-search") {
            NativeComposerTrayPickers.apps(Self.apps(Self.connectors, on: ["github"]), query: "no", close: {})
        }
        // At the ceiling of five: the rest go quiet and say why.
        try await render(name: "apps-full") {
            NativeComposerTrayPickers.apps(
                Self.apps(Array(Self.connectors.prefix(7)), on: ["github", "notion", "slack", "linear", "figma"]),
                close: {}
            )
        }
    }

    // MARK: Folder and media values

    @Test
    func theFolderAndChoiceLists() async throws {
        let folder = DesktopChatFolderStore.Folder(
            id: "f1", name: "juno", access: .readWrite, alwaysAllowed: [], isReachable: true
        )
        try await render(name: "folder") {
            ChatFolderControl.accessList(folder, setAccess: { _ in }, chooseAnother: {}, stop: {}, cursor: "action:choose", close: {})
        }
        let schema = ComposerTraySnapshotTests.schema("openai:gpt-image-2.5-sunburst")
        try await render(name: "aspect", width: NativeTrayPickerMetrics.compactWidth) {
            NativeComposerTrayPickers.choices(schema: schema, params: schema.defaults(), key: "aspect", close: {})
        }
        try await render(name: "quality", width: NativeTrayPickerMetrics.compactWidth) {
            NativeComposerTrayPickers.choices(schema: schema, params: schema.defaults(), key: "quality", close: {})
        }
    }

    // MARK: Rendering

    private func render<V: View>(
        name: String,
        width: CGFloat = NativeTrayPickerMetrics.width,
        @ViewBuilder _ view: () -> V
    ) async throws {
        let gutter = JunoSpace.region
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let framed = view()
                .background(Color.junoPopover)
                .clipShape(RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: JunoRadius.menu, style: .continuous)
                        .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 0.5)
                }
                .shadow(color: .black.opacity(0.16), radius: 18, y: 8)
                .padding(gutter)
            let url = try await TranscriptSnapshotRenderer.render(
                framed,
                name: "tray-\(name)",
                width: width + gutter * 2,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}
